import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
    ScmReviewWorkspaceCurrentness,
    ScmReviewWorkspaceSourceTip,
} from '@happier-dev/plugin-sdk/scm';
import {
    parseScmRemoteUrl,
    SCM_OPERATION_ERROR_CODES,
    type ScmOperationErrorCode,
} from '@happier-dev/plugin-sdk/scm';

import { normalizeCommitRef, runScmCommand } from '../runtime.js';
import { inspectGitCheckoutIdentity, isGitLinkedWorktreeIdentity } from '../checkoutIdentity.js';
import { buildScmNonInteractiveEnv } from '../providers/shared/nonInteractiveEnv.js';
import { parseGitWorktreeListPorcelain } from '../worktreeListParser.js';
import { repairGitWorktreeAdminReference } from './repairGitWorktreeAdminReference.js';
import {
    buildWorktreeTargetPath,
    hasForbiddenGitRefName,
    normalizeWorktreeDisplayName,
} from './worktreeName.js';
import {
    GIT_WORKTREE_NAME_ATTEMPT_LIMIT,
    gitWorktreeNameForAttempt,
    isGitWorktreeAlreadyExistsFailure,
    runGitWorktreeAdd as runCanonicalGitWorktreeAdd,
} from './gitWorktreeAdd.js';

type GitWorkspaceCheckoutCreationInput = Readonly<{
    repoRoot: string;
    displayName: string;
    baseRef: string | null;
    branchMode: 'new' | 'existing';
}>;

type GitPreparedReviewWorkspaceInput = Readonly<{
    repoRoot: string;
    sourceTip: ScmReviewWorkspaceSourceTip;
    signal?: AbortSignal;
}>;

type GitPreparedReviewWorkspaceResult = Readonly<{
    targetPath: string;
    branchName: string;
    created: boolean;
    currentness: ScmReviewWorkspaceCurrentness;
}>;

function resolveNormalizedBaseRef(baseRef: string | null): string | null {
    if (baseRef == null) {
        return null;
    }

    const normalized = normalizeCommitRef(baseRef);
    if (!normalized.ok) {
        throw new Error(normalized.error);
    }

    return normalized.commit;
}

function resolveWorktreeBranchName(displayName: string): string {
    if (displayName.trim() && hasForbiddenGitRefName(displayName)) {
        throw new Error('Invalid Git worktree name');
    }

    const branchName = normalizeWorktreeDisplayName(displayName);
    if (!branchName) {
        throw new Error('Workspace checkout display name is required');
    }

    return branchName;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw new Error('SCM review-workspace materialization was aborted');
    }
}

/**
 * The generic SCM dispatcher preserves this narrow classification verbatim.
 * A source can therefore distinguish a selected-root remote mismatch from an
 * unavailable SCM operation without inspecting human error prose.
 */
function reviewWorkspaceOperationError(
    message: string,
    errorCode: ScmOperationErrorCode,
): Error & Readonly<{ errorCode: ScmOperationErrorCode }> {
    return Object.assign(new Error(message), { errorCode });
}

async function runGitOrThrow(input: Readonly<{
    cwd: string;
    args: string[];
    signal?: AbortSignal;
}>): Promise<string> {
    throwIfAborted(input.signal);
    const result = await runScmCommand({
        bin: 'git',
        cwd: input.cwd,
        args: input.args,
        timeoutMs: 30_000,
        env: buildScmNonInteractiveEnv(),
    });
    throwIfAborted(input.signal);
    if (!result.success) {
        throw new Error(result.stderr || result.stdout || SCM_OPERATION_ERROR_CODES.COMMAND_FAILED);
    }
    return result.stdout.trim();
}

async function readGitRevision(input: Readonly<{
    cwd: string;
    revision?: string;
    signal?: AbortSignal;
}>): Promise<string | null> {
    try {
        const head = await runGitOrThrow({
            cwd: input.cwd,
            args: ['rev-parse', '--verify', input.revision ?? 'HEAD'],
            signal: input.signal,
        });
        return /^[0-9a-fA-F]{40,64}$/.test(head) ? head.toLowerCase() : null;
    } catch {
        return null;
    }
}

function sameGitRemoteTarget(left: string, right: string): boolean {
    const leftParsed = parseScmRemoteUrl(left);
    const rightParsed = parseScmRemoteUrl(right);
    return leftParsed !== null
        && rightParsed !== null
        && leftParsed.host === rightParsed.host
        && leftParsed.path === rightParsed.path;
}

async function resolveSourceTipRemote(input: Readonly<{
    repoRoot: string;
    sourceTip: ScmReviewWorkspaceSourceTip;
    signal?: AbortSignal;
}>): Promise<string> {
    const remoteOutput = await runGitOrThrow({
        cwd: input.repoRoot,
        args: ['remote'],
        signal: input.signal,
    });
    for (const remoteName of remoteOutput.split(/\r?\n/).map((name) => name.trim()).filter(Boolean)) {
        let configuredUrls: string;
        try {
            configuredUrls = await runGitOrThrow({
                cwd: input.repoRoot,
                args: ['config', '--get-all', `remote.${remoteName}.url`],
                signal: input.signal,
            });
        } catch {
            continue;
        }
        if (configuredUrls.split(/\r?\n/).some((url) => sameGitRemoteTarget(url, input.sourceTip.cloneUrl))) {
            return remoteName;
        }
    }
    throw reviewWorkspaceOperationError(
        'The selected workspace has no remote for the provider-authorized source repository',
        SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND,
    );
}

async function fetchVerifiedSourceTip(input: GitPreparedReviewWorkspaceInput): Promise<void> {
    const remote = await resolveSourceTipRemote(input);
    await runGitOrThrow({
        cwd: input.repoRoot,
        args: ['fetch', '--no-tags', remote, input.sourceTip.fetchRef],
        signal: input.signal,
    });
    const fetchedHead = await readGitRevision({
        cwd: input.repoRoot,
        revision: 'FETCH_HEAD',
        signal: input.signal,
    });
    if (fetchedHead !== input.sourceTip.sourceHeadSha.toLowerCase()) {
        throw new Error('The selected source ref no longer resolves to the observed source head');
    }
}

async function branchExists(input: Readonly<{
    repoRoot: string;
    branchName: string;
    signal?: AbortSignal;
}>): Promise<boolean> {
    try {
        await runGitOrThrow({
            cwd: input.repoRoot,
            args: ['show-ref', '--verify', '--quiet', `refs/heads/${input.branchName}`],
            signal: input.signal,
        });
        return true;
    } catch {
        return false;
    }
}

async function branchToFetchedSourceTip(input: Readonly<{
    repoRoot: string;
    branchName: string;
    signal?: AbortSignal;
}>): Promise<void> {
    await runGitOrThrow({
        cwd: input.repoRoot,
        args: ['branch', '--', input.branchName, 'FETCH_HEAD'],
        signal: input.signal,
    });
}

async function isDirtyGitWorktree(input: Readonly<{
    cwd: string;
    signal?: AbortSignal;
}>): Promise<boolean> {
    return (await runGitOrThrow({
        cwd: input.cwd,
        args: ['status', '--porcelain=v1', '--untracked-files=all'],
        signal: input.signal,
    })).length > 0;
}

async function localOnlyCommitCount(input: Readonly<{
    cwd: string;
    observedHeadSha: string;
    resolvedHeadSha: string;
    signal?: AbortSignal;
}>): Promise<number | null> {
    try {
        const count = await runGitOrThrow({
            cwd: input.cwd,
            args: ['rev-list', '--left-right', '--count', `${input.observedHeadSha}...${input.resolvedHeadSha}`],
            signal: input.signal,
        });
        const [, localOnly] = count.split(/\s+/).map((part) => Number(part));
        return Number.isSafeInteger(localOnly) && localOnly >= 0 ? localOnly : null;
    } catch {
        return null;
    }
}

function recoveryRefFor(headSha: string): string {
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
    return `refs/happier/recovery/${timestamp}-${headSha.slice(0, 12)}`;
}

async function moveCleanGitWorktreeToObservedHead(input: Readonly<{
    cwd: string;
    fromSha: string;
    observedHeadSha: string;
    signal?: AbortSignal;
}>): Promise<ScmReviewWorkspaceCurrentness> {
    const recoveryRef = recoveryRefFor(input.fromSha);
    await runGitOrThrow({
        cwd: input.cwd,
        args: ['update-ref', recoveryRef, input.fromSha],
        signal: input.signal,
    });

    const observedOnly = await localOnlyCommitCount({
        cwd: input.cwd,
        observedHeadSha: input.fromSha,
        resolvedHeadSha: input.observedHeadSha,
        signal: input.signal,
    });
    try {
        if (observedOnly !== null && observedOnly > 0) {
            await runGitOrThrow({
                cwd: input.cwd,
                args: ['merge', '--ff-only', input.observedHeadSha],
                signal: input.signal,
            });
        } else {
            await runGitOrThrow({
                cwd: input.cwd,
                args: ['reset', '--merge', input.observedHeadSha],
                signal: input.signal,
            });
        }
    } catch {
        const resolvedHeadSha = await readGitRevision({ cwd: input.cwd, signal: input.signal }) ?? input.fromSha;
        return {
            kind: 'preservedStale',
            resolvedHeadSha,
            observedHeadSha: input.observedHeadSha,
            reason: await isDirtyGitWorktree({ cwd: input.cwd, signal: input.signal })
                ? 'dirtyWorktree'
                : 'unresolvedHead',
        };
    }

    const resolvedHeadSha = await readGitRevision({ cwd: input.cwd, signal: input.signal });
    if (resolvedHeadSha !== input.observedHeadSha) {
        return {
            kind: 'preservedStale',
            resolvedHeadSha: resolvedHeadSha ?? input.fromSha,
            observedHeadSha: input.observedHeadSha,
            reason: 'unresolvedHead',
        };
    }
    return {
        kind: 'movedToObservedHead',
        fromSha: input.fromSha,
        observedHeadSha: input.observedHeadSha,
        recoveryRef,
    };
}

/**
 * Adds the worktree through the package's one `git worktree add` owner and
 * turns its failure into the throw this materializer's callers already handle.
 * The parent directory is prepared here because only this caller materializes
 * into an explicitly chosen absolute path.
 */
async function addGitWorktree(input: Readonly<{
    repoRoot: string;
    targetPath: string;
    branchName: string;
    baseRef: string | null;
    branchMode: 'new' | 'existing';
}>): Promise<void> {
    await mkdir(dirname(input.targetPath), { recursive: true });

    const result = await runCanonicalGitWorktreeAdd({
        repoRoot: input.repoRoot,
        worktreePath: input.targetPath,
        branchName: input.branchName,
        branchMode: input.branchMode,
        baseRef: input.baseRef,
    });
    if (result.success) {
        return;
    }

    throw new Error(result.stderr || result.stdout || SCM_OPERATION_ERROR_CODES.COMMAND_FAILED);
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch {
        return false;
    }
}

async function isDirectoryEmpty(path: string): Promise<boolean> {
    if (!(await pathExists(path))) {
        return true;
    }

    return (await readdir(path)).length === 0;
}

async function materializeGitWorktreeIntoExistingDirectory(input: Readonly<{
    repoRoot: string;
    targetPath: string;
    branchName: string;
    baseRef: string | null;
    branchMode: 'new' | 'existing';
}>): Promise<string> {
    const temporaryTargetPath = `${input.targetPath}.happier-materialize-tmp`;
    await rm(temporaryTargetPath, { recursive: true, force: true });

    await addGitWorktree({
        repoRoot: input.repoRoot,
        targetPath: temporaryTargetPath,
        branchName: input.branchName,
        baseRef: input.baseRef,
        branchMode: input.branchMode,
    });

    try {
        const temporaryIdentity = await inspectGitCheckoutIdentity({ cwd: temporaryTargetPath });
        if (!temporaryIdentity) {
            throw new Error('Failed to inspect temporary git worktree identity');
        }

        await rename(join(temporaryTargetPath, '.git'), join(input.targetPath, '.git'));
        await repairGitWorktreeAdminReference({
            identity: temporaryIdentity,
            targetPath: input.targetPath,
        });

        return await resolveGitMaterializedWorktreeTargetPath({ targetPath: input.targetPath });
    } finally {
        await rm(temporaryTargetPath, { recursive: true, force: true });
    }
}

async function resolveGitMaterializedWorktreeTargetPath(input: Readonly<{
    targetPath: string;
}>): Promise<string> {
    const identity = await inspectGitCheckoutIdentity({ cwd: input.targetPath });
    return identity?.registeredWorktreePath ?? identity?.worktreePath ?? input.targetPath;
}

async function tryReuseExistingGitWorktree(input: Readonly<{
    repoRoot: string;
    targetPath: string;
    branchName: string;
}>): Promise<string | null> {
    if (!await pathExists(input.targetPath)) {
        return null;
    }
    const [repoIdentity, targetIdentity] = await Promise.all([
        inspectGitCheckoutIdentity({ cwd: input.repoRoot }),
        inspectGitCheckoutIdentity({ cwd: input.targetPath }),
    ]);
    if (
        !repoIdentity
        || !targetIdentity
        || !isGitLinkedWorktreeIdentity(targetIdentity)
        || targetIdentity.commonDirPath !== repoIdentity.commonDirPath
        || targetIdentity.branchName !== input.branchName
    ) {
        return null;
    }

    await repairGitWorktreeAdminReference({
        identity: targetIdentity,
        targetPath: input.targetPath,
    });

    return await resolveGitMaterializedWorktreeTargetPath({ targetPath: input.targetPath });
}

async function tryReuseGitWorktreeByBranch(input: Readonly<{
    repoRoot: string;
    branchName: string;
}>): Promise<string | null> {
    const listed = await runScmCommand({
        bin: 'git',
        cwd: input.repoRoot,
        args: ['worktree', 'list', '--porcelain'],
        timeoutMs: 15_000,
        env: buildScmNonInteractiveEnv(),
    });
    if (!listed.success) return null;

    return parseGitWorktreeListPorcelain({
        worktreesOutput: listed.stdout,
        currentWorktreePath: input.repoRoot,
        mainWorktreePath: input.repoRoot,
    }).find((worktree) => worktree.branch === input.branchName)?.path ?? null;
}

export async function materializeGitWorkspaceCheckoutAtPath(input: Readonly<{
    repoRoot: string;
    targetPath: string;
    displayName: string;
    baseRef: string | null;
    branchMode: 'new' | 'existing';
}>): Promise<Readonly<{
    targetPath: string;
    branchName: string;
    reused: boolean;
}>> {
    const branchName = resolveWorktreeBranchName(input.displayName);

    const reusedTargetPath = await tryReuseExistingGitWorktree({
        repoRoot: input.repoRoot,
        targetPath: input.targetPath,
        branchName,
    });
    if (reusedTargetPath) {
        return {
            targetPath: reusedTargetPath,
            branchName,
            reused: true,
        };
    }

    if (input.branchMode === 'existing') {
        const existingBranchPath = await tryReuseGitWorktreeByBranch({
            repoRoot: input.repoRoot,
            branchName,
        });
        if (existingBranchPath) {
            return {
                targetPath: existingBranchPath,
                branchName,
                reused: true,
            };
        }
    }

    const normalizedBaseRef = input.branchMode === 'existing'
        ? null
        : resolveNormalizedBaseRef(input.baseRef);
    if (!await isDirectoryEmpty(input.targetPath)) {
        return {
            targetPath: await materializeGitWorktreeIntoExistingDirectory({
                repoRoot: input.repoRoot,
                targetPath: input.targetPath,
                branchName,
                baseRef: normalizedBaseRef,
                branchMode: input.branchMode,
            }),
            branchName,
            reused: false,
        };
    }

    await addGitWorktree({
        repoRoot: input.repoRoot,
        targetPath: input.targetPath,
        branchName,
        baseRef: normalizedBaseRef,
        branchMode: input.branchMode,
    });

    return {
        targetPath: await resolveGitMaterializedWorktreeTargetPath({ targetPath: input.targetPath }),
        branchName,
        reused: false,
    };
}

/**
 * The single Git owner for a provider-authorized pull-request source tip.
 *
 * It never switches the selected root. A matching source branch is materialized
 * into a linked worktree, and an existing worktree is either shown to be at the
 * observed source head, moved only through the safe recovery-ref path, or left
 * untouched with an explicit stale result.
 */
export async function prepareGitReviewWorkspace(
    input: GitPreparedReviewWorkspaceInput,
): Promise<GitPreparedReviewWorkspaceResult> {
    const branchName = resolveWorktreeBranchName(input.sourceTip.branch);
    const observedHeadSha = input.sourceTip.sourceHeadSha.toLowerCase();

    await fetchVerifiedSourceTip(input);
    if (!await branchExists({
        repoRoot: input.repoRoot,
        branchName,
        signal: input.signal,
    })) {
        await branchToFetchedSourceTip({
            repoRoot: input.repoRoot,
            branchName,
            signal: input.signal,
        });
    }

    const materialized = await createGitWorkspaceCheckoutAtDefaultPath({
        repoRoot: input.repoRoot,
        displayName: branchName,
        baseRef: null,
        branchMode: 'existing',
    });
    const identity = await inspectGitCheckoutIdentity({ cwd: materialized.targetPath });
    if (!identity || !isGitLinkedWorktreeIdentity(identity)) {
        throw new Error('The requested source branch is checked out in the selected live workspace');
    }

    const resolvedHeadSha = await readGitRevision({
        cwd: materialized.targetPath,
        signal: input.signal,
    });
    if (!resolvedHeadSha) {
        throw new Error('Unable to resolve the prepared review-workspace head');
    }
    if (resolvedHeadSha === observedHeadSha) {
        return {
            targetPath: materialized.targetPath,
            branchName: materialized.branchName,
            created: !materialized.reused,
            currentness: { kind: 'currentAtObservedHead' },
        };
    }
    if (await isDirtyGitWorktree({ cwd: materialized.targetPath, signal: input.signal })) {
        return {
            targetPath: materialized.targetPath,
            branchName: materialized.branchName,
            created: !materialized.reused,
            currentness: {
                kind: 'preservedStale',
                resolvedHeadSha,
                observedHeadSha,
                reason: 'dirtyWorktree',
            },
        };
    }

    const localOnly = await localOnlyCommitCount({
        cwd: materialized.targetPath,
        observedHeadSha,
        resolvedHeadSha,
        signal: input.signal,
    });
    if (localOnly === null) {
        return {
            targetPath: materialized.targetPath,
            branchName: materialized.branchName,
            created: !materialized.reused,
            currentness: {
                kind: 'preservedStale',
                resolvedHeadSha,
                observedHeadSha,
                reason: 'unresolvedHead',
            },
        };
    }
    if (localOnly > 0) {
        return {
            targetPath: materialized.targetPath,
            branchName: materialized.branchName,
            created: !materialized.reused,
            currentness: {
                kind: 'preservedStale',
                resolvedHeadSha,
                observedHeadSha,
                reason: 'localCommits',
            },
        };
    }

    return {
        targetPath: materialized.targetPath,
        branchName: materialized.branchName,
        created: !materialized.reused,
        currentness: await moveCleanGitWorktreeToObservedHead({
            cwd: materialized.targetPath,
            fromSha: resolvedHeadSha,
            observedHeadSha,
            signal: input.signal,
        }),
    };
}

export async function createGitWorkspaceCheckoutAtDefaultPath(
    input: GitWorkspaceCheckoutCreationInput,
): Promise<Readonly<{
    targetPath: string;
    branchName: string;
    reused: boolean;
}>> {
    const branchName = resolveWorktreeBranchName(input.displayName);

    const normalizedBaseRef = input.branchMode === 'existing'
        ? null
        : resolveNormalizedBaseRef(input.baseRef);

    for (let attempt = 1; attempt <= GIT_WORKTREE_NAME_ATTEMPT_LIMIT; attempt += 1) {
        const candidateBranchName = gitWorktreeNameForAttempt(branchName, attempt);
        const candidateTargetPath = buildWorktreeTargetPath(input.repoRoot, candidateBranchName);
        try {
            const materialized = await materializeGitWorkspaceCheckoutAtPath({
                repoRoot: input.repoRoot,
                targetPath: candidateTargetPath,
                displayName: candidateBranchName,
                baseRef: normalizedBaseRef,
                branchMode: input.branchMode,
            });
            return {
                targetPath: materialized.targetPath,
                branchName: materialized.branchName,
                reused: materialized.reused,
            };
        } catch (error) {
            if (
                input.branchMode === 'new'
                && attempt < GIT_WORKTREE_NAME_ATTEMPT_LIMIT
                && isGitWorktreeAlreadyExistsFailure(error)
            ) {
                continue;
            }
            throw error;
        }
    }

    throw new Error('Failed to create workspace checkout');
}
