import { readCurrentBackendRuntimeServices, readUntrackedFileStats } from '@happier-dev/plugin-sdk/scm/backend';
import type { ScmRepoDetection, ScmBackendContext } from './types.js';
import type {
  ScmStatusSnapshotRequest,
  ScmStatusSnapshotResponse,
  ScmWorktreesEnrichmentRequest,
  ScmWorktreesEnrichmentResponse,
} from '@happier-dev/plugin-sdk/scm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';

import { getScmCommandIndeterminateErrorCode, runScmCommand, type ScmExecResult } from './runtime.js';
import { buildGitSnapshot } from './statusSnapshot.js';
import { inspectGitCheckoutIdentity, resolveGitMainWorktreePath } from './checkoutIdentity.js';
import { enrichGitWorktreesWithStatus, readWorktreeStatusEnrichmentForPaths } from './worktreeStatusEnricher.js';
import { readRepositoryFileSystem } from './repositoryFileSystem.js';
import {
  readGitBranchOperationStateFromResolvedPaths,
  resolveGitBranchOperationStatePaths,
} from './operations/branchOperationState.js';
import { parseGitStatusPorcelainV2Z } from './statusParser.js';
import { parseGitWorktreeListPorcelain } from './worktreeListParser.js';
import { inspectGitOrphanWorktree, readGitRetentionFacts, resolveGitRetainedWorktreeRepository } from './operations/worktreeRetentionFacts.js';
import { projectPullRequestStatus, resolveDefaultPullRequestStatusProjectionRegistry, type PullRequestStatusProjectionRegistry } from './operations/pullRequestStatusProjection.js';

const NOT_A_REPOSITORY: ScmRepoDetection = { isRepo: false, rootPath: null, mode: null };

export type GitExecutionFeatures = Readonly<{ hookRun: boolean; stagedIntentMerge: boolean }>;

/** Observe the Git version once per backend and admitted command source. */
export function createGitExecutionFeatureDetector(): (cwd: string) => Promise<GitExecutionFeatures> {
    const localCommandSource = {};
    const pending = new WeakMap<object, Promise<GitExecutionFeatures>>();
    return (cwd) => {
        const commandSource = readCurrentBackendRuntimeServices()?.repositoryFileSystem?.commandPaths ?? localCommandSource;
        const cached = pending.get(commandSource);
        if (cached) return cached;
        const probe = readGitExecutionFeatures(cwd);
        pending.set(commandSource, probe);
        return probe;
    };
}

/** Interpret the Git version from the same command source as this commit. */
export async function readGitExecutionFeatures(cwd: string): Promise<GitExecutionFeatures> {
    const result = await runScmCommand({ bin: 'git', cwd, args: ['--version'] });
    const version = result.success ? /^git version (\d+)\.(\d+)(?:\.|\s|$)/.exec(result.stdout.trim()) : null;
    if (!version) throw detectionUnavailable(result.stderr || 'Could not determine the Git executable version');
    const major = Number(version[1]);
    const minor = Number(version[2]);
    return { hookRun: major > 2 || (major === 2 && minor >= 36), stagedIntentMerge: major > 2 || (major === 2 && minor >= 40) };
}

/**
 * `git` produced no answer at all — the spawn failed, the probe was cut
 * short by its deadline, or the output cap killed it. Rejecting is the contract the host registry
 * already reads as "this backend could not look"; returning `isRepo: false` would publish the
 * confident domain fact *"this directory is not under source control"* about a directory nothing
 * inspected (`F-SCM-1`).
 */
function detectionUnavailable(detail: string): Error {
    return Object.assign(
        new Error(/^fatal: detected dubious ownership in repository at /u.test(detail)
            ? 'git_dubious_ownership'
            : `Unable to determine whether this path is a Git repository: ${detail}`),
        { errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE },
    );
}

export async function detectGitRepo(input: { cwd: string; includeRetainedWorktrees?: boolean }): Promise<ScmRepoDetection> {
    const paths = readCurrentBackendRuntimeServices()?.repositoryFileSystem?.commandPaths;
    if (input.includeRetainedWorktrees && !paths) {
        const rootPath = await resolveGitRetainedWorktreeRepository(input.cwd);
        if (rootPath) return { isRepo: true, rootPath, mode: '.git' };
    }
    const gitRepoCheck = await runScmCommand({
        bin: 'git',
        cwd: input.cwd,
        // Resolve both facts during the same discovery. Per-file RPCs already carry this
        // detection into their backend context; a second process only repeats setup.
        args: ['rev-parse', '--is-inside-work-tree', '--show-toplevel'],
        timeoutMs: 5000,
        env: { LC_ALL: 'C', LANGUAGE: 'C' },
    });
    if (gitRepoCheck.workingDirectoryMissing === true) {
        throw Object.assign(new Error('The workspace folder no longer exists on this machine'), {
            errorCode: SCM_OPERATION_ERROR_CODES.ROOT_NOT_FOUND,
        });
    }
    if (gitRepoCheck.executableMissing === true) {
        throw Object.assign(new Error(gitRepoCheck.stderr || 'Git is not installed'), {
            errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_NOT_INSTALLED,
        });
    }
    if (getScmCommandIndeterminateErrorCode(gitRepoCheck)) {
        throw detectionUnavailable(gitRepoCheck.stderr.trim() || 'the repository probe did not complete');
    }
    const discoveryAnswer = /^(true|false)\r?\n/.exec(gitRepoCheck.stdout);
    if ((!gitRepoCheck.success || gitRepoCheck.exitCode !== 0) && !discoveryAnswer) {

        // Git's setup.c distinguishes exhausted discovery from ownership, access and format
        // refusals. A working `git --version` cannot turn those refusals into repository absence.
        const diagnostic = gitRepoCheck.stderr.trim();
        if (
            /^fatal: not a git repository \(or any of the parent directories\): \.git$/.test(diagnostic)
            || /^fatal: not a git repository \(or any parent up to mount point [^\r\n]+\)\r?\nStopping at filesystem boundary \(GIT_DISCOVERY_ACROSS_FILESYSTEM not set\)\.$/.test(diagnostic)
        ) {
            return NOT_A_REPOSITORY;
        }
        throw detectionUnavailable(diagnostic || 'the repository probe was refused');
    }

    // Bare repositories answer false before --show-toplevel fails.
    const discoveredRoot = gitRepoCheck.success && discoveryAnswer
        ? gitRepoCheck.stdout.slice(discoveryAnswer[0].length).trim()
        : '';
    return {
        isRepo: true,
        rootPath: discoveredRoot ? paths?.fromCommandPath(discoveredRoot) ?? discoveredRoot : null,
        mode: '.git',
    };
}

function hasMeaningfulTrackedChange(statusChar: string): boolean {
    return statusChar !== ' ' && statusChar !== '.' && statusChar !== '?';
}

export async function getGitSnapshot(input: {
    context: ScmBackendContext;
    request?: Pick<ScmStatusSnapshotRequest, 'includeWorktreeStatus' | 'operationStateVersion' | 'detail'>;
    resolveHostingProviderRegistry?: () => Promise<PullRequestStatusProjectionRegistry>;
}): Promise<ScmStatusSnapshotResponse> {
    const { context, request } = input;
    const repoRoot = context.detection.rootPath ?? context.cwd;
    // A facts reader (checkout picker) reads root, branch, worktrees and remotes: answer from
    // ref queries and never walk the working copy (no status, numstat or untracked reads).
    const factsOnly = request?.detail === 'facts';
    const noScan: ScmExecResult = { success: true, stdout: '', stderr: '', exitCode: 0 };

    let statusResult: ScmExecResult;
    let worktreesResult: ScmExecResult;
    let remotesResult: ScmExecResult;
    let remoteHeadRefsResult: ScmExecResult;
    let includedResult: ScmExecResult = noScan;
    let pendingResult: ScmExecResult = noScan;
    let operationState: Awaited<ReturnType<typeof readGitBranchOperationStateFromResolvedPaths>> = null;
    let upstreamOidResult: ScmExecResult | null = null;
    let untrackedStatsByPath: Record<string, { pendingAdded: number; isBinary: boolean }> = {};
    let mainWorktreePath: string | null = null;

    if (factsOnly) {
        // Dispatch all ref and repository-facts queries in one wave so placed
        // workspaces pay a single channel round trip for `detail: 'facts'`.
        const [
            headResult,
            branchResult,
            upstreamResult,
            countsResult,
            worktrees,
            remotes,
            remoteHeadRefs,
        ] = await Promise.all([
            runScmCommand({ bin: 'git', cwd: context.cwd, args: ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'] }),
            runScmCommand({ bin: 'git', cwd: context.cwd, args: ['symbolic-ref', '--quiet', '--short', 'HEAD'] }),
            runScmCommand({ bin: 'git', cwd: context.cwd, args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'] }),
            runScmCommand({ bin: 'git', cwd: context.cwd, args: ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'] }),
            runScmCommand({
                bin: 'git',
                cwd: repoRoot,
                args: ['worktree', 'list', '--porcelain', '-z'],
                timeoutMs: 10_000,
            }),
            runScmCommand({
                bin: 'git',
                cwd: repoRoot,
                args: ['remote', '-v'],
                timeoutMs: 10_000,
            }),
            runScmCommand({
                bin: 'git',
                cwd: repoRoot,
                args: ['for-each-ref', '--format=%(refname:short)%09%(symref:short)', 'refs/remotes/*/HEAD'],
                timeoutMs: 10_000,
            }),
        ]);
        statusResult = buildGitBranchHeaderStatus({
            head: headResult,
            branch: branchResult,
            upstream: upstreamResult,
            counts: countsResult,
        });
        if (!statusResult.success) {
            return {
                success: false,
                errorCode: getScmCommandIndeterminateErrorCode(statusResult) ?? SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                error: statusResult.stderr || 'Failed to read repository status',
            };
        }
        worktreesResult = worktrees;
        remotesResult = remotes;
        remoteHeadRefsResult = remoteHeadRefs;
        mainWorktreePath = worktreesResult.success ? await resolveGitMainWorktreePath({
            worktreesOutput: worktreesResult.stdout, currentWorktreePath: context.detection.rootPath,
        }) : null;
    } else {
        // Wave 1: dispatch status together with all status-independent repository
        // queries and operation-state path resolution.
        const [
            status,
            worktrees,
            remotes,
            remoteHeadRefs,
            statePathsResult,
        ] = await Promise.all([
            runScmCommand({
                bin: 'git',
                cwd: context.cwd,
                args: ['status', '--porcelain=v2', '-z', '--branch', '--show-stash', '--untracked-files=all'],
                timeoutMs: 10_000,
            }),
            runScmCommand({
                bin: 'git',
                cwd: repoRoot,
                args: ['worktree', 'list', '--porcelain', '-z'],
                timeoutMs: 10_000,
            }),
            runScmCommand({
                bin: 'git',
                cwd: repoRoot,
                args: ['remote', '-v'],
                timeoutMs: 10_000,
            }),
            runScmCommand({
                bin: 'git',
                cwd: repoRoot,
                args: ['for-each-ref', '--format=%(refname:short)%09%(symref:short)', 'refs/remotes/*/HEAD'],
                timeoutMs: 10_000,
            }),
            resolveGitBranchOperationStatePaths(context).then(
                (paths) => ({ ok: true as const, paths }),
                (error: unknown) => ({ ok: false as const, error }),
            ),
        ]);
        if (!status.success) {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                error: status.stderr || 'Failed to read repository status',
            };
        }
        if (!statePathsResult.ok) {
            throw statePathsResult.error;
        }
        statusResult = status;
        worktreesResult = worktrees;
        remotesResult = remotes;
        remoteHeadRefsResult = remoteHeadRefs;

        const parsedStatus = parseGitStatusPorcelainV2Z(statusResult.stdout ?? '');
        const hasIncludedTrackedChanges = parsedStatus.files.some((entry) => hasMeaningfulTrackedChange(entry.index));
        const hasPendingTrackedChanges = parsedStatus.files.some((entry) => hasMeaningfulTrackedChange(entry.workingDir));

        // Wave 2: dispatch status-dependent reads (conditional numstats, parallel
        // operation-state FS probes, upstream OID, untracked stats, main worktree proof).
        [
            includedResult,
            pendingResult,
            operationState,
            upstreamOidResult,
            untrackedStatsByPath,
            mainWorktreePath,
        ] = await Promise.all([
            hasIncludedTrackedChanges ? runScmCommand({
                bin: 'git',
                cwd: context.cwd,
                args: ['diff', '--cached', '--numstat', '-z'],
                timeoutMs: 10_000,
            }) : noScan,
            hasPendingTrackedChanges ? runScmCommand({
                bin: 'git',
                cwd: context.cwd,
                args: ['diff', '--numstat', '-z'],
                timeoutMs: 10_000,
            }) : noScan,
            readGitBranchOperationStateFromResolvedPaths(context, statePathsResult.paths, parsedStatus.branch.oid),
            parsedStatus.branch.upstream ? runScmCommand({
                bin: 'git', cwd: context.cwd, args: ['rev-parse', '--verify', '@{upstream}^{commit}'],
            }) : null,
            repoRoot && parsedStatus.notAdded.length > 0
                ? readUntrackedFileStats(repoRoot, parsedStatus.notAdded) : {},
            worktreesResult.success ? resolveGitMainWorktreePath({
                worktreesOutput: worktreesResult.stdout, currentWorktreePath: context.detection.rootPath,
            }) : null,
        ]);
    }

    const commandPaths = readCurrentBackendRuntimeServices()?.repositoryFileSystem?.commandPaths;

    const baseSnapshot = buildGitSnapshot({
        projectKey: context.projectKey,
        fetchedAt: Date.now(),
        rootPath: context.detection.rootPath,
        currentWorktreePath: context.cwd,
        mainWorktreePath,
        statusOutput: statusResult.stdout ?? '',
        ...(upstreamOidResult?.success ? { upstreamOid: upstreamOidResult.stdout.trim() } : {}),
        includedNumStatOutput: includedResult.success ? (includedResult.stdout ?? '') : '',
        pendingNumStatOutput: pendingResult.success ? (pendingResult.stdout ?? '') : '',
        includedNumStatSuccess: includedResult.success,
        pendingNumStatSuccess: pendingResult.success,
        untrackedStatsByPath,
        worktreesOutput: worktreesResult.success ? (worktreesResult.stdout ?? '') : '',
        fromCommandPath: commandPaths?.fromCommandPath,
        remotesOutput: remotesResult.success ? (remotesResult.stdout ?? '') : '',
        remoteHeadRefsOutput: remoteHeadRefsResult.success ? (remoteHeadRefsResult.stdout ?? '') : '',
        operationState: request?.operationStateVersion === 1 ? operationState : operationState && (operationState.kind === 'merge' || operationState.kind === 'rebase') ? { kind: operationState.kind, sourceRef: operationState.sourceRef, canContinue: operationState.canContinue, canAbort: operationState.canAbort } : null,
        ...(request?.operationStateVersion === 1 ? { operationStateVersion: 1 as const } : {}),
    });
    // Without a remote, hosting cannot contribute any facts. Local status must
    // not wait for the host's external Connected Account deployment inventory.
    const snapshot = projectPullRequestStatus({
        snapshot: baseSnapshot,
        ...(baseSnapshot.repo.remotes.length > 0
            ? { registry: await (input.resolveHostingProviderRegistry ?? resolveDefaultPullRequestStatusProjectionRegistry)() }
            : {}),
    });

    if (request?.includeWorktreeStatus === true && snapshot.repo.worktrees.length > 0) {
        const worktrees = await enrichGitWorktreesWithStatus({
            worktrees: snapshot.repo.worktrees,
            includeWorktreeStatus: true,
        });
        return {
            success: true,
            snapshot: {
                ...snapshot,
                ...(factsOnly ? { detail: 'facts' as const } : {}),
                repo: {
                    ...snapshot.repo,
                    worktrees,
                },
            },
        };
    }

    return {
        success: true,
        snapshot: factsOnly ? { ...snapshot, detail: 'facts' } : snapshot,
    };
}

/**
 * The porcelain v2 branch header (`# branch.oid/head/upstream/ab`) from ref queries alone, so the
 * canonical status parser builds the branch facts without a working-copy walk.
 */
function buildGitBranchHeaderStatus(input: Readonly<{
    head: ScmExecResult;
    branch: ScmExecResult;
    upstream: ScmExecResult;
    counts: ScmExecResult;
}>): ScmExecResult {
    const { head, branch, upstream, counts } = input;
    if (getScmCommandIndeterminateErrorCode(head)) return head;
    if (getScmCommandIndeterminateErrorCode(branch)) return branch;
    if (!head.success && !branch.success) {
        // Neither a commit nor a branch: not a readable repository state.
        return head;
    }
    const lines = [
        `# branch.oid ${head.success ? head.stdout.trim() : '(initial)'}`,
        `# branch.head ${branch.success ? branch.stdout.trim() : '(detached)'}`,
    ];
    if (branch.success) {
        if (getScmCommandIndeterminateErrorCode(upstream)) return upstream;
        if (upstream.success && upstream.stdout.trim()) {
            lines.push(`# branch.upstream ${upstream.stdout.trim()}`);
            if (head.success) {
                if (getScmCommandIndeterminateErrorCode(counts)) return counts;
                const [ahead, behind] = counts.success ? counts.stdout.trim().split(/\s+/) : [];
                if (ahead !== undefined && behind !== undefined) lines.push(`# branch.ab +${ahead} -${behind}`);
            }
        }
    }
    return { success: true, stdout: lines.map(line => `${line}\0`).join(''), stderr: '', exitCode: 0 };
}

async function canonicalizeWorktreePathForCompare(path: string): Promise<string> {
    if (path.length === 0) return path;
    const trimmed = path === '/' || path === '\\'
        ? path
        : (path.endsWith('/') || path.endsWith('\\') ? path.slice(0, -1) : path);
    try {
        return await readRepositoryFileSystem().realpath(trimmed);
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

    const repoRoot = input.context.detection.rootPath ?? input.context.cwd;
    const worktreesList = await runScmCommand({
        bin: 'git',
        cwd: repoRoot,
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
        fromCommandPath: readCurrentBackendRuntimeServices()?.repositoryFileSystem?.commandPaths?.fromCommandPath,
    });
    const canonicalToRegisteredPath = new Map<string, string>();
    const knownCanonicalEntries = await Promise.all(knownWorktrees.map(async (worktree) => ({
        registered: worktree.path,
        canonical: await canonicalizeWorktreePathForCompare(worktree.path),
    })));
    for (const { registered, canonical } of knownCanonicalEntries) {
        if (!canonicalToRegisteredPath.has(canonical)) {
            canonicalToRegisteredPath.set(canonical, registered);
        }
    }

    const requestedCanonicals = await Promise.all(paths.map((path) => canonicalizeWorktreePathForCompare(path)));
    const allowedPaths: string[] = [];
    const seenAllowed = new Set<string>();
    const repositoryIdentity = await inspectGitCheckoutIdentity({ cwd: repoRoot });
    for (let index = 0; index < requestedCanonicals.length; index++) {
        const canonical = requestedCanonicals[index]!;
        const registered = canonicalToRegisteredPath.get(canonical);
        const orphan = registered === undefined && repositoryIdentity
            ? await inspectGitOrphanWorktree(paths[index]!, repositoryIdentity.commonDirPath) : null;
        const allowed = registered ?? (orphan !== null ? paths[index]! : undefined);
        if (allowed === undefined || seenAllowed.has(allowed)) continue;
        seenAllowed.add(allowed);
        allowedPaths.push(allowed);
    }

    if (allowedPaths.length === 0) {
        return { success: true, worktrees: [] };
    }

    const entries = await readWorktreeStatusEnrichmentForPaths({ worktreePaths: allowedPaths });
    await Promise.all(entries.map(async entry => {
        const retention = await readGitRetentionFacts(entry.path, repoRoot);
        if (retention) entry.retention = retention;
    }));
    return {
        success: true,
        worktrees: entries,
    };
}
