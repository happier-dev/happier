import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { repoRootDir } from './paths';
import { sleep } from './timing';

export type FakeClaudeInvocation = {
  type: 'invocation';
  invocationId?: string;
  mode: 'sdk' | 'local';
  argv: string[];
  mcpConfigs?: unknown[];
  mergedMcpServers?: Record<string, unknown>;
  [key: string]: unknown;
};

export type FakeClaudeLogEvent = Record<string, unknown>;

export function fakeClaudeFixturePath(): string {
  const path = resolve(repoRootDir(), 'packages/tests/src/fixtures/fake-claude-code-cli.js');
  if (!existsSync(path)) {
    throw new Error(`Missing fake Claude fixture at ${path}`);
  }
  return path;
}

export async function createIsolatedFakeClaudeControlShim(params: Readonly<{
  testDir: string;
  invocationId: string;
  captureEnvironmentKeys: readonly string[];
  logFullStdin: boolean;
}>): Promise<Readonly<{
  executablePath: string;
  logPath: string;
  configDir: string;
}>> {
  const testDir = resolve(params.testDir);
  const executablePath = resolve(join(testDir, 'fake-claude-control.mjs'));
  const logPath = resolve(join(testDir, 'fake-claude.jsonl'));
  const configDir = resolve(join(testDir, 'fake-claude-config'));
  await mkdir(configDir, { recursive: true });

  const controlledEnvironment = {
    HAPPIER_E2E_FAKE_CLAUDE_LOG: logPath,
    HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: params.invocationId,
    HAPPIER_E2E_FAKE_CLAUDE_LOG_FULL_STDIN: params.logFullStdin ? '1' : '0',
    HAPPIER_E2E_FAKE_CLAUDE_CAPTURE_ENV_KEYS: params.captureEnvironmentKeys.join(','),
    CLAUDE_CONFIG_DIR: configDir,
  } satisfies Record<string, string>;
  const source = [
    '// Scenario-owned fake-Claude controls intentionally live inside this test-only child shim.',
    ...Object.entries(controlledEnvironment).map(
      ([key, value]) => `process.env[${JSON.stringify(key)}] = ${JSON.stringify(value)};`,
    ),
    `await import(${JSON.stringify(pathToFileURL(fakeClaudeFixturePath()).href)});`,
    '',
  ].join('\n');
  await writeFile(executablePath, source, { encoding: 'utf8', mode: 0o600 });

  return { executablePath, logPath, configDir };
}

function parseJsonl(raw: string): any[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

async function readJsonlFile(path: string): Promise<any[]> {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, 'utf8').catch(() => '');
  return parseJsonl(raw);
}

function asFakeClaudeLogEvent(value: unknown): FakeClaudeLogEvent | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as FakeClaudeLogEvent
    : null;
}

async function readRequiredFakeClaudeJsonlFile(path: string): Promise<FakeClaudeLogEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Expected readable fake Claude log at ${path}: ${reason}`);
  }
  return parseJsonl(raw).flatMap((event) => {
    const record = asFakeClaudeLogEvent(event);
    return record ? [record] : [];
  });
}

export async function countFakeClaudeEventsAfterCurrentRunSentinel(params: Readonly<{
  logPath: string;
  sinceMs: number;
  predicate: (event: FakeClaudeLogEvent) => boolean;
  sentinelPredicate?: (event: FakeClaudeLogEvent) => boolean;
}>): Promise<number> {
  const events = await readRequiredFakeClaudeJsonlFile(params.logPath);
  const hasCurrentRunSentinel = events.some((event) => {
    if (params.sentinelPredicate) return params.sentinelPredicate(event);
    return event.type === 'invocation'
      && typeof event.ts === 'number'
      && Number.isFinite(event.ts)
      && event.ts <= params.sinceMs;
  });
  if (!hasCurrentRunSentinel) {
    throw new Error(`Expected fake Claude log current-run sentinel in ${params.logPath}`);
  }
  return events.filter((event) => {
    if (typeof event.ts !== 'number' || !Number.isFinite(event.ts) || event.ts < params.sinceMs) return false;
    return params.predicate(event);
  }).length;
}

export async function waitForFakeClaudeInvocation(
  logPath: string,
  predicate: (i: FakeClaudeInvocation) => boolean,
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<FakeClaudeInvocation> {
  const timeoutMs = opts?.timeoutMs ?? 60_000;
  const pollMs = opts?.pollMs ?? 100;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const events = await readJsonlFile(logPath);
    const invocations = events.filter((e): e is FakeClaudeInvocation => e && e.type === 'invocation');
    const found = invocations.find((i) => predicate(i));
    if (found) return found;
    await sleep(pollMs);
  }

  const exists = existsSync(logPath);
  const events = await readJsonlFile(logPath);
  const invocations = events.filter((e): e is FakeClaudeInvocation => e && e.type === 'invocation');
  const matchesNow = invocations.some((i) => {
    try {
      return predicate(i);
    } catch {
      return false;
    }
  });
  const last = invocations.length > 0 ? invocations[invocations.length - 1] : null;
  const lastSummary = last
    ? {
        invocationId: last.invocationId ?? null,
        mode: last.mode,
        argvHead: Array.isArray(last.argv) ? last.argv.slice(0, 8) : null,
        argvHasSettings: Array.isArray(last.argv) ? last.argv.includes('--settings') : null,
      }
    : null;

  throw new Error(
    [
      'Timed out waiting for fake Claude invocation',
      `logPath=${logPath}`,
      `exists=${exists}`,
      `invocations=${invocations.length}`,
      `matchesNow=${matchesNow}`,
      `last=${lastSummary ? JSON.stringify(lastSummary) : 'null'}`,
    ].join(' | '),
  );
}

export async function waitForFakeClaudeUserText(
  logPath: string,
  predicate: (text: string) => boolean,
  opts?: { invocationId?: string; timeoutMs?: number; pollMs?: number },
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? 60_000;
  const pollMs = opts?.pollMs ?? 100;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const events = await readJsonlFile(logPath);
    for (const event of events) {
      if (event?.type !== 'sdk_stdin') continue;
      if (opts?.invocationId !== undefined && event?.invocationId !== opts.invocationId) continue;
      if (event?.hasUserText !== true) continue;
      const userText = typeof event.userText === 'string'
        ? event.userText
        : typeof event.userTextPreview === 'string'
          ? event.userTextPreview
          : null;
      if (userText !== null && predicate(userText)) return userText;
    }
    await sleep(pollMs);
  }

  throw new Error(`Timed out waiting for fake Claude user text in ${logPath}`);
}
