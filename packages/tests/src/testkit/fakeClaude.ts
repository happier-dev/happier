import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

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

export function fakeClaudeFixturePath(): string {
  const path = resolve(repoRootDir(), 'packages/tests/src/fixtures/fake-claude-code-cli.js');
  if (!existsSync(path)) {
    throw new Error(`Missing fake Claude fixture at ${path}`);
  }
  return path;
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
