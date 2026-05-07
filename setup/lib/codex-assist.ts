/**
 * Offer Codex-assisted debugging when a setup step fails.
 *
 * Codex is optional for diagnostics: if it is not installed or authenticated,
 * setup simply shows the logs and continues to the normal abort path. The
 * default NanoClaw provider still depends on Codex, but this helper must not
 * block early setup failures before auth has run.
 */
import { execSync, spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import * as p from '@clack/prompts';
import k from 'kleur';

import { ensureAnswer } from './runner.js';
import { brandBody, fitToWidth, fmtDuration, note } from './theme.js';

export interface AssistContext {
  stepName: string;
  msg: string;
  hint?: string;
  /** Absolute path to the per-step raw log, if the caller has one. */
  rawLogPath?: string;
}

const STEP_FILES: Record<string, string[]> = {
  bootstrap: ['setup.sh', 'setup/install-node.sh', 'nanoclaw.sh'],
  environment: ['setup/environment.ts'],
  container: ['setup/container.ts', 'setup/install-docker.sh', 'container/Dockerfile'],
  onecli: ['setup/onecli.ts'],
  auth: ['setup/auto.ts'],
  mounts: ['setup/mounts.ts'],
  service: ['setup/service.ts'],
  'cli-agent': ['setup/cli-agent.ts', 'scripts/init-cli-agent.ts'],
  timezone: ['setup/timezone.ts', 'setup/lib/tz-from-codex.ts'],
  channel: ['setup/auto.ts'],
  verify: ['setup/verify.ts'],
  'telegram-install': ['setup/add-telegram.sh', 'setup/channels/telegram.ts'],
  'telegram-validate': ['setup/channels/telegram.ts'],
  'pair-telegram': ['setup/pair-telegram.ts', 'setup/channels/telegram.ts'],
  'discord-install': ['setup/add-discord.sh', 'setup/channels/discord.ts'],
  'slack-install': ['setup/add-slack.sh', 'setup/channels/slack.ts'],
  'slack-validate': ['setup/channels/slack.ts'],
  'imessage-install': ['setup/add-imessage.sh', 'setup/channels/imessage.ts'],
  imessage: ['setup/channels/imessage.ts'],
  'teams-install': ['setup/add-teams.sh', 'setup/channels/teams.ts'],
  'teams-manifest': ['setup/lib/teams-manifest.ts', 'setup/channels/teams.ts'],
  'init-first-agent': ['scripts/init-first-agent.ts', 'setup/channels/telegram.ts', 'setup/channels/discord.ts'],
};

const BIG_PICTURE_FILES = ['README.md', 'setup/auto.ts'];

export async function offerCodexAssist(ctx: AssistContext, projectRoot: string = process.cwd()): Promise<boolean> {
  if (process.env.NANOCLAW_SKIP_CODEX_ASSIST === '1' || process.env.NANOCLAW_SKIP_CLAUDE_ASSIST === '1') {
    return false;
  }
  if (!isCodexInstalled() || !isCodexAuthenticated()) return false;

  const want = ensureAnswer(
    await p.confirm({
      message: 'Want me to ask Codex to diagnose this?',
      initialValue: true,
    }),
  );
  if (!want) return false;

  const response = await queryCodexUnderSpinner(buildPrompt(ctx, projectRoot), projectRoot);
  if (!response) return false;

  const parsed = parseResponse(response);
  if (!parsed) {
    p.log.warn(brandBody("Codex responded but I couldn't parse a command out of it."));
    p.log.message(k.dim(response.trim().slice(0, 500)));
    return false;
  }

  note(`${parsed.reason}\n\n${k.cyan('$')} ${parsed.command}`, "Codex's suggestion");

  const run = ensureAnswer(
    await p.confirm({
      message: 'Run this command? (you can edit it before executing)',
      initialValue: true,
    }),
  );
  if (!run) return false;

  await runSuggested(parsed.command, projectRoot);
  return true;
}

function isCodexInstalled(): boolean {
  try {
    execSync('command -v codex', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isCodexAuthenticated(): boolean {
  return (
    Boolean(process.env.OPENAI_API_KEY?.trim() || envFileValue('OPENAI_API_KEY')) || fs.existsSync(codexAuthPath())
  );
}

function codexAuthPath(): string {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'auth.json');
}

function envFileValue(key: string): string | null {
  const envFile = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envFile)) return null;
  const content = fs.readFileSync(envFile, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    if (trimmed.slice(0, eq) === key) return trimmed.slice(eq + 1).trim() || null;
  }
  return null;
}

function buildPrompt(ctx: AssistContext, projectRoot: string): string {
  const stepRefs = STEP_FILES[ctx.stepName] ?? [];
  const references = [
    ...BIG_PICTURE_FILES,
    ...stepRefs,
    'logs/setup.log',
    ctx.rawLogPath ? path.relative(projectRoot, ctx.rawLogPath) : 'logs/setup-steps/',
  ].filter((v, i, a) => a.indexOf(v) === i);

  const hintLine = ctx.hint ? `Hint shown to the user: ${ctx.hint}\n` : '';

  return [
    "I'm trying to set up this Codex-first NanoClaw fork and ran into an issue.",
    'Please inspect the referenced files and logs, then suggest a single bash command I can run to fix it.',
    '',
    `Failed step: ${ctx.stepName}`,
    `Error shown to the user: ${ctx.msg}`,
    hintLine,
    'References:',
    ...references.map((r) => `  - ${r}`),
    '',
    'Respond in EXACTLY this format, nothing before or after:',
    '',
    'REASON: <one short line describing the root cause>',
    'COMMAND: <single bash command, one line, no backticks>',
    '',
    'If no safe single command can fix it, respond with:',
    'REASON: <why>',
    'COMMAND: none',
  ].join('\n');
}

function queryCodexUnderSpinner(prompt: string, projectRoot: string): Promise<string | null> {
  const s = p.spinner();
  const start = Date.now();
  const label = 'Asking Codex to diagnose…';
  s.start(fitToWidth(label, ' (99m 59s)'));
  const tick = setInterval(() => {
    const suffix = ` (${fmtDuration(Date.now() - start)})`;
    s.message(`${fitToWidth(label, suffix)}${k.dim(suffix)}`);
  }, 1000);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearInterval(tick);
      const suffix = ` (${fmtDuration(Date.now() - start)})`;
      if (value) {
        s.stop(`${brandBody(fitToWidth('Codex replied.', suffix))}${k.dim(suffix)}`);
      } else {
        s.stop(`${fitToWidth("Codex couldn't help here.", suffix)}${k.dim(suffix)}`, 1);
        const tail = stderr.trim().split('\n').slice(-3).join('\n');
        if (tail) p.log.message(k.dim(tail));
      }
      resolve(value);
    };

    const child = spawn(
      'codex',
      ['exec', '--sandbox', 'read-only', '--ask-for-approval', 'never', '--color', 'never', '-C', projectRoot, '-'],
      {
        cwd: projectRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf-8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf-8');
    });
    child.on('close', (code) => finish(code === 0 && stdout.trim() ? stdout : null));
    child.on('error', () => finish(null));
    child.stdin.end(prompt);
  });
}

function parseResponse(raw: string): { reason: string; command: string } | null {
  const reasonMatch = raw.match(/^\s*REASON:\s*(.+?)\s*$/m);
  const commandMatch = raw.match(/^\s*COMMAND:\s*(.+?)\s*$/m);
  if (!reasonMatch || !commandMatch) return null;
  const command = commandMatch[1].trim();
  if (!command || command.toLowerCase() === 'none') return null;
  return { reason: reasonMatch[1].trim(), command };
}

function runSuggested(command: string, projectRoot: string): Promise<void> {
  const script = path.join(projectRoot, 'setup/run-suggested.sh');
  if (!fs.existsSync(script)) {
    p.log.error(`Missing helper: ${script}`);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const child = spawn('bash', [script, command], { cwd: projectRoot, stdio: 'inherit' });
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}
