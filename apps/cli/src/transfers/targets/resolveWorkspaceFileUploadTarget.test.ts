import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { copyFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { SERVER_ROUTED_FILE_TRANSFER_SIZE_LIMIT_ERROR } from '../policy/serverRoutedTransferPolicy';
import { resolveWorkspaceFileUploadTarget } from './resolveWorkspaceFileUploadTarget';

const createdPaths = new Set<string>();

function createWorkspace(): string {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-transfer-upload-target-'));
    createdPaths.add(workspace);
    return workspace;
}

afterEach(() => {
    for (const path of createdPaths) {
        rmSync(path, { recursive: true, force: true });
    }
    createdPaths.clear();
});

describe('resolveWorkspaceFileUploadTarget', () => {
    it('allows destinations outside the default directory by default', () => {
        const workspace = createWorkspace();
        const externalRoot = createWorkspace();
        const externalPath = join(externalRoot, 'uploaded.txt');

        expect(
            resolveWorkspaceFileUploadTarget({
                workingDirectory: workspace,
                path: externalPath,
                sizeBytes: 5,
                overwrite: false,
            }),
        ).toMatchObject({
            success: true,
            target: {
                destPath: externalPath,
                destDisplayPath: externalPath,
            },
        });
    });

    it('returns the resolved workspace destination with validated size and overwrite state', () => {
        const workspace = createWorkspace();

        expect(
            resolveWorkspaceFileUploadTarget({
                workingDirectory: workspace,
                path: 'nested/file.txt',
                sizeBytes: 5,
                overwrite: true,
            }),
        ).toMatchObject({
            success: true,
            target: {
                destDisplayPath: 'nested/file.txt',
                expectedSizeBytes: 5,
                overwrite: true,
            },
        });
        const result = resolveWorkspaceFileUploadTarget({
            workingDirectory: workspace,
            path: 'nested/file.txt',
            sizeBytes: 5,
            overwrite: true,
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.target.destPath).toBe(join(workspace, 'nested', 'file.txt'));
        }
    });

    it('allows configured extra write directories outside the workspace root', () => {
        const workspace = createWorkspace();
        const extraRoot = createWorkspace();
        const allowedDir = join(extraRoot, 'attachments');
        mkdirSync(allowedDir, { recursive: true });

        expect(
            resolveWorkspaceFileUploadTarget({
                workingDirectory: workspace,
                path: join(allowedDir, 'message.txt'),
                sizeBytes: 5,
                overwrite: false,
                additionalAllowedWriteDirs: [allowedDir],
            }),
        ).toMatchObject({
            success: true,
            target: {
                destPath: join(allowedDir, 'message.txt'),
                destDisplayPath: join(allowedDir, 'message.txt'),
                expectedSizeBytes: 5,
                overwrite: false,
            },
        });
    });

    it('returns a finalizer that materializes the staged upload into the resolved destination', async () => {
        const workspace = createWorkspace();
        const stagedPath = join(workspace, '.staged-upload');
        writeFileSync(stagedPath, 'hello\n', 'utf8');

        const result = resolveWorkspaceFileUploadTarget({
            workingDirectory: workspace,
            path: 'nested/file.txt',
            sizeBytes: 6,
            overwrite: false,
        });

        expect(result.success).toBe(true);
        if (!result.success) {
            return;
        }

        const finalizeUpload = result.target.finalizeUpload;

        expect(typeof finalizeUpload).toBe('function');

        const finalized = await finalizeUpload?.({
            uploadId: 'upload-materialize',
            tempPath: stagedPath,
            sizeBytes: 6,
            sha256: 'hash-1',
        });

        expect(finalized).toEqual({
            success: true,
            path: 'nested/file.txt',
            sizeBytes: 6,
        });
        expect(readFileSync(join(workspace, 'nested', 'file.txt'), 'utf8')).toBe('hello\n');
    });

    it('binds one exact-upload filesystem fault beneath the canonical finalizer, then retries normally', async () => {
        const workspace = createWorkspace();
        const stagedPath = join(workspace, '.staged-upload');
        const destinationPath = join(workspace, 'nested', 'file.txt');
        writeFileSync(stagedPath, 'hello\n', 'utf8');
        // The absent destination keeps this topology on the no-backup rollback path:
        // source cleanup fails, then removing the newly published destination fails.
        expect(existsSync(destinationPath)).toBe(false);
        let faultArmed = true;

        const result = resolveWorkspaceFileUploadTarget({
            workingDirectory: workspace,
            path: 'nested/file.txt',
            sizeBytes: 6,
            overwrite: true,
            finalizeFileOperations: ({ uploadId, tempPath, destPath }) => {
                if (!faultArmed || uploadId !== 'upload-1' || tempPath !== stagedPath || destPath !== destinationPath) {
                    return null;
                }
                faultArmed = false;
                return {
                    copyFile,
                    rename: async (from: string, to: string) => {
                        if (from === stagedPath && to === destinationPath) {
                            const error = new Error('testkit cross-device boundary') as NodeJS.ErrnoException;
                            error.code = 'EXDEV';
                            throw error;
                        }
                        await rename(from, to);
                    },
                    rm: async (path: string, options?: Parameters<typeof rm>[1]) => {
                        if (path === stagedPath || path === destinationPath) {
                            const error = new Error('testkit recovery boundary') as NodeJS.ErrnoException;
                            error.code = 'EPERM';
                            throw error;
                        }
                        await rm(path, options);
                    },
                };
            },
        });

        expect(result.success).toBe(true);
        if (!result.success) {
            return;
        }
        const finalizeUpload = result.target.finalizeUpload;

        await expect(finalizeUpload({
            uploadId: 'upload-1',
            tempPath: stagedPath,
            sizeBytes: 6,
            sha256: 'hash-1',
        })).resolves.toMatchObject({
            success: false,
            errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
            keepSession: true,
        });
        expect(readFileSync(stagedPath, 'utf8')).toBe('hello\n');
        expect(readFileSync(destinationPath, 'utf8')).toBe('hello\n');

        await expect(finalizeUpload({
            uploadId: 'upload-1',
            tempPath: stagedPath,
            sizeBytes: 6,
            sha256: 'hash-1',
        })).resolves.toEqual({
            success: true,
            path: 'nested/file.txt',
            sizeBytes: 6,
        });
        expect(readFileSync(destinationPath, 'utf8')).toBe('hello\n');
    });

    it('fails closed when the selected session-routed size limit is exceeded', () => {
        const workspace = createWorkspace();

        expect(
            resolveWorkspaceFileUploadTarget({
                workingDirectory: workspace,
                path: 'large.bin',
                sizeBytes: 5,
                overwrite: false,
                sessionRpcTransferMaxBytes: 4,
            }),
        ).toEqual({
            success: false,
            error: SERVER_ROUTED_FILE_TRANSFER_SIZE_LIMIT_ERROR,
        });
    });

    it('rejects invalid size values before path validation', () => {
        const workspace = createWorkspace();

        expect(
            resolveWorkspaceFileUploadTarget({
                workingDirectory: workspace,
                path: 'file.txt',
                sizeBytes: -1,
                overwrite: false,
            }),
        ).toEqual({
            success: false,
            error: 'Invalid sizeBytes',
        });
    });
});
