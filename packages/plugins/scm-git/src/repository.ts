import { readUntrackedFileStats } from '@happier-dev/plugin-sdk/scm/backend';
import type { ScmRepoDetection, ScmBackendContext } from './types.js';
import type {
  ScmStatusSnapshotRequest,
  ScmStatusSnapshotResponse,
  ScmWorktreesEnrichmentRequest,
  ScmWorktreesEnrichmentResponse,
} from '@happier-dev/plugin-sdk/scm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';

import { runScmCommand, type ScmExecResult } from './runtime.js';
import { buildGitSnapshot } from './statusSnapshot.js';
import { inspectGitCheckoutIdentity } from './checkoutIdentity.js';
import { enrichGitWorktreesWithStatus, readWorktreeStatusEnrichmentForPaths } from './worktreeStatusEnricher.js';
import { realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { readGitBranchOperationState } from './operations/branchOperationState.js';
import { parseGitStatusPorcelainV2Z } from './statusParser.js';
import { parseGitWorktreeListPorcelain } from './worktreeListParser.js';

function resolveMainWorktreePathFromCheckoutIdentity(
    checkoutIdentity: Awaited<ReturnType<typeof inspectGitCheckoutIdentity>>,
): string | null {
    if (!checkoutIdentity) {
        return null;
    }

    return dirname(checkoutIdentity.commonDirPath);
}

const NOT_A_REPOSITORY: ScmRepoDetection = { isRepo: false, rootPath: null, mode: null };

export type GitExecutionFeatures = Readonly<{ hookRun: boolean; stagedIntentMerge: boolean }>;

/** One executable-version observation per backend occurrence, shared by its commit callers. */
export function createGitExecutionFeatureDetector(): () => Promise<GitExecutionFeatures> {
    let pending: Promise<GitExecutionFeatures> | undefined;
    return () => pending ??= (async () => {
        const result = await runScmCommand({ bin: 'git', cwd: tmpdir(), args: ['--version'] });
        const version = result.success ? /^git version (\d+)\.(\d+)(?:\.|\s|$)/.exec(result.stdout.trim()) : null;
        if (!version) throw detectionUnavailable(result.stderr || 'Could not determine the Git executable version');
        const major = Number(version[1]);
        const minor = Number(version[2]);
        return { hookRun: major > 2 || (major === 2 && minor >= 36), stagedIntentMerge: major > 2 || (major === 2 && minor >= 40) };
    })();
}

/**
 * `git` produced no answer at all — the binary is missing, the spawn failed, the probe was cut
 * short by its deadline, or the output cap killed it. Rejecting is the contract the host registry
 * already reads as "this backend could not look"; returning `isRepo: false` would publish the
 * confident domain fact *"this directory is not under source control"* about a directory nothing
 * inspected (`F-SCM-1`).
 */
function detectionUnavailable(detail: string): Error {
    return Object.assign(
        new Error(`Unable to determine whether this path is a Git repository: ${detail}`),
        { errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE },
    );
}

/** True when the command did not run to completion, so its exit code carries no meaning. */
function commandProducedNoAnswer(result: ScmExecResult): boolean {
    return result.timedOut === true || result.outputLimitExceeded === true || result.exitCode < 0;
}

export async function detectGitRepo(input: { cwd: string }): Promise<ScmRepoDetection> {
    const gitRepoCheck = await runScmCommand({
        bin: 'git',
        cwd: input.cwd,
        args: ['rev-parse', '--is-inside-work-tree'],
        timeoutMs: 5000,
        env: { LC_ALL: 'C', LANGUAGE: 'C' },
    });
    if (!gitRepoCheck.success || gitRepoCheck.exitCode !== 0) {
        if (commandProducedNoAnswer(gitRepoCheck)) {
            throw detectionUnavailable(gitRepoCheck.stderr.trim() || 'the repository probe did not complete');
        }

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
    request?: Pick<ScmStatusSnapshotRequest, 'includeWorktreeStatus' | 'operationStateVersion'>;
}): Promise<ScmStatusSnapshotResponse> {
    const { context, request } = input;
    const repoRoot = context.detection.rootPath ?? context.cwd;

    const statusResult = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['status', '--porcelain=v2', '-z', '--branch', '--show-stash', '--untracked-files=all'],
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
    const checkoutIdentity = await inspectGitCheckoutIdentity({ cwd: context.cwd });
    const operationState = await readGitBranchOperationState(context);
    const { resolveDefaultPullRequestStatusProjectionRegistry } = await import('./operations/pullRequestStatusProjection.js');
    const hostingProviderRegistry = await resolveDefaultPullRequestStatusProjectionRegistry();

    const statusRaw = statusResult.stdout ?? '';
    const parsedStatus = parseGitStatusPorcelainV2Z(statusRaw);
    const upstreamOidResult = parsedStatus.branch.upstream ? await runScmCommand({
        bin: 'git', cwd: context.cwd, args: ['rev-parse', '--verify', '@{upstream}^{commit}'],
    }) : null;
    const untrackedPaths = parsedStatus.notAdded;
    const untrackedStatsByPath = repoRoot && untrackedPaths.length > 0 ? await readUntrackedFileStats(repoRoot, untrackedPaths) : {};

    const snapshot = buildGitSnapshot({
        projectKey: context.projectKey,
        fetchedAt: Date.now(),
        rootPath: context.detection.rootPath,
        currentWorktreePath: context.cwd,
        mainWorktreePath: resolveMainWorktreePathFromCheckoutIdentity(checkoutIdentity),
        statusOutput: statusResult.stdout ?? '',
        ...(upstreamOidResult?.success ? { upstreamOid: upstreamOidResult.stdout.trim() } : {}),
        includedNumStatOutput: includedResult.success ? (includedResult.stdout ?? '') : '',
        pendingNumStatOutput: pendingResult.success ? (pendingResult.stdout ?? '') : '',
        includedNumStatSuccess: includedResult.success,
        pendingNumStatSuccess: pendingResult.success,
        untrackedStatsByPath,
        worktreesOutput: worktreesResult.success ? (worktreesResult.stdout ?? '') : '',
        remotesOutput: remotesResult.success ? (remotesResult.stdout ?? '') : '',
        remoteHeadRefsOutput: remoteHeadRefsResult.success ? (remoteHeadRefsResult.stdout ?? '') : '',
        operationState: request?.operationStateVersion === 1 ? operationState : operationState && (operationState.kind === 'merge' || operationState.kind === 'rebase') ? { kind: operationState.kind, sourceRef: operationState.sourceRef, canContinue: operationState.canContinue, canAbort: operationState.canAbort } : null,
        ...(request?.operationStateVersion === 1 ? { operationStateVersion: 1 as const } : {}),
        hostingProviderRegistry,
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
                repo: {
                    ...snapshot.repo,
                    worktrees,
                },
            },
        };
    }

    return {
        success: true,
        snapshot,
    };
}

async function canonicalizeWorktreePathForCompare(path: string): Promise<string> {
    if (path.length === 0) return path;
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
    for (const canonical of requestedCanonicals) {
        const registered = canonicalToRegisteredPath.get(canonical);
        if (registered === undefined || seenAllowed.has(registered)) continue;
        seenAllowed.add(registered);
        allowedPaths.push(registered);
    }

    if (allowedPaths.length === 0) {
        return { success: true, worktrees: [] };
    }

    return {
        success: true,
        worktrees: await readWorktreeStatusEnrichmentForPaths({
            worktreePaths: allowedPaths,
        }),
    };
}
