import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectDeploymentReviewRevisionV1 } from '@happier-dev/protocol/deployments/deploymentReviewV1';

import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture, type AdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';

import { captureDeploymentFolderSourceForHost } from './captureDeploymentFolderSourceForHost';

async function reviewFolder(rootPath: string) {
    const workspace = { id: 'workspace', serverId: 'home', machineId: 'machine', createdAtMs: 0, rootPath };
    const { captured, sourceIntent } = await captureDeploymentFolderSourceForHost({
        workspace, selection: { kind: 'folder', workspaceId: workspace.id },
    });
    try {
        return { sourceIntent, paths: captured.workspaceExportArtifacts.manifest.entries.map(entry => entry.relativePath) };
    } finally {
        await captured.dispose();
    }
}

describe('folder deployment review from the Machine filesystem', () => {
    let runtime: AdmittedPluginRuntimeFixture | undefined;
    beforeAll(async () => {
        runtime = await createAdmittedPluginRuntimeFixture({
            controller: pluginReloadController,
            runtimeOptions: { pluginIds: ['happier.scm.backend.git'] },
        });
    });
    afterAll(async () => { await runtime?.dispose(); });

    it('uses portable nested paths and honours CRLF ignore files', async () => {
        const root = await mkdtemp(join(tmpdir(), 'deploy-folder-'));
        try {
            await mkdir(join(root, 'src'));
            await writeFile(join(root, '.gitignore'), 'src/ignored.txt\r\n');
            await writeFile(join(root, 'src', 'ignored.txt'), 'ignored');
            await writeFile(join(root, 'src', 'keep.txt'), 'kept');
            await writeFile(join(root, '.ENV.local'), 'local secret');
            const { sourceIntent, paths } = await reviewFolder(root);
            expect(sourceIntent).toMatchObject({ fileCount: 2, excludedPaths: ['.ENV.local', 'src/ignored.txt'] });
            expect(paths).toContain('src/keep.txt');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it.skipIf(process.platform === 'win32')('explains excluded pipes and sockets without staging them', async () => {
        const root = await mkdtemp(join(tmpdir(), 'deploy-folder-'));
        const socket = createServer();
        try {
            await writeFile(join(root, 'compose.yaml'), 'services: {}');
            execFileSync('mkfifo', [join(root, 'build.pipe')]);
            await new Promise<void>((resolve, reject) => {
                socket.once('error', reject);
                socket.listen(join(root, 'build.sock'), resolve);
            });
            const { sourceIntent, paths } = await reviewFolder(root);
            expect(projectDeploymentReviewRevisionV1(sourceIntent)).toMatchObject({
                fileCount: 1,
                excludedPaths: ['build.pipe', 'build.sock'],
                unsupportedFilePaths: ['build.pipe', 'build.sock'],
            });
            expect(paths).toEqual(['compose.yaml']);
        } finally {
            try {
                if (socket.listening) await new Promise<void>(resolve => socket.close(() => resolve()));
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        }
    });
});
