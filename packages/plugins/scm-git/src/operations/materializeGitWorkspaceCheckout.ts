import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

import type {
    ScmReviewWorkspaceCurrentness,
    ScmReviewWorkspaceSourceTip,
} from '@happier-dev/plugin-sdk/scm';
import {
    parseScmRemoteUrl,
    hasForbiddenGitRefName,
    normalizeWorktreeDisplayName,
    SCM_OPERATION_ERROR_CODES,
    type ScmOperationErrorCode,
    type ScmTransportIdentityV1,
} from '@happier-dev/plugin-sdk/scm';

import { getScmCommandIndeterminateErrorCode, normalizeCommitRef, runScmCommand } from '../runtime.js';
import { inspectGitCheckoutIdentity, isGitLinkedWorktreeIdentity } from '../checkoutIdentity.js';
import { buildScmNonInteractiveEnv } from '../providers/shared/nonInteractiveEnv.js';
import { readRepositoryFileSystem } from '../repositoryFileSystem.js';
import { parseGitWorktreeListPorcelain } from '../worktreeListParser.js';
import { repairGitWorktreeAdminReference } from './repairGitWorktreeAdminReference.js';
import { buildWorktreeTargetPath } from './worktreeName.js';
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
    assertFilesystemPathAuthorized?: (targetPath: string) => void;
}>;

type GitPreparedReviewWorkspaceInput = Readonly<{
    repoRoot: string;
    sourceTip: ScmReviewWorkspaceSourceTip;
    signal?: AbortSignal;
    assertFilesystemPathAuthorized?: (targetPath: string) => void;
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
        signal: input.signal,
    });
    throwIfAborted(input.signal);
    if (!result.success) {
        throw Object.assign(new Error(result.stderr || result.stdout || SCM_OPERATION_ERROR_CODES.COMMAND_FAILED), {
            exitCode: getScmCommandIndeterminateErrorCode(result) ? undefined : result.exitCode,
        });
    }
    return result.stdout.trim();
}

/** Only a definite missing ref result is absence; interrupted reads still throw. */
async function readGitOrNull(input: Parameters<typeof runGitOrThrow>[0]): Promise<string | null> {
    try {
        return await runGitOrThrow(input);
    } catch (error) {
        if (error && typeof error === 'object' && 'exitCode' in error && error.exitCode === 1) return null;
        throw error;
    }
}

async function hasGitWorktreeBranch(repoRoot: string, branchName: string): Promise<boolean> {
    if (await readGitOrNull({ cwd: repoRoot,
        args: ['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${branchName}^{commit}`],
    }) !== null) return true;
    // Without a local branch Git would resolve this name to the tag and detach HEAD.
    if (await readGitOrNull({ cwd: repoRoot,
        args: ['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/tags/${branchName}`],
    }) !== null) return false;
    // Refuse only definite absence. Git owns remote disambiguation and checkout semantics.
    if ((await runGitOrThrow({ cwd: repoRoot,
        args: ['for-each-ref', '--count=1', '--format=%(refname)', `refs/remotes/*/${branchName}`],
    })) !== '') return true;
    const fetchConfig = await readGitOrNull({ cwd: repoRoot,
        args: ['config', '--get-regexp', '^remote\\..*\\.fetch$'],
    });
    // A custom destination makes the conventional-namespace miss inconclusive.
    // Do not interpret refspec matching or remote preference; defer those to Git.
    return (fetchConfig ?? '').split(/\r?\n/).some((entry) => {
        const refspec = entry.slice(entry.indexOf(' ') + 1);
        const destination = refspec.split(':')[1];
        return Boolean(destination && !destination.startsWith('refs/remotes/'));
    });
}

export async function readGitRevision(input: Readonly<{
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

/** The port each transport implies when a remote names none. */
const IMPLIED_TRANSPORT_PORTS: Readonly<Record<'https:' | 'ssh:', number>> = Object.freeze({
    'https:': 443,
    'ssh:': 22,
});

/**
 * The endpoint a remote actually reaches, with the transport's own default folded away so
 * `ssh://git@forge.example:22/team/repo` and `git@forge.example:team/repo` stay one target.
 * Any other port is a different deployment and must not compare equal.
 */
function readRemoteEndpointPort(identity: ScmTransportIdentityV1): number | null {
    if (identity.syntax === 'scp') return null;
    return identity.port === IMPLIED_TRANSPORT_PORTS[identity.protocol] ? null : identity.port;
}

function sameGitRemoteTarget(left: string, right: string): boolean {
    const leftParsed = parseScmRemoteUrl(left);
    const rightParsed = parseScmRemoteUrl(right);
    return leftParsed !== null
        && rightParsed !== null
        && leftParsed.host === rightParsed.host
        && readRemoteEndpointPort(leftParsed) === readRemoteEndpointPort(rightParsed)
        && leftParsed.path === rightParsed.path;
}

async function resolveSourceTipRemote(input: Readonly<{
    repoRoot: string;
    sourceTip: Pick<ScmReviewWorkspaceSourceTip, 'cloneUrl'>;
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
        // Git fetch uses the first URL; later URLs must not authorize another
        // repository reached through that configured remote name.
        const [fetchUrl] = configuredUrls.split(/\r?\n/);
        if (fetchUrl && sameGitRemoteTarget(fetchUrl, input.sourceTip.cloneUrl)) {
            return remoteName;
        }
    }
    throw reviewWorkspaceOperationError(
        'The selected workspace has no remote for the provider-authorized source repository',
        SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND,
    );
}

/** Review and deployment share configured-remote admission and exact fetched-object verification. */
export async function fetchVerifiedGitCommitRef(input: Readonly<{
    repoRoot: string; cloneUrl: string; ref: string; expectedCommitSha: string; signal?: AbortSignal;
}>): Promise<void> {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(input.expectedCommitSha)
        || !input.ref.startsWith('refs/') || hasForbiddenGitRefName(input.ref)) {
        throw Object.assign(new Error('Invalid source ref'), { code: 'git_selection_unavailable' });
    }
    const remote = await resolveSourceTipRemote({ ...input, sourceTip: { cloneUrl: input.cloneUrl } });
    // FETCH_HEAD is shared by every fetch in this repository. An invocation-owned
    // ref keeps unrelated concurrent fetches out of this approval comparison.
    const fetchedRef = `refs/happier/source-fetch/${randomUUID()}`;
    try {
        await runGitOrThrow({ cwd: input.repoRoot,
            args: ['fetch', '--no-tags', '--no-write-fetch-head', '--refmap=', '--', remote, `${input.ref}:${fetchedRef}`], signal: input.signal });
        const fetchedHead = await readGitRevision({ cwd: input.repoRoot, revision: fetchedRef, signal: input.signal });
        if (fetchedHead !== input.expectedCommitSha.toLowerCase()) {
            throw Object.assign(new Error('The selected source ref no longer resolves to the approved commit'), { code: 'approval_stale' });
        }
    } finally {
        // Cleanup owns only this temporary ref and must finish after cancellation.
        await runGitOrThrow({ cwd: input.repoRoot, args: ['update-ref', '-d', fetchedRef] });
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
    commitSha: string;
    signal?: AbortSignal;
}>): Promise<void> {
    await runGitOrThrow({
        cwd: input.repoRoot,
        args: ['branch', '--', input.branchName, input.commitSha],
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
    force?: boolean;
}>): Promise<void> {
    await readRepositoryFileSystem().mkdir(dirname(input.targetPath), { recursive: true });

    const result = await runCanonicalGitWorktreeAdd({
        repoRoot: input.repoRoot,
        worktreePath: input.targetPath,
        branchName: input.branchName,
        branchMode: input.branchMode,
        baseRef: input.baseRef,
        force: input.force,
    });
    if (result.success) {
        return;
    }

    throw new Error(result.stderr || result.stdout || SCM_OPERATION_ERROR_CODES.COMMAND_FAILED);
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await readRepositoryFileSystem().lstat(path);
        return true;
    } catch {
        return false;
    }
}

async function isDirectoryEmpty(path: string): Promise<boolean> {
    if (!(await pathExists(path))) {
        return true;
    }

    return (await readRepositoryFileSystem().readdir(path)).length === 0;
}

async function materializeGitWorktreeIntoExistingDirectory(input: Readonly<{
    repoRoot: string;
    targetPath: string;
    branchName: string;
    baseRef: string | null;
    branchMode: 'new' | 'existing';
    assertFilesystemPathAuthorized?: (targetPath: string) => void;
}>): Promise<string> {
    const files = readRepositoryFileSystem();
    const temporaryTargetPath = `${input.targetPath}.happier-materialize-tmp`;
    input.assertFilesystemPathAuthorized?.(temporaryTargetPath);
    await files.rm(temporaryTargetPath, { recursive: true, force: true });

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

        await files.rename(join(temporaryTargetPath, '.git'), join(input.targetPath, '.git'));
        await repairGitWorktreeAdminReference({
            identity: temporaryIdentity,
            targetPath: input.targetPath,
        });

        return await resolveGitMaterializedWorktreeTargetPath({ targetPath: input.targetPath });
    } finally {
        await files.rm(temporaryTargetPath, { recursive: true, force: true });
    }
}

async function resolveGitMaterializedWorktreeTargetPath(input: Readonly<{
    targetPath: string;
}>): Promise<string> {
    const identity = await inspectGitCheckoutIdentity({ cwd: input.targetPath });
    if (!identity) return input.targetPath;
    const path = identity.registeredWorktreePath;
    return readRepositoryFileSystem().commandPaths?.fromCommandPath(path) ?? path;
}

async function inspectReusableGitWorktree(input: Readonly<{
    repoRoot: string;
    targetPath: string;
    branchName: string;
}>) {
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

    return targetIdentity;
}

async function tryReuseExistingGitWorktree(input: Readonly<{
    repoRoot: string;
    targetPath: string;
    branchName: string;
}>): Promise<string | null> {
    const targetIdentity = await inspectReusableGitWorktree(input);
    if (!targetIdentity) return null;

    await repairGitWorktreeAdminReference({
        identity: targetIdentity,
        targetPath: input.targetPath,
    });

    return await resolveGitMaterializedWorktreeTargetPath({ targetPath: input.targetPath });
}

export async function assertGitWorkspaceCheckoutMutationPathsAuthorized(input: Readonly<{
    repoRoot: string;
    targetPath: string;
    branchName: string;
    branchMode: 'new' | 'existing';
    assertFilesystemPathAuthorized?: (targetPath: string) => void;
}>): Promise<void> {
    const assertAuthorized = input.assertFilesystemPathAuthorized;
    if (!assertAuthorized) return;
    assertAuthorized(input.targetPath);
    if (await inspectReusableGitWorktree(input)) return;
    if (input.branchMode === 'existing') {
        const registration = await inspectGitWorktreeBranchRegistration(input);
        if (registration.existingPath) {
            assertAuthorized(registration.existingPath);
            return;
        }
    }
    if (!await isDirectoryEmpty(input.targetPath)) {
        assertAuthorized(`${input.targetPath}.happier-materialize-tmp`);
    }
}

async function inspectGitWorktreeBranchRegistration(input: Readonly<{
    repoRoot: string;
    targetPath: string;
    branchName: string;
}>): Promise<Readonly<{
    existingPath: string | null;
    missingAtTarget: boolean;
}>> {
    const listed = await runScmCommand({
        bin: 'git',
        cwd: input.repoRoot,
        args: ['worktree', 'list', '--porcelain'],
        timeoutMs: 15_000,
        env: buildScmNonInteractiveEnv(),
    });
    if (!listed.success) return { existingPath: null, missingAtTarget: false };

    const files = readRepositoryFileSystem();
    const registered = parseGitWorktreeListPorcelain({
        worktreesOutput: listed.stdout,
        currentWorktreePath: input.repoRoot,
        mainWorktreePath: input.repoRoot,
        fromCommandPath: files.commandPaths?.fromCommandPath,
    });
    const branchPath = registered.find((worktree) => worktree.branch === input.branchName)?.path ?? null;
    if (branchPath && await pathExists(branchPath)) return { existingPath: branchPath, missingAtTarget: false };

    const canonicalizeMissingTarget = async (path: string): Promise<string> => {
        try {
            return await files.realpath(path);
        } catch {
            try {
                return join(await files.realpath(dirname(path)), basename(path));
            } catch {
                return resolve(path);
            }
        }
    };
    // Git refuses to add into a path it still lists as a deleted worktree, whichever branch
    // that earlier worktree carried, and `--force` is the documented override.
    const canonicalTarget = await canonicalizeMissingTarget(input.targetPath);
    for (const worktree of registered) {
        if (await pathExists(worktree.path)) continue;
        if (await canonicalizeMissingTarget(worktree.path) === canonicalTarget) {
            return { existingPath: null, missingAtTarget: true };
        }
    }
    return { existingPath: null, missingAtTarget: false };
}

export async function materializeGitWorkspaceCheckoutAtPath(input: Readonly<{
    repoRoot: string;
    targetPath: string;
    displayName: string;
    baseRef: string | null;
    branchMode: 'new' | 'existing';
    assertFilesystemPathAuthorized?: (targetPath: string) => void;
}>): Promise<Readonly<{
    targetPath: string;
    branchName: string;
    reused: boolean;
}>> {
    const branchName = resolveWorktreeBranchName(input.displayName);
    await assertGitWorkspaceCheckoutMutationPathsAuthorized({ ...input, branchName });

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

    const branchRegistration = await inspectGitWorktreeBranchRegistration({
        repoRoot: input.repoRoot,
        targetPath: input.targetPath,
        branchName,
    });
    if (input.branchMode === 'existing' && branchRegistration.existingPath) {
            input.assertFilesystemPathAuthorized?.(branchRegistration.existingPath);
            return {
                targetPath: branchRegistration.existingPath,
                branchName,
                reused: true,
            };
    }

    const normalizedBaseRef = input.branchMode === 'existing'
        ? null
        : resolveNormalizedBaseRef(input.baseRef);
    // Admit the exact ref before mkdir, temporary-directory replacement or
    // worktree add. This code is a known no-effect refusal for host callers;
    // failures after this read remain potentially effectful.
    const refAvailable = input.branchMode === 'existing'
        ? await hasGitWorktreeBranch(input.repoRoot, branchName)
        : await readGitOrNull({ cwd: input.repoRoot,
            args: ['rev-parse', '--verify', '--quiet', '--end-of-options', `${normalizedBaseRef ?? 'HEAD'}^{commit}`],
        }) !== null;
    if (!refAvailable) throw Object.assign(new Error('The selected Git ref is unavailable'), { code: 'ref_unavailable' });
    if (!await isDirectoryEmpty(input.targetPath)) {
        return {
            targetPath: await materializeGitWorktreeIntoExistingDirectory({
                repoRoot: input.repoRoot,
                targetPath: input.targetPath,
                branchName,
                baseRef: normalizedBaseRef,
                branchMode: input.branchMode,
                assertFilesystemPathAuthorized: input.assertFilesystemPathAuthorized,
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
        force: branchRegistration.missingAtTarget,
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

    // Review preparation fetches and creates the branch before materialization.
    // Check the same mutation targets before those earlier Git side effects.
    await assertGitWorkspaceCheckoutMutationPathsAuthorized({
        repoRoot: input.repoRoot,
        targetPath: buildWorktreeTargetPath(input.repoRoot, branchName),
        branchName,
        branchMode: 'existing',
        assertFilesystemPathAuthorized: input.assertFilesystemPathAuthorized,
    });

    await fetchVerifiedGitCommitRef({ repoRoot: input.repoRoot, cloneUrl: input.sourceTip.cloneUrl,
        ref: input.sourceTip.fetchRef, expectedCommitSha: input.sourceTip.sourceHeadSha, signal: input.signal });
    if (!await branchExists({
        repoRoot: input.repoRoot,
        branchName,
        signal: input.signal,
    })) {
        await branchToFetchedSourceTip({
            repoRoot: input.repoRoot,
            branchName,
            commitSha: observedHeadSha,
            signal: input.signal,
        });
    }

    const materialized = await createGitWorkspaceCheckoutAtDefaultPath({
        repoRoot: input.repoRoot,
        displayName: branchName,
        baseRef: null,
        branchMode: 'existing',
        assertFilesystemPathAuthorized: input.assertFilesystemPathAuthorized,
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
                assertFilesystemPathAuthorized: input.assertFilesystemPathAuthorized,
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
                // An identical caller may have won creation after our initial
                // reuse check. Rejoin that exact candidate before treating the
                // collision as an unrelated name and allocating a suffix.
                const concurrentlyCreated = await tryReuseExistingGitWorktree({
                    repoRoot: input.repoRoot,
                    targetPath: candidateTargetPath,
                    branchName: candidateBranchName,
                });
                if (concurrentlyCreated) {
                    return {
                        targetPath: concurrentlyCreated,
                        branchName: candidateBranchName,
                        reused: true,
                    };
                }
                continue;
            }
            throw error;
        }
    }

    throw new Error('Failed to create workspace checkout');
}
