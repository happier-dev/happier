import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  SCM_OPERATION_ERROR_CODES,
  type ScmRepositoryRemoveIndexLockRequest,
  type ScmRepositoryRemoveIndexLockResponse,
} from '@happier-dev/plugin-sdk/scm';
import { describe, expect, it, vi } from 'vitest';

import { createGitBackend } from '../backend.js';
import { runWithRealGitScmRuntime } from '../testkit/scmRuntime.test-support.js';
import type { ScmBackend, ScmBackendContext } from '../types.js';

const REAL_GIT_INDEX_LOCK_TEST_TIMEOUT_MS = 20_000;

type RemoveIndexLockOperation = (input: {
    context: ScmBackendContext;
    request: ScmRepositoryRemoveIndexLockRequest;
}) => Promise<ScmRepositoryRemoveIndexLockResponse>;

function runGit(cwd: string, args: string[]): string {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

function createRepository(): string {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-git-index-lock-operation-'));
    runGit(workspace, ['init']);
    return workspace;
}

function makeContext(cwd: string): ScmBackendContext {
    return {
        cwd,
        projectKey: `test:${cwd}`,
        detection: {
            isRepo: true,
            rootPath: runGit(cwd, ['rev-parse', '--show-toplevel']),
            mode: '.git',
        },
    };
}

function getRemoveIndexLockOperation(): RemoveIndexLockOperation {
    const backend = createGitBackend() as ScmBackend & {
        removeIndexLock?: RemoveIndexLockOperation;
    };
    expect(backend.removeIndexLock).toBeTypeOf('function');
    if (!backend.removeIndexLock) {
        throw new Error('Git backend removeIndexLock operation is not registered');
    }
    return backend.removeIndexLock;
}

function removeIndexLockWithRuntime(
    removeIndexLock: RemoveIndexLockOperation,
    input: Parameters<RemoveIndexLockOperation>[0],
) {
    return runWithRealGitScmRuntime(() => removeIndexLock(input));
}

function confirmedRequest(cwd: string): ScmRepositoryRemoveIndexLockRequest {
    return {
        cwd,
        confirmed: true,
        confirmationToken: 'remove-stale-index-lock',
    };
}

async function withFakeGitPath<T>(
    fakeGitPathOutput: string,
    gitDir: string,
    commonDir: string,
    run: () => Promise<T>,
): Promise<T> {
    const originalPath = process.env.PATH;
    const fakeBin = mkdtempSync(join(tmpdir(), 'happier-fake-git-'));
    const fakeGit = join(fakeBin, 'git');
    writeFileSync(
        fakeGit,
        [
            '#!/bin/sh',
            'if [ "$1" = "rev-parse" ] && [ "$2" = "--git-path" ]; then',
            `  printf '%s\\n' '${fakeGitPathOutput.replace(/'/g, "'\\''")}'`,
            '  exit 0',
            'fi',
            'if [ "$1" = "rev-parse" ] && [ "$2" = "--absolute-git-dir" ]; then',
            `  printf '%s\\n' '${gitDir.replace(/'/g, "'\\''")}'`,
            '  exit 0',
            'fi',
            'if [ "$1" = "rev-parse" ] && [ "$2" = "--git-common-dir" ]; then',
            `  printf '%s\\n' '${commonDir.replace(/'/g, "'\\''")}'`,
            '  exit 0',
            'fi',
            'printf "%s\\n" "unexpected fake git invocation: $*" >&2',
            'exit 1',
            '',
        ].join('\n'),
        { mode: 0o755 },
    );
    process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;
    try {
        return await run();
    } finally {
        process.env.PATH = originalPath;
    }
}

describe('git remove index-lock operation', () => {
    it('removes only the real Git index.lock resolved by Git', async () => {
        const workspace = createRepository();
        const lockPath = join(workspace, '.git', 'index.lock');
        writeFileSync(lockPath, 'stale lock');
        const configBefore = readFileSync(join(workspace, '.git', 'config'), 'utf8');
        const removeIndexLock = getRemoveIndexLockOperation();

        const response = await removeIndexLockWithRuntime(removeIndexLock, {
            context: makeContext(workspace),
            request: confirmedRequest(workspace),
        });

        expect(response).toMatchObject({
            success: true,
            removed: true,
            reason: 'removed',
        });
        expect(existsSync(lockPath)).toBe(false);
        expect(readFileSync(join(workspace, '.git', 'config'), 'utf8')).toBe(configBefore);
        expect(response.success ? response.lockPath : null).toBe(lockPath);
        expect(response.success ? response.snapshot?.repo.isRepo : false).toBe(true);
    });

    it('allows a resolved index.lock under a dot-dot-prefixed Git directory child', async () => {
        const workspace = createRepository();
        const gitDir = join(workspace, '.git');
        const lockParent = join(gitDir, '..build');
        const lockPath = join(lockParent, 'index.lock');
        await mkdir(lockParent);
        await writeFile(lockPath, 'stale lock');
        const context = makeContext(workspace);
        const removeIndexLock = getRemoveIndexLockOperation();

        const response = await withFakeGitPath(lockPath, gitDir, '.git', () =>
            removeIndexLockWithRuntime(removeIndexLock, {
                context,
                request: confirmedRequest(workspace),
            }),
        );

        expect(response).toMatchObject({
            success: true,
            removed: true,
            reason: 'removed',
        });
        expect(existsSync(lockPath)).toBe(false);
    });

    it('returns removed false when the resolved Git index.lock is absent', async () => {
        const workspace = createRepository();
        const removeIndexLock = getRemoveIndexLockOperation();

        const response = await removeIndexLockWithRuntime(removeIndexLock, {
            context: makeContext(workspace),
            request: confirmedRequest(workspace),
        });

        expect(response).toMatchObject({
            success: true,
            removed: false,
            reason: 'absent',
        });
        expect(existsSync(join(workspace, '.git', 'index.lock'))).toBe(false);
    });

    it('rejects caller-supplied lock paths without unlinking them', async () => {
        const workspace = createRepository();
        const outside = join(mkdtempSync(join(tmpdir(), 'happier-git-index-lock-outside-')), 'index.lock');
        writeFileSync(outside, 'do not remove');
        const removeIndexLock = getRemoveIndexLockOperation();

        const response = await removeIndexLockWithRuntime(removeIndexLock, {
            context: makeContext(workspace),
            request: {
                ...confirmedRequest(workspace),
                lockPath: outside,
            } as ScmRepositoryRemoveIndexLockRequest,
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        });
        expect(existsSync(outside)).toBe(true);
    });

    it('denies traversal output from Git path resolution', async () => {
        const workspace = createRepository();
        const outsideDir = mkdtempSync(join(tmpdir(), 'happier-git-index-lock-traversal-'));
        const outsideLock = join(outsideDir, 'index.lock');
        writeFileSync(outsideLock, 'do not remove');
        const gitDir = join(workspace, '.git');
        const context = makeContext(workspace);
        const removeIndexLock = getRemoveIndexLockOperation();

        const response = await withFakeGitPath('../index.lock', gitDir, '.git', () =>
            removeIndexLockWithRuntime(removeIndexLock, {
                context,
                request: confirmedRequest(workspace),
            }),
        );

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        });
        expect(existsSync(outsideLock)).toBe(true);
    });

    it('denies resolved lock paths with an incorrect basename', async () => {
        const workspace = createRepository();
        const gitDir = join(workspace, '.git');
        const wrongLock = join(gitDir, 'other.lock');
        writeFileSync(wrongLock, 'do not remove');
        const context = makeContext(workspace);
        const removeIndexLock = getRemoveIndexLockOperation();

        const response = await withFakeGitPath(wrongLock, gitDir, '.git', () =>
            removeIndexLockWithRuntime(removeIndexLock, {
                context,
                request: confirmedRequest(workspace),
            }),
        );

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        });
        expect(existsSync(wrongLock)).toBe(true);
    });

    it('denies resolved lock paths outside the absolute Git dir and common dir', async () => {
        const workspace = createRepository();
        const outsideDir = mkdtempSync(join(tmpdir(), 'happier-git-index-lock-outside-'));
        const outsideLock = join(outsideDir, 'index.lock');
        writeFileSync(outsideLock, 'do not remove');
        const context = makeContext(workspace);
        const removeIndexLock = getRemoveIndexLockOperation();

        const response = await withFakeGitPath(outsideLock, join(workspace, '.git'), '.git', () =>
            removeIndexLockWithRuntime(removeIndexLock, {
                context,
                request: confirmedRequest(workspace),
            }),
        );

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        });
        expect(existsSync(outsideLock)).toBe(true);
    });

    it('does not fall back to removing a worktree-root index.lock when common-dir resolution is invalid', async () => {
        const workspace = createRepository();
        const rootLock = join(workspace, 'index.lock');
        writeFileSync(rootLock, 'do not remove');
        const context = makeContext(workspace);
        const removeIndexLock = getRemoveIndexLockOperation();

        const response = await withFakeGitPath(rootLock, join(workspace, '.git'), '', () =>
            removeIndexLockWithRuntime(removeIndexLock, {
                context,
                request: confirmedRequest(workspace),
            }),
        );

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        });
        expect(existsSync(rootLock)).toBe(true);
    });

    it('denies symlink escape for the resolved index.lock path', async () => {
        const workspace = createRepository();
        const outsideDir = mkdtempSync(join(tmpdir(), 'happier-git-index-lock-symlink-'));
        const outsideTarget = join(outsideDir, 'target');
        writeFileSync(outsideTarget, 'do not remove');
        const lockPath = join(workspace, '.git', 'index.lock');
        symlinkSync(outsideTarget, lockPath);
        const removeIndexLock = getRemoveIndexLockOperation();

        const response = await removeIndexLockWithRuntime(removeIndexLock, {
            context: makeContext(workspace),
            request: confirmedRequest(workspace),
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        });
        expect(existsSync(outsideTarget)).toBe(true);
        expect(existsSync(lockPath)).toBe(true);
    });

    it('treats ENOENT during unlink as absent success', async () => {
        const workspace = createRepository();
        const raceDir = join(workspace, '.git', 'race-parent');
        await mkdir(raceDir);
        const lockPath = join(raceDir, 'index.lock');
        await writeFile(lockPath, 'removed by another process');
        const context = makeContext(workspace);
        let unlinkRaceHit = false;
        vi.resetModules();
        vi.doMock('node:fs/promises', async () => {
            const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
            return {
                ...actual,
                unlink: async (path: Parameters<typeof actual.unlink>[0]) => {
                    if (path === lockPath) {
                        unlinkRaceHit = true;
                        await actual.unlink(path);
                        throw Object.assign(new Error('simulated unlink race'), { code: 'ENOENT' });
                    }
                    return await actual.unlink(path);
                },
            };
        });

        try {
            const { createGitBackend: createGitBackendWithUnlinkRace } = await import('../backend.js');
            const backend = createGitBackendWithUnlinkRace() as ScmBackend & {
                removeIndexLock?: RemoveIndexLockOperation;
            };
            if (!backend.removeIndexLock) {
                throw new Error('Git backend removeIndexLock operation is not registered');
            }

            const response = await withFakeGitPath(lockPath, join(workspace, '.git'), '.git', () =>
                backend.removeIndexLock
                    ? removeIndexLockWithRuntime(backend.removeIndexLock, {
                        context,
                        request: confirmedRequest(workspace),
                    })
                    : Promise.reject(new Error('Git backend removeIndexLock operation is not registered')),
            );

            expect(response).toMatchObject({
                success: true,
                removed: false,
                reason: 'absent',
            });
            expect(unlinkRaceHit).toBe(true);
            expect(existsSync(lockPath)).toBe(false);
        } finally {
            vi.doUnmock('node:fs/promises');
            vi.resetModules();
        }
    }, REAL_GIT_INDEX_LOCK_TEST_TIMEOUT_MS);

    it('does not contain destructive Git repair commands or broad filesystem cleanup', () => {
        const source = readFileSync(join(dirname(new URL(import.meta.url).pathname), 'removeIndexLockOperation.ts'), 'utf8');

        expect(source).not.toMatch(/git clean|git reset|git restore|git checkout --|reset --hard|rm -rf|force-push|--force|remote remove|remote rm|deleteRemote/);
        expect(source).not.toMatch(/unlink\([^)]*request/);
    });
});
