import type {
    ScmOperationErrorCode,
    ScmStashApplyRequest,
    ScmStashApplyResponse,
    ScmStashDropRequest,
    ScmStashDropResponse,
    ScmStashEntry,
    ScmStashListRequest,
    ScmStashListResponse,
    ScmStashPopRequest,
    ScmStashPopResponse,
    ScmStashShowRequest,
    ScmStashShowResponse,
} from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import type { ScmBackendContext } from '../../../types';
import { runScmCommand } from '../../../runtime';
import { buildScmNonInteractiveEnv } from '../../shared/nonInteractiveEnv';
import { mapGitErrorCode } from '../remote';

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
const NO_LOCAL_CHANGES_REGEX = /no local changes to save/i;
const STASH_CONFLICT_REGEX = /conflict|needs merge|merge conflict/i;

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
    message: string;
};

async function readGitStashList(context: ScmBackendContext): Promise<
    | { ok: true; rows: GitStashListRow[] }
    | { ok: false; errorCode: ScmOperationErrorCode; error: string; stdout?: string; stderr?: string }
> {
    const result = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['stash', 'list'],
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
        const colonIndex = trimmed.indexOf(':');
        if (colonIndex <= 0) continue;
        const stashRef = trimmed.slice(0, colonIndex).trim();
        const message = trimmed.slice(colonIndex + 1).trim();
        if (!stashRef) continue;
        rows.push({ stashRef, message });
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

export async function createGitStashPush(input: {
    context: ScmBackendContext;
    message: string;
}): Promise<
    | { ok: true; stashCreated: boolean; stashRef: string | null; stdout: string; stderr: string }
    | { ok: false; errorCode: ScmOperationErrorCode; error: string; stdout: string; stderr: string }
> {
    const push = await runScmCommand({
        bin: 'git',
        cwd: input.context.cwd,
        args: ['stash', 'push', '-u', '-m', input.message],
        timeoutMs: 30_000,
        env: buildScmNonInteractiveEnv(),
    });

    if (!push.success) {
        return {
            ok: false,
            errorCode: mapGitErrorCode(push.stderr),
            error: push.stderr || 'Stash creation failed',
            stdout: push.stdout,
            stderr: push.stderr,
        };
    }

    const combined = `${push.stdout}\n${push.stderr}`;
    if (NO_LOCAL_CHANGES_REGEX.test(combined)) {
        return {
            ok: true,
            stashCreated: false,
            stashRef: null,
            stdout: push.stdout,
            stderr: push.stderr,
        };
    }

    // Resolve the actual created stash ref from git state
    const list = await readGitStashList(input.context);
    if (!list.ok) {
        return {
            ok: false,
            errorCode: list.errorCode,
            error: list.error,
            stdout: push.stdout,
            stderr: push.stderr,
        };
    }

    // Find the stash entry that matches our message
    const createdStash = list.rows.find((row) => row.message.includes(input.message));
    if (!createdStash) {
        return {
            ok: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: 'Stash was created but could not be found in stash list',
            stdout: push.stdout,
            stderr: push.stderr,
        };
    }

    return {
        ok: true,
        stashCreated: true,
        stashRef: createdStash.stashRef,
        stdout: push.stdout,
        stderr: push.stderr,
    };
}

export async function dropGitStashRef(input: {
    context: ScmBackendContext;
    stashRef: string;
}): Promise<
    | { ok: true }
    | { ok: false; errorCode: ScmOperationErrorCode; error: string; stdout: string; stderr: string }
> {
    const drop = await runScmCommand({
        bin: 'git',
        cwd: input.context.cwd,
        args: ['stash', 'drop', input.stashRef],
        timeoutMs: 15_000,
        env: buildScmNonInteractiveEnv(),
    });

    if (!drop.success) {
        return {
            ok: false,
            errorCode: mapGitErrorCode(drop.stderr),
            error: drop.stderr || 'Stash drop failed',
            stdout: drop.stdout,
            stderr: drop.stderr,
        };
    }

    return { ok: true };
}

function mapApplyLikeErrorCode(stderr: string): ScmOperationErrorCode {
    return STASH_CONFLICT_REGEX.test(stderr)
        ? SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED
        : mapGitErrorCode(stderr);
}

export async function gitStashList(input: {
    context: ScmBackendContext;
    request: ScmStashListRequest;
}): Promise<ScmStashListResponse> {
    const managed = await listGitManagedStashes(input.context);
    if (!managed.ok) {
        return {
            success: false,
            errorCode: managed.errorCode,
            error: managed.error,
        };
    }

    return {
        success: true,
        managedStashes: managed.managed,
        managedCount: managed.managed.length,
        totalCount: managed.totalCount,
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

    const drop = await runScmCommand({
        bin: 'git',
        cwd: input.context.cwd,
        args: ['stash', 'drop', stashRef.value],
        timeoutMs: 15_000,
        env: buildScmNonInteractiveEnv(),
    });

    return drop.success
        ? { success: true, stdout: drop.stdout, stderr: drop.stderr }
        : {
            success: false,
            errorCode: mapGitErrorCode(drop.stderr),
            error: drop.stderr || 'Stash drop failed',
            stdout: drop.stdout,
            stderr: drop.stderr,
        };
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

    const pop = await runScmCommand({
        bin: 'git',
        cwd: input.context.cwd,
        args: ['stash', 'pop', stashRef.value],
        timeoutMs: 30_000,
        env: buildScmNonInteractiveEnv(),
    });

    return pop.success
        ? { success: true, stdout: pop.stdout, stderr: pop.stderr }
        : {
            success: false,
            errorCode: mapApplyLikeErrorCode(pop.stderr),
            error: pop.stderr || 'Stash pop failed',
            stdout: pop.stdout,
            stderr: pop.stderr,
        };
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

    const apply = await runScmCommand({
        bin: 'git',
        cwd: input.context.cwd,
        args: ['stash', 'apply', stashRef.value],
        timeoutMs: 30_000,
        env: buildScmNonInteractiveEnv(),
    });

    return apply.success
        ? { success: true, stdout: apply.stdout, stderr: apply.stderr }
        : {
            success: false,
            errorCode: mapApplyLikeErrorCode(apply.stderr),
            error: apply.stderr || 'Stash apply failed',
            stdout: apply.stdout,
            stderr: apply.stderr,
        };
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
