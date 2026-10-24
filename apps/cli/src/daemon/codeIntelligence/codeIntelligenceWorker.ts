import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  CodeIntelligenceSettingsV1Schema,
  redactCodeIntelligenceSettingsSecrets,
  type CodeIntelligenceAnalysisProviderV1,
  type CodeIntelligenceCommitAnalyzeResponseV1,
  type CodeIntelligenceCommitV1,
  type CodeIntelligenceRepositoryRegisterResponseV1,
  type CodeIntelligenceSettingsV1,
  type CodeIntelligenceSnapshotRequestV1,
  type CodeIntelligenceSnapshotResponseV1,
  type CodeIntelligenceWorkerStatusV1,
} from '@happier-dev/protocol';

import type { ObservedProcess } from '@/backends/directSessions/processMatch';
import { startSingleFlightIntervalLoop, type SingleFlightIntervalLoopHandle } from '@/daemon/lifecycle/singleFlightIntervalLoop';
import { logger } from '@/ui/logger';

import { analyzeCommit, persistCommitAnalysis } from './analysis/analyzeCommit';
import { observeCheckout } from './commits/observeCheckout';
import type { ObservedCheckout } from './git/observedGit';
import { sweepExternalSessions, type ObservedSessionProvider } from './sessions/sweepExternalSessions';
import { openCodeIntelligenceStore, type CodeIntelligenceStore } from './store/codeIntelligenceStore';

/**
 * Observation cadence. Provider session stores expose no change notification through the
 * direct-sessions owner, so sessions are swept; checkouts are also re-read on this cadence as the
 * backstop for git-dir watch events the platform drops. Each sweep reads a bounded number of
 * provider entries and runs a handful of read-only git commands per known worktree.
 */
const SWEEP_INTERVAL_MS = 30_000;
/** Coalesces the burst of reflog writes one git operation produces into one reconcile. */
const WATCH_DEBOUNCE_MS = 750;
/** Analyses per tick; one request at a time keeps provider concurrency at one per machine. */
const MAX_ANALYSES_PER_TICK = 5;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_SNAPSHOT_EVENTS = 200;
/**
 * Daemon shutdown must not be held by a remote model request. Stopping waits this long for the
 * current unit of work, then closes the store; an interrupted analysis stays `analyzing`/`queued`
 * and is retried or re-requested on the next start.
 */
const STOP_GRACE_MS = 2_000;
const DEFAULT_SNAPSHOT_COMMITS = 50;

export type CodeIntelligenceWorkerDeps = Readonly<{
  dbPath: string;
  readSettings: () => Promise<CodeIntelligenceSettingsV1>;
  writeSettings: (raw: unknown) => Promise<CodeIntelligenceSettingsV1>;
  resolveApiKey: (provider: CodeIntelligenceAnalysisProviderV1) => Promise<string | null>;
  resolveSessionProviders: () => Promise<ObservedSessionProvider[]>;
  listProcesses: () => Promise<ObservedProcess[]>;
  /** The machine's filesystem access policy, asked before git runs anywhere and for every resolved checkout. */
  isPathAllowed?: (path: string) => boolean;
  /** Watches one directory (non-recursively); returns a closer, or null when watching failed. */
  watchDirectory: (path: string, onChange: () => void) => (() => void) | null;
  fetchImpl: typeof fetch;
  nowMs: () => number;
  sweepIntervalMs?: number;
}>;

export type CodeIntelligenceWorkerHandle = Readonly<{
  getStatus: () => CodeIntelligenceWorkerStatusV1;
  getSnapshot: (request: CodeIntelligenceSnapshotRequestV1) => CodeIntelligenceSnapshotResponseV1;
  registerRepository: (path: string) => Promise<CodeIntelligenceRepositoryRegisterResponseV1>;
  requestCommitAnalysis: (input: Readonly<{ repositoryId: string; sha: string }>) => Promise<CodeIntelligenceCommitAnalyzeResponseV1>;
  getSettings: () => CodeIntelligenceSettingsV1;
  setSettings: (raw: unknown) => Promise<CodeIntelligenceSettingsV1>;
  /** Runs one full observation pass now; used by tests and explicit refreshes. */
  runOnce: () => Promise<void>;
  stop: () => Promise<void>;
}>;

const DISABLED_RESPONSE = { ok: false, errorCode: 'code_intelligence_disabled', error: 'Code intelligence is disabled' } as const;

/**
 * The daemon's single owner of code-intelligence lifecycle. It runs only while enabled, owns the
 * store and git-dir watchers, and serializes every store mutation through one work chain so
 * watcher events, sweeps and RPC requests never race on the same worktree.
 */
export async function startCodeIntelligenceWorker(deps: CodeIntelligenceWorkerDeps): Promise<CodeIntelligenceWorkerHandle> {
  let settings = await deps.readSettings();
  let store: CodeIntelligenceStore | null = null;
  let loop: SingleFlightIntervalLoopHandle | null = null;
  let stopped = false;
  let state: CodeIntelligenceWorkerStatusV1['state'] = 'disabled';
  let lastSweepAtMs: number | null = null;
  let lastError: string | null = null;
  let lastPruneAtMs = 0;
  let chain: Promise<unknown> = Promise.resolve();
  const watchers = new Map<string, () => void>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const workingDirectoryCache = new Map<string, string | null>();
  const unavailableUntilMsByProviderId = new Map<string, number>();
  const pendingAnalysisRequests = new Map<string, Promise<CodeIntelligenceCommitAnalyzeResponseV1>>();

  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  };

  const recordError = (context: string, error: unknown) => {
    lastError = `${context}: ${error instanceof Error ? error.message : String(error)}`;
    logger.warn(`[codeIntelligence] ${context}`, error);
  };

  const plausibleSessionIdsFor = (activeStore: CodeIntelligenceStore) => (worktreePath: string) =>
    activeStore.listSessions()
      .filter((session) => session.worktreePath === worktreePath && (session.status === 'running' || session.status === 'active_recently'))
      .map((session) => session.id);

  const ensureWatcher = (checkout: ObservedCheckout) => {
    if (watchers.has(checkout.worktreePath)) return;
    // The worktree's own reflog is appended on every commit, checkout, merge and reset.
    const logsDir = join(checkout.gitDirPath, 'logs');
    const target = existsSync(logsDir) ? logsDir : checkout.gitDirPath;
    const close = deps.watchDirectory(target, () => {
      const pending = debounceTimers.get(checkout.worktreePath);
      if (pending) clearTimeout(pending);
      debounceTimers.set(checkout.worktreePath, setTimeout(() => {
        debounceTimers.delete(checkout.worktreePath);
        void serialize(async () => {
          await observeWorktree(checkout.worktreePath, 'session');
          await drainAnalysisQueue();
        }).catch((error) => recordError('reconcile after git change failed', error));
      }, WATCH_DEBOUNCE_MS));
    });
    if (close) watchers.set(checkout.worktreePath, close);
    else recordError('watch unavailable', new Error(`could not watch ${target}; relying on periodic reconcile`));
  };

  const observeWorktree = async (
    cwd: string,
    source: 'session' | 'manual',
    additionalPlausibleSessionIds: readonly string[] = [],
  ): Promise<ObservedCheckout | null> => {
    if (!store) return null;
    const result = await observeCheckout({
      store,
      cwd,
      registrationSource: source,
      excludedPathPrefixes: settings.excludedPathPrefixes,
      resolvePlausibleSessionIds: plausibleSessionIdsFor(store),
      additionalPlausibleSessionIds,
      isPathAllowed: deps.isPathAllowed,
      nowMs: deps.nowMs,
    });
    if (result) ensureWatcher(result.checkout);
    return result?.checkout ?? null;
  };

  const runAnalysis = async (activeStore: CodeIntelligenceStore, commit: CodeIntelligenceCommitV1) => {
    try {
      await analyzeCommit({
        store: activeStore,
        settings,
        commit,
        unavailableUntilMsByProviderId,
        deps: { fetchImpl: deps.fetchImpl, nowMs: deps.nowMs, resolveApiKey: deps.resolveApiKey },
      });
    } catch (error) {
      // An analysis that throws is closed as failed, never left `analyzing` until the next restart.
      recordError(`analysis of ${commit.sha} failed`, error);
      // Builds on the stored state so attempts counted before the throw are kept.
      const current = activeStore.getCommit({ repositoryId: commit.repositoryId, sha: commit.sha })?.analysis ?? commit.analysis;
      persistCommitAnalysis({
        store: activeStore,
        commit,
        analysis: { ...current, status: 'failed', reason: 'internal_error', updatedAtMs: deps.nowMs() },
        kind: 'analysis_failed',
      });
    }
  };

  const drainAnalysisQueue = async () => {
    if (!store) return;
    const now = deps.nowMs();
    const due = store.listCommitsWithAnalysisStatus({ status: 'queued', limit: 50 })
      .filter((commit) => commit.analysis.retryAfterMs === null || commit.analysis.updatedAtMs + commit.analysis.retryAfterMs <= now)
      .slice(0, MAX_ANALYSES_PER_TICK);
    for (const commit of due) {
      if (!store || stopped) return;
      state = 'analyzing';
      await runAnalysis(store, commit);
    }
  };

  const tick = async () => {
    if (!store) return;
    state = 'observing';
    try {
      const knownWorktrees = new Set(store.listRepositories().flatMap((repository) => repository.worktrees.map((worktree) => worktree.worktreePath)));
      if (settings.externalSessionDiscovery) {
        const sweep = await sweepExternalSessions({
          store,
          providers: await deps.resolveSessionProviders(),
          processes: await deps.listProcesses().catch(() => []),
          nowMs: deps.nowMs(),
          workingDirectoryCache,
          observeWorkingDirectory: async (cwd, sessionActive, sessionId) => {
            // Idle sessions in an already-known checkout reuse the stored association.
            const known = store?.listRepositories().find((repository) => repository.worktrees.some((worktree) => worktree.worktreePath === cwd));
            if (known && !sessionActive) {
              const worktree = known.worktrees.find((candidate) => candidate.worktreePath === cwd)!;
              return {
                repositoryId: known.repositoryId,
                displayName: known.displayName,
                commonDirPath: known.commonDirPath,
                worktreePath: worktree.worktreePath,
                gitDirPath: worktree.gitDirPath,
                isLinkedWorktree: worktree.isLinkedWorktree,
                branch: worktree.branch,
                headCommit: worktree.headCommit,
              };
            }
            knownWorktrees.delete(cwd);
            return await observeWorktree(cwd, 'session', sessionActive ? [sessionId] : []);
          },
        });
        for (const failure of sweep.providerErrors) recordError(`session discovery for ${failure.providerId} failed`, new Error(failure.message));
      }
      for (const worktreePath of knownWorktrees) await observeWorktree(worktreePath, 'session');
      await drainAnalysisQueue();
      const now = deps.nowMs();
      if (now - lastPruneAtMs >= PRUNE_INTERVAL_MS) {
        store.prune({ olderThanMs: now - settings.retentionDays * 24 * 60 * 60 * 1000 });
        lastPruneAtMs = now;
      }
      lastSweepAtMs = now;
    } finally {
      state = store ? 'idle' : 'disabled';
    }
  };

  const activate = () => {
    if (store || stopped) return;
    store = openCodeIntelligenceStore({ dbPath: deps.dbPath });
    // This worker is the store's only writer, so an `analyzing` job here was interrupted by a stop.
    for (const commit of store.listCommitsWithAnalysisStatus({ status: 'analyzing', limit: 1_000 })) {
      store.updateCommitAnalysis({
        repositoryId: commit.repositoryId,
        sha: commit.sha,
        analysis: { ...commit.analysis, status: 'queued', reason: 'interrupted', retryAfterMs: null, updatedAtMs: deps.nowMs() },
      });
    }
    state = 'idle';
    loop = startSingleFlightIntervalLoop({
      intervalMs: deps.sweepIntervalMs ?? SWEEP_INTERVAL_MS,
      task: () => serialize(tick),
      onError: (error) => recordError('observation pass failed', error),
      unref: true,
      failureBackoffMs: SWEEP_INTERVAL_MS,
      maxFailureBackoffMs: 10 * 60 * 1000,
    });
    loop.trigger();
  };

  const deactivate = () => {
    loop?.stop();
    loop = null;
    for (const close of watchers.values()) close();
    watchers.clear();
    for (const timer of debounceTimers.values()) clearTimeout(timer);
    debounceTimers.clear();
    store?.close();
    store = null;
    state = 'disabled';
  };

  const requestCommitAnalysisNow = ({ repositoryId, sha }: Readonly<{ repositoryId: string; sha: string }>): Promise<CodeIntelligenceCommitAnalyzeResponseV1> => serialize(async () => {
    if (!store) return DISABLED_RESPONSE;
    const commit = store.getCommit({ repositoryId, sha });
    if (!commit) return { ok: false, errorCode: 'commit_not_found', error: 'commit is not observed' } as const;
    // Manual reanalysis is an explicit user request: it resets the retry schedule but still goes
    // through the same admission policy as automatic analysis.
    unavailableUntilMsByProviderId.clear();
    await runAnalysis(store, { ...commit, analysis: { ...commit.analysis, attempts: 0, retryAfterMs: null } });
    return { ok: true, commit: store.getCommit({ repositoryId, sha })! };
  });

  if (settings.enabled) activate();

  return {
    getStatus: () => ({ state, lastSweepAtMs, lastError }),
    getSnapshot: (request) => {
      if (!store) return DISABLED_RESPONSE;
      const limit = request.eventLimit ?? DEFAULT_SNAPSHOT_EVENTS;
      // Without a cursor a client starts from the newest events; with one it pages forward, and the
      // returned cursor is the last event it received so no page is ever skipped.
      const page = request.afterSeq === undefined
        ? { ...store.listLatestEvents({ limit }), truncated: false }
        : store.listEventsAfter({ afterSeq: request.afterSeq, limit });
      const cursor = request.afterSeq === undefined || page.events.length === 0
        ? page.latestSeq
        : page.events.at(-1)!.seq;
      return {
        ok: true,
        worker: { state, lastSweepAtMs, lastError },
        repositories: store.listRepositories(),
        sessions: store.listSessions(),
        commits: store.listRecentCommits({ limit: request.commitLimit ?? DEFAULT_SNAPSHOT_COMMITS }),
        events: page.events,
        latestSeq: cursor,
        eventsTruncated: request.afterSeq !== undefined && page.truncated,
      };
    },
    registerRepository: (path) => serialize(async () => {
      if (!store) return DISABLED_RESPONSE;
      const checkout = await observeWorktree(path, 'manual');
      if (!checkout) return { ok: false, errorCode: 'not_a_git_repository', error: `${path} is not inside a git working tree` } as const;
      const repository = store.listRepositories().find((candidate) => candidate.repositoryId === checkout.repositoryId);
      return repository
        ? { ok: true, repository }
        : { ok: false, errorCode: 'internal_error', error: 'repository was not recorded' } as const;
    }),
    requestCommitAnalysis: ({ repositoryId, sha }) => {
      // Repeated requests for the same commit while one is pending share it: one review, one charge.
      const key = `${repositoryId}:${sha}`;
      const pending = pendingAnalysisRequests.get(key);
      if (pending) return pending;
      const request = requestCommitAnalysisNow({ repositoryId, sha })
        .finally(() => pendingAnalysisRequests.delete(key));
      pendingAnalysisRequests.set(key, request);
      return request;
    },
    getSettings: () => redactCodeIntelligenceSettingsSecrets(settings),
    setSettings: (raw) => serialize(async () => {
      // Validate before persisting: an invalid payload is an error, never a reset to defaults.
      CodeIntelligenceSettingsV1Schema.parse(raw);
      settings = await deps.writeSettings(raw);
      if (settings.enabled) activate();
      else deactivate();
      return redactCodeIntelligenceSettingsSecrets(settings);
    }),
    runOnce: () => serialize(tick),
    stop: async () => {
      stopped = true;
      loop?.stop();
      await Promise.race([chain, new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS))]);
      deactivate();
    },
  };
}
