import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { SERVER_ROUTED_FILE_TRANSFER_SIZE_LIMIT_ERROR } from '../policy/serverRoutedTransferPolicy';
import { resolveWorkspaceFileDownloadSource } from './resolveWorkspaceFileDownloadSource';

const createdPaths = new Set<string>();

function createWorkspace(): string {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-transfer-download-source-'));
    createdPaths.add(workspace);
    return workspace;
}

afterEach(() => {
    for (const path of createdPaths) {
        rmSync(path, { recursive: true, force: true });
    }
    createdPaths.clear();
});

describe('resolveWorkspaceFileDownloadSource', () => {
    it('allows sources outside the default directory by default', async () => {
        const workspace = createWorkspace();
        const externalRoot = createWorkspace();
        const externalPath = join(externalRoot, 'hello.txt');
        writeFileSync(externalPath, 'hello\n', 'utf8');

        const result = await resolveWorkspaceFileDownloadSource({
            workingDirectory: workspace,
            path: externalPath,
            asZip: false,
        });

        expect(result).toMatchObject({
            success: true,
            source: {
                filePath: externalPath,
                deleteFileOnClose: false,
                sizeBytes: 6,
                name: 'hello.txt',
            },
        });
    });

    it('returns a direct file source for non-zip downloads', async () => {
        const workspace = createWorkspace();
        writeFileSync(join(workspace, 'hello.txt'), 'hello\n', 'utf8');

        await expect(
            resolveWorkspaceFileDownloadSource({
                workingDirectory: workspace,
                path: 'hello.txt',
                asZip: false,
            }),
        ).resolves.toMatchObject({
            success: true,
            source: {
                deleteFileOnClose: false,
                sizeBytes: 6,
                name: 'hello.txt',
            },
        });
        const result = await resolveWorkspaceFileDownloadSource({
            workingDirectory: workspace,
            path: 'hello.txt',
            asZip: false,
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.source.filePath.endsWith('/hello.txt')).toBe(true);
            expect(result.source.filePath).toContain('happier-transfer-download-source-');
        }
    });

    it('permits an exact transient media file outside restricted roots without permitting its sibling', async () => {
        const workspace = createWorkspace();
        const providerDirectory = createWorkspace();
        const grantedPath = join(providerDirectory, 'provider-owned.png');
        const siblingPath = join(providerDirectory, 'sibling-secret.png');
        writeFileSync(grantedPath, 'media', 'utf8');
        writeFileSync(siblingPath, 'secret', 'utf8');
        const grantedRealPath = realpathSync(grantedPath);

        await expect(
            resolveWorkspaceFileDownloadSource({
                workingDirectory: workspace,
                path: grantedPath,
                asZip: false,
                accessPolicy: { kind: 'restrictedRoots', roots: [workspace] },
                additionalAllowedReadFiles: [{ path: grantedPath, realPath: grantedRealPath }],
            }),
        ).resolves.toMatchObject({
            success: true,
            source: { filePath: grantedPath },
        });
        await expect(
            resolveWorkspaceFileDownloadSource({
                workingDirectory: workspace,
                path: siblingPath,
                asZip: false,
                accessPolicy: { kind: 'restrictedRoots', roots: [workspace] },
                additionalAllowedReadFiles: [{ path: grantedPath, realPath: grantedRealPath }],
            }),
        ).resolves.toMatchObject({ success: false });
    });

    it('rejects directory downloads unless zip mode is requested', async () => {
        const workspace = createWorkspace();
        mkdirSync(join(workspace, 'folder'), { recursive: true });

        await expect(
            resolveWorkspaceFileDownloadSource({
                workingDirectory: workspace,
                path: 'folder',
                asZip: false,
            }),
        ).resolves.toEqual({
            success: false,
            error: 'Download is only supported for files',
        });
    });

    it('builds a temporary zip source for directory downloads', async () => {
        const workspace = createWorkspace();
        mkdirSync(join(workspace, 'folder'), { recursive: true });
        writeFileSync(join(workspace, 'folder', 'hello.txt'), 'hello\n', 'utf8');

        const result = await resolveWorkspaceFileDownloadSource({
            workingDirectory: workspace,
            path: 'folder',
            asZip: true,
        });

        expect(result.success).toBe(true);
        if (!result.success) {
            return;
        }

        expect(result.source.deleteFileOnClose).toBe(true);
        expect(result.source.name).toBe('folder.zip');
        expect(result.source.sizeBytes).toBeGreaterThan(0);
        expect(existsSync(result.source.filePath)).toBe(true);
        createdPaths.add(result.source.filePath);
    });

    it('fails closed when the selected session-routed size limit is exceeded', async () => {
        const workspace = createWorkspace();
        writeFileSync(join(workspace, 'hello.txt'), 'hello\n', 'utf8');

        await expect(
            resolveWorkspaceFileDownloadSource({
                workingDirectory: workspace,
                path: 'hello.txt',
                asZip: false,
                sessionRpcTransferMaxBytes: 4,
            }),
        ).resolves.toEqual({
            success: false,
            error: SERVER_ROUTED_FILE_TRANSFER_SIZE_LIMIT_ERROR,
        });
    });
});
