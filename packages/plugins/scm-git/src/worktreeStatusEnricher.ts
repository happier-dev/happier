import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ScmWorktree,
  ScmWorktreeEnrichmentEntry,
} from '@happier-dev/plugin-sdk/experimental/scm';

import { runScmCommand } from './runtime.js';
import { parseGitStatusPorcelainShortZ, type ParsedGitStatusPorcelainShortZEntry } from './statusParser.js';

export const DEFAULT_WORKTREE_STATUS_CONCURRENCY = 8;
export const DEFAULT_WORKTREE_STATUS_PER_CALL_TIMEOUT_MS = 1500;
export const DEFAULT_DIRTY_FILE_STAT_MAX_ENTRIES = 16;
export const DEFAULT_DIRTY_FILE_STAT_CONCURRENCY = 4;
export const DEFAULT_DIRTY_FILE_STAT_BUDGET_MS = 200;

type DirtyFileScanOptions = Readonly<{
    maxEntries: number;
    concurrency: number;
    budgetMs: number;
    onDirtyFileStat?: (relativePath: string) => void;
    onDirtyFileStatStart?: (relativePath: string) => void;
    onDirtyFileStatFinish?: (relativePath: string) => void;
}>;

type EnrichmentOptions = Readonly<{
    concurrency?: number;
    perCallTimeoutMs?: number;
    dirtyFileStatMaxEntries?: number;
    dirtyFileStatConcurrency?: number;
    dirtyFileStatBudgetMs?: number;
    onPerWorktreeStart?: (path: string) => void;
    onPerWorktreeFinish?: (path: string) => void;
    onDirtyFileStat?: (relativePath: string) => void;
    onDirtyFileStatStart?: (relativePath: string) => void;
    onDirtyFileStatFinish?: (relativePath: string) => void;
}>;

export type EnrichGitWorktreesWithStatusInput = EnrichmentOptions & Readonly<{
    worktrees: ReadonlyArray<ScmWorktree>;
    includeWorktreeStatus: boolean | undefined;
}>;

export async function enrichGitWorktreesWithStatus(
    input: EnrichGitWorktreesWithStatusInput,
): Promise<ScmWorktree[]> {
    const worktrees = [...input.worktrees];
    if (input.includeWorktreeStatus !== true || worktrees.length === 0) {
        return worktrees;
    }

    const entries = await readWorktreeStatusEnrichmentForPaths({
        ...input,
        worktreePaths: worktrees.map((worktree) => worktree.path),
    });
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));

    return worktrees.map((worktree) => {
        const metrics = byPath.get(worktree.path);
        if (!metrics) return worktree;
        const next: ScmWorktree = { ...worktree };
        if (metrics.changeCount !== undefined) next.changeCount = metrics.changeCount;
        if (metrics.lastActivityAt !== undefined) next.lastActivityAt = metrics.lastActivityAt;
        return next;
    });
}

export type ReadWorktreeStatusEnrichmentForPathsInput = EnrichmentOptions & Readonly<{
    worktreePaths: ReadonlyArray<string>;
}>;

export async function readWorktreeStatusEnrichmentForPaths(
    input: ReadWorktreeStatusEnrichmentForPathsInput,
): Promise<ScmWorktreeEnrichmentEntry[]> {
    const paths = [...input.worktreePaths];
    const result: ScmWorktreeEnrichmentEntry[] = new Array(paths.length);
    if (paths.length === 0) return result;

    const concurrency = Math.max(1, Math.floor(input.concurrency ?? DEFAULT_WORKTREE_STATUS_CONCURRENCY));
    const timeoutMs = Math.max(1, Math.floor(input.perCallTimeoutMs ?? DEFAULT_WORKTREE_STATUS_PER_CALL_TIMEOUT_MS));
    const dirtyOpts = resolveDirtyFileScanOptions(input);

    let nextIndex = 0;
    const workerCount = Math.min(concurrency, paths.length);
    const workers: Promise<void>[] = [];
    for (let workerId = 0; workerId < workerCount; workerId += 1) {
        workers.push((async () => {
            while (true) {
                const index = nextIndex;
                nextIndex += 1;
                if (index >= paths.length) return;
                const path = paths[index]!;

                input.onPerWorktreeStart?.(path);
                try {
                    const metrics = await readWorktreeEnrichmentMetrics(path, timeoutMs, dirtyOpts);
                    const entry: ScmWorktreeEnrichmentEntry = { path };
                    if (metrics.changeCount !== undefined) entry.changeCount = metrics.changeCount;
                    if (metrics.lastActivityAt !== undefined) entry.lastActivityAt = metrics.lastActivityAt;
                    result[index] = entry;
                } finally {
                    input.onPerWorktreeFinish?.(path);
                }
            }
        })());
    }

    await Promise.all(workers);
    for (let index = 0; index < paths.length; index += 1) {
        if (!result[index]) result[index] = { path: paths[index]! };
    }
    return result;
}

function resolveDirtyFileScanOptions(input: EnrichmentOptions): DirtyFileScanOptions {
    return {
        maxEntries: Math.max(0, Math.floor(input.dirtyFileStatMaxEntries ?? DEFAULT_DIRTY_FILE_STAT_MAX_ENTRIES)),
        concurrency: Math.max(1, Math.floor(input.dirtyFileStatConcurrency ?? DEFAULT_DIRTY_FILE_STAT_CONCURRENCY)),
        budgetMs: Math.max(0, Math.floor(input.dirtyFileStatBudgetMs ?? DEFAULT_DIRTY_FILE_STAT_BUDGET_MS)),
        onDirtyFileStat: input.onDirtyFileStat,
        onDirtyFileStatStart: input.onDirtyFileStatStart,
        onDirtyFileStatFinish: input.onDirtyFileStatFinish,
    };
}

type WorktreeEnrichmentMetrics = Readonly<{
    changeCount: number | undefined;
    lastActivityAt: number | undefined;
}>;

async function readWorktreeEnrichmentMetrics(
    worktreePath: string,
    timeoutMs: number,
    dirtyOpts: DirtyFileScanOptions,
): Promise<WorktreeEnrichmentMetrics> {
    const [headTime, porcelainEntries] = await Promise.all([
        readHeadCommitTimeMs(worktreePath, timeoutMs),
        readWorktreePorcelainEntries(worktreePath, timeoutMs),
    ]);

    const changeCount = porcelainEntries === undefined ? undefined : porcelainEntries.length;
    let lastActivityAt = headTime.kind === 'value' ? headTime.value : undefined;

    if (headTime.kind === 'timeout') {
        return { changeCount, lastActivityAt: undefined };
    }

    if (lastActivityAt === undefined) {
        try {
            const info = await stat(worktreePath);
            const mtimeMs = Math.floor(info.mtimeMs);
            if (Number.isFinite(mtimeMs) && mtimeMs >= 0) lastActivityAt = mtimeMs;
        } catch {
            // Missing or unreadable worktrees simply omit lastActivityAt.
        }
    }

    if (porcelainEntries && dirtyOpts.maxEntries > 0) {
        const trackedDirty = porcelainEntries.filter((entry) => !entry.isUntracked).slice(0, dirtyOpts.maxEntries);
        if (trackedDirty.length > 0) {
            const newestDirtyMtime = await readNewestDirtyFileMtime({
                worktreePath,
                entries: trackedDirty,
                dirtyOpts,
            });
            if (newestDirtyMtime !== undefined) {
                lastActivityAt = lastActivityAt === undefined ? newestDirtyMtime : Math.max(lastActivityAt, newestDirtyMtime);
            }
        }
    }

    return { changeCount, lastActivityAt };
}

async function readNewestDirtyFileMtime(input: Readonly<{
    worktreePath: string;
    entries: readonly ParsedGitStatusPorcelainShortZEntry[];
    dirtyOpts: DirtyFileScanOptions;
}>): Promise<number | undefined> {
    const startedAtMs = Date.now();
    let newest: number | undefined;
    let nextEntryIndex = 0;
    const isBudgetExceeded = (): boolean => {
        if (input.dirtyOpts.budgetMs === 0) return true;
        return (Date.now() - startedAtMs) > input.dirtyOpts.budgetMs;
    };

    const dispatchNext = async (): Promise<void> => {
        while (true) {
            if (isBudgetExceeded()) return;
            const index = nextEntryIndex;
            nextEntryIndex += 1;
            if (index >= input.entries.length) return;
            const entry = input.entries[index]!;
            input.dirtyOpts.onDirtyFileStat?.(entry.path);
            input.dirtyOpts.onDirtyFileStatStart?.(entry.path);
            try {
                const info = await stat(join(input.worktreePath, entry.path));
                const mtimeMs = Math.floor(info.mtimeMs);
                if (Number.isFinite(mtimeMs) && mtimeMs >= 0) {
                    newest = newest === undefined ? mtimeMs : Math.max(newest, mtimeMs);
                }
            } catch {
                // File races are expected while a worktree is active.
            } finally {
                input.dirtyOpts.onDirtyFileStatFinish?.(entry.path);
            }
        }
    };

    const workerCount = Math.min(input.dirtyOpts.concurrency, input.entries.length);
    const workers: Promise<void>[] = [];
    for (let workerId = 0; workerId < workerCount; workerId += 1) {
        workers.push(dispatchNext());
    }
    await Promise.all(workers);
    return newest;
}

type HeadCommitTimeResult =
    | { kind: 'value'; value: number }
    | { kind: 'failed' }
    | { kind: 'timeout' };

async function readHeadCommitTimeMs(worktreePath: string, timeoutMs: number): Promise<HeadCommitTimeResult> {
    try {
        const result = await runScmCommand({
            bin: 'git',
            cwd: worktreePath,
            args: ['log', '-1', '--format=%ct'],
            timeoutMs,
        });
        if (result.timedOut) return { kind: 'timeout' };
        if (!result.success || result.exitCode !== 0) return { kind: 'failed' };
        const seconds = Number.parseInt((result.stdout ?? '').trim(), 10);
        if (!Number.isFinite(seconds) || seconds < 0) return { kind: 'failed' };
        return { kind: 'value', value: seconds * 1000 };
    } catch {
        return { kind: 'failed' };
    }
}

async function readWorktreePorcelainEntries(
    worktreePath: string,
    timeoutMs: number,
): Promise<readonly ParsedGitStatusPorcelainShortZEntry[] | undefined> {
    try {
        const result = await runScmCommand({
            bin: 'git',
            cwd: worktreePath,
            args: ['status', '--porcelain', '-z'],
            timeoutMs,
        });
        if (!result.success || result.exitCode !== 0) return undefined;
        return parseGitStatusPorcelainShortZ(result.stdout ?? '');
    } catch {
        return undefined;
    }
}
