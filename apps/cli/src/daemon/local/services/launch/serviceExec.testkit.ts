import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { execFile } from 'node:child_process';
import type { ProjectNativeToolchainIo } from '@/workspaces/toolchain/prepareProjectNativeToolchain';
import nacl from 'tweetnacl';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { createDeploymentSourceMaterializationPort } from '@/deployments/targets/ownServer/exactCommitRelease';
import { createOwnServerDockerBoundary } from '@/deployments/targets/ownServer/ownServerDeployment.testkit';
import { createDeploymentExecEnvPortForHost } from '@/deployments/secrets/deploymentExecEnvPort';
import { prepareEnvironmentSecretBindings } from '@/deployments/secrets/environmentSecretBindingService';
import { prepareEnvironmentSecretBindingsForLaunch } from '@/deployments/secrets/prepareEnvironmentSecretBindingsForLaunch';
import { createSavedSecretMaterializerV1 } from '@/settings/secrets/savedSecretCatalog';
import { createStablePluginExecService, createProjectNativeToolchainIoForHost,
    readPluginExecProcessCustodyForHost } from '@/plugins/runtime/invocation/services/exec';
import { createPluginExecSystemToolResolver } from '@/plugins/runtime/exec/system/tools/resolveGrant';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { createNativeComposeLifecycle, type NativeComposeEnvironmentProject } from './nativeComposeLifecycle';

export async function withFiniteComposeFixture(run: (fixture: Readonly<{
    project: NativeComposeEnvironmentProject;
    docker: Awaited<ReturnType<typeof createOwnServerDockerBoundary>>;
    root: string;
    source: Awaited<ReturnType<ReturnType<typeof createDeploymentSourceMaterializationPort>['materialize']>>;
    exec: ReturnType<typeof createStablePluginExecService>;
    envPort: ReturnType<typeof createDeploymentExecEnvPortForHost>;
    io: ProjectNativeToolchainIo;
}>) => Promise<void>, options: Readonly<{
    machineId?: string;
    installationId?: string;
    installationPrivateSeed?: Uint8Array;
    applicationDockerHost?: string;
    namedVolume?: true;
    runtimeSecrets?: Readonly<Record<string, string>>;
    serviceEnvironment?: Readonly<Record<string, string>>;
    serviceLabels?: Readonly<Record<string, string>>;
    withdrawnResourceIds?: readonly string[];
    recordedImages?: boolean;
    /** Substitute only Docker/OS metadata IO; admitted command supervision remains real. */
    nativeExecutableIo?: true;
    /** A distinct application writer for real restore quiesce/resume checks. */
    writerService?: true;
}> = {}) {
    const root = await mkdtemp(join(tmpdir(), 'happier-service-exec-'));
    const controller = new AbortController();
    const incumbent = tryAcquireAuthoritativePluginRuntimeRegistryLease();
    let admitted: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
    try {
        if (!incumbent) admitted = await createAdmittedPluginRuntimeFixture({ happyHomeDir: root, controller: pluginReloadController,
            // This native host fixture activates no plugins. Keep declarations
            // on that same empty scope instead of loading the ambient catalog.
            runtimeOptions: { pluginIds: [], contributes: createResolvedContributionRegistry({}) } });
        const hostDockerEndpoint = 'unix:///admitted-finite-engine.sock';
        const docker = await createOwnServerDockerBoundary(join(root, 'tools'), {
            engineId: `finite-engine-${createHash('sha256').update(root).digest('hex')}`,
            expectedDockerHost: hostDockerEndpoint,
        });
        const image = await docker.registerImage('worker', 'candidate-b');
        const document = JSON.stringify({ services: { worker: { image: image.registryReference,
            environment: { TOKEN: '${TOKEN:?required}', ...options.serviceEnvironment },
            ...(options.serviceLabels ? { labels: options.serviceLabels } : {}),
            ...(options.namedVolume ? { volumes: [{ type: 'volume', source: 'data', target: '/data' }] } : {}),
        }, ...(options.writerService ? { writer: { image: image.registryReference } } : {}) },
            ...(options.namedVolume ? { volumes: { data: { name: 'fixture-physical-data' } } } : {}) });
        const source = await createDeploymentSourceMaterializationPort({ async admit() {
            return { environmentId: 'finite-environment', environmentInstanceId: 'finite-instance', deploymentId: 'candidate-b',
                machineId: options.machineId ?? 'finite-machine', installationId: options.installationId ?? 'finite-installation', deploymentRoot: join(root, 'deployments'),
                artifactDirectory: join(root, 'source-artifacts'),
                definition: { kind: 'stored' as const, contentRevision: 1, document,
                    profiles: [], services: options.writerService ? ['worker', 'writer'] : ['worker'],
                    composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}` }, async assertCurrent() {} };
        } }).materialize({ environmentId: 'finite-environment', deploymentId: 'candidate-b' });
        const environment = { PATH: `${join(root, 'tools')}${delimiter}${process.env.PATH ?? ''}`, HOME: root, DOCKER_HOST: hostDockerEndpoint,
            COMPOSE_PROJECT_NAME: 'unreviewed-project', UNREVIEWED: 'unreviewed-value' };
        const exec = createStablePluginExecService({
            // Owner 2026-10-30: trust this machine's host profile; explicit
            // native project/engine selection still wins over ambient decoys.
            environment, signal: controller.signal, isOccurrenceCurrent: () => true,
            systemTools: createPluginExecSystemToolResolver({ baseEnv: environment,
                definitions: [{ toolId: 'docker', displayName: 'Docker', lookupNames: ['docker'] }], registerGrant() {} }),
            async resolveExecutable() { throw new Error('Only the resolved native tool is admitted'); }, resolvePath: async path => String(path) });
        const seed = options.installationPrivateSeed ?? new Uint8Array(32).fill(31);
        const binding = { purpose: 'variable' as const, phase: 'runtime' as const, name: 'TOKEN',
            source: { kind: 'secret' as const, ref: formatSharedSavedSecretRefV1('finite-secret'), resourceRevision: 1 } };
        const bindings = [binding, ...(options.applicationDockerHost === undefined ? [] : [{
            purpose: 'variable' as const, phase: 'runtime' as const, name: 'DOCKER_HOST',
            source: { kind: 'value' as const, value: options.applicationDockerHost },
        }])];
        const resource = { resourceId: 'finite-secret', ownerAccountId: 'finite-owner', displayName: 'Finite secret',
            kind: 'password' as const, encryptionMode: 'plain' as const, revision: 1, materialStatus: 'ready' as const,
            capabilities: { use: true, reveal: true, manage: true }, storedContent: { t: 'plain' as const,
                v: { v: 1 as const, name: 'Finite secret', kind: 'password' as const, value: 'finite-native-secret-sentinel' } } };
        const resources = [resource, ...Object.entries(options.runtimeSecrets ?? {}).map(([name, value]) => {
            const resourceId = `finite-${name.toLowerCase()}`;
            bindings.push({ purpose: 'variable', phase: 'runtime', name,
                source: { kind: 'secret', ref: formatSharedSavedSecretRefV1(resourceId), resourceRevision: 1 } });
            return { ...resource, resourceId, displayName: name,
                storedContent: { t: 'plain' as const, v: { ...resource.storedContent.v, name, value } } };
        })];
        const prepared = await prepareEnvironmentSecretBindings({ environmentId: source.environmentId, bindings, previousBindings: [],
            runtimeInstallations: [{ machineId: source.machineId, installationId: source.installationId,
                publicKey: nacl.sign.keyPair.fromSeed(seed).publicKey }], existingGrants: [],
            materializer: createSavedSecretMaterializerV1({ accountSettings: {}, settingsSecretsReadKeys: [], resources,
                resourceCatalogState: 'ready', isCurrent: () => true }), assertCurrent: source.assertCurrent });
        const envPort = createDeploymentExecEnvPortForHost({ source, phase: 'runtime', signal: controller.signal,
            isCurrent: () => true, prepare: ({ phase }: { phase: Parameters<typeof prepareEnvironmentSecretBindingsForLaunch>[0]['phase'] }) => prepareEnvironmentSecretBindingsForLaunch({
                environmentId: source.environmentId, machineId: source.machineId, installationId: source.installationId,
                installationPrivateSeed: seed, phase, bindings,
                grants: prepared.grants.filter(grant => grant.kind !== 'secret' || !options.withdrawnResourceIds?.includes(grant.resourceId)),
                assertCurrent: source.assertCurrent }) });
        const io: ProjectNativeToolchainIo = options.nativeExecutableIo ? {
            async resolveTool() { return null; },
            run(request) {
                return new Promise((resolve, reject) => {
                    const child = execFile(request.command, [...request.args], { cwd: request.cwd, env: request.env,
                        encoding: 'utf8', ...(request.signal ? { signal: request.signal } : {}) }, (error, stdout, stderr) => {
                        if (error && typeof error.code !== 'number') { reject(error); return; }
                        resolve({ exitCode: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
                    });
                    child.stdin?.end(request.stdin);
                });
            },
        } : createProjectNativeToolchainIoForHost({ async resolveTool() { return null; } });
        const project = createNativeComposeLifecycle({ kind: 'environmentProject', exec, envPort, source, sourceKind: 'stored',
            files: ['compose.yaml'], services: options.writerService ? ['worker', 'writer'] : ['worker'],
            images: options.recordedImages === false ? [] : [image, ...(options.writerService ? [{ ...image, service: 'writer' }] : [])], io,
            settleNative: readPluginExecProcessCustodyForHost(exec).waitForSettlement });
        try { await run({ project, docker, root, source, io, exec, envPort }); }
        finally { await project.dispose(); await readPluginExecProcessCustodyForHost(exec).requestStop(); }
    } finally {
        controller.abort();
        try { await incumbent?.release(); await admitted?.dispose(); }
        finally { await rm(root, { recursive: true, force: true }); }
    }
}
