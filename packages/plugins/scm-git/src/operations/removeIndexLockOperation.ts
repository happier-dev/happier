import { constants } from 'node:fs';
import { access, lstat, realpath, unlink } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

import {
  SCM_OPERATION_ERROR_CODES,
  type ScmRepositoryRemoveIndexLockRequest,
  type ScmRepositoryRemoveIndexLockResponse,
  type ScmWorkingSnapshot,
} from '@happier-dev/plugin-sdk/experimental/scm';

import { runScmCommand } from '../runtime.js';
import type { ScmBackendContext } from '../types.js';
import { buildScmNonInteractiveEnv } from '../providers/shared/nonInteractiveEnv.js';
import { mapGitErrorCode } from '../remote.js';
import { getGitSnapshot } from '../repository.js';

const GIT_INDEX_LOCK_TIMEOUT_MS = 10_000;
const INDEX_LOCK_BASENAME = 'index.lock';
const DISALLOWED_CALLER_LOCK_PATH_FIELDS = ['lockPath', ['index', 'LockPath'].join('')] as const;

type LockPathResolution =
    | {
        ok: true;
        lockPath: string;
        absoluteGitDir: string;
        commonDir: string | null;
        rawGitPath: string;
    }
    | {
        ok: false;
        response: ScmRepositoryRemoveIndexLockResponse;
    };

function invalidRequestResponse(error: string): ScmRepositoryRemoveIndexLockResponse {
    return {
        success: false,
        errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        error,
    };
}

function commandFailureResponse(error: string, stdout?: string, stderr?: string): ScmRepositoryRemoveIndexLockResponse {
    return {
        success: false,
        errorCode: mapGitErrorCode(stderr ?? error),
        error,
        stdout,
        stderr,
    };
}

function hasOwnProperty(value: object, property: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, property);
}

function containsTraversalSegment(rawPath: string): boolean {
    return rawPath.split(/[\\/]+/).some((segment) => segment === '..');
}

function isPathInside(parentPath: string, childPath: string): boolean {
    const relativePath = relative(parentPath, childPath);
    return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

async function realpathIfExists(path: string): Promise<string | null> {
    try {
        return await realpath(path);
    } catch {
        return null;
    }
}

async function resolveCommonDir(input: {
    cwd: string;
    absoluteGitDir: string;
    rawCommonDir: string;
}): Promise<string | null> {
    const trimmed = input.rawCommonDir.trim();
    if (!trimmed) return null;
    if (containsTraversalSegment(trimmed)) return null;

    const candidates = isAbsolute(trimmed)
        ? [trimmed]
        : [
            resolve(input.cwd, trimmed),
            resolve(input.absoluteGitDir, trimmed),
        ];
    for (const candidate of candidates) {
        const canonical = await realpathIfExists(candidate);
        if (canonical) return canonical;
    }
    return null;
}

async function runGitRevParse(input: {
    cwd: string;
    args: string[];
}): Promise<{ ok: true; stdout: string } | { ok: false; response: ScmRepositoryRemoveIndexLockResponse }> {
    const result = await runScmCommand({
        bin: 'git',
        cwd: input.cwd,
        args: input.args,
        timeoutMs: GIT_INDEX_LOCK_TIMEOUT_MS,
        env: buildScmNonInteractiveEnv(),
    });
    if (!result.success) {
        return {
            ok: false,
            response: commandFailureResponse(
                result.stderr || `Failed to resolve Git path with ${input.args.join(' ')}.`,
                result.stdout,
                result.stderr,
            ),
        };
    }
    return { ok: true, stdout: result.stdout.trim() };
}

async function resolveGitIndexLockPath(context: ScmBackendContext): Promise<LockPathResolution> {
    const gitPath = await runGitRevParse({
        cwd: context.cwd,
        args: ['rev-parse', '--git-path', INDEX_LOCK_BASENAME],
    });
    if (!gitPath.ok) return gitPath;

    const absoluteGitDir = await runGitRevParse({
        cwd: context.cwd,
        args: ['rev-parse', '--absolute-git-dir'],
    });
    if (!absoluteGitDir.ok) return absoluteGitDir;

    const rawGitPath = gitPath.stdout;
    if (!rawGitPath || containsTraversalSegment(rawGitPath)) {
        return {
            ok: false,
            response: invalidRequestResponse('Resolved Git index lock path is invalid.'),
        };
    }

    const absoluteGitDirPath = await realpathIfExists(absoluteGitDir.stdout);
    if (!absoluteGitDirPath) {
        return {
            ok: false,
            response: invalidRequestResponse('Resolved Git directory is invalid.'),
        };
    }

    const commonDirResult = await runGitRevParse({
        cwd: context.cwd,
        args: ['rev-parse', '--git-common-dir'],
    });
    const commonDir = commonDirResult.ok
        ? await resolveCommonDir({
            cwd: context.cwd,
            absoluteGitDir: absoluteGitDirPath,
            rawCommonDir: commonDirResult.stdout,
        })
        : null;

    return {
        ok: true,
        rawGitPath,
        lockPath: isAbsolute(rawGitPath) ? resolve(rawGitPath) : resolve(context.cwd, rawGitPath),
        absoluteGitDir: absoluteGitDirPath,
        commonDir,
    };
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await access(path, constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

async function validateResolvedIndexLockPath(input: {
    lockPath: string;
    rawGitPath: string;
    absoluteGitDir: string;
    commonDir: string | null;
}): Promise<ScmRepositoryRemoveIndexLockResponse | null> {
    if (basename(input.lockPath) !== INDEX_LOCK_BASENAME) {
        return invalidRequestResponse('Resolved Git lock path must be index.lock.');
    }
    if (containsTraversalSegment(input.rawGitPath)) {
        return invalidRequestResponse('Resolved Git index lock path contains traversal segments.');
    }

    const parentRealPath = await realpathIfExists(resolve(input.lockPath, '..'));
    if (!parentRealPath) {
        return invalidRequestResponse('Resolved Git index lock parent does not exist.');
    }

    const allowedRoots = [input.absoluteGitDir, input.commonDir]
        .filter((path): path is string => typeof path === 'string' && path.length > 0);
    if (!allowedRoots.some((rootPath) => isPathInside(rootPath, parentRealPath))) {
        return invalidRequestResponse('Resolved Git index lock path is outside the Git directory.');
    }

    if (await pathExists(input.lockPath)) {
        const lockStat = await lstat(input.lockPath);
        if (lockStat.isSymbolicLink()) {
            return invalidRequestResponse('Resolved Git index lock path must not be a symlink.');
        }
    }

    return null;
}

async function readSnapshotIfAvailable(context: ScmBackendContext): Promise<ScmWorkingSnapshot | undefined> {
    const snapshotResponse = await getGitSnapshot({ context });
    return snapshotResponse.success ? snapshotResponse.snapshot : undefined;
}

export async function gitRemoveIndexLock(input: {
    context: ScmBackendContext;
    request: ScmRepositoryRemoveIndexLockRequest;
}): Promise<ScmRepositoryRemoveIndexLockResponse> {
    if (input.request.confirmed !== true || !input.request.confirmationToken) {
        return invalidRequestResponse('Confirmed stale index-lock removal is required.');
    }
    if (DISALLOWED_CALLER_LOCK_PATH_FIELDS.some((field) => hasOwnProperty(input.request, field))) {
        return invalidRequestResponse('Git index lock path must be resolved by the SCM backend.');
    }

    const resolved = await resolveGitIndexLockPath(input.context);
    if (!resolved.ok) return resolved.response;

    const validationError = await validateResolvedIndexLockPath({
        lockPath: resolved.lockPath,
        rawGitPath: resolved.rawGitPath,
        absoluteGitDir: resolved.absoluteGitDir,
        commonDir: resolved.commonDir,
    });
    if (validationError) return validationError;

    if (!await pathExists(resolved.lockPath)) {
        return {
            success: true,
            removed: false,
            reason: 'absent',
            lockPath: resolved.lockPath,
            snapshot: await readSnapshotIfAvailable(input.context),
        };
    }

    try {
        await unlink(resolved.lockPath);
    } catch (error) {
        if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') {
            return {
                success: true,
                removed: false,
                reason: 'absent',
                lockPath: resolved.lockPath,
                snapshot: await readSnapshotIfAvailable(input.context),
            };
        }
        const message = error instanceof Error ? error.message : 'Failed to remove Git index lock.';
        return commandFailureResponse(message);
    }

    return {
        success: true,
        removed: true,
        reason: 'removed',
        lockPath: resolved.lockPath,
        snapshot: await readSnapshotIfAvailable(input.context),
    };
}
