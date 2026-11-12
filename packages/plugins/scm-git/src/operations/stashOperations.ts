import type {
  ScmOperationErrorCode,
  ScmOperationOutcome,
  ScmStashApplyRequest,
  ScmStashApplyResponse,
  ScmStashDropRequest,
  ScmStashDropResponse,
  ScmStashCreateRequest,
  ScmStashCreateResponse,
  ScmStashEntry,
  ScmStashListRequest,
  ScmStashListResponse,
  ScmStashPopRequest,
  ScmStashPopResponse,
  ScmStashShowRequest,
  ScmStashShowResponse,
} from '@happier-dev/plugin-sdk/scm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';

import type { ScmBackendContext } from '../types.js';
import { getScmCommandIndeterminateErrorCode, runScmCommand } from '../runtime.js';
import { buildScmNonInteractiveEnv } from '../providers/shared/nonInteractiveEnv.js';
import { mapGitErrorCode } from '../remote.js';
import { readGitOperationRepositoryState } from './branchOperationState.js';

function validateStashRef(stashRef: string): { ok: true; value: string } | { ok: false; error: string } {
    const normalized = String(stashRef ?? '').trim();
    if (!normalized) {
        return { ok: false, error: 'Stash ref cannot be empty' };
    }
    if (normalized.startsWith('-')) {
        return { ok: false, error: 'Stash ref cannot start with "-"' };
    }
    return { ok: true, value: normalized };
}

export const HAPPIER_MANAGED_STASH_MARKERS = {
    branch: '!!Happier<',
    transient: '!!HappierTransient<',
} as const;

const MANAGED_STASH_MARKER_SUFFIX = '>';

export function buildHappierBranchStashMarker(branchName: string): string {
    return `!!Happier<${branchName}>`;
}

export function buildHappierTransientStashMarker(branchName: string): string {
    return `!!HappierTransient<${branchName}>`;
}

type ParsedManagedStashMarker =
    | { kind: 'branch'; branch: string }
    | { kind: 'transient'; branch: string };

function parseManagedStashBranchName(message: string, markerPrefix: string): string | null {
    const markerIndex = message.indexOf(markerPrefix);
    if (markerIndex < 0) return null;
    const branchStart = markerIndex + markerPrefix.length;
    const markerEnd = message.lastIndexOf(MANAGED_STASH_MARKER_SUFFIX);
    if (markerEnd < branchStart) return null;
    const branchName = message.slice(branchStart, markerEnd);
    return branchName.length > 0 ? branchName : null;
}

function parseManagedStashMarker(message: string): ParsedManagedStashMarker | null {
    const transientBranch = parseManagedStashBranchName(message, HAPPIER_MANAGED_STASH_MARKERS.transient);
    if (transientBranch) {
        return { kind: 'transient', branch: transientBranch };
    }
    const persistentBranch = parseManagedStashBranchName(message, HAPPIER_MANAGED_STASH_MARKERS.branch);
    if (persistentBranch) {
        return { kind: 'branch', branch: persistentBranch };
    }
    return null;
}

type GitStashListRow = {
    stashRef: string;
    stashOid: string;
    message: string;
};

function buildScmStashEntryFromGitRow(row: GitStashListRow): ScmStashEntry {
    const marker = parseManagedStashMarker(row.message);
    if (!marker) {
        return {
            stashRef: row.stashRef,
            stashOid: row.stashOid,
            kind: 'unmanaged',
            message: row.message,
        };
    }
    return {
        stashRef: row.stashRef,
        stashOid: row.stashOid,
        kind: marker.kind,
        branch: marker.branch,
        message: row.message,
    };
}

async function readGitStashList(context: ScmBackendContext): Promise<
    | { ok: true; rows: GitStashListRow[] }
    | { ok: false; errorCode: ScmOperationErrorCode; error: string; stdout?: string; stderr?: string }
> {
    const result = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['stash', 'list', '--format=%gd%x00%H%x00%gs'],
        timeoutMs: 15_000,
        env: buildScmNonInteractiveEnv(),
    });

    if (!result.success) {
        return {
            ok: false,
            errorCode: mapGitErrorCode(result.stderr),
            error: result.stderr || 'Failed to list stashes',
            stdout: result.stdout,
            stderr: result.stderr,
        };
    }

    const rows: GitStashListRow[] = [];
    for (const line of result.stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [stashRef, stashOid, message] = trimmed.split('\0');
        if (!stashRef || !stashOid || message === undefined) continue;
        rows.push({ stashRef, stashOid, message });
    }

    return { ok: true, rows };
}

export async function listGitManagedStashes(context: ScmBackendContext): Promise<
    | { ok: true; totalCount: number; managed: ScmStashEntry[] }
    | { ok: false; errorCode: ScmOperationErrorCode; error: string }
> {
    const list = await readGitStashList(context);
    if (!list.ok) {
        return { ok: false, errorCode: list.errorCode, error: list.error };
    }

    const managed: ScmStashEntry[] = [];
    for (const row of list.rows) {
        const marker = parseManagedStashMarker(row.message);
        if (!marker) continue;
        managed.push({
            stashRef: row.stashRef,
            stashOid: row.stashOid,
            kind: marker.kind,
            branch: marker.branch,
            message: row.message,
        });
    }

    return {
        ok: true,
        totalCount: list.rows.length,
        managed,
    };
}

export async function listGitStashes(context: ScmBackendContext): Promise<
    | { ok: true; totalCount: number; stashes: ScmStashEntry[] }
    | { ok: false; errorCode: ScmOperationErrorCode; error: string }
> {
    const list = await readGitStashList(context);
    if (!list.ok) {
        return { ok: false, errorCode: list.errorCode, error: list.error };
    }
    return {
        ok: true,
        totalCount: list.rows.length,
        stashes: list.rows.map(buildScmStashEntryFromGitRow),
    };
}

export async function createGitStashPush(input: {
    context: ScmBackendContext;
    message: string;
}): Promise<
    | { ok: true; stashCreated: boolean; stashRef: string | null; stashOid: string | null; stdout: string; stderr: string }
    | { ok: false; errorCode: ScmOperationErrorCode; error: string; stdout: string; stderr: string; outcome?: ScmOperationOutcome }
> {
    const before = await readGitStashList(input.context);
    if (!before.ok) return { ...before, stdout: before.stdout ?? '', stderr: before.stderr ?? '' };
    const status = await runScmCommand({ bin: 'git', cwd: input.context.cwd, args: ['status', '--porcelain', '-z', '--untracked-files=all'], timeoutMs: 15_000, env: buildScmNonInteractiveEnv() });
    if (!status.success) return { ok: false, errorCode: mapGitErrorCode(status.stderr), error: status.stderr || 'Failed to inspect changes before stashing', stdout: status.stdout, stderr: status.stderr };
    if (!status.stdout) return { ok: true, stashCreated: false, stashRef: null, stashOid: null, stdout: '', stderr: '' };
    const push = await runScmCommand({
        bin: 'git',
        cwd: input.context.cwd,
        args: ['stash', 'push', '-u', '-m', input.message],
        timeoutMs: 30_000,
        env: buildScmNonInteractiveEnv(),
    });

    // The reflog/object delta proves creation; messages remain presentation only.
    const list = await readGitStashList(input.context);
    if (!list.ok) {
        return {
            ok: false,
            errorCode: list.errorCode,
            error: list.error,
            stdout: push.stdout,
            stderr: push.stderr,
            outcome: { v: 1, kind: 'outcome_unknown', errorCode: list.errorCode, reconciliation: { kind: 'stash', message: input.message }, nextActions: [{ kind: 'refresh' }] },
        };
    }

    const createdStash = list.rows[0];
    const created = createdStash && (before.rows[0]?.stashOid !== createdStash.stashOid || before.rows.length !== list.rows.length);
    if (!push.success) {
        const indeterminateErrorCode = getScmCommandIndeterminateErrorCode(push);
        const errorCode = indeterminateErrorCode ?? mapGitErrorCode(push.stderr);
        return { ok: false, errorCode, error: push.stderr || 'Stash creation failed', stdout: push.stdout, stderr: push.stderr,
            outcome: created ? { v: 1, kind: 'effect_applied_with_warning', errorCode, effect: { kind: 'stash', stashOid: createdStash.stashOid, stashRef: createdStash.stashRef }, recoveryStash: { stashOid: createdStash.stashOid, stashRef: createdStash.stashRef }, nextActions: [{ kind: 'refresh' }] } : indeterminateErrorCode ? { v: 1, kind: 'outcome_unknown', errorCode, reconciliation: { kind: 'stash', message: input.message }, nextActions: [{ kind: 'refresh' }] } : { v: 1, kind: 'failed', errorCode, nextActions: [] } };
    }
    if (!created) return { ok: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, error: 'Could not prove stash creation', stdout: push.stdout, stderr: push.stderr, outcome: { v: 1, kind: 'outcome_unknown', errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, reconciliation: { kind: 'stash', message: input.message }, nextActions: [{ kind: 'refresh' }] } };

    return {
        ok: true,
        stashCreated: true,
        stashRef: createdStash.stashRef,
        stashOid: createdStash.stashOid,
        stdout: push.stdout,
        stderr: push.stderr,
    };
}

export async function gitStashCreate(input: {
    context: ScmBackendContext;
    request: ScmStashCreateRequest;
}): Promise<ScmStashCreateResponse> {
    const branch = await runScmCommand({
        bin: 'git', cwd: input.context.cwd, args: ['branch', '--show-current'], timeoutMs: 10_000,
    });
    if (!branch.success) {
        return { success: false, errorCode: mapGitErrorCode(branch.stderr), error: branch.stderr || 'Failed to read current branch' };
    }
    const marker = buildHappierTransientStashMarker(branch.stdout.trim() || 'HEAD');
    const message = input.request.message?.trim();
    const result = await createGitStashPush({
        context: input.context,
        message: message ? `${marker} ${message}` : marker,
    });
    return result.ok
        ? { success: true, stashCreated: result.stashCreated, stashRef: result.stashRef, ...(result.stashOid ? { stashOid: result.stashOid } : {}), stdout: result.stdout, stderr: result.stderr, outcome: { v: 1, kind: 'succeeded', nextActions: [], ...(result.stashOid ? { effect: { kind: 'stash', stashOid: result.stashOid, ...(result.stashRef ? { stashRef: result.stashRef } : {}) } } : {}) } }
        : { success: false, errorCode: result.errorCode, error: result.error, stdout: result.stdout, stderr: result.stderr, outcome: result.outcome ?? { v: 1, kind: 'failed', errorCode: result.errorCode, nextActions: [] } };
}

export async function resolveGitStashIdentity(input: { context: ScmBackendContext; stashRef: string }): Promise<
    | { ok: true; stashOid: string; stashRef?: string }
    | { ok: false; errorCode: ScmOperationErrorCode; error: string; stdout: string; stderr: string }
> {
    const ref = validateStashRef(input.stashRef);
    if (!ref.ok) return { ok: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, error: ref.error, stdout: '', stderr: '' };
    const resolved = await runScmCommand({ bin: 'git', cwd: input.context.cwd, args: ['rev-parse', '--verify', `${ref.value}^{commit}`], timeoutMs: 15_000, env: buildScmNonInteractiveEnv() });
    if (!resolved.success) return { ok: false, errorCode: mapGitErrorCode(resolved.stderr), error: resolved.stderr || 'Failed to resolve stash identity', stdout: resolved.stdout, stderr: resolved.stderr };
    const stashOid = resolved.stdout.trim();
    const list = await readGitStashList(input.context);
    if (!list.ok) return { ...list, stdout: list.stdout ?? '', stderr: list.stderr ?? '' };
    return { ok: true, stashOid, stashRef: list.rows.find((row) => row.stashOid === stashOid)?.stashRef };
}

export function applyGitStashOid(input: { context: ScmBackendContext; stashOid: string; restoreIndex?: boolean }) {
    return runScmCommand({ bin: 'git', cwd: input.context.cwd, args: ['stash', 'apply', ...(input.restoreIndex ? ['--index'] : []), input.stashOid], timeoutMs: 30_000, env: buildScmNonInteractiveEnv() });
}

export async function dropGitStashOid(input: { context: ScmBackendContext; stashOid: string }): Promise<
    | { ok: true; stdout: string; stderr: string }
    | { ok: false; errorCode: ScmOperationErrorCode; error: string; stdout: string; stderr: string; outcome?: ScmOperationOutcome }
> {
    const list = await readGitStashList(input.context);
    if (!list.ok) return { ...list, stdout: list.stdout ?? '', stderr: list.stderr ?? '' };
    const target = list.rows.find((row) => row.stashOid === input.stashOid);
    if (!target) return { ok: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, error: 'Stash object is no longer present in the stash list', stdout: '', stderr: '' };
    const result = await runScmCommand({ bin: 'git', cwd: input.context.cwd, args: ['stash', 'drop', target.stashRef], timeoutMs: 15_000, env: buildScmNonInteractiveEnv() });
    const indeterminateErrorCode = getScmCommandIndeterminateErrorCode(result);
    if (indeterminateErrorCode) return { ok: false, errorCode: indeterminateErrorCode, error: result.stderr || 'Stash drop completion could not be determined', stdout: result.stdout, stderr: result.stderr, outcome: { v: 1, kind: 'outcome_unknown', errorCode: indeterminateErrorCode, reconciliation: { kind: 'stash', stashOid: input.stashOid }, recoveryStash: { stashOid: input.stashOid, stashRef: target.stashRef }, nextActions: [{ kind: 'refresh' }] } };
    return result.success ? { ok: true, stdout: result.stdout, stderr: result.stderr } : { ok: false, errorCode: mapGitErrorCode(result.stderr), error: result.stderr || 'Stash drop failed', stdout: result.stdout, stderr: result.stderr };
}

export async function dropGitStashRef(input: {
    context: ScmBackendContext;
    stashRef: string;
}): Promise<
    | { ok: true }
    | { ok: false; errorCode: ScmOperationErrorCode; error: string; stdout: string; stderr: string }
> {
    const identity = await resolveGitStashIdentity(input);
    return identity.ok ? dropGitStashOid({ context: input.context, stashOid: identity.stashOid }) : identity;
}

export async function gitStashList(input: {
    context: ScmBackendContext;
    request: ScmStashListRequest;
}): Promise<ScmStashListResponse> {
    const stashes = await listGitStashes(input.context);
    if (!stashes.ok) {
        return {
            success: false,
            errorCode: stashes.errorCode,
            error: stashes.error,
        };
    }

    const managedStashes = stashes.stashes.filter((entry) => entry.kind !== 'unmanaged');
    return {
        success: true,
        stashes: stashes.stashes,
        managedStashes,
        managedCount: managedStashes.length,
        totalCount: stashes.totalCount,
    };
}

export async function gitStashDrop(input: {
    context: ScmBackendContext;
    request: ScmStashDropRequest;
}): Promise<ScmStashDropResponse> {
    const stashRef = validateStashRef(input.request.stashRef);
    if (!stashRef.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: stashRef.error,
            stdout: '',
            stderr: '',
        };
    }

    const identity = await resolveGitStashIdentity({ context: input.context, stashRef: stashRef.value });
    if (!identity.ok) return { success: false, ...identity };
    const dropped = await dropGitStashOid({ context: input.context, stashOid: identity.stashOid });
    return dropped.ok ? { success: true, stdout: dropped.stdout, stderr: dropped.stderr, outcome: { v: 1, kind: 'succeeded', nextActions: [] } } : { success: false, errorCode: dropped.errorCode, error: dropped.error, stdout: dropped.stdout, stderr: dropped.stderr, outcome: dropped.outcome ?? { v: 1, kind: 'failed', errorCode: dropped.errorCode, nextActions: [], recoveryStash: { stashOid: identity.stashOid, ...(identity.stashRef ? { stashRef: identity.stashRef } : {}) } } };
}

export async function gitStashPop(input: {
    context: ScmBackendContext;
    request: ScmStashPopRequest;
}): Promise<ScmStashPopResponse> {
    const stashRef = validateStashRef(input.request.stashRef);
    if (!stashRef.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: stashRef.error,
            stdout: '',
            stderr: '',
        };
    }

    return applyStash({ context: input.context, stashRef: stashRef.value, dropAfterApply: true });
}

export async function gitStashApply(input: {
    context: ScmBackendContext;
    request: ScmStashApplyRequest;
}): Promise<ScmStashApplyResponse> {
    const stashRef = validateStashRef(input.request.stashRef);
    if (!stashRef.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: stashRef.error,
            stdout: '',
            stderr: '',
        };
    }

    return applyStash({ context: input.context, stashRef: stashRef.value, dropAfterApply: false });
}

async function applyStash(input: { context: ScmBackendContext; stashRef: string; dropAfterApply: boolean }): Promise<ScmStashApplyResponse> {
    const identity = await resolveGitStashIdentity(input);
    if (!identity.ok) return { success: false, errorCode: identity.errorCode, error: identity.error, stdout: identity.stdout, stderr: identity.stderr };
    const recoveryStash = { stashOid: identity.stashOid, ...(identity.stashRef ? { stashRef: identity.stashRef } : {}) };
    const applied = await applyGitStashOid({ context: input.context, stashOid: identity.stashOid });
    let repositoryState;
    try { repositoryState = await readGitOperationRepositoryState(input.context); }
    catch {
        if (applied.success) return { success: !input.dropAfterApply, errorCode: SCM_OPERATION_ERROR_CODES.REPOSITORY_REFRESH_FAILED, error: 'Stash applied, but repository refresh failed', stdout: applied.stdout, stderr: applied.stderr, outcome: { v: 1, kind: 'effect_applied_with_warning', errorCode: SCM_OPERATION_ERROR_CODES.REPOSITORY_REFRESH_FAILED, effect: { kind: 'stash', ...recoveryStash }, recoveryStash, nextActions: [{ kind: 'refresh' }] } };
        const indeterminateErrorCode = getScmCommandIndeterminateErrorCode(applied);
        const errorCode = indeterminateErrorCode ?? mapGitErrorCode(applied.stderr);
        return { success: false, errorCode, error: applied.stderr || 'Stash application failed and repository state could not be refreshed', stdout: applied.stdout, stderr: applied.stderr, outcome: indeterminateErrorCode
            ? { v: 1, kind: 'outcome_unknown', errorCode, reconciliation: { kind: 'stash', stashOid: identity.stashOid }, recoveryStash, nextActions: [{ kind: 'refresh' }] }
            : { v: 1, kind: 'failed', errorCode, recoveryStash, nextActions: [{ kind: 'refresh' }] } };
    }
    if (repositoryState.hasConflicts) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE, error: applied.stderr || 'Stash application left conflicts', stdout: applied.stdout, stderr: applied.stderr, outcome: { v: 1, kind: 'conflicted', errorCode: SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE, repositoryState, recoveryStash, nextActions: [{ kind: 'resolve_conflicts' }] } };
    const indeterminateErrorCode = getScmCommandIndeterminateErrorCode(applied);
    if (indeterminateErrorCode) return { success: false, errorCode: indeterminateErrorCode, error: applied.stderr || 'Stash application completion could not be determined', stdout: applied.stdout, stderr: applied.stderr, outcome: { v: 1, kind: 'outcome_unknown', errorCode: indeterminateErrorCode, repositoryState, recoveryStash, reconciliation: { kind: 'stash', stashOid: identity.stashOid }, nextActions: [{ kind: 'refresh' }] } };
    if (!applied.success) {
        const errorCode = mapGitErrorCode(applied.stderr);
        return { success: false, errorCode, error: applied.stderr || 'Stash application failed', stdout: applied.stdout, stderr: applied.stderr, outcome: { v: 1, kind: 'failed', errorCode, repositoryState, recoveryStash, nextActions: [] } };
    }
    if (input.dropAfterApply) {
        const dropped = await dropGitStashOid({ context: input.context, stashOid: identity.stashOid });
        if (!dropped.ok) return { success: false, errorCode: dropped.errorCode, error: dropped.error, stdout: applied.stdout, stderr: dropped.stderr, outcome: { v: 1, kind: 'effect_applied_with_warning', errorCode: dropped.errorCode, effect: { kind: 'stash', ...recoveryStash }, repositoryState, recoveryStash, nextActions: [{ kind: 'refresh' }] } };
    }
    return { success: true, stdout: applied.stdout, stderr: applied.stderr, outcome: { v: 1, kind: 'succeeded', repositoryState, nextActions: [] } };
}

export async function gitStashShow(input: {
    context: ScmBackendContext;
    request: ScmStashShowRequest;
}): Promise<ScmStashShowResponse> {
    const stashRef = validateStashRef(input.request.stashRef);
    if (!stashRef.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: stashRef.error,
        };
    }

    const show = await runScmCommand({
        bin: 'git',
        cwd: input.context.cwd,
        args: ['stash', 'show', '-p', '--include-untracked', '--no-color', stashRef.value],
        timeoutMs: 30_000,
        maxOutputBytes: input.request.maxBytes,
        env: buildScmNonInteractiveEnv(),
    });

    if (show.success) {
        return {
            success: true,
            diff: show.stdout,
            truncated: false,
        };
    }

    if (show.outputLimitExceeded) {
        return {
            success: true,
            diff: show.stdout,
            truncated: true,
        };
    }

    return {
        success: false,
        errorCode: mapGitErrorCode(show.stderr),
        error: show.stderr || 'Stash show failed',
    };
}
