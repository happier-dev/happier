import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DeploymentImageV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentSourceMaterializationV1 } from '@happier-dev/plugin-sdk/services';
import { createProjectNativeToolchainIoForHost, createStablePluginExecService,
    type ProjectNativeEffectCaptureForHost } from '@/plugins/runtime/invocation/services/exec';
import { createDeploymentExecEnvPortForHost } from '@/deployments/secrets/deploymentExecEnvPort';
import { createOwnServerDockerBoundary } from '@/deployments/targets/ownServer/ownServerDeployment.testkit';
import { createNativeComposeLifecycle } from './nativeComposeLifecycle';
import { machineNativeEffectAdmission } from './machineNativeEffectAdmission';

describe('Environment changed-service recreation', () => {
    // The executable fixture is the Docker/OS boundary. Admission, phase rendering,
    // image archive verification and activation use their real production owners.
    it.skipIf(process.platform === 'win32')('keeps the unchanged database generation when only the web image changes', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-compose-recreate-'));
        const captures = new Set<ProjectNativeEffectCaptureForHost>();
        try {
            const docker = await createOwnServerDockerBoundary(join(root, 'docker'));
            const database = await docker.registerImage('db', 'A');
            const webA = await docker.registerImage('web', 'A');
            const webB = await docker.registerImage('web', 'B');
            const io = createProjectNativeToolchainIoForHost({
                async resolveTool() { return { executablePath: docker.executablePath, version: 'fixture' }; },
            }).createInvocation({ signal: new AbortController().signal, retainCapture(capture) { captures.add(capture); } });
            async function activate(deploymentId: string, web: DeploymentImageV1) {
                const rootPath = join(root, deploymentId);
                await mkdir(rootPath);
                await writeFile(join(rootPath, 'compose.yaml'), JSON.stringify({ services: {
                    web: { image: web.registryReference }, db: { image: database.registryReference },
                } }));
                const source: DeploymentSourceMaterializationV1 = {
                    environmentId: 'environment', environmentInstanceId: 'instance', deploymentId,
                    machineId: 'machine', installationId: 'installation', rootPath,
                    manifestFingerprint: deploymentId, async assertCurrent() {}, async commit() {}, async abort() {},
                };
                const executable = { kind: 'systemTool', id: 'docker' } as const;
                const signal = new AbortController().signal;
                const exec = createStablePluginExecService({ signal,
                    isOccurrenceCurrent: () => true,
                    async resolveExecutable() { return { command: docker.executablePath }; },
                    async resolvePath() { return rootPath; },
                    systemTools: { async resolve(request) { return { grantId: 'docker-fixture', toolId: request.toolId, displayName: 'Docker fixture', source: 'system', executablePath: docker.executablePath,
                        launch: { kind: 'binary', executablePath: docker.executablePath } }; } },
                });
                const envPort = createDeploymentExecEnvPortForHost({ source, phase: 'runtime', signal,
                    isCurrent: () => true, async prepare() {
                        return { env: { PATH: process.env.PATH ?? '', HOME: root }, secretValues: [], refs: [],
                            async recheck() {}, dispose() {} };
                    },
                });
                const project = createNativeComposeLifecycle({ kind: 'environmentProject', source, exec, envPort,
                    files: ['compose.yaml'], services: ['web', 'db'], images: [web, database], io,
                    async settleNative() { await Promise.all([...captures].map(capture => capture.waitForSettlement())); } });
                try {
                    const rendered = await project.render();
                    const beforeActivation = (await docker.readInvocations()).length;
                    const activated = await machineNativeEffectAdmission.run({
                        operation: { operationId: deploymentId, kind: 'deployments.deploy' }, keys: rendered.keys,
                    }, context => project.activate({ render: rendered, context }));
                    // One fresh render identifies the engine at admission;
                    // image effects, activation and native waits do not recheck it.
                    expect((await docker.readInvocations()).slice(beforeActivation)
                        .filter(invocation => invocation.args.includes('info'))).toHaveLength(1);
                    return { web: activated.nativeIdsForService('web'), db: activated.nativeIdsForService('db'),
                        webFacts: activated.nativeFactsForService('web'), dbFacts: activated.nativeFactsForService('db') };
                } finally { await project.dispose(); }
            }

            const first = await activate('deployment-A', webA);
            // An unchanged native dependency keeps its historical restart
            // counter; Compose convergence does not erase earlier crashes.
            await docker.setNativeRestartCount('db', 3);
            const second = await activate('deployment-B', webB);
            expect(second.db).toEqual(first.db);
            expect(second.web).not.toEqual(first.web);
            expect(first.webFacts).toMatchObject({ configuration: { name: 'web' },
                containerImages: [{ id: first.web[0], imageConfigDigest: webA.configDigest }] });
            expect(second.webFacts).toMatchObject({ configuration: { name: 'web' },
                containerImages: [{ id: second.web[0], imageConfigDigest: webB.configDigest }] });
            // The private configuration matcher is a fresh closure for each
            // capture; unchanged native identity is the public generation fact.
            expect(second.dbFacts.containerImages).toMatchObject(first.dbFacts.containerImages.map(
                ({ id, nativeImageId, imageConfigDigest }) => ({ id, nativeImageId, imageConfigDigest })));
            expect(second.dbFacts.containerImages[0]?.imageConfigDigest).toBe(database.configDigest);
            const invocations = await docker.readInvocations();
            expect(invocations.filter(invocation => invocation.args.includes('up'))).toHaveLength(2);
            expect(invocations.some(invocation => invocation.args.includes('stop') || invocation.args.includes('down')
                || invocation.args.includes('--force-recreate') || invocation.args.includes('--no-recreate'))).toBe(false);
        } finally {
            try { await Promise.all([...captures].map(capture => capture.release())); }
            finally { await rm(root, { recursive: true, force: true }); }
        }
    });
});
