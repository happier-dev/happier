import { readUntrackedFileStats } from '@happier-dev/plugin-sdk/scm/backend';
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
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readGitBranchOperationState } from './operations/branchOperationState.js';
import { parseGitStatusPorcelainV2Z } from './statusParser.js';
import { parseGitWorktreeListPorcelain } from './worktreeListParser.js';
import { inspectGitOrphanWorktree, readGitRetentionFacts, resolveGitRetainedWorktreeRepository } from './operations/worktreeRetentionFacts.js';
import { projectPullRequestStatus, resolveDefaultPullRequestStatusProjectionRegistry, type PullRequestStatusProjectionRegistry } from './operations/pullRequestStatusProjection.js';

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
 * `git` produced no answer at all — the spawn failed, the probe was cut
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

export async function detectGitRepo(input: { cwd: string; includeRetainedWorktrees?: boolean }): Promise<ScmRepoDetection> {
    if (input.includeRetainedWorktrees) {
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

    return {
        isRepo: true,
        // Bare repositories answer false before --show-toplevel fails. Preserve their
        // existing repository detection without inventing a worktree root.
        rootPath: gitRepoCheck.success && discoveryAnswer
            ? gitRepoCheck.stdout.slice(discoveryAnswer[0].length).trim() || null
            : null,
        mode: '.git',
    };
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

    const statusResult = factsOnly ? await readGitBranchHeaderAsStatus(context.cwd) : await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['status', '--porcelain=v2', '-z', '--branch', '--show-stash', '--untracked-files=all'],
        timeoutMs: 10_000,
    });
    if (!statusResult.success) {
        return {
            success: false,
            errorCode: (factsOnly ? getScmCommandIndeterminateErrorCode(statusResult) : null) ?? SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: statusResult.stderr || 'Failed to read repository status',
        };
    }

    const noScan: ScmExecResult = { success: true, stdout: '', stderr: '', exitCode: 0 };
    const includedResult = factsOnly ? noScan : await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['diff', '--cached', '--numstat', '-z'],
        timeoutMs: 10_000,
    });
    const pendingResult = factsOnly ? noScan : await runScmCommand({
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
    const mainWorktreePath = worktreesResult.success ? await resolveGitMainWorktreePath({
        worktreesOutput: worktreesResult.stdout, currentWorktreePath: context.detection.rootPath,
    }) : null;
    const statusRaw = statusResult.stdout ?? '';
    const parsedStatus = parseGitStatusPorcelainV2Z(statusRaw);
    const operationState = factsOnly ? null : await readGitBranchOperationState(context, parsedStatus.branch.oid);
    const upstreamOidResult = parsedStatus.branch.upstream && !factsOnly ? await runScmCommand({
        bin: 'git', cwd: context.cwd, args: ['rev-parse', '--verify', '@{upstream}^{commit}'],
    }) : null;
    const untrackedPaths = parsedStatus.notAdded;
    const untrackedStatsByPath = repoRoot && untrackedPaths.length > 0 && !factsOnly ? await readUntrackedFileStats(repoRoot, untrackedPaths) : {};

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
async function readGitBranchHeaderAsStatus(cwd: string): Promise<ScmExecResult> {
    const head = await runScmCommand({ bin: 'git', cwd, args: ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'] });
    if (getScmCommandIndeterminateErrorCode(head)) return head;
    const branch = await runScmCommand({ bin: 'git', cwd, args: ['symbolic-ref', '--quiet', '--short', 'HEAD'] });
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
        const upstream = await runScmCommand({ bin: 'git', cwd, args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'] });
        if (getScmCommandIndeterminateErrorCode(upstream)) return upstream;
        if (upstream.success && upstream.stdout.trim()) {
            lines.push(`# branch.upstream ${upstream.stdout.trim()}`);
            const counts = head.success ? await runScmCommand({ bin: 'git', cwd, args: ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'] }) : null;
            if (counts && getScmCommandIndeterminateErrorCode(counts)) return counts;
            const [ahead, behind] = counts?.success ? counts.stdout.trim().split(/\s+/) : [];
            if (ahead !== undefined && behind !== undefined) lines.push(`# branch.ab +${ahead} -${behind}`);
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
