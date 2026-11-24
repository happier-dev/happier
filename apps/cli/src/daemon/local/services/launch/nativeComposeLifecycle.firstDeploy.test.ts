import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { DeploymentImageV1 } from '@happier-dev/deployments/contracts/v1';
import { createProjectNativeToolchainIoForHost, createStablePluginExecService,
    type ProjectNativeEffectCaptureForHost } from '@/plugins/runtime/invocation/services/exec';
import { readDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { projectDeploymentException, projectDeploymentReceiptFailure } from '@/deployments/deploymentFailure';
import { createDeploymentExecEnvPortForHost } from '@/deployments/secrets/deploymentExecEnvPort';
import { createOwnServerDockerBoundary } from '@/deployments/targets/ownServer/ownServerDeployment.testkit';
import { createNativeComposeLifecycle } from './nativeComposeLifecycle';
import { machineNativeEffectAdmission } from './machineNativeEffectAdmission';

it.skipIf(process.platform === 'win32').each(['proven', 'beforeCreate', 'missingVariable', 'addressPoolExhausted', 'cancelled', 'unprovedRemoval', 'previewFresh', 'previewExisting'] as const)('limits first-deploy cleanup to witnessed introduced containers and fresh preview data after %s failure', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'happier-first-deploy-'));
    const captures = new Set<ProjectNativeEffectCaptureForHost>();
    try {
        const docker = await createOwnServerDockerBoundary(join(root, 'docker'));
        const image = await docker.registerImage('app', 'first');
        const database = await docker.registerImage('db', 'incumbent');
        await docker.failImageHealth(image.configDigest);
        if (mode === 'missingVariable') await docker.exitImage(image.configDigest, 78);
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
        const refusesBeforeCreate = mode === 'beforeCreate' || mode === 'addressPoolExhausted';
        let cancelAfterUp = false;
        let failBeforeCreate = false;
        let removalUnproved = false;
        const capturedLogs: string[] = [];
        let incumbentIds: readonly string[];
        // Lost caller custody immediately after Docker's real OS effect. This
        // boundary interruption must not be interpreted as proven failure.
        const io = { ...realIo, async run(request: Parameters<typeof realIo.run>[0]) {
            // Docker can refuse up before creating a candidate container.
            if (failBeforeCreate && request.args.includes('up')) {
                // Compose may allocate the first network before a later
                // allocation fails, without ever creating a container.
                const project = request.args[request.args.indexOf('--project-name') + 1]!;
                await docker.seedNetwork('e'.repeat(64), project);
                return { exitCode: 1, stdout: '', stderr: mode === 'addressPoolExhausted'
                    ? 'failed to create network project_extra: all predefined address pools have been fully subnetted'
                    : 'fixture up refused before create' };
            }
            if (removalUnproved && ['ps', 'inspect'].includes(request.args[0]!)) return { exitCode: 1, stdout: '[]', stderr: '' };
            if (mode === 'missingVariable' && request.args[0] === 'logs') {
                const id = request.args.at(-1)!;
                capturedLogs.push(id);
                const log = incumbentIds.includes(id) ? 'incumbent log' : 'FIELD_NOTES_SECRET_KEY is not set';
                request.output?.onChunk?.('stderr', Buffer.from(`${log}\n`));
                return { exitCode: 0, stdout: '', stderr: '' };
            }
            const output = await realIo.run(request);
            if (cancelAfterUp && request.args.includes('up')) candidateController.abort();
            if (mode === 'unprovedRemoval' && request.args[0] === 'container' && request.args[1] === 'rm') removalUnproved = true;
            return output;
        } };
        const native = (services: readonly string[], images: readonly DeploymentImageV1[]) => createNativeComposeLifecycle({ kind: 'environmentProject', source, exec, envPort,
            files: ['compose.yaml'], services, images, io,
            ...(mode === 'missingVariable' ? { stageOutput: { appendRedacted() {}, assertWritten() {} } } : {}),
            storage: { runtimeMachineCount: 1, ...(mode.startsWith('preview')
                ? { previewDataVolumes: [{ service: 'app', target: '/data' }] } : {}) }, async settleNative() {
                await Promise.all([...captures].map(capture => capture.waitForSettlement()));
            } });
        await writeFile(join(root, 'compose.yaml'), JSON.stringify({ services: { db: { image: database.registryReference,
            volumes: [{ type: 'volume', source: 'db_data', target: '/data' }] } }, volumes: { db_data: {} } }));
        const incumbent = native(['db'], [database]);
        try {
            const rendered = await incumbent.render();
            const running = await machineNativeEffectAdmission.run({ operation: { operationId: 'incumbent', kind: 'deployments.deploy' }, keys: rendered.keys },
                context => incumbent.activate({ render: rendered, context }));
            incumbentIds = running.nativeIdsForService('db');
            await running.dispose();
        } finally { await incumbent.dispose(); }
        await writeFile(join(root, 'compose.yaml'), JSON.stringify({ services: {
            app: { image: image.registryReference, environment: { DEPLOY_PASSWORD: 'fixture-password' }, volumes: [{ type: 'volume', source: 'app_data', target: '/data' }] },
            db: { image: database.registryReference, volumes: [{ type: 'volume', source: 'db_data', target: '/data' }] },
        }, volumes: { app_data: {}, db_data: {} } }));
        const project = native(['app', 'db'], [image, database]);
        cancelAfterUp = mode === 'cancelled';
        failBeforeCreate = refusesBeforeCreate;
        const candidateSignal = mode === 'cancelled' ? candidateController.signal : signal;
        try {
            const rendered = await project.render();
            const beforeNetworks = await docker.readNetworkIds(rendered.projectName);
            expect(beforeNetworks).toHaveLength(1);
            const appVolume = `${rendered.projectName}_app_data`;
            const dbVolume = `${rendered.projectName}_db_data`;
            await docker.seedVolume('source-postgres-data', 'source-project');
            if (mode === 'previewExisting') await docker.seedVolume(appVolume, rendered.projectName);
            const activation = machineNativeEffectAdmission.run({ operation: { operationId: 'first', kind: 'deployments.deploy', signal: candidateSignal }, keys: rendered.keys },
                context => project.activate({ render: rendered, context, cleanupOnFailure: true, signal: candidateSignal }));
            if (mode === 'missingVariable') {
                const error = await activation.catch((failure: unknown) => failure);
                const failure = projectDeploymentReceiptFailure(projectDeploymentException(error), 'activate');
                expect(failure).toMatchObject({ nativeActivation: {
                    service: 'app', exitStatus: 78, missingVariable: 'FIELD_NOTES_SECRET_KEY',
                } });
                expect(readDeploymentFailureRecoveryV1(failure.code, failure)).toMatchObject({
                    remedy: expect.stringMatching(/app.*78.*FIELD_NOTES_SECRET_KEY/),
                    nextAction: { destination: 'variables' },
                });
                expect(capturedLogs).toHaveLength(2);
                expect(capturedLogs).toEqual(expect.arrayContaining(incumbentIds));
                return;
            } else if (mode === 'addressPoolExhausted') {
                const error = await activation.catch((failure: unknown) => failure);
                const receiptFailure = projectDeploymentReceiptFailure(projectDeploymentException(error), 'activate');
                expect(receiptFailure).toMatchObject({ code: 'native_failed', phase: 'activate',
                    effectAttempted: true, failureCause: { errorCode: 'deployment_network_address_pool_exhausted' } });
                expect(readDeploymentFailureRecoveryV1(receiptFailure.code, receiptFailure)).toMatchObject({
                    remedy: expect.stringMatching(/free unused Docker networks/i),
                    nextAction: { destination: 'machines' },
                });
            } else if (mode === 'proven' || mode === 'beforeCreate' || mode.startsWith('preview')) await expect(activation).rejects.toMatchObject({ code: 'native_failed',
                details: { reason: mode === 'beforeCreate' ? 'native_compose_command_failed' : 'deployment_health_check_failed', firstDeployCleanup: 'removed' } });
            else if (mode === 'unprovedRemoval') {
                await expect(activation).rejects.toMatchObject({ code: 'native_failed', details: { reason: 'deployment_health_check_failed' } });
                await expect(activation).rejects.not.toMatchObject({ details: { firstDeployCleanup: 'removed' } });
            } else await expect(activation).rejects.toBeDefined();
            expect(await docker.readRunningImageConfig('app')).toBe(mode === 'cancelled' ? image.configDigest : null);
            expect(await docker.readRunningImageConfig('db')).toBe(database.configDigest);
            expect(await docker.readNetworkIds(rendered.projectName)).toEqual(beforeNetworks);
            expect(await docker.readVolumeNames()).toEqual((mode === 'previewFresh' || refusesBeforeCreate
                ? [dbVolume, 'source-postgres-data'] : [appVolume, dbVolume, 'source-postgres-data']).sort());
            const invocations = await docker.readInvocations();
            expect(invocations.some(call => call.args[0] === 'container' && call.args[1] === 'rm')).toBe(mode !== 'cancelled' && !refusesBeforeCreate);
            expect(invocations.filter(call => call.args[0] === 'container' && call.args[1] === 'rm')
                .some(call => incumbentIds.some(id => call.args.includes(id)))).toBe(false);
            expect(invocations.some(call => call.args.includes('down') || call.args.includes('--volumes') || call.args.includes('prune'))).toBe(false);
        } finally { await project.dispose(); }
    } finally {
        try { await Promise.all([...captures].map(capture => capture.release())); }
        finally { await rm(root, { recursive: true, force: true }); }
    }
});
