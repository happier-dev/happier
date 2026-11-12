import type { ScmRepoDetection, ScmBackendContext } from '../../types';
import type {
    ScmStatusSnapshotRequest,
    ScmStatusSnapshotResponse,
    ScmWorktreesEnrichmentRequest,
    ScmWorktreesEnrichmentResponse,
} from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { runScmCommand } from '../../runtime';
import { buildGitSnapshot, resolveGitHostingProviderFromOutputs } from './statusSnapshot';
import { resolveGitMainWorktreePath } from './checkoutIdentity';
import { readGitBranchOperationState } from './operations/branchOperationState';
import { defaultPrStatusCache } from '../../hostingProviders/prStatusCache';
import { resolveHostingAuthProfileKey } from './operations/pullRequestOperationHelpers';
import { enrichGitWorktreesWithStatus, readWorktreeStatusEnrichmentForPaths } from './worktreeStatusEnricher';
import { parseGitStatusPorcelainV2Z } from './statusParser';
import { parseGitWorktreeListPorcelain } from './worktreeListParser';
import { realpath } from 'node:fs/promises';
import { readUntrackedFileStats } from '../../readUntrackedFileStats';

export async function detectGitRepo(input: { cwd: string }): Promise<ScmRepoDetection> {
    const gitRepoCheck = await runScmCommand({
        bin: 'git',
        cwd: input.cwd,
        args: ['rev-parse', '--is-inside-work-tree'],
        timeoutMs: 5000,
    });
    if (!gitRepoCheck.success || gitRepoCheck.exitCode !== 0) {
        return {
            isRepo: false,
            rootPath: null,
            mode: null,
        };
    }

    const rootResult = await runScmCommand({
        bin: 'git',
        cwd: input.cwd,
        args: ['rev-parse', '--show-toplevel'],
        timeoutMs: 5000,
    });

    return {
        isRepo: true,
        rootPath: rootResult.success ? rootResult.stdout.trim() : null,
        mode: '.git',
    };
}

export async function getGitSnapshot(input: {
    context: ScmBackendContext;
    request?: Pick<ScmStatusSnapshotRequest, 'includeWorktreeStatus' | 'untrackedFiles'>;
}): Promise<ScmStatusSnapshotResponse> {
    const { context, request } = input;
    const repoRoot = context.detection.rootPath ?? context.cwd;

    // 'all' (default) = today's exact single-command shape: one entry per
    // untracked file. 'normal' is strictly opt-in (request-field presence) and
    // swaps to git's own -unormal collapse, so a pre-flag client can never
    // receive a collapsed directory row. Collapsed entries need one additional
    // bounded enumeration (`ls-files --others`) so totals keep FILE semantics
    // (T2) — see aggregateUntrackedFileCounts.
    const untrackedMode = request?.untrackedFiles === 'normal' ? 'normal' : 'all';
    const statusResult = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['status', '--porcelain=v2', '-z', '--branch', '--show-stash', `--untracked-files=${untrackedMode}`],
        timeoutMs: 10_000,
    });
    if (!statusResult.success) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: statusResult.stderr || 'Failed to read repository status',
        };
    }

    const includedResult = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['diff', '--cached', '--numstat', '-z'],
        timeoutMs: 10_000,
    });
    const pendingResult = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['diff', '--numstat', '-z'],
        timeoutMs: 10_000,
    });
    const worktreesResult = await runScmCommand({
        bin: 'git',
        cwd: repoRoot,
        // FR4-4: `-z` keeps worktree paths whole even when they contain newline
        // characters. Without it, `parseGitWorktreeListPorcelain` would see a
        // truncated path and the security intersection in `getGitWorktreesEnrichment`
        // could admit an unrelated sibling whose absolute path matches the truncation.
        args: ['worktree', 'list', '--porcelain', '-z'],
        timeoutMs: 10_000,
    });
    const remotesResult = await runScmCommand({
        bin: 'git',
        cwd: repoRoot,
        args: ['remote', '-v'],
        timeoutMs: 10_000,
    });
    const remoteHeadRefsResult = await runScmCommand({
        bin: 'git',
        cwd: repoRoot,
        args: ['for-each-ref', '--format=%(refname:short)%09%(symref:short)', 'refs/remotes/*/HEAD'],
        timeoutMs: 10_000,
    });
    const mainWorktreePath = worktreesResult.success ? await resolveGitMainWorktreePath({
        worktreesOutput: worktreesResult.stdout,
        currentWorktreePath: repoRoot,
    }) : null;
    const operationState = await readGitBranchOperationState(context);

    const statusRaw = statusResult.stdout ?? '';
    const untrackedPaths = parseGitStatusPorcelainV2Z(statusRaw).notAdded;
    const untrackedStatsByPath = repoRoot && untrackedPaths.length > 0 ? await readUntrackedFileStats(repoRoot, untrackedPaths) : {};
    // 'normal' only: bounded count enumeration (the same command
    // readOperations.ts uses for untracked diff checks). Failure degrades
    // honestly: directory entries omit untrackedFileCount and totals fall
    // back to entry-derived counts with the existing totals.isComplete flag.
    const untrackedEnumeration = untrackedMode === 'normal'
        ? await readGitUntrackedEnumeration(repoRoot)
        : undefined;
    const remotesOutput = remotesResult.success ? (remotesResult.stdout ?? '') : '';
    const hostingProvider = resolveGitHostingProviderFromOutputs({
        statusOutput: statusRaw,
        remotesOutput,
    });
    const pullRequestAuthProfileKey = await resolveHostingAuthProfileKey({
        context,
        provider: hostingProvider,
    });

    const snapshot = buildGitSnapshot({
        projectKey: context.projectKey,
        fetchedAt: Date.now(),
        rootPath: context.detection.rootPath,
        currentWorktreePath: context.cwd,
        mainWorktreePath,
        statusOutput: statusResult.stdout ?? '',
        includedNumStatOutput: includedResult.success ? (includedResult.stdout ?? '') : '',
        pendingNumStatOutput: pendingResult.success ? (pendingResult.stdout ?? '') : '',
        includedNumStatSuccess: includedResult.success,
        pendingNumStatSuccess: pendingResult.success,
        untrackedStatsByPath,
        untrackedEnumeration,
        worktreesOutput: worktreesResult.success ? (worktreesResult.stdout ?? '') : '',
        remotesOutput,
        remoteHeadRefsOutput: remoteHeadRefsResult.success ? (remoteHeadRefsResult.stdout ?? '') : '',
        operationState,
        hostingProvider,
        prStatusCache: defaultPrStatusCache,
        pullRequestAuthProfileKey,
    });

    if (request?.includeWorktreeStatus === true && snapshot.repo.worktrees && snapshot.repo.worktrees.length > 0) {
        const enrichedWorktrees = await enrichGitWorktreesWithStatus({
            worktrees: snapshot.repo.worktrees,
            includeWorktreeStatus: true,
        });
        return {
            success: true,
            snapshot: {
                ...snapshot,
                repo: {
                    ...snapshot.repo,
                    worktrees: enrichedWorktrees,
                },
            },
        };
    }

    return {
        success: true,
        snapshot,
    };
}

/**
 * Aggregates `git ls-files --others --exclude-standard -z` output into the
 * truthful untracked-FILE facts the 'normal' mode needs: the total untracked
 * file count and, for every directory prefix, how many untracked files live
 * under it (so a collapsed `D/` entry can carry its file count without
 * shipping per-file rows). Pure string aggregation — no extra repository
 * probes.
 */
export function aggregateUntrackedFileCounts(othersOutput: string): {
    totalFileCount: number;
    fileCountByDirectoryPath: ReadonlyMap<string, number>;
} {
    const paths = othersOutput.split('\0').filter((path) => path.length > 0);
    const fileCountByDirectoryPath = new Map<string, number>();
    for (const path of paths) {
        // Count every ancestor directory prefix. Collapsed entries look up
        // their own prefix ('D/', 'D/sub/'), so nested untracked subtrees are
        // counted correctly without probing the filesystem.
        let slashIndex = path.indexOf('/');
        while (slashIndex > 0 && slashIndex < path.length - 1) {
            const prefix = path.slice(0, slashIndex + 1);
            fileCountByDirectoryPath.set(prefix, (fileCountByDirectoryPath.get(prefix) ?? 0) + 1);
            slashIndex = path.indexOf('/', slashIndex + 1);
        }
    }
    return { totalFileCount: paths.length, fileCountByDirectoryPath };
}

async function readGitUntrackedEnumeration(repoRoot: string): Promise<{
    totalFileCount: number;
    fileCountByDirectoryPath: ReadonlyMap<string, number>;
} | undefined> {
    const othersResult = await runScmCommand({
        bin: 'git',
        cwd: repoRoot,
        args: ['ls-files', '--others', '--exclude-standard', '-z'],
        timeoutMs: 10_000,
    });
    if (!othersResult.success) {
        return undefined;
    }
    return aggregateUntrackedFileCounts(othersResult.stdout ?? '');
}

/**
 * Canonicalize a path for the F7 enrichment-RPC path-validation intersection.
 *
 * Two-stage normalization:
 *   1. Strip a single trailing separator so `/foo` and `/foo/` compare equal.
 *   2. Resolve symlinks via `fs.realpath` when possible. macOS in particular
 *      reports `git worktree list` paths under `/private/var/...` while a
 *      caller might pass the equivalent `/var/...` symlink path, and a strict
 *      string compare would reject those legitimate paths. `realpath` failures
 *      (missing path, EACCES, etc.) fall back to the trim-only form so a
 *      genuinely foreign path is still rejected by intersection.
 */
async function canonicalizeWorktreePathForCompare(path: string): Promise<string> {
    if (typeof path !== 'string' || path.length === 0) return path;
    const trimmed = path === '/' || path === '\\'
        ? path
        : (path.endsWith('/') || path.endsWith('\\') ? path.slice(0, -1) : path);
    try {
        return await realpath(trimmed);
    } catch {
        return trimmed;
    }
}

export async function getGitWorktreesEnrichment(input: {
    context: ScmBackendContext;
    request: Pick<ScmWorktreesEnrichmentRequest, 'worktreePaths'>;
}): Promise<ScmWorktreesEnrichmentResponse> {
    const paths = input.request.worktreePaths ?? [];
    if (paths.length === 0) {
        return { success: true, worktrees: [] };
    }

    // F7: intersect the caller-supplied paths with the actual `git worktree list`
    // for the detected repo. Without this, the enricher would happily probe any
    // filesystem path the daemon user can read (a security boundary leak).
    const repoRoot = input.context.detection.rootPath ?? input.context.cwd;
    const worktreesList = await runScmCommand({
        bin: 'git',
        cwd: repoRoot,
        // FR4-4: `-z` keeps worktree paths whole even when they contain newline
        // characters. Without it, `parseGitWorktreeListPorcelain` would see a
        // truncated path and the security intersection in `getGitWorktreesEnrichment`
        // could admit an unrelated sibling whose absolute path matches the truncation.
        args: ['worktree', 'list', '--porcelain', '-z'],
        timeoutMs: 10_000,
    });
    if (!worktreesList.success) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: worktreesList.stderr || 'Failed to list worktrees',
        };
    }
    const knownWorktrees = parseGitWorktreeListPorcelain({
        worktreesOutput: worktreesList.stdout ?? '',
        currentWorktreePath: input.context.cwd,
        mainWorktreePath: repoRoot,
    });

    // FR3-5 (audit 2026-05-12): build a canonical → registered-worktree map so
    // we can probe the CANONICAL path that was actually validated, not the
    // caller-supplied path. The previous code stashed the requested string into
    // `allowedPaths`, which allowed a symlink path to be swapped between
    // validation and the per-worktree git probe (TOCTOU).
    const canonicalToRegisteredPath = new Map<string, string>();
    const knownCanonicalEntries = await Promise.all(
        knownWorktrees.map(async (w) => ({
            registered: w.path,
            canonical: await canonicalizeWorktreePathForCompare(w.path),
        })),
    );
    for (const { registered, canonical } of knownCanonicalEntries) {
        // First-write wins so multiple git-reported paths normalizing to the
        // same canonical (very unusual) still pick a stable registered path.
        if (!canonicalToRegisteredPath.has(canonical)) {
            canonicalToRegisteredPath.set(canonical, registered);
        }
    }

    // FR3-12 (audit 2026-05-12): canonicalize requested paths in parallel
    // (bounded by the schema-enforced max length). The previous serial
    // `for…await` allowed a malformed client to force O(N) filesystem work
    // before the intersection drop ran.
    const requestedCanonicals = await Promise.all(paths.map((p) => canonicalizeWorktreePathForCompare(p)));

    const allowedPaths: string[] = [];
    const seenAllowed = new Set<string>();
    for (const canonical of requestedCanonicals) {
        const registered = canonicalToRegisteredPath.get(canonical);
        if (registered === undefined) continue;
        // Deduplicate so two requested paths resolving to the same worktree
        // produce a single probe + response entry.
        if (seenAllowed.has(registered)) continue;
        seenAllowed.add(registered);
        allowedPaths.push(registered);
    }

    if (allowedPaths.length === 0) {
        return { success: true, worktrees: [] };
    }

    const worktrees = await readWorktreeStatusEnrichmentForPaths({
        worktreePaths: allowedPaths,
    });
    return { success: true, worktrees };
}
