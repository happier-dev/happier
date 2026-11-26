import { readRepositoryFileSystem } from './repositoryFileSystem.js';
import { join } from 'node:path';
import type { ScmWorktree, ScmWorktreeEnrichmentEntry } from '@happier-dev/plugin-sdk/scm';
import { runScmCommand } from './runtime.js';
import { inspectGitCheckoutIdentity } from './checkoutIdentity.js';
import { parseGitStatusPorcelainShortZ } from './statusParser.js';
import { resolveGitDefaultRef } from './statusSnapshot.js';
import { buildScmNonInteractiveEnv } from './providers/shared/nonInteractiveEnv.js';

export const DEFAULT_WORKTREE_STATUS_CONCURRENCY = 8;
export const DEFAULT_WORKTREE_STATUS_PER_CALL_TIMEOUT_MS = 1500;
type EnrichmentOptions = Readonly<{
    concurrency?: number;
    perCallTimeoutMs?: number;
    onPerWorktreeStart?: (path: string) => void;
    onPerWorktreeFinish?: (path: string) => void;
}>;
export type EnrichGitWorktreesWithStatusInput = EnrichmentOptions & Readonly<{
    worktrees: ReadonlyArray<ScmWorktree>; includeWorktreeStatus: boolean | undefined;
}>;
export async function enrichGitWorktreesWithStatus(input: EnrichGitWorktreesWithStatusInput): Promise<ScmWorktree[]> {
    if (input.includeWorktreeStatus !== true || !input.worktrees.length) return [...input.worktrees];
    const entries = await readWorktreeStatusEnrichmentForPaths({ ...input, worktreePaths: input.worktrees.map(w => w.path) });
    const byPath = new Map(entries.map(e => [e.path, e]));
    return input.worktrees.map(w => {
        const facts = byPath.get(w.path);
        return { ...w, ...(facts?.changeCount !== undefined ? { changeCount: facts.changeCount } : {}),
            ...(facts?.lastActivityAt !== undefined ? { lastActivityAt: facts.lastActivityAt } : {}) };
    });
}
export type ReadWorktreeStatusEnrichmentForPathsInput = EnrichmentOptions & Readonly<{ worktreePaths: ReadonlyArray<string> }>;
export async function readWorktreeStatusEnrichmentForPaths(input: ReadWorktreeStatusEnrichmentForPathsInput): Promise<ScmWorktreeEnrichmentEntry[]> {
    const result: ScmWorktreeEnrichmentEntry[] = new Array(input.worktreePaths.length);
    let next = 0;
    const timeoutMs = Math.max(1, Math.floor(input.perCallTimeoutMs ?? DEFAULT_WORKTREE_STATUS_PER_CALL_TIMEOUT_MS));
    const count = Math.min(input.worktreePaths.length, Math.max(1, Math.floor(input.concurrency ?? DEFAULT_WORKTREE_STATUS_CONCURRENCY)));
    await Promise.all(Array.from({ length: count }, async () => {
        while (next < input.worktreePaths.length) {
            const index = next++;
            const path = input.worktreePaths[index]!;
            input.onPerWorktreeStart?.(path);
            try { result[index] = await readFacts(path, timeoutMs); }
            finally { input.onPerWorktreeFinish?.(path); }
        }
    }));
    return result;
}
async function readFacts(path: string, timeoutMs: number): Promise<ScmWorktreeEnrichmentEntry> {
    const facts: ScmWorktreeEnrichmentEntry = { path };
    const command = (args: string[]) => runScmCommand({ bin: 'git', cwd: path, args, timeoutMs, env: buildScmNonInteractiveEnv() });
    const [status, identity, submodules] = await Promise.all([
        command(['status', '--porcelain', '-z']), inspectGitCheckoutIdentity({ cwd: path }), command(['ls-files', '--stage', '-z']),
    ]);
    if (status.success) facts.changeCount = parseGitStatusPorcelainShortZ(status.stdout).length;
    if (submodules.success) facts.hasSubmodules = submodules.stdout.split('\0').some(e => e.startsWith('160000 '));
    if (!identity) return facts;
    if (identity.headRevision) facts.headOid = identity.headRevision;
    const files = readRepositoryFileSystem();
    const addressedGitDirPath = files.commandPaths?.fromCommandPath(identity.gitDirPath) ?? identity.gitDirPath;
    const [lockState, times, reflog, upstream, remoteHeads] = await Promise.all([
        files.readFile(join(addressedGitDirPath, 'locked')).then(
            (raw) => ({ isLocked: true as const, lockReason: Buffer.from(raw).toString('utf8').trim() }),
            (error: unknown) => (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
                ? { isLocked: false as const }
                : null),
        ),
        Promise.all(['HEAD', 'COMMIT_EDITMSG', 'ORIG_HEAD'].map(async name => {
            try {
                const info = await files.stat(join(addressedGitDirPath, name));
                return typeof info.mtimeMs === 'number' ? Math.floor(info.mtimeMs) : undefined;
            } catch { return undefined; }
        })), command(['reflog', '-1', '--date=unix', '--format=%gD']),
        identity.branchName ? command(['for-each-ref', '--format=%(upstream:short)%00%(upstream:track)', `refs/heads/${identity.branchName}`]) : Promise.resolve(null),
        command(['for-each-ref', '--format=%(refname:short)%09%(symref:short)', 'refs/remotes/*/HEAD']),
    ]);
    if (lockState) {
        facts.isLocked = lockState.isLocked;
        if (lockState.isLocked) facts.lockReason = lockState.lockReason;
    }
    if (reflog.success) {
        const value = /@\{(\d+)\}/u.exec(reflog.stdout);
        if (value) times.push(Number(value[1]) * 1000);
    }
    const knownTimes = times.filter((value): value is number => value !== undefined && Number.isFinite(value));
    if (knownTimes.length) facts.lastActivityAt = Math.max(...knownTimes);
    if (upstream?.success || identity.branchName === null) {
        const [ref, track] = upstream?.stdout.trim().split('\0') ?? ['', ''];
        facts.upstream = ref || null;
        facts.upstreamGone = track?.includes('[gone]') ?? false;
        const ahead = await command(facts.upstream && !facts.upstreamGone
            ? ['rev-list', '--count', '@{upstream}..HEAD'] : ['rev-list', '--count', 'HEAD', '--not', '--remotes']);
        if (ahead.success && /^\d+$/u.test(ahead.stdout.trim())) facts.ahead = Number(ahead.stdout.trim());
    }
    const defaultInput = { remoteHeadRefsOutput: remoteHeads.stdout, remotes: [], upstreamRef: facts.upstream };
    let defaultRef = remoteHeads.success ? resolveGitDefaultRef(defaultInput) : null;
    if (remoteHeads.success && !defaultRef) {
        // A repository-local choice is evidence; ambient init defaults or the main
        // checkout's current branch do not establish this repository's default.
        const configured = await command(['config', '--local', '--get', 'init.defaultBranch']);
        const branch = configured.success ? configured.stdout.trim() : '';
        if (branch) {
            const localDefaultRef = `refs/heads/${branch}`;
            const verified = await command(['show-ref', '--verify', '--quiet', localDefaultRef]);
            if (verified.success) defaultRef = resolveGitDefaultRef({ ...defaultInput, localDefaultRef });
        }
    }
    if (defaultRef) {
        const merged = await command(['merge-base', '--is-ancestor', 'HEAD', defaultRef]);
        if (!merged.timedOut && !merged.outputLimitExceeded && (merged.exitCode === 0 || merged.exitCode === 1)) facts.mergedIntoDefault = merged.exitCode === 0;
    }
    return facts;
}
