import type {
  ScmBranchCheckoutRequest,
  ScmBranchCheckoutResponse,
  ScmBranchCreateRequest,
  ScmBranchCreateResponse,
  ScmBranchListEntry,
  ScmBranchListRequest,
  ScmBranchListResponse,
  ScmOperationOutcome,
} from '@happier-dev/plugin-sdk/scm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';

import type { ScmBackendContext } from '../types.js';
import { getScmCommandIndeterminateErrorCode, runScmCommand, type ScmExecResult } from '../runtime.js';
import { buildScmNonInteractiveEnv } from '../providers/shared/nonInteractiveEnv.js';
import { mapGitErrorCode } from '../remote.js';
import {
    buildHappierBranchStashMarker,
    buildHappierTransientStashMarker,
    createGitStashPush,
    dropGitStashOid,
    gitStashPop,
    listGitManagedStashes,
} from './stashOperations.js';
import { invalidatePrStatusCacheAfterSuccessfulScmMutation } from '../hostingProviders/prStatusCacheInvalidation.js';

const LOCAL_CHANGES_OVERWRITTEN_ERROR_REGEX =
    /local changes.*would be overwritten|untracked working tree files.*would be overwritten|please commit your changes or stash them/i;
const GIT_BRANCH_SWITCH_TIMEOUT_MS = 60_000;

function invalidateAfterBranchMutation(input: Readonly<{
    response: ScmBranchCreateResponse | ScmBranchCheckoutResponse;
    context: ScmBackendContext;
    headBranch?: string | null;
}>): void {
    invalidatePrStatusCacheAfterSuccessfulScmMutation(input);
}

function isLocalChangesOverwrittenError(stderr: string): boolean {
    return LOCAL_CHANGES_OVERWRITTEN_ERROR_REGEX.test(stderr.toLowerCase());
}

function branchMutationFailure(input: {
    context: ScmBackendContext;
    result: ScmExecResult;
    fallback: string;
    recoveryStash?: NonNullable<ScmOperationOutcome['recoveryStash']>;
}): ScmBranchCreateResponse {
    const indeterminateErrorCode = getScmCommandIndeterminateErrorCode(input.result);
    const errorCode = indeterminateErrorCode ?? mapGitErrorCode(input.result.stderr);
    return {
        success: false,
        errorCode,
        error: input.result.stderr || input.fallback,
        stdout: input.result.stdout,
        stderr: input.result.stderr,
        outcome: indeterminateErrorCode
            ? { v: 1, kind: 'outcome_unknown', errorCode, reconciliation: { kind: 'repository_status', cwd: input.context.cwd }, recoveryStash: input.recoveryStash, nextActions: [{ kind: 'refresh' }] }
            : { v: 1, kind: 'failed', errorCode, recoveryStash: input.recoveryStash, nextActions: input.recoveryStash ? [{ kind: 'refresh' }] : [] },
    };
}

async function runGitSwitch(input: {
    cwd: string;
    name: string;
    detach?: boolean;
    signal?: AbortSignal;
}): Promise<ScmExecResult> {
    const switchResult = await runScmCommand({
        bin: 'git',
        cwd: input.cwd,
        args: ['switch', ...(input.detach ? ['--detach'] : []), input.name],
        timeoutMs: GIT_BRANCH_SWITCH_TIMEOUT_MS,
        env: buildScmNonInteractiveEnv(),
        signal: input.signal,
    });

    if (switchResult.success) {
        return switchResult;
    }

    // Fallback for older git installs without `switch`.
    if (!getScmCommandIndeterminateErrorCode(switchResult) && /unknown subcommand: switch|is not a git command/i.test(switchResult.stderr)) {
        const checkoutResult = await runScmCommand({
            bin: 'git',
            cwd: input.cwd,
            args: ['checkout', ...(input.detach ? ['--detach'] : []), input.name],
            timeoutMs: GIT_BRANCH_SWITCH_TIMEOUT_MS,
            env: buildScmNonInteractiveEnv(),
            signal: input.signal,
        });
        return checkoutResult;
    }

    return switchResult;
}

async function runGitSwitchCreate(input: {
    cwd: string;
    name: string;
    startPoint?: string | null;
}): Promise<ScmExecResult> {
    const startPoint = typeof input.startPoint === 'string' ? input.startPoint.trim() : '';
    const args = startPoint
        ? ['switch', '-c', input.name, startPoint]
        : ['switch', '-c', input.name];

    const switchResult = await runScmCommand({
        bin: 'git',
        cwd: input.cwd,
        args,
        timeoutMs: GIT_BRANCH_SWITCH_TIMEOUT_MS,
        env: buildScmNonInteractiveEnv(),
    });

    if (switchResult.success) {
        return switchResult;
    }

    // Fallback for older git installs without `switch`.
    if (!getScmCommandIndeterminateErrorCode(switchResult) && /unknown subcommand: switch|is not a git command/i.test(switchResult.stderr)) {
        const checkoutArgs = startPoint
            ? ['checkout', '-b', input.name, startPoint]
            : ['checkout', '-b', input.name];
        const checkoutResult = await runScmCommand({
            bin: 'git',
            cwd: input.cwd,
            args: checkoutArgs,
            timeoutMs: GIT_BRANCH_SWITCH_TIMEOUT_MS,
            env: buildScmNonInteractiveEnv(),
        });
        return checkoutResult;
    }

    return switchResult;
}

function validateStartPoint(startPoint: string | undefined): { ok: true } | { ok: false; error: string } {
    const normalized = typeof startPoint === 'string' ? startPoint.trim() : '';
    if (!normalized) {
        return { ok: true };
    }
    if (normalized.startsWith('-')) {
        return { ok: false, error: 'Invalid startPoint: revision cannot start with "-"' };
    }
    return { ok: true };
}

async function readCurrentBranchName(context: ScmBackendContext): Promise<string | null> {
    const result = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        timeoutMs: 10_000,
        env: buildScmNonInteractiveEnv(),
    });
    if (!result.success) return null;
    const head = result.stdout.trim();
    if (!head || head === 'HEAD') return null;
    return head;
}

function validateBranchName(name: string): { ok: true } | { ok: false; error: string } {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) return { ok: false, error: 'Branch name cannot be empty' };
    if (trimmed.includes('\0')) return { ok: false, error: 'Branch name contains null bytes' };
    if (trimmed.startsWith('-')) return { ok: false, error: 'Branch name cannot start with "-"' };
    return { ok: true };
}

export async function gitBranchList(input: {
    context: ScmBackendContext;
    request: ScmBranchListRequest;
}): Promise<ScmBranchListResponse> {
    const locals = await runScmCommand({
        bin: 'git',
        cwd: input.context.cwd,
        args: [
            'for-each-ref',
            '--format=%(refname:short)\t%(HEAD)\t%(upstream:short)',
            'refs/heads',
        ],
        timeoutMs: 15_000,
        env: buildScmNonInteractiveEnv(),
    });

    if (!locals.success) {
        return {
            success: false,
            errorCode: mapGitErrorCode(locals.stderr),
            error: locals.stderr || 'Failed to list branches',
        };
    }

    const branches: ScmBranchListEntry[] = [];
    for (const line of locals.stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [nameRaw, headMarkerRaw, upstreamRaw] = trimmed.split('\t');
        const name = (nameRaw ?? '').trim();
        if (!name) continue;
        const headMarker = (headMarkerRaw ?? '').trim();
        const upstream = (upstreamRaw ?? '').trim();
        branches.push({
            name,
            type: 'local',
            isCurrent: headMarker === '*',
            upstream: upstream ? upstream : null,
        });
    }

    if (input.request.includeRemotes) {
        const remotes = await runScmCommand({
            bin: 'git',
            cwd: input.context.cwd,
            args: [
                'for-each-ref',
                '--format=%(refname:short)\t%(HEAD)',
                'refs/remotes',
            ],
            timeoutMs: 15_000,
            env: buildScmNonInteractiveEnv(),
        });

        if (!remotes.success) {
            return {
                success: false,
                errorCode: mapGitErrorCode(remotes.stderr),
                error: remotes.stderr || 'Failed to list remote branches',
            };
        }

        for (const line of remotes.stdout.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const [nameRaw, headMarkerRaw] = trimmed.split('\t');
            const name = (nameRaw ?? '').trim();
            if (!name || name.endsWith('/HEAD')) continue;
            const headMarker = (headMarkerRaw ?? '').trim();
            branches.push({
                name,
                type: 'remote',
                isCurrent: headMarker === '*',
            });
        }
    }

    return {
        success: true,
        branches,
    };
}

export async function gitBranchCreate(input: {
    context: ScmBackendContext;
    request: ScmBranchCreateRequest;
}): Promise<ScmBranchCreateResponse> {
    const validation = validateBranchName(input.request.name);
    if (!validation.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: validation.error,
        };
    }

    const startPointValidation = validateStartPoint(input.request.startPoint);
    if (!startPointValidation.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: startPointValidation.error,
        };
    }

    if (input.request.checkout) {
        const switched = await runGitSwitchCreate({
            cwd: input.context.cwd,
            name: input.request.name,
            startPoint: input.request.startPoint,
        });

        const response: ScmBranchCreateResponse = switched.success
            ? { success: true, stdout: switched.stdout, stderr: switched.stderr }
            : branchMutationFailure({ context: input.context, result: switched, fallback: 'Branch creation failed' });
        invalidateAfterBranchMutation({
            response,
            context: input.context,
            headBranch: input.request.name,
        });
        return response;
    }

    const args = ['branch', '--', input.request.name, ...(input.request.startPoint ? [input.request.startPoint] : [])];

    const result = await runScmCommand({
        bin: 'git',
        cwd: input.context.cwd,
        args,
        timeoutMs: 30_000,
        env: buildScmNonInteractiveEnv(),
    });

    const response: ScmBranchCreateResponse = result.success
        ? { success: true, stdout: result.stdout, stderr: result.stderr }
        : branchMutationFailure({ context: input.context, result, fallback: 'Branch creation failed' });
    invalidateAfterBranchMutation({ response, context: input.context });
    return response;
}

/** Materialize an exact fetched commit without moving a local branch. */
export async function gitDetachedCheckout(input: Readonly<{
    context: ScmBackendContext;
    commit: string;
    signal?: AbortSignal;
}>): Promise<ScmBranchCheckoutResponse> {
    const result = await runGitSwitch({ cwd: input.context.cwd, name: input.commit, detach: true,
        ...(input.signal ? { signal: input.signal } : {}) });
    const response: ScmBranchCheckoutResponse = result.success
        ? { success: true, stdout: result.stdout, stderr: result.stderr }
        : branchMutationFailure({ context: input.context, result, fallback: 'Ref checkout failed' });
    invalidateAfterBranchMutation({ response, context: input.context });
    return response;
}

export async function gitBranchCheckout(input: {
    context: ScmBackendContext;
    request: ScmBranchCheckoutRequest;
}): Promise<ScmBranchCheckoutResponse> {
    const validation = validateBranchName(input.request.name);
    if (!validation.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: validation.error,
        };
    }

    if (input.request.strategy === 'stash_on_current_branch') {
        const currentBranch = await readCurrentBranchName(input.context);
        if (!currentBranch) {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                error: 'Branch switching with stashing requires an active branch',
            };
        }

        const managed = await listGitManagedStashes(input.context);
        if (!managed.ok) {
            return {
                success: false,
                errorCode: managed.errorCode,
                error: managed.error,
            };
        }

        const existing = managed.managed.filter((stash) => stash.kind === 'branch' && stash.branch === currentBranch);
        if (existing.length > 0 && input.request.overwriteCurrentBranchStash !== true) {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                error: 'A stash already exists for the current branch',
            };
        }

        const created = await createGitStashPush({
            context: input.context,
            message: buildHappierBranchStashMarker(currentBranch),
        });
        if (!created.ok) {
            return {
                success: false,
                errorCode: created.errorCode,
                error: created.error,
                stdout: created.stdout,
                stderr: created.stderr,
                outcome: created.outcome,
            };
        }

        const switched = await runGitSwitch({ cwd: input.context.cwd, name: input.request.name });
        if (!switched.success) {
            return {
                ...branchMutationFailure({ context: input.context, result: switched, fallback: 'Branch checkout failed', ...(created.stashOid ? { recoveryStash: { stashOid: created.stashOid, ...(created.stashRef ? { stashRef: created.stashRef } : {}) } } : {}) }),
                stdout: `${created.stdout}\n${switched.stdout}`.trim() || undefined,
                stderr: `${created.stderr}\n${switched.stderr}`.trim() || undefined,
                didCreateStash: created.stashCreated,
                didPopStash: false,
                stashRef: created.stashRef,
                ...(created.stashOid ? { stashOid: created.stashOid } : {}),
            };
        }

        // Keep the superseded recovery objects until a replacement exists and the switch succeeded.
        if (created.stashCreated && created.stashOid) {
            for (const entry of existing) {
                if (!entry.stashOid) continue;
                const dropped = await dropGitStashOid({ context: input.context, stashOid: entry.stashOid });
                if (!dropped.ok) return { success: false, errorCode: dropped.errorCode, error: dropped.error, stdout: dropped.stdout, stderr: dropped.stderr, didCreateStash: true, didPopStash: false, stashRef: created.stashRef, stashOid: created.stashOid, outcome: { v: 1, kind: 'effect_applied_with_warning', errorCode: dropped.errorCode, effect: { kind: 'branch', name: input.request.name }, recoveryStash: { stashOid: created.stashOid, ...(created.stashRef ? { stashRef: created.stashRef } : {}) }, nextActions: [{ kind: 'refresh' }] } };
            }
        }

        const response: ScmBranchCheckoutResponse = {
            success: true,
            stdout: `${created.stdout}\n${switched.stdout}`.trim() || undefined,
            stderr: `${created.stderr}\n${switched.stderr}`.trim() || undefined,
            didCreateStash: created.stashCreated,
            didPopStash: false,
            stashRef: created.stashRef,
            ...(created.stashOid ? { stashOid: created.stashOid } : {}),
        };
        invalidateAfterBranchMutation({
            response,
            context: input.context,
            headBranch: input.request.name,
        });
        return response;
    }

    const switched = await runGitSwitch({ cwd: input.context.cwd, name: input.request.name });
    if (switched.success) {
        const response: ScmBranchCheckoutResponse = {
            success: true,
            stdout: switched.stdout,
            stderr: switched.stderr,
            didCreateStash: false,
            didPopStash: false,
            stashRef: null,
        };
        invalidateAfterBranchMutation({
            response,
            context: input.context,
            headBranch: input.request.name,
        });
        return response;
    }

    if (getScmCommandIndeterminateErrorCode(switched) || !isLocalChangesOverwrittenError(switched.stderr)) return branchMutationFailure({ context: input.context, result: switched, fallback: 'Branch checkout failed' });

    const transientMarker = buildHappierTransientStashMarker(input.request.name);
    const created = await createGitStashPush({
        context: input.context,
        message: transientMarker,
    });
    if (!created.ok) {
        return {
            success: false,
            errorCode: created.errorCode,
            error: created.error,
            stdout: created.stdout,
            stderr: created.stderr,
            outcome: created.outcome,
        };
    }

    const switchedAfterStash = await runGitSwitch({ cwd: input.context.cwd, name: input.request.name });
    if (!switchedAfterStash.success) {
        return {
            ...branchMutationFailure({ context: input.context, result: switchedAfterStash, fallback: 'Branch checkout failed', ...(created.stashOid ? { recoveryStash: { stashOid: created.stashOid, ...(created.stashRef ? { stashRef: created.stashRef } : {}) } } : {}) }),
            stdout: `${created.stdout}\n${switchedAfterStash.stdout}`.trim() || undefined,
            stderr: `${created.stderr}\n${switchedAfterStash.stderr}`.trim() || undefined,
            didCreateStash: created.stashCreated,
            didPopStash: false,
            stashRef: created.stashRef,
            ...(created.stashOid ? { stashOid: created.stashOid } : {}),
        };
    }

    // If the stash command reported "no local changes", do not attempt to pop an unrelated stash.
    if (!created.stashCreated) {
        const response: ScmBranchCheckoutResponse = {
            success: true,
            stdout: `${created.stdout}\n${switchedAfterStash.stdout}`.trim() || undefined,
            stderr: `${created.stderr}\n${switchedAfterStash.stderr}`.trim() || undefined,
            didCreateStash: false,
            didPopStash: false,
            stashRef: null,
        };
        invalidateAfterBranchMutation({
            response,
            context: input.context,
            headBranch: input.request.name,
        });
        return response;
    }

    if (!created.stashOid) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: 'Transient stash was created but no stashRef was returned',
            stdout: `${created.stdout}\n${switchedAfterStash.stdout}`.trim() || undefined,
            stderr: `${created.stderr}\n${switchedAfterStash.stderr}`.trim() || undefined,
            didCreateStash: true,
            didPopStash: false,
            stashRef: null,
        };
    }

    const pop = await gitStashPop({ context: input.context, request: { stashRef: created.stashOid } });

    if (!pop.success) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED,
            error: pop.stderr || 'Failed to apply stashed changes',
            stdout: `${created.stdout}\n${switchedAfterStash.stdout}\n${pop.stdout}`.trim() || undefined,
            stderr: `${created.stderr}\n${switchedAfterStash.stderr}\n${pop.stderr}`.trim() || undefined,
            didCreateStash: created.stashCreated,
            didPopStash: false,
            stashRef: created.stashRef,
            stashOid: created.stashOid,
            outcome: pop.outcome,
        };
    }

    const response: ScmBranchCheckoutResponse = {
        success: true,
        stdout: `${created.stdout}\n${switchedAfterStash.stdout}\n${pop.stdout}`.trim() || undefined,
        stderr: `${created.stderr}\n${switchedAfterStash.stderr}\n${pop.stderr}`.trim() || undefined,
        didCreateStash: created.stashCreated,
        didPopStash: true,
        stashRef: created.stashRef,
        stashOid: created.stashOid,
        outcome: pop.outcome,
    };
    invalidateAfterBranchMutation({
        response,
        context: input.context,
        headBranch: input.request.name,
    });
    return response;
}
