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

    it.skipIf(process.platform === 'win32').each(['plain', 'git'])('explains excluded pipes and sockets in a %s folder without staging them', async kind => {
        const root = await mkdtemp(join(tmpdir(), 'deploy-folder-'));
        const socket = createServer();
        try {
            await writeFile(join(root, 'compose.yaml'), 'services: {}');
            // The tracked ignored file distinguishes Git selection from the fallback.
            if (kind === 'git') {
                execFileSync('git', ['init', '--quiet'], { cwd: root });
                await writeFile(join(root, '.gitignore'), 'compose.yaml\n');
                execFileSync('git', ['add', '-f', 'compose.yaml'], { cwd: root });
            }
            await mkdir(join(root, 'non-ordinary'));
            execFileSync('mkfifo', [join(root, 'non-ordinary', 'build.pipe')]);
            await new Promise<void>((resolve, reject) => {
                socket.once('error', reject);
                socket.listen(join(root, 'build.sock'), resolve);
            });
            const { sourceIntent, paths } = await reviewFolder(root);
            const retained = kind === 'git' ? ['.gitignore', 'compose.yaml'] : ['compose.yaml'];
            expect(paths).toEqual(retained);
            expect(projectDeploymentReviewRevisionV1(sourceIntent)).toMatchObject({
                fileCount: retained.length,
                excludedPaths: ['build.sock', 'non-ordinary/build.pipe'],
                unsupportedFilePaths: ['build.sock', 'non-ordinary/build.pipe'],
            });
        } finally {
            try {
                if (socket.listening) await new Promise<void>(resolve => socket.close(() => resolve()));
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        }
    });
});
