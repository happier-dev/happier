import type {
    ScmBranchCheckoutRequest,
    ScmBranchCheckoutResponse,
    ScmBranchCreateRequest,
    ScmBranchCreateResponse,
    ScmBranchListEntry,
    ScmBranchListRequest,
    ScmBranchListResponse,
} from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import type { ScmBackendContext } from '../../../types';
import { runScmCommand } from '../../../runtime';
import { buildScmNonInteractiveEnv } from '../../shared/nonInteractiveEnv';
import { mapGitErrorCode } from '../remote';
import {
    buildHappierBranchStashMarker,
    buildHappierTransientStashMarker,
    createGitStashPush,
    dropGitStashRef,
    listGitManagedStashes,
} from './stashOperations';

const LOCAL_CHANGES_OVERWRITTEN_ERROR_REGEX =
    /local changes.*would be overwritten|untracked working tree files.*would be overwritten|please commit your changes or stash them/i;
const GIT_BRANCH_SWITCH_TIMEOUT_MS = 60_000;

function isLocalChangesOverwrittenError(stderr: string): boolean {
    return LOCAL_CHANGES_OVERWRITTEN_ERROR_REGEX.test(stderr.toLowerCase());
}

async function runGitSwitch(input: {
    cwd: string;
    name: string;
}): Promise<{ success: boolean; stdout: string; stderr: string }> {
    const switchResult = await runScmCommand({
        bin: 'git',
        cwd: input.cwd,
        args: ['switch', input.name],
        timeoutMs: GIT_BRANCH_SWITCH_TIMEOUT_MS,
        env: buildScmNonInteractiveEnv(),
    });

    if (switchResult.success) {
        return { success: true, stdout: switchResult.stdout, stderr: switchResult.stderr };
    }

    // Fallback for older git installs without `switch`.
    if (/unknown subcommand: switch|is not a git command/i.test(switchResult.stderr)) {
        const checkoutResult = await runScmCommand({
            bin: 'git',
            cwd: input.cwd,
            args: ['checkout', input.name],
            timeoutMs: GIT_BRANCH_SWITCH_TIMEOUT_MS,
            env: buildScmNonInteractiveEnv(),
        });
        return {
            success: checkoutResult.success,
            stdout: checkoutResult.stdout,
            stderr: checkoutResult.stderr,
        };
    }

    return { success: false, stdout: switchResult.stdout, stderr: switchResult.stderr };
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

    const args = input.request.checkout
        ? ['switch', '-c', input.request.name, ...(input.request.startPoint ? [input.request.startPoint] : [])]
        : ['branch', '--', input.request.name, ...(input.request.startPoint ? [input.request.startPoint] : [])];

    const result = await runScmCommand({
        bin: 'git',
        cwd: input.context.cwd,
        args,
        timeoutMs: 30_000,
        env: buildScmNonInteractiveEnv(),
    });

    return result.success
        ? { success: true, stdout: result.stdout, stderr: result.stderr }
        : {
            success: false,
            errorCode: mapGitErrorCode(result.stderr),
            error: result.stderr || 'Branch creation failed',
            stdout: result.stdout,
            stderr: result.stderr,
        };
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

        for (const entry of existing) {
            const dropped = await dropGitStashRef({ context: input.context, stashRef: entry.stashRef });
            if (!dropped.ok) {
                return {
                    success: false,
                    errorCode: dropped.errorCode,
                    error: dropped.error,
                    stdout: dropped.stdout,
                    stderr: dropped.stderr,
                };
            }
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
            };
        }

        const switched = await runGitSwitch({ cwd: input.context.cwd, name: input.request.name });
        if (!switched.success) {
            return {
                success: false,
                errorCode: mapGitErrorCode(switched.stderr),
                error: switched.stderr || 'Branch checkout failed',
                stdout: `${created.stdout}\n${switched.stdout}`.trim() || undefined,
                stderr: `${created.stderr}\n${switched.stderr}`.trim() || undefined,
                didCreateStash: created.stashCreated,
                didPopStash: false,
                stashRef: created.stashRef,
            };
        }

        return {
            success: true,
            stdout: `${created.stdout}\n${switched.stdout}`.trim() || undefined,
            stderr: `${created.stderr}\n${switched.stderr}`.trim() || undefined,
            didCreateStash: created.stashCreated,
            didPopStash: false,
            stashRef: created.stashRef,
        };
    }

    const switched = await runGitSwitch({ cwd: input.context.cwd, name: input.request.name });
    if (switched.success) {
        return {
            success: true,
            stdout: switched.stdout,
            stderr: switched.stderr,
            didCreateStash: false,
            didPopStash: false,
            stashRef: null,
        };
    }

    if (!isLocalChangesOverwrittenError(switched.stderr)) {
        return {
            success: false,
            errorCode: mapGitErrorCode(switched.stderr),
            error: switched.stderr || 'Branch checkout failed',
            stdout: switched.stdout,
            stderr: switched.stderr,
        };
    }

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
        };
    }

    const switchedAfterStash = await runGitSwitch({ cwd: input.context.cwd, name: input.request.name });
    if (!switchedAfterStash.success) {
        return {
            success: false,
            errorCode: mapGitErrorCode(switchedAfterStash.stderr),
            error: switchedAfterStash.stderr || 'Branch checkout failed',
            stdout: `${created.stdout}\n${switchedAfterStash.stdout}`.trim() || undefined,
            stderr: `${created.stderr}\n${switchedAfterStash.stderr}`.trim() || undefined,
            didCreateStash: created.stashCreated,
            didPopStash: false,
            stashRef: created.stashRef,
        };
    }

    const pop = await runScmCommand({
        bin: 'git',
        cwd: input.context.cwd,
        args: ['stash', 'pop', created.stashRef ?? 'stash@{0}'],
        timeoutMs: GIT_BRANCH_SWITCH_TIMEOUT_MS,
        env: buildScmNonInteractiveEnv(),
    });

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
        };
    }

    return {
        success: true,
        stdout: `${created.stdout}\n${switchedAfterStash.stdout}\n${pop.stdout}`.trim() || undefined,
        stderr: `${created.stderr}\n${switchedAfterStash.stderr}\n${pop.stderr}`.trim() || undefined,
        didCreateStash: created.stashCreated,
        didPopStash: true,
        stashRef: created.stashRef,
    };
}
