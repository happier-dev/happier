import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { DeploymentImageV1 } from '@happier-dev/deployment-protocol';
import { createProjectNativeToolchainIoForHost, createStablePluginExecService,
    type ProjectNativeEffectCaptureForHost } from '@/plugins/runtime/invocation/services/exec';
import { createDeploymentExecEnvPortForHost } from '@/deployments/secrets/deploymentExecEnvPort';
import { createOwnServerDockerBoundary } from '@/deployments/targets/ownServer/ownServerDeployment.testkit';
import { createNativeComposeLifecycle } from './nativeComposeLifecycle';
import { machineNativeEffectAdmission } from './machineNativeEffectAdmission';

it.skipIf(process.platform === 'win32').each(['proven', 'cancelled', 'unprovedRemoval', 'previewFresh', 'previewExisting'] as const)('limits first-deploy cleanup to witnessed introduced containers and fresh preview data after %s failure', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'happier-first-deploy-'));
    const captures = new Set<ProjectNativeEffectCaptureForHost>();
    try {
        const docker = await createOwnServerDockerBoundary(join(root, 'docker'));
        const image = await docker.registerImage('app', 'first');
        const database = await docker.registerImage('db', 'incumbent');
        await docker.failImageHealth(image.configDigest);
        const signal = new AbortController().signal;
        const source = { environmentId: 'environment', environmentInstanceId: 'instance', deploymentId: 'first', machineId: 'machine',
            installationId: 'installation', rootPath: root, manifestFingerprint: 'manifest', async assertCurrent() {}, async commit() {}, async abort() {} };
        const exec = createStablePluginExecService({ signal,
            isOccurrenceCurrent: () => true, async resolveExecutable() { return { command: docker.executablePath }; },
            async resolvePath() { return root; }, systemTools: { async resolve(request) { return { grantId: 'docker-fixture', toolId: request.toolId, displayName: 'Docker fixture', source: 'system', executablePath: docker.executablePath,
                launch: { kind: 'binary', executablePath: docker.executablePath } }; } } });
        const envPort = createDeploymentExecEnvPortForHost({ source, phase: 'runtime', signal, isCurrent: () => true,
            async prepare() { return { env: { PATH: process.env.PATH ?? '', HOME: root }, secretValues: [], refs: [], async recheck() {}, dispose() {} }; } });
        const realIo = createProjectNativeToolchainIoForHost({ async resolveTool() { return { executablePath: docker.executablePath, version: 'fixture' }; } })
            .createInvocation({ signal, retainCapture(capture) { captures.add(capture); } });
        const candidateController = new AbortController();
        let cancelAfterUp = false;
        let removalUnproved = false;
        // Lost caller custody immediately after Docker's real OS effect. This
        // boundary interruption must not be interpreted as proven failure.
        const io = { ...realIo, async run(request: Parameters<typeof realIo.run>[0]) {
            if (removalUnproved && ['ps', 'inspect'].includes(request.args[0]!)) return { exitCode: 1, stdout: '[]', stderr: '' };
            const output = await realIo.run(request);
            if (cancelAfterUp && request.args.includes('up')) candidateController.abort();
            if (mode === 'unprovedRemoval' && request.args[0] === 'container' && request.args[1] === 'rm') removalUnproved = true;
            return output;
        } };
        const native = (services: readonly string[], images: readonly DeploymentImageV1[]) => createNativeComposeLifecycle({ kind: 'environmentProject', source, exec, envPort,
            files: ['compose.yaml'], services, images, io,
            storage: { runtimeMachineCount: 1, ...(mode.startsWith('preview')
                ? { previewDataVolumes: [{ service: 'app', target: '/data' }] } : {}) }, async settleNative() {
                await Promise.all([...captures].map(capture => capture.waitForSettlement()));
            } });
        await writeFile(join(root, 'compose.yaml'), JSON.stringify({ services: { db: { image: database.registryReference,
            volumes: [{ type: 'volume', source: 'db_data', target: '/data' }] } }, volumes: { db_data: {} } }));
        const incumbent = native(['db'], [database]);
        let incumbentIds: readonly string[];
        try {
            const rendered = await incumbent.render();
            const running = await machineNativeEffectAdmission.run({ operation: { operationId: 'incumbent', kind: 'deployments.deploy' }, keys: rendered.keys },
                context => incumbent.activate({ render: rendered, context }));
            incumbentIds = running.nativeIdsForService('db');
            await running.dispose();
        } finally { await incumbent.dispose(); }
        await writeFile(join(root, 'compose.yaml'), JSON.stringify({ services: {
            app: { image: image.registryReference, volumes: [{ type: 'volume', source: 'app_data', target: '/data' }] },
            db: { image: database.registryReference, volumes: [{ type: 'volume', source: 'db_data', target: '/data' }] },
        }, volumes: { app_data: {}, db_data: {} } }));
        const project = native(['app', 'db'], [image, database]);
        cancelAfterUp = mode === 'cancelled';
        const candidateSignal = mode === 'cancelled' ? candidateController.signal : signal;
        try {
            const rendered = await project.render();
            const appVolume = `${rendered.projectName}_app_data`;
            const dbVolume = `${rendered.projectName}_db_data`;
            await docker.seedVolume('source-postgres-data', 'source-project');
            if (mode === 'previewExisting') await docker.seedVolume(appVolume, rendered.projectName);
            const activation = machineNativeEffectAdmission.run({ operation: { operationId: 'first', kind: 'deployments.deploy', signal: candidateSignal }, keys: rendered.keys },
                context => project.activate({ render: rendered, context, cleanupOnFailure: true, signal: candidateSignal }));
            if (mode === 'proven' || mode.startsWith('preview')) await expect(activation).rejects.toMatchObject({ code: 'native_failed',
                details: { reason: 'deployment_activation_failed', firstDeployCleanup: 'removed' } });
            else if (mode === 'unprovedRemoval') {
                await expect(activation).rejects.toMatchObject({ code: 'native_failed', details: { reason: 'deployment_activation_failed' } });
                await expect(activation).rejects.not.toMatchObject({ details: { firstDeployCleanup: 'removed' } });
            } else await expect(activation).rejects.toBeDefined();
            expect(await docker.readRunningImageConfig('app')).toBe(mode === 'cancelled' ? image.configDigest : null);
            expect(await docker.readRunningImageConfig('db')).toBe(database.configDigest);
            expect(await docker.readVolumeNames()).toEqual((mode === 'previewFresh'
                ? [dbVolume, 'source-postgres-data'] : [appVolume, dbVolume, 'source-postgres-data']).sort());
            const invocations = await docker.readInvocations();
            expect(invocations.some(call => call.args[0] === 'container' && call.args[1] === 'rm')).toBe(mode !== 'cancelled');
            expect(invocations.filter(call => call.args[0] === 'container' && call.args[1] === 'rm')
                .some(call => incumbentIds.some(id => call.args.includes(id)))).toBe(false);
            expect(invocations.some(call => call.args.includes('down') || call.args.includes('--volumes') || call.args.includes('prune'))).toBe(false);
        } finally { await project.dispose(); }
    } finally {
        try { await Promise.all([...captures].map(capture => capture.release())); }
        finally { await rm(root, { recursive: true, force: true }); }
    }
});
