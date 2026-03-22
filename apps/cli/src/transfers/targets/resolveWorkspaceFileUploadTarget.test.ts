import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { SESSION_RPC_FILE_TRANSFER_SIZE_LIMIT_ERROR } from '../policy/sessionRpcTransferPolicy';
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
            expect(result.target.destPath.endsWith('/nested/file.txt')).toBe(true);
            expect(result.target.destPath).toContain('happier-transfer-upload-target-');
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

        const finalizeUpload = (
            result.target as {
                finalizeUpload?: (input: Readonly<{ tempPath: string; sizeBytes: number; sha256: string }>) => Promise<{
                    path: string;
                    sizeBytes: number;
                }>;
            }
        ).finalizeUpload;

        expect(typeof finalizeUpload).toBe('function');

        const finalized = await finalizeUpload?.({
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
            error: SESSION_RPC_FILE_TRANSFER_SIZE_LIMIT_ERROR,
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
