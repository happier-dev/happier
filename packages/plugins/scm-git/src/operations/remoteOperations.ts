import { randomUUID } from 'node:crypto';
import type { ScmOperationEffect, ScmOperationErrorCode, ScmOperationOutcome, ScmOperationRepositoryState, ScmRemoteRequest, ScmRemoteResponse, ScmWorkingSnapshot } from '@happier-dev/plugin-sdk/scm';
import { normalizeScmOperationOutcome, SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';
import { buildScmNonInteractiveEnv } from '../providers/shared/nonInteractiveEnv.js';
import type { ScmBackendContext } from '../types.js';
import { getScmCommandIndeterminateErrorCode, runScmCommand, type ScmExecResult } from '../runtime.js';
import { buildGitPullArgs, buildGitPushArgs, mapGitErrorCode, normalizeScmRemoteRequest } from '../remote.js';
import { evaluateRemoteMutationPreconditions } from '../remoteGuards.js';
import { invalidatePrStatusCacheAfterSuccessfulScmMutation } from '../hostingProviders/prStatusCacheInvalidation.js';
import { readGitOperationRepositoryState } from './branchOperationState.js';
import { readGitSnapshotForChecks } from './snapshotChecks.js';
import { applyGitStashOid, buildHappierTransientStashMarker, createGitStashPush, dropGitStashOid } from './stashOperations.js';

type RemoteTarget = { remote: string; branch?: string };
type RecoveryStash = NonNullable<ScmOperationOutcome['recoveryStash']>;

function failure(errorCode: ScmOperationErrorCode, error: string): ScmRemoteResponse {
    return { success: false, errorCode, error, outcome: normalizeScmOperationOutcome({ success: false, errorCode, error }) };
}

async function git(context: ScmBackendContext, args: string[], timeoutMs = 10_000) {
    return runScmCommand({ bin: 'git', cwd: context.cwd, args, timeoutMs, env: buildScmNonInteractiveEnv() });
}

async function refresh(context: ScmBackendContext): Promise<ScmOperationRepositoryState | undefined> {
    try {
        const result = await readGitSnapshotForChecks(context);
        return result.success && result.snapshot ? await readGitOperationRepositoryState(context, result.snapshot) : undefined;
    } catch { return undefined; }
}

async function resolveTarget(context: ScmBackendContext, request: ScmRemoteRequest, snapshot: ScmWorkingSnapshot, kind: 'push' | 'pull'): Promise<RemoteTarget | undefined> {
    if (request.branch) return { remote: request.remote ?? 'origin', branch: request.branch.replace(/^refs\/heads\//, '') };
    const head = snapshot.branch.head;
    if (!head) return request.remote ? { remote: request.remote } : undefined;
    const metadata = await git(context, ['for-each-ref', `--format=%(${kind === 'push' ? 'push' : 'upstream'}:remotename)%00%(${kind === 'push' ? 'push' : 'upstream'}:remoteref)`, `refs/heads/${head}`]);
    const [configuredRemote, configuredRef] = metadata.success ? metadata.stdout.trim().split('\0') : [];
    let remote: string | undefined = request.remote ?? configuredRemote;
    if (!remote && kind === 'push') {
        for (const key of [`branch.${head}.pushRemote`, 'remote.pushDefault', `branch.${head}.remote`]) {
            const config = await git(context, ['config', '--get', key]);
            if (!config.success && config.exitCode !== 1) return undefined;
            if (config.success && config.stdout.trim()) { remote = config.stdout.trim(); break; }
        }
        remote ||= snapshot.repo.remotes?.find((entry) => entry.name === 'origin')?.name;
        if (!remote && snapshot.repo.remotes?.length === 1) remote = snapshot.repo.remotes[0].name;
    }
    if (!remote) return undefined;
    if (kind === 'push' && !request.remote && !configuredRef) {
        const pushRef = await git(context, ['rev-parse', '--symbolic-full-name', '@{push}']);
        const prefix = `refs/remotes/${remote}/`;
        if (pushRef.success && pushRef.stdout.trim().startsWith(prefix)) return { remote, branch: pushRef.stdout.trim().slice(prefix.length) };
    }
    return { remote, ...(remote === configuredRemote && configuredRef?.startsWith('refs/heads/') ? { branch: configuredRef.slice('refs/heads/'.length) } : {}) };
}

// Ordinary Git configuration remains authoritative except for unapproved rewriting.
export async function evaluateGitPushConfiguration(input: { context: ScmBackendContext; remote: string; hasExplicitRefspec: boolean }): Promise<ScmRemoteResponse | null> {
    const mirror = await git(input.context, ['config', '--bool', '--get', `remote.${input.remote}.mirror`]);
    const refspec = await git(input.context, ['config', '--get-all', `remote.${input.remote}.push`]);
    if ((!mirror.success && mirror.exitCode !== 1) || (!refspec.success && refspec.exitCode !== 1)) return failure(SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, 'Failed to inspect Git push configuration');
    if (mirror.stdout.trim() === 'true' || (!input.hasExplicitRefspec && refspec.stdout.split(/\r?\n/).some((line) => line.trim().startsWith('+')))) {
        const error = 'Configured history rewriting requires an explicit expected-OID lease.';
        return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, error, outcome: { v: 1, kind: 'needs_input', errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, message: error, nextActions: [] } };
    }
    return null;
}

function commandCode(command: ScmExecResult) {
    return getScmCommandIndeterminateErrorCode(command) ?? mapGitErrorCode(`${command.stderr}\n${command.stdout}`);
}

function warning(input: { command: ScmExecResult; effect: ScmOperationEffect; errorCode: ScmOperationErrorCode; error: string; repositoryState?: ScmOperationRepositoryState; recoveryStash?: RecoveryStash }): ScmRemoteResponse {
    return { success: true, stdout: input.command.stdout, stderr: input.command.stderr, errorCode: input.errorCode, error: input.error, outcome: { v: 1, kind: 'effect_applied_with_warning', effect: input.effect, errorCode: input.errorCode, message: input.error, repositoryState: input.repositoryState, recoveryStash: input.recoveryStash, nextActions: [{ kind: 'refresh' }] } };
}

export async function finalizeGitRemoteMutation(input: { context: ScmBackendContext; kind: 'fetch' | 'pull' | 'push'; command: ScmExecResult; target?: RemoteTarget; effect?: ScmOperationEffect; recoveryStash?: RecoveryStash }): Promise<ScmRemoteResponse> {
    const { context, command, target, effect, recoveryStash } = input;
    const errorCode = commandCode(command);
    let remoteRefreshFailed = false;
    if (!command.success && input.kind === 'push' && errorCode === SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD && target) {
        const fetched = await git(context, ['fetch', '--prune', target.remote, ...(target.branch ? [`refs/heads/${target.branch}`] : [])], 30_000);
        remoteRefreshFailed = !fetched.success;
    }
    const repositoryState = await refresh(context);
    const common = { v: 1 as const, repositoryState, recoveryStash };
    const error = command.stderr || command.stdout || `${input.kind} failed`;
    const uncertainEffect = getScmCommandIndeterminateErrorCode(command) !== null || (!command.success && input.kind === 'push' && errorCode === SCM_OPERATION_ERROR_CODES.REMOTE_NETWORK_FAILED);
    if (uncertainEffect) {
        const unknownCode = errorCode;
        return { success: false, stdout: command.stdout, stderr: command.stderr, errorCode: unknownCode, error, outcome: { ...common, kind: 'outcome_unknown', errorCode: unknownCode, message: error, reconciliation: input.kind === 'push' && target ? { kind: 'remote_ref', ...target } : { kind: 'repository_status', cwd: context.cwd }, nextActions: [{ kind: 'refresh' }] } };
    }
    if (repositoryState?.hasConflicts) {
        return { success: false, stdout: command.stdout, stderr: command.stderr, errorCode: SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE, error, outcome: { ...common, kind: 'conflicted', errorCode: SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE, repositoryState, nextActions: [{ kind: 'resolve_conflicts' }] } };
    }
    if (!command.success) {
        const response = failure(errorCode, error);
        if (input.kind === 'pull' && errorCode === SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE) return { ...response, stdout: command.stdout, stderr: command.stderr, outcome: { ...common, kind: 'needs_input', errorCode, nextActions: [{ kind: 'choose_dirty_policy' }] } };
        const outcome = normalizeScmOperationOutcome(response);
        if (input.kind === 'push' && errorCode === SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD) {
            return { ...response, stdout: command.stdout, stderr: command.stderr, outcome: {
                ...outcome, ...common, repositoryState: repositoryState!, nextActions: [{ kind: 'refresh' }, { kind: 'choose_reconcile' }],
                ...(remoteRefreshFailed ? { message: `${error}\nRemote refresh failed; refresh before reconciling.` } : {}),
            } };
        }
        return { ...response, stdout: command.stdout, stderr: command.stderr, outcome: { ...outcome, ...common, repositoryState: repositoryState!, ...(remoteRefreshFailed ? { message: `${error}\nRemote refresh failed; refresh before reconciling.` } : {}) } };
    }
    if (!repositoryState) {
        if (effect) return warning({ command, effect, errorCode: SCM_OPERATION_ERROR_CODES.REPOSITORY_REFRESH_FAILED, error: 'Mutation applied, but repository refresh failed', recoveryStash });
        const message = 'Mutation applied, but repository refresh failed';
        return { success: true, stdout: command.stdout, stderr: command.stderr, errorCode: SCM_OPERATION_ERROR_CODES.REPOSITORY_REFRESH_FAILED, error: message, outcome: { ...common, kind: 'succeeded', message, nextActions: [{ kind: 'refresh' }] } };
    }
    return { success: true, stdout: command.stdout, stderr: command.stderr, outcome: { ...common, kind: 'succeeded', effect: effect?.kind === 'branch' ? { ...effect, headOid: repositoryState.headOid } : effect, nextActions: [] } };
}

export async function gitRemoteFetch(input: { context: ScmBackendContext; request: ScmRemoteRequest }): Promise<ScmRemoteResponse> {
    const normalized = normalizeScmRemoteRequest(input.request);
    if (!normalized.ok) return failure(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, normalized.error);
    const command = await git(input.context, ['fetch', '--prune', ...(normalized.request.remote ? [normalized.request.remote] : [])], 30_000);
    const response = await finalizeGitRemoteMutation({ context: input.context, kind: 'fetch', command });
    invalidatePrStatusCacheAfterSuccessfulScmMutation({ response, context: input.context });
    return response;
}

export async function gitRemotePull(input: { context: ScmBackendContext; request: ScmRemoteRequest }): Promise<ScmRemoteResponse> {
    const { context } = input;
    const normalized = normalizeScmRemoteRequest(input.request);
    if (!normalized.ok) return failure(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, normalized.error);
    const request = normalized.request;
    const snapshotResponse = await readGitSnapshotForChecks(context);
    if (!snapshotResponse.success || !snapshotResponse.snapshot) return failure(snapshotResponse.errorCode ?? SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, snapshotResponse.error || 'Failed to evaluate repository state');
    const snapshot = snapshotResponse.snapshot;
    const guard = evaluateRemoteMutationPreconditions({ kind: 'pull', snapshot, request, hasExplicitRemoteOrBranch: Boolean(request.remote || request.branch) });
    if (!guard.ok) {
        const response = failure(guard.errorCode, guard.error);
        if (guard.errorCode === SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE && !snapshot.hasConflicts && !snapshot.operationState) response.outcome = { v: 1, kind: 'needs_input', errorCode: guard.errorCode, nextActions: [{ kind: 'choose_dirty_policy' }] };
        return response;
    }
    let recoveryStash: RecoveryStash | undefined;
    if (request.dirtyPolicy === 'autostash' && snapshot.entries.length > 0) {
        const stash = await createGitStashPush({ context, message: `${buildHappierTransientStashMarker(snapshot.branch.head ?? 'HEAD')} pull ${randomUUID()}` });
        if (!stash.ok) return { ...failure(stash.errorCode, stash.error), stdout: stash.stdout, stderr: stash.stderr, ...(stash.outcome ? { outcome: stash.outcome } : {}) };
        if (stash.stashCreated && stash.stashOid) recoveryStash = { stashOid: stash.stashOid, ...(stash.stashRef ? { stashRef: stash.stashRef } : {}) };
    }
    const command = await git(context, buildGitPullArgs(request), 30_000);
    const effect: ScmOperationEffect = { kind: 'branch', name: snapshot.branch.head ?? 'HEAD' };
    if (command.success) invalidatePrStatusCacheAfterSuccessfulScmMutation({ response: { success: true }, context, headBranch: snapshot.branch.head });
    if (command.success && recoveryStash) {
        const restored = await applyGitStashOid({ context, stashOid: recoveryStash.stashOid, restoreIndex: true });
        if (!restored.success) {
            const repositoryState = await refresh(context);
            if (repositoryState?.hasConflicts) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.STASH_APPLY_FAILED, error: restored.stderr, outcome: { v: 1, kind: 'conflicted', errorCode: SCM_OPERATION_ERROR_CODES.STASH_APPLY_FAILED, repositoryState, recoveryStash, nextActions: [{ kind: 'resolve_conflicts' }] } };
            return warning({ command, effect: { ...effect, headOid: repositoryState?.headOid }, errorCode: SCM_OPERATION_ERROR_CODES.STASH_APPLY_FAILED, error: restored.stderr || 'Pull applied, but saved work could not be restored', repositoryState, recoveryStash });
        }
    }
    const response = await finalizeGitRemoteMutation({ context, kind: 'pull', command, effect, recoveryStash });
    if (response.outcome?.kind === 'succeeded' && recoveryStash) {
        const dropped = await dropGitStashOid({ context, stashOid: recoveryStash.stashOid });
        if (!dropped.ok) return warning({ command, effect: response.outcome.effect ?? effect, errorCode: SCM_OPERATION_ERROR_CODES.STASH_DROP_FAILED, error: dropped.error, repositoryState: response.outcome.repositoryState, recoveryStash });
        const { recoveryStash: _recovery, ...outcome } = response.outcome;
        return { ...response, outcome };
    }
    return response;
}

export async function gitRemotePush(input: { context: ScmBackendContext; request: ScmRemoteRequest }): Promise<ScmRemoteResponse> {
    const { context } = input;
    const normalized = normalizeScmRemoteRequest(input.request);
    if (!normalized.ok) return failure(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, normalized.error);
    const request = normalized.request;
    const snapshotResponse = await readGitSnapshotForChecks(context);
    if (!snapshotResponse.success || !snapshotResponse.snapshot) return failure(snapshotResponse.errorCode ?? SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, snapshotResponse.error || 'Failed to evaluate repository state');
    const snapshot = snapshotResponse.snapshot;
    const target = await resolveTarget(context, request, snapshot, 'push');
    const guard = evaluateRemoteMutationPreconditions({ kind: 'push', snapshot, request, hasExplicitRemoteOrBranch: Boolean(request.remote || request.branch), behindAppliesToTarget: (!request.remote && !request.branch) || Boolean(target?.branch && snapshot.branch.upstream === `${target.remote}/${target.branch}`) });
    if (!guard.ok) return failure(guard.errorCode, guard.error);
    if (request.pushMode !== 'force_with_lease') {
        if (!target) return failure(SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED, 'Cannot resolve configured push remote');
        const rejected = await evaluateGitPushConfiguration({ context, remote: target.remote, hasExplicitRefspec: Boolean(request.branch) });
        if (rejected) return rejected;
    }
    const command = await git(context, buildGitPushArgs(request), 30_000);
    const response = await finalizeGitRemoteMutation({ context, kind: 'push', command, target, effect: target ? { kind: 'remote', ...target } : undefined });
    invalidatePrStatusCacheAfterSuccessfulScmMutation({ response, context, headBranch: snapshot.branch.head });
    return response;
}
