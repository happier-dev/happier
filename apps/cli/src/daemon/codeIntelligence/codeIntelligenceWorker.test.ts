import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizeCodeIntelligenceSettings, type CodeIntelligenceSettingsV1 } from '@happier-dev/protocol';

import { startCodeIntelligenceWorker, type CodeIntelligenceWorkerDeps, type CodeIntelligenceWorkerHandle } from './codeIntelligenceWorker';

const execFile = promisify(execFileCallback);
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFile('git', ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', ...args], { cwd });
}

async function setupRepo(): Promise<Readonly<{ root: string; repo: string }>> {
  const root = await mkdtemp(join(tmpdir(), 'ci-worker-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'shop');
  await execFile('git', ['init', '-b', 'main', repo]);
  await writeFile(join(repo, 'cart.py'), 'def total(items):\n    return len(items)\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'initial']);
  return { root, repo };
}

function buildDeps(root: string, initial: Partial<CodeIntelligenceSettingsV1>, watched: Map<string, () => void>): CodeIntelligenceWorkerDeps {
  let persisted = normalizeCodeIntelligenceSettings(initial);
  return {
    dbPath: join(root, 'state', 'ci.sqlite'),
    readSettings: async () => persisted,
    writeSettings: async (raw) => (persisted = normalizeCodeIntelligenceSettings(raw)),
    resolveApiKey: async () => null,
    resolveSessionProviders: async () => [],
    listProcesses: async () => [],
    watchDirectory: (path, onChange) => {
      watched.set(path, onChange);
      return () => watched.delete(path);
    },
    fetchImpl: (async () => { throw new Error('no network in tests'); }) as typeof fetch,
    nowMs: Date.now,
    sweepIntervalMs: 60 * 60 * 1000,
  };
}

async function start(deps: CodeIntelligenceWorkerDeps): Promise<CodeIntelligenceWorkerHandle> {
  const worker = await startCodeIntelligenceWorker(deps);
  cleanups.push(() => worker.stop());
  return worker;
}

describe('code intelligence worker', () => {
  it('does nothing and reports disabled until the user opts in', async () => {
    const { root, repo } = await setupRepo();
    const worker = await start(buildDeps(root, {}, new Map()));

    expect(worker.getSnapshot({})).toMatchObject({ ok: false, errorCode: 'code_intelligence_disabled' });
    expect(await worker.registerRepository(repo)).toMatchObject({ ok: false, errorCode: 'code_intelligence_disabled' });
  });

  it('detects a commit from a git-dir change and preserves it for a client that reconnects after a restart', async () => {
    const { root, repo } = await setupRepo();
    const watched = new Map<string, () => void>();
    const deps = buildDeps(root, { enabled: true }, watched);
    const worker = await start(deps);

    const registered = await worker.registerRepository(repo);
    expect(registered).toMatchObject({ ok: true, repository: { displayName: 'shop' } });
    const [watchedDir] = [...watched.keys()];
    expect(watchedDir).toContain(join('.git', 'logs'));

    const before = worker.getSnapshot({});
    const cursor = before.ok ? before.latestSeq : 0;

    await writeFile(join(repo, 'cart.py'), 'def total(items):\n    return sum(items)\n');
    await git(repo, ['commit', '-am', 'fix: sum totals']);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    watched.get(watchedDir!)!();
    await vi.advanceTimersByTimeAsync(1_000);
    vi.useRealTimers();
    // Only the watcher-triggered reconcile runs here; the periodic sweep is an hour away.
    await vi.waitFor(() => {
      const snapshot = worker.getSnapshot({ afterSeq: cursor });
      expect(snapshot.ok && snapshot.events.map((event) => event.kind)).toContain('analysis_skipped');
    }, { timeout: 10_000 });

    const incremental = worker.getSnapshot({ afterSeq: cursor });
    expect(incremental.ok && incremental.events.map((event) => event.kind)).toEqual(['commit_observed', 'analysis_skipped']);
    expect(incremental.ok && incremental.commits[0]).toMatchObject({
      subject: 'fix: sum totals',
      changedSymbols: [expect.objectContaining({ name: 'total', changeKind: 'modified' })],
      analysis: { status: 'skipped', reason: 'remote_analysis_disabled' },
    });

    await worker.stop();
    const restarted = await start(deps);
    const recovered = restarted.getSnapshot({ afterSeq: cursor });
    expect(recovered.ok && recovered.commits.map((commit) => commit.subject)).toEqual(['fix: sum totals']);
    expect(recovered.ok && recovered.events.map((event) => event.kind)).toEqual(['commit_observed', 'analysis_skipped']);
  });

  it('resumes an analysis that a previous daemon stopped in the middle of', async () => {
    const { root, repo } = await setupRepo();
    const deps = buildDeps(root, { enabled: true }, new Map());
    const first = await start(deps);
    await first.registerRepository(repo);
    await writeFile(join(repo, 'cart.py'), 'def total(items):\n    return 0\n');
    await git(repo, ['commit', '-am', 'wip']);
    await first.runOnce();
    await first.stop();

    const { openCodeIntelligenceStore } = await import('./store/codeIntelligenceStore');
    const store = openCodeIntelligenceStore({ dbPath: deps.dbPath });
    const [commit] = store.listRecentCommits({ limit: 1 });
    store.updateCommitAnalysis({ repositoryId: commit!.repositoryId, sha: commit!.sha, analysis: { ...commit!.analysis, status: 'analyzing' } });
    store.close();

    const restarted = await start(deps);
    await restarted.runOnce();
    const snapshot = restarted.getSnapshot({});
    expect(snapshot.ok && snapshot.commits[0]?.analysis.status).toBe('skipped');
  });

  it('pages events without skipping any and starts a fresh client at the newest events', async () => {
    const { root } = await setupRepo();
    const deps = buildDeps(root, { enabled: true }, new Map());
    const { openCodeIntelligenceStore } = await import('./store/codeIntelligenceStore');
    const seeded = openCodeIntelligenceStore({ dbPath: deps.dbPath });
    for (let index = 0; index < 250; index += 1) {
      seeded.appendEvent({ kind: 'session_observed', atMs: Date.now(), repositoryId: null, worktreePath: null, sessionId: `s${index}`, commitSha: null, data: {} });
    }
    seeded.close();
    const worker = await start(deps);

    const initial = worker.getSnapshot({ eventLimit: 200 });
    expect(initial.ok && [initial.events[0]?.seq, initial.events.at(-1)?.seq, initial.latestSeq]).toEqual([51, 250, 250]);

    const firstPage = worker.getSnapshot({ afterSeq: 0, eventLimit: 200 });
    expect(firstPage.ok && [firstPage.events.length, firstPage.latestSeq]).toEqual([200, 200]);
    const secondPage = worker.getSnapshot({ afterSeq: firstPage.ok ? firstPage.latestSeq : 0, eventLimit: 200 });
    expect(secondPage.ok && [secondPage.events[0]?.seq, secondPage.events.at(-1)?.seq, secondPage.latestSeq]).toEqual([201, 250, 250]);
  });

  it('never registers a checkout the machine filesystem policy refuses', async () => {
    const { root, repo } = await setupRepo();
    const worker = await start({ ...buildDeps(root, { enabled: true }, new Map()), isPathAllowed: () => false });

    expect(await worker.registerRepository(repo)).toMatchObject({ ok: false });
    const snapshot = worker.getSnapshot({});
    expect(snapshot.ok && snapshot.repositories).toEqual([]);
  });

  it('rejects an invalid settings payload instead of resetting everything to defaults', async () => {
    const { root } = await setupRepo();
    const worker = await start(buildDeps(root, { enabled: true, retentionDays: 7 }, new Map()));

    await expect(worker.setSettings(null)).rejects.toThrow();
    await expect(worker.setSettings({ enabled: 'yes' })).rejects.toThrow();
    expect(worker.getSettings()).toMatchObject({ enabled: true, retentionDays: 7 });
  });

  it('shares one review between repeated requests for the same commit', async () => {
    const { root, repo } = await setupRepo();
    let providerCalls = 0;
    const worker = await start({
      ...buildDeps(root, { enabled: true }, new Map()),
      resolveApiKey: async () => 'gsk_test',
      fetchImpl: (async () => {
        providerCalls += 1;
        return new Response('busy', { status: 503 });
      }) as typeof fetch,
    });
    const registered = await worker.registerRepository(repo);
    const repositoryId = registered.ok ? registered.repository.repositoryId : '';
    await writeFile(join(repo, 'cart.py'), 'def total(items):\n    return 0\n');
    await git(repo, ['commit', '-am', 'wip']);
    await worker.runOnce();
    await worker.setSettings({
      enabled: true,
      remoteAnalysis: {
        enabled: true,
        allowedRepositoryIds: [repositoryId],
        providers: [{ id: 'groq', kind: 'groq', modelId: 'm', billing: 'free', apiKey: { _isSecretValue: true, value: 'gsk_test' } }],
      },
    });
    const snapshot = worker.getSnapshot({});
    const sha = snapshot.ok ? snapshot.commits[0]!.sha : '';

    const first = worker.requestCommitAnalysis({ repositoryId, sha });
    const second = worker.requestCommitAnalysis({ repositoryId, sha });

    expect(second).toBe(first);
    expect(await first).toMatchObject({ ok: true });
    expect(providerCalls).toBe(1);
  });

  it('closes a manual review that throws as failed instead of leaving it analyzing', async () => {
    const { root, repo } = await setupRepo();
    const deps: CodeIntelligenceWorkerDeps = {
      ...buildDeps(root, { enabled: true }, new Map()),
      resolveApiKey: async () => 'gsk_test',
      // A fetch boundary that breaks its contract (resolves to no Response) makes analysis throw.
      fetchImpl: (async () => null) as unknown as typeof fetch,
    };
    const worker = await start(deps);
    const registered = await worker.registerRepository(repo);
    const repositoryId = registered.ok ? registered.repository.repositoryId : '';
    await writeFile(join(repo, 'cart.py'), 'def total(items):\n    return 0\n');
    await git(repo, ['commit', '-am', 'wip']);
    await worker.runOnce();
    await worker.setSettings({
      enabled: true,
      remoteAnalysis: {
        enabled: true,
        allowedRepositoryIds: [repositoryId],
        providers: [{ id: 'groq', kind: 'groq', modelId: 'm', billing: 'free', apiKey: { _isSecretValue: true, value: 'gsk_test' } }],
      },
    });
    const snapshot = worker.getSnapshot({});
    const commit = snapshot.ok ? snapshot.commits[0]! : null;

    const result = await worker.requestCommitAnalysis({ repositoryId, sha: commit!.sha });

    expect(result).toMatchObject({ ok: true, commit: { analysis: { status: 'failed', reason: 'internal_error' } } });
    const feed = worker.getSnapshot({});
    expect(feed.ok && feed.events.at(-1)).toMatchObject({ kind: 'analysis_failed', commitSha: commit!.sha, data: { reason: 'internal_error' } });
  });

  it('never hands API keys back to clients', async () => {
    const { root } = await setupRepo();
    const worker = await start(buildDeps(root, { enabled: true }, new Map()));

    const saved = await worker.setSettings({
      enabled: true,
      remoteAnalysis: { providers: [{ id: 'groq', kind: 'groq', modelId: 'm', billing: 'free', apiKey: { _isSecretValue: true, value: 'gsk_secret_value_123' } }] },
    });

    expect(JSON.stringify(saved)).not.toContain('gsk_secret_value_123');
    expect(JSON.stringify(worker.getSettings())).not.toContain('gsk_secret_value_123');
  });
});
