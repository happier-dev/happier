import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { claudeDirectSessionProviderOps } from '@/backends/claude/directSessions/providerOps';
import type { DirectSessionProviderOps } from '@/backends/directSessions/providerOps';

import { observeCheckout } from '../commits/observeCheckout';
import { openCodeIntelligenceStore, type CodeIntelligenceStore } from '../store/codeIntelligenceStore';
import { deriveObservedSessionStatus, sweepExternalSessions } from './sweepExternalSessions';

const execFile = promisify(execFileCallback);
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const SESSION_ID = '0f3c6f2e-6a59-4d1e-9b7a-1d2c3e4f5a6b';

async function setup(): Promise<Readonly<{ repo: string; sessionFile: string; configDir: string; store: CodeIntelligenceStore }>> {
  const root = await mkdtemp(join(tmpdir(), 'ci-sessions-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'shop');
  await execFile('git', ['init', '-b', 'main', repo]);
  await execFile('git', ['-C', repo, '-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'commit', '--allow-empty', '-m', 'initial']);

  // A Claude Code session started outside Happier, in Claude's own on-disk store.
  const configDir = join(root, 'claude-config');
  const projectDir = join(configDir, 'projects', '-tmp-shop');
  await mkdir(projectDir, { recursive: true });
  const sessionFile = join(projectDir, `${SESSION_ID}.jsonl`);
  await writeFile(sessionFile, `${JSON.stringify({
    type: 'user',
    sessionId: SESSION_ID,
    cwd: repo,
    message: { role: 'user', content: 'Fix the cart totals' },
    timestamp: new Date().toISOString(),
  })}\n`);

  const store = openCodeIntelligenceStore({ dbPath: join(root, 'ci.sqlite') });
  cleanups.push(() => store.close());
  return { repo, sessionFile, configDir, store };
}

function sweep(store: CodeIntelligenceStore, configDir: string, processes: Array<{ name: string; cmd?: string }>) {
  return sweepExternalSessions({
    store,
    providers: [{ providerId: 'claude', source: { kind: 'claudeConfig', configDir }, ops: claudeDirectSessionProviderOps }],
    processes,
    nowMs: Date.now(),
    workingDirectoryCache: new Map(),
    observeWorkingDirectory: async (cwd) => (await observeCheckout({
      store,
      cwd,
      registrationSource: 'session',
      excludedPathPrefixes: [],
      resolvePlausibleSessionIds: () => [],
      nowMs: Date.now,
    }))?.checkout ?? null,
  });
}

describe('sweepExternalSessions', () => {
  it('discovers an externally started session read-only and associates it with its repository', async () => {
    const { configDir, store } = await setup();

    const result = await sweep(store, configDir, [{ name: 'claude' }]);

    expect(result.observedSessionIds).toEqual([`claude:${SESSION_ID}`]);
    const [session] = store.listSessions();
    expect(session).toMatchObject({
      providerId: 'claude',
      providerSessionId: SESSION_ID,
      status: 'running',
      providerProcessObserved: true,
      source: 'external',
    });
    const [repository] = store.listRepositories();
    expect(session?.repositoryId).toBe(repository?.repositoryId);
    expect(session?.worktreePath).toBe(repository?.worktrees[0]?.worktreePath);
    expect(store.listEventsAfter({ afterSeq: 0, limit: 10 }).events.map((event) => event.kind)).toEqual([
      'repository_registered',
      'worktree_observed',
      'session_observed',
    ]);
  });

  it('does not treat an old session file as active, even with a provider process running', async () => {
    const { configDir, sessionFile, store } = await setup();
    await sweep(store, configDir, [{ name: 'claude' }]);

    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(sessionFile, anHourAgo, anHourAgo);
    await sweep(store, configDir, [{ name: 'claude' }]);

    expect(store.listSessions()[0]?.status).toBe('idle');
    const transitions = store.listEventsAfter({ afterSeq: 0, limit: 10 }).events.filter((event) => event.kind === 'session_status_changed');
    expect(transitions.map((event) => [event.data.from, event.data.status])).toEqual([['running', 'idle']]);
  });
});

describe('process evidence across several sessions', () => {
  it('does not mark every recently written session running when fewer agent processes are alive', async () => {
    const { configDir, sessionFile, store } = await setup();
    const second = sessionFile.replace(SESSION_ID, '1a2b3c4d-0000-4000-8000-000000000002');
    await writeFile(second, `${JSON.stringify({ type: 'user', cwd: process.cwd(), message: { role: 'user', content: 'Other task' } })}\n`);

    await sweep(store, configDir, [{ name: 'claude' }]);

    expect(store.listSessions().map((session) => session.status)).toEqual(['active_recently', 'active_recently']);
  });
});

describe('process evidence and archived sessions', () => {
  it('does not let an archived session withhold process evidence from the live one', async () => {
    const { store, repo } = await setup();
    const now = Date.now();
    // Stands in for an agent's own session store, which may list a just-archived session.
    const ops: DirectSessionProviderOps = {
      listCandidates: async () => ({
        nextCursor: null,
        candidates: [
          { remoteSessionId: 'live', updatedAtMs: now, activity: 'active_recently' },
          { remoteSessionId: 'archived', updatedAtMs: now, activity: 'active_recently', archived: true },
        ],
      }),
      getWorkingDirectory: async () => repo,
      matchesProviderProcess: (process) => process.name === 'agent',
    };

    await sweepExternalSessions({
      store,
      providers: [{ providerId: 'claude', source: { kind: 'claudeConfig', configDir: repo }, ops }],
      processes: [{ name: 'agent' }],
      nowMs: now,
      workingDirectoryCache: new Map(),
      observeWorkingDirectory: async () => null,
    });

    expect(store.listSessions().map((session) => [session.providerSessionId, session.status])).toEqual([['live', 'running']]);
  });
});

describe('provider listing failures', () => {
  it('leaves a provider\'s sessions untouched when its listing fails instead of settling them', async () => {
    const { configDir, store } = await setup();
    await sweep(store, configDir, [{ name: 'claude' }]);
    const before = store.listSessions()[0];

    await sweepExternalSessions({
      store,
      providers: [{
        providerId: 'claude',
        source: { kind: 'claudeConfig', configDir },
        ops: { listCandidates: async () => { throw new Error('EACCES'); } },
      }],
      processes: [],
      nowMs: Date.now() + 60 * 60 * 1000,
      workingDirectoryCache: new Map(),
      observeWorkingDirectory: async () => null,
    });

    expect(store.listSessions()[0]?.status).toBe(before?.status);
  });

  it('retries a working directory the provider could not resolve yet', async () => {
    const { configDir, store } = await setup();
    const cache = new Map<string, string | null>();
    let lookups = 0;
    const ops = {
      ...claudeDirectSessionProviderOps,
      getWorkingDirectory: async () => {
        lookups += 1;
        return lookups === 1 ? null : '/somewhere';
      },
    };
    for (let index = 0; index < 2; index += 1) {
      await sweepExternalSessions({
        store,
        providers: [{ providerId: 'claude', source: { kind: 'claudeConfig', configDir }, ops }],
        processes: [],
        nowMs: Date.now(),
        workingDirectoryCache: cache,
        observeWorkingDirectory: async () => null,
      });
    }

    expect(lookups).toBe(2);
    expect(store.listSessions()[0]?.workingDirectory).toBe('/somewhere');
  });
});

describe('deriveObservedSessionStatus', () => {
  it('lets process evidence strengthen recent activity but never wake an idle session', () => {
    expect(deriveObservedSessionStatus({ activity: 'active_recently', providerProcessObserved: true }).status).toBe('running');
    expect(deriveObservedSessionStatus({ activity: 'active_recently', providerProcessObserved: false }).status).toBe('active_recently');
    expect(deriveObservedSessionStatus({ activity: 'idle', providerProcessObserved: true }).status).toBe('idle');
  });
});
