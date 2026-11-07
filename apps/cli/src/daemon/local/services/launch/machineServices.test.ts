import { describe, expect, it, vi } from 'vitest';
import axios, { AxiosHeaders } from 'axios';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MachineServicesListResultV1Schema, MachineServicesDiscoveryResultV1Schema, MachineServicesDetailResultV1Schema,
    MachineServiceWatchMutationResultV1Schema, type MachineMetadataFieldPortV1, type MachineMetadataFieldReadV1 } from '@happier-dev/protocol';
import { seedCurrentLocalPathPluginFixture } from '@/plugins/store/registry/currentState.testkit';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { readCurrentCommittedPluginGenerations } from '@/plugins/store/registry/generationStore';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createDeploymentSourceMaterializationPort } from '@/deployments/targets/ownServer/exactCommitRelease';
import { createScmBackendRegistry } from '@/scm/registry';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';
import { acquireRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { buildAccountIdentitiesChangeV1, type ChangeEntry } from '@happier-dev/protocol/changes';
import { createMachineServicesRuntime } from './machineServices';
import type { ProjectNativeRuntimeFacts } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { withMachineServiceTarget } from './machineServiceTarget';
import { ActionsSettingsV1Schema, setScopedActionApprovalPreference } from '@happier-dev/protocol/actions/actionSettings';
import { createLocalServiceActionRoutes } from '../actions/routes';
import { createLocalServiceInventoryRegistry } from '../inventory/registry';
import { createLocalServiceActionConfirmationNonceV1 } from '@happier-dev/protocol/local/services/actions/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandler } from '@/api/rpc/types';
import { registerDaemonLocalServicesMachineRpcHandlers } from '@/rpc/handlers/daemonLocalServices';
import { registerDaemonContributionRegistryProjectionHandler } from '@/rpc/handlers/daemonContributionRegistryProjection';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol';
import { ManagedServiceNativeLogResultV1Schema, type ManagedServiceNativeLogResultV1 } from '@happier-dev/protocol';
import { DaemonPluginUiResourceReadResponseSchema, DAEMON_PLUGIN_UI_RESOURCE_WATCH_MIN_WAIT_MS } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

describe('Machine service watch front door', () => {
    it('leaves Compose adoption to the reviewed deployment owner before native observation admission', async () => {
        const runtime = createMachineServicesRuntime({ target: { serverId: 'home', machineId: 'machine' },
            readMetadata: () => { throw new Error('Adoption must not read watch custody'); },
            captureMetadataPort: () => { throw new Error('Adoption must not mutate watch custody'); } });
        expect(await runtime.execute({ actionId: 'machines.services.adopt', input: {
            serverId: 'home', machineId: 'machine', serviceId: 'analytics', expectedGeneration: 'generation',
            requestKey: 'adoption', profiles: [], mode: 'review',
        }, context: { surface: 'cli', authority: 'present_user' },
        canReadEnvironments: async () => new Set() })).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
        await runtime.dispose();
    });

    it('retires exact transferred watches without stopping native services and hides residual watches when metadata custody is unavailable', async () => {
        const fixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController, runtimeOptions: { pluginIds: [] } });
        const root = await mkdtemp(join(tmpdir(), 'happier-watch-takeover-'));
        const target = { serverId: 'home', machineId: 'machine' };
        const adapter = { pluginId: 'example.native', localId: 'compose' };
        const watches = ['project', 'project/web', 'unrelated'].map((nativeResourceId, index) => ({
            v: 1 as const, watchId: `watch-${index}`, name: `Native ${index}`, adapter, nativeResourceId,
            lifecyclePurpose: 'deployment' as const,
        }));
        let metadata: MachineMetadataFieldReadV1 = { status: 'ready', metadataVersion: 1,
            metadata: { displayName: 'Keep this', serviceWatchesV1: { v: 1, watches } } };
        let writeAvailable = false;
        let writes = 0;
        let nativeStops = 0;
        let watchReleases = 0;
        const port: MachineMetadataFieldPortV1 = { read: async () => metadata, compareAndSwap: async request => {
            writes++;
            if (!writeAvailable) return { status: 'locked' };
            if (metadata.status !== 'ready') return metadata;
            if (request.expectedMetadataVersion !== metadata.metadataVersion) return { ...metadata, status: 'conflict' };
            metadata = { status: 'ready', metadataVersion: metadata.metadataVersion + 1, metadata: request.metadata };
            return { ...metadata, status: 'applied' };
        } };
        const runtime = createMachineServicesRuntime({ target, readMetadata: () => metadata, captureMetadataPort: () => port });
        const owner = fixture.registry.projectManagedServices;
        const watchedHandles: Awaited<ReturnType<typeof owner.superviseMachine>>[] = [];
        let environmentHandle: Awaited<ReturnType<typeof owner.superviseProject>> | undefined;
        const document = JSON.stringify({ services: { web: { image: 'example/web:1' } } });
        const materializer = createDeploymentSourceMaterializationPort({ registry: createScmBackendRegistry([]), async admit() {
            return { environmentId: 'production', environmentInstanceId: 'production-machine', deploymentId: 'deploy-a',
                machineId: target.machineId, installationId: 'installation', deploymentRoot: join(root, 'deployments'),
                artifactDirectory: join(root, 'artifacts'), definition: { kind: 'stored' as const, contentRevision: 1,
                    document, composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`,
                    profiles: [], services: ['web'] }, async assertCurrent() {} };
        } });
        const release = await materializer.materialize({ environmentId: 'production', deploymentId: 'deploy-a' });
        await release.commit();
        const request = { actionId: 'machines.services.list' as const, input: target,
            context: { surface: 'cli' as const, authority: 'present_user' as const },
            canReadEnvironments: async (environmentIds: readonly string[]) => new Set(environmentIds) };
        try {
            for (const watch of watches) watchedHandles.push(await owner.superviseMachine({ ...target, watch, isCurrent: () => true,
                releaseObservation: async () => { watchReleases++; }, lifecycle: {
                    async inspect() { return { phase: 'running', readiness: 'not_reported', endpoint: null }; },
                    async stop() { nativeStops++; return { status: 'stopped' }; },
                } }));
            environmentHandle = await owner.superviseProject({ kind: 'environment', ...target,
                environmentId: release.environmentId, environmentInstanceId: release.environmentInstanceId,
                deploymentId: release.deploymentId, release, composeService: 'web', serviceId: 'production-machine/web',
                specIdentity: 'deploy-a', isCurrent: () => true,
                releaseObservation: async () => {}, nativeEffects: { keys: [] },
                processSpec: { mode: { kind: 'native', observationOnly: true, builtinLifecycle: {
                    nativeInstances: () => watches.slice(0, 2),
                    async inspect() { return { phase: 'running', readiness: 'not_reported', endpoint: null }; },
                    async stop() { nativeStops++; return { status: 'stopped' }; },
                } } },
            });
            // Ownership transfers before any Machine projection or metadata CAS.
            expect(watchedHandles.slice(0, 2).every(handle => handle.retirementSignal.aborted && !handle.isCurrent())).toBe(true);
            expect(watchedHandles[2]?.isCurrent()).toBe(true);
            expect(watchReleases).toBe(2);
            expect(nativeStops).toBe(0);
            const list = MachineServicesListResultV1Schema.parse(await runtime.execute(request));
            expect(list).toMatchObject({ kind: 'snapshot', services: [
                { serviceId: 'production-machine/web', authority: 'project', environmentId: 'production' },
                { serviceId: 'watch-2', authority: 'machine' },
            ] });
            if (list.kind !== 'snapshot') throw new Error('Expected current service projection');
            expect(list.services).toHaveLength(2);
            expect(owner.listMachineServices().map(handle => handle.watch.watchId)).toEqual(['watch-2']);
            expect(watchReleases).toBe(2);
            expect(metadata).toMatchObject({ metadata: { serviceWatchesV1: { watches } } });
            expect(writes).toBe(1);
            writeAvailable = true;
            await runtime.reconcile();
            expect(metadata).toMatchObject({ metadata: { displayName: 'Keep this', serviceWatchesV1: { watches: [watches[2]] } } });
            const settledWrites = writes;
            for (let index = 0; index < 10; index++) await runtime.reconcile();
            expect(writes).toBe(settledWrites);
            expect(owner.listMachineServices()).toHaveLength(1);
            expect(nativeStops).toBe(0);
        } finally {
            // Shared-controller fixture retirement retains Environment residency.
            // This test owns the observation and must detach it even on failure.
            try { await environmentHandle?.dispose(); }
            finally { await runtime.dispose(); await fixture.dispose(); await rm(root, { recursive: true, force: true }); }
        }
        expect(nativeStops).toBe(0);
    });
    it('retains unavailable watch intent and removes it without a native effect or unrelated-field loss', async () => {
        const target = { serverId: 'home', machineId: 'machine' };
        const watch = { v: 1 as const, watchId: 'watch-one', name: 'Worker', adapter: {
            pluginId: 'acme.not-installed', localId: 'native' }, nativeResourceId: 'user/worker.service', lifecyclePurpose: 'deployment' as const };
        let snapshot: MachineMetadataFieldReadV1 = { status: 'ready', metadataVersion: 4,
            metadata: { displayName: 'Retained name', serviceWatchesV1: { v: 1, watches: [watch] } } };
        let writes = 0;
        const port: MachineMetadataFieldPortV1 = { read: async () => snapshot, compareAndSwap: async input => {
            writes++;
            if (snapshot.status !== 'ready') return snapshot;
            if (input.expectedMetadataVersion !== snapshot.metadataVersion) return { ...snapshot, status: 'conflict' };
            snapshot = { status: 'ready', metadataVersion: snapshot.metadataVersion + 1, metadata: input.metadata };
            return { ...snapshot, status: 'applied' };
        } };
        const runtime = createMachineServicesRuntime({ target, readMetadata: () => snapshot, captureMetadataPort: () => port });
        const context = { surface: 'cli' as const, authority: 'present_user' as const };
        try {
            const listed = MachineServicesListResultV1Schema.parse(await runtime.execute({ actionId: 'machines.services.list', input: target, context }));
            expect(listed).toMatchObject({ kind: 'snapshot', services: [{ serviceId: watch.watchId, watchId: watch.watchId,
                nativeInstance: { adapter: watch.adapter, nativeResourceId: watch.nativeResourceId },
                authority: 'machine', generation: null, state: 'unknown', lifecyclePurpose: 'deployment',
                capabilities: { start: false, stop: false, restart: false, logs: false, accounting: false } }] });
            if (listed.kind !== 'snapshot') throw new Error('Expected service snapshot');
            expect(listed.services[0]).not.toHaveProperty('baseUrl');
            expect(listed.services[0]).not.toHaveProperty('port');
            const revision = listed.services[0]?.watchRevision;
            if (!revision) throw new Error('The actual watch row must carry its unwatch revision');
            expect(await runtime.execute({ actionId: 'machines.services.unwatch', context, input: {
                ...target, watchId: watch.watchId, expectedRevision: 'stale-review',
            } })).toMatchObject({ kind: 'conflict' });
            expect(writes).toBe(0);
            expect(await runtime.execute({ actionId: 'machines.services.unwatch', context, input: {
                ...target, watchId: watch.watchId, expectedRevision: revision,
            } })).toMatchObject({ kind: 'applied' });
            expect(writes).toBe(1);
            expect(snapshot).toMatchObject({ metadata: { displayName: 'Retained name', serviceWatchesV1: { v: 1, watches: [] } } });
            snapshot = { status: 'locked' };
            expect(await runtime.execute({ actionId: 'machines.services.list', context, input: target }))
                .toEqual({ kind: 'unavailable', reason: 'admission_unavailable' });
            expect(await runtime.execute({ actionId: 'machines.services.unwatch', context, input: {
                ...target, watchId: watch.watchId, expectedRevision: revision,
            } })).toEqual({ kind: 'unavailable', reason: 'admission_unavailable' });
            expect(writes).toBe(1);
        } finally { await runtime.dispose(); }
    });

    it('discovers an installed native adapter and adopts only its reviewed instance without starting or stopping it', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-machine-services-'));
        const pluginRoot = join(happyHomeDir, 'native-plugin');
        const nativeState = join(happyHomeDir, 'native.json');
        const pluginId = 'acme.machine-services';
        const adapter = { pluginId, localId: 'native' };
        const target = { serverId: 'home', machineId: 'machine' };
        const context = { surface: 'cli' as const, authority: 'present_user' as const };
        let metadata: MachineMetadataFieldReadV1 = { status: 'ready', metadataVersion: 1, metadata: { displayName: 'Original',
            serviceWatchesV1: { v: 1, watches: [{ v: 1, watchId: 'recovered-watch', name: 'Recovered worker', adapter,
                nativeResourceId: 'user/worker.service', lifecyclePurpose: 'infrastructure' }] } } };
        let writes = 0;
        let metadataBasis = 0;
        const port: MachineMetadataFieldPortV1 = { read: async () => metadata, compareAndSwap: async input => {
            if (metadata.status !== 'ready') return metadata;
            if (metadata.metadataVersion !== input.expectedMetadataVersion) return { ...metadata, status: 'conflict' };
            writes++;
            metadata = { status: 'ready', metadataVersion: metadata.metadataVersion + 1, metadata: input.metadata };
            return { ...metadata, status: 'applied' };
        } };
        const runtime = createMachineServicesRuntime({ target, readMetadata: () => metadata, captureMetadataPort: () => {
            const capturedBasis = metadataBasis;
            return { read: async () => capturedBasis === metadataBasis ? port.read() : { status: 'unavailable' as const },
                compareAndSwap: async input => capturedBasis === metadataBasis ? port.compareAndSwap(input) : { status: 'unavailable' as const } };
        } });
        let registry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | undefined;
        let releaseHome = () => {};
        let releaseDiscovery = () => {};
        let discoveryEntered = () => {};
        const pausedDiscovery = new Promise<void>(resolve => { discoveryEntered = resolve; });
        let releaseLogDisposal = () => {};
        let logDisposalEntered = () => {};
        const pausedLogDisposal = new Promise<void>(resolve => { logDisposalEntered = resolve; });
        let releaseNativeStop = () => {};
        let nativeStopEntered = () => {};
        const pausedNativeStop = new Promise<void>(resolve => { nativeStopEntered = resolve; });
        const nativeBoundary = createServer((request, response) => {
            if (request.url === '/native-stop') {
                releaseNativeStop = () => response.end('settled');
                nativeStopEntered();
                return;
            }
            if (request.url === '/logs-dispose') {
                releaseLogDisposal = () => response.end('released');
                logDisposalEntered();
                return;
            }
            releaseDiscovery = () => response.end('observed');
            discoveryEntered();
        });
        try {
            await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
            await writeFile(nativeState, JSON.stringify({ name: 'Native worker', endpoint: 'http://127.0.0.1:45432/',
                discovers: 0, inspects: 0, accountings: 0, logs: 0, logWatches: 0, logDisposals: 0, controls: [] }));
            await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
                schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Native service fixture',
                engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
                contributes: { projectNativeAdapters: [{ id: 'native', files: ['native.json'], roles: ['nativeServiceLifecycle'] }] },
            }));
            // The installed native adapter is the system boundary. Registry admission,
            // capture, observation supervision, schemas and metadata CAS stay real.
            await writeFile(join(pluginRoot, 'daemon.mjs'), [
                "import { readFile, writeFile } from 'node:fs/promises';",
                `const path = ${JSON.stringify(nativeState)};`,
                "async function read() { return JSON.parse(await readFile(path, 'utf8')); }",
                "async function update(key) { const state = await read(); state[key]++; await writeFile(path, JSON.stringify(state)); return state; }",
                'export function activate(api) {',
                "api.projectNativeAdapters.register('native', { nativeServiceLifecycle: {",
                `async discover(machine) { if (machine.serverId !== 'home' || machine.machineId !== 'machine') throw new Error('Wrong native target'); const state = await update('discovers'); if (state.discoveryPauseUrl) await fetch(state.discoveryPauseUrl); return { kind: 'partial', candidates: [{ instance: { adapter: ${JSON.stringify(adapter)}, nativeResourceId: 'user/worker.service' }, name: state.name, observation: { phase: 'running', readiness: 'not_reported', endpoint: null } }], failures: [{ kind: 'unavailable', code: 'second_source_unavailable' }] }; },`,
                "async inspect() { const state = await update('inspects'); return { phase: state.phase ?? 'running', readiness: 'not_reported', endpoint: state.endpoint ?? null }; },",
                "async logs(instance, request) { if (request.kind === 'watch') { await update('logWatches'); request.emit({ kind: 'page', page: { sourceRevision: instance.nativeResourceId, text: 'followed native output', nextCursor: null, truncated: false } }); return { async dispose() { const state = await read(); if (state.logDisposalPauseUrl) await fetch(state.logDisposalPauseUrl); await update('logDisposals'); } }; } await update('logs'); return { kind: 'page', page: { sourceRevision: instance.nativeResourceId, text: 'adopted native output', nextCursor: null, truncated: false } }; },",
                "async accounting(instances) { const state = await update('accountings'); if (state.accountingUncertain) throw Object.assign(new Error('Native accounting cleanup is unconfirmed'), { code: 'plugin_exec_termination_incomplete' }); return { kind: 'sample', samples: instances.map(instance => ({ instance, cpuPercent: null, memoryBytes: 128 })) }; },",
                "async stop() { const state = await read(); state.controls.push('stop'); const status = state.stopStatus ?? 'stopped'; if (status === 'stopped') state.phase = 'stopped'; await writeFile(path, JSON.stringify(state)); if (state.stopPauseUrl) await fetch(state.stopPauseUrl); return { status }; },",
                '} }); }',
            ].join('\n'));
            await seedCurrentLocalPathPluginFixture({ happyHomeDir, pluginRoot, pluginId, manifestVersion: '1.0.0' });
            const loaded = await loadInstalledPlugins({ happyHomeDir });
            expect(loaded.diagnosticsByPluginId[pluginId] ?? []).toEqual([]);
            const contributes = createResolvedContributionRegistry(projectLoadedPluginContributes({ loadResult: loaded,
                provenance: 'external', existingAgentIds: new Set() }));
            const generationAuthority = await readCurrentCommittedPluginGenerations(resolvePluginStorePaths({ happyHomeDir }), {});
            if (!generationAuthority) throw new Error('Expected installed native adapter generation');
            registry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir, contributes, generationAuthority, generation: 1 });
            expect(await pluginReloadController.adoptPreparedRuntimeRegistry({ registry, changedPluginIds: [pluginId],
                durableRevision: registry.durableRevision, runningSessionDisposition: 'retainRunningSessions' })).toMatchObject({ ok: true });
            const document = 'services:\n  private_web:\n    image: example/web\n  private_db:\n    image: example/db\n';
            const materializer = createDeploymentSourceMaterializationPort({ registry: createScmBackendRegistry([]), async admit() {
                return { environmentId: 'private-environment', environmentInstanceId: 'private-instance', deploymentId: 'private-deployment',
                    machineId: target.machineId, installationId: 'installation', deploymentRoot: join(happyHomeDir, 'deployments'),
                    artifactDirectory: join(happyHomeDir, 'artifacts'), definition: { kind: 'stored' as const, contentRevision: 1,
                        document, composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`,
                        profiles: [], services: ['private_web', 'private_db'] }, async assertCurrent() {} };
            } });
            const release = await materializer.materialize({ environmentId: 'private-environment', deploymentId: 'private-deployment' });
            await release.commit();
            let environmentAccounting = 0;
            let environmentRuntimeReads = 0;
            let environmentRuntimeFacts: ProjectNativeRuntimeFacts = { configuration: {
                name: 'private_web', replicas: null, resources: { cpus: null, memory: null },
                restartPolicy: 'unless-stopped', healthcheck: 'absent',
                ports: [
                    { target: 5432, published: '15432', bindAddress: '10.20.0.7', protocol: 'tcp' },
                    { target: '8080', published: 18080, bindAddress: '127.0.0.1', protocol: 'udp' },
                ],
                mounts: [{ type: 'bind', source: '/srv/private-data', target: '/data', readOnly: true }],
            }, observedAt: 41, freshness: 'current' };
            let environmentLogs = 0;
            let afterEnvironmentLogRead: (() => void) | undefined;
            let duringEnvironmentLogWatch: (() => void) | undefined;
            let emitEnvironmentLog: ((value: ManagedServiceNativeLogResultV1) => void) | undefined;
            let environmentLogWatchCursor: import('@happier-dev/protocol').ManagedServiceNativeLogCursorV1 | undefined;
            let environmentLogWatchDisposals = 0;
            let environmentServiceCurrent = true;
            let environmentStops = 0;
            let observationReleases = 0;
            for (const composeService of ['private_web', 'private_db']) await registry.projectManagedServices.superviseProject({
                kind: 'environment', ...target, environmentId: release.environmentId, environmentInstanceId: release.environmentInstanceId,
                deploymentId: release.deploymentId, release, composeService, serviceId: `${release.environmentInstanceId}/${composeService}`,
                specIdentity: composeService, isCurrent: () => environmentServiceCurrent, releaseObservation: async () => { observationReleases++; },
                nativeEffects: { keys: [] },
                processSpec: { mode: { kind: 'native', builtinLifecycle: {
                    async inspect() { return { phase: 'running', readiness: 'not_reported', endpoint: null }; },
                    runtimeFacts() { environmentRuntimeReads++; return environmentRuntimeFacts; },
                    async stop() { environmentStops++; return { status: 'stopped' }; },
                    async logs(request) {
                        environmentLogs++;
                        if (request.kind === 'watch') {
                            environmentLogWatchCursor = request.cursor;
                            emitEnvironmentLog = request.emit;
                            duringEnvironmentLogWatch?.();
                            return { async dispose() { environmentLogWatchDisposals++; emitEnvironmentLog = undefined; } };
                        }
                        const offset = request.cursor?.token;
                        const text = offset === undefined ? 'private Environment output' : offset === 'native-position-1' ? '\ncontinued 🌍 synthetic-private-log-material\n' : '';
                        afterEnvironmentLogRead?.();
                        return { kind: 'page', page: { sourceRevision: composeService, text,
                            nextCursor: { sourceRevision: composeService, token: offset === undefined ? 'native-position-1' : 'native-position-2' },
                            truncated: offset === undefined } };
                    },
                    async readAccounting() { environmentAccounting++; return { kind: 'sample', samples: [
                        { nativeResourceId: 'actual-container-id', cpuPercent: null, memoryBytes: 256 },
                    ] }; },
                    redactedValues: ['synthetic-private-log-material'],
                } } },
            });
            const legacyControls = createLocalServiceActionRoutes({ machineId: target.machineId,
                inventoryRegistry: createLocalServiceInventoryRegistry(), projectManagedServices: registry.projectManagedServices });
            const environmentHandle = registry.projectManagedServices.listProjectServices().find(handle => handle.kind === 'environment');
            if (!environmentHandle) throw new Error('Expected actual Environment owner');
            // The admitted native boundary supplies Stop only. Wrapper methods
            // do not make Start and Restart executable native operations.
            expect.soft(registry.projectManagedServices.machineServiceRows.read(environmentHandle).capabilities)
                .toMatchObject({ start: false, stop: true, restart: false });
            for (const action of ['stop_managed', 'restart_managed'] as const) {
                const request = { requestId: `legacy-${action}`, action, force: false,
                    target: { kind: 'managed_service' as const, machineId: target.machineId, managedServiceId: environmentHandle.instanceId } };
                for (const input of [request, { ...request, confirmationNonce: createLocalServiceActionConfirmationNonceV1(request) }]) {
                    expect(await legacyControls.execute(input))
                        .toMatchObject({ status: 'denied', reasonCode: 'use_machines_services_control' });
                }
            }
            expect(environmentStops).toBe(0);
            const offTargetMaterializer = createDeploymentSourceMaterializationPort({ registry: createScmBackendRegistry([]), async admit() {
                return { environmentId: 'off-target-environment', environmentInstanceId: 'off-target-instance', deploymentId: 'off-target-deployment',
                    machineId: 'other-machine', installationId: 'installation', deploymentRoot: join(happyHomeDir, 'deployments'),
                    artifactDirectory: join(happyHomeDir, 'artifacts'), definition: { kind: 'stored' as const, contentRevision: 1,
                        document, composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`,
                        profiles: [], services: ['private_web'] }, async assertCurrent() {} };
            } });
            const offTargetRelease = await offTargetMaterializer.materialize({ environmentId: 'off-target-environment', deploymentId: 'off-target-deployment' });
            await offTargetRelease.commit();
            await registry.projectManagedServices.superviseProject({ kind: 'environment', serverId: target.serverId, machineId: 'other-machine',
                environmentId: offTargetRelease.environmentId, environmentInstanceId: offTargetRelease.environmentInstanceId,
                deploymentId: offTargetRelease.deploymentId, release: offTargetRelease, composeService: 'private_web',
                serviceId: `${offTargetRelease.environmentInstanceId}/private_web`, specIdentity: 'off-target',
                isCurrent: () => true, releaseObservation: async () => { observationReleases++; }, nativeEffects: { keys: [] },
                processSpec: { mode: { kind: 'native', builtinLifecycle: {
                    async inspect() { return { phase: 'running', readiness: 'not_reported', endpoint: null }; },
                    async stop() { environmentStops++; return { status: 'stopped' }; },
                } } },
            });
            const hidden = MachineServicesListResultV1Schema.parse(await runtime.execute({ actionId: 'machines.services.list', input: target, context }));
            expect(hidden).toMatchObject({ kind: 'snapshot', services: [{ authority: 'machine' }] });
            if (hidden.kind !== 'snapshot') throw new Error('Expected watch projection');
            expect(hidden.services).toHaveLength(1);
            expect(JSON.parse(await readFile(nativeState, 'utf8')).accountings).toBe(1);
            const readerToken = `e30.${Buffer.from(JSON.stringify({ sub: 'environment-reader' })).toString('base64url')}.signature`;
            let environmentReadable = false;
            let environmentControllable = false;
            let accessFailure: 'denied' | 'unavailable' | 'transport' | null = null;
            const http = vi.spyOn(axios, 'request').mockImplementation(async () => {
                if (accessFailure === 'transport') throw new Error('HTTP access read failed');
                if (accessFailure) return { status: accessFailure === 'denied' ? 403 : 503, statusText: 'Unavailable',
                    headers: {}, config: { headers: new AxiosHeaders() }, data: { ok: false,
                        error: accessFailure === 'denied' ? 'deployment_access_denied' : 'deployment_unavailable' } };
                return {
                status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() },
                data: { ok: true, items: environmentReadable || environmentControllable
                    ? [{ environmentId: 'private-environment', read: true, deploy: environmentControllable }] : [] },
                };
            });
            releaseHome = publishServerHttpRuntimeOrigin('https://services-reader.invalid', 'https');
            const logsActionId = 'machines.services.logs.read';
            const logsBaseSettings = ActionsSettingsV1Schema.parse({ v: 1, actions: { [logsActionId]: { approvalRequiredSurfaces: ['cli'] } } });
            let logsSettings = setScopedActionApprovalPreference({ actionId: logsActionId, scope: { kind: 'machine', machineId: target.machineId },
                surface: 'cli', mode: 'waived', settings: logsBaseSettings });
            const operations = createHostActionOperationRuntime({ machineId: target.machineId, resolveAccountId: async () => 'environment-reader' });
            const reader = createCliActionExecutor({ token: readerToken, credentials: { token: readerToken, encryption: null }, mode: 'plain', ctx: null,
                sessionId: 'cli-global', serverId: target.serverId, serverHttpBaseUrl: 'https://services-reader.invalid',
                runActionOperation: operations.runActionOperation,
                actionsSettingsProvider: { getActionsSettings: () => logsSettings },
                machineActionDirectTargetTransport: { machineId: target.machineId, machineServiceAction: runtime.execute,
                    invoke: async () => { throw new Error('Local service projection must not re-enter Machine RPC'); } },
            });
            const readsBeforeDeniedInvocation = environmentRuntimeReads;
            expect(await reader.execute('machines.services.list', target, context)).toMatchObject({ ok: true, result: { kind: 'snapshot' } });
            expect(http).toHaveBeenCalledTimes(1);
            expect(http.mock.calls[0]?.[0]).toMatchObject({ method: 'POST',
                url: 'https://services-reader.invalid/v1/deployments/environments/access',
                data: { serverId: target.serverId, environmentIds: ['private-environment'] } });
            expect(await reader.execute('machines.services.detail', { ...target, serviceId: 'private-instance/private_web' }, context))
                .toEqual({ ok: true, result: { kind: 'unavailable', reason: 'unavailable' } });
            expect(environmentAccounting).toBe(0);
            expect(environmentRuntimeReads).toBe(readsBeforeDeniedInvocation);
            environmentReadable = true;
            const visible = await reader.execute('machines.services.list', target, context);
            expect(visible).toMatchObject({ ok: true, result: { kind: 'snapshot', services: [
                { environmentId: 'private-environment', baseUrl: null, port: null,
                    configuration: { ports: environmentRuntimeFacts.configuration!.ports },
                    health: { freshness: 'current', observedAtMs: 41 } },
                { environmentId: 'private-environment', baseUrl: null, port: null,
                    configuration: { ports: environmentRuntimeFacts.configuration!.ports },
                    health: { freshness: 'current', observedAtMs: 41 } }, { authority: 'machine' },
            ] } });
            expect(http).toHaveBeenCalledTimes(3);
            expect(environmentAccounting).toBe(2);
            accessFailure = 'denied';
            expect(await reader.execute('machines.services.list', target, context)).toMatchObject({ ok: true,
                result: { kind: 'snapshot', services: [expect.objectContaining({ authority: 'machine' })] } });
            accessFailure = 'unavailable';
            expect.soft(await reader.execute('machines.services.list', target, context))
                .toMatchObject({ ok: false, errorCode: 'deployment_unavailable' });
            accessFailure = 'transport';
            expect.soft(await reader.execute('machines.services.list', target, context))
                .toMatchObject({ ok: false, errorCode: 'home_unreachable' });
            accessFailure = null;
            expect(JSON.stringify(visible)).not.toContain('/srv/private-data');
            expect(await reader.execute('machines.services.detail', { ...target, serviceId: 'private-instance/private_web' }, context))
                .toMatchObject({ ok: true, result: { kind: 'service', runtimeFacts: environmentRuntimeFacts,
                    service: { configuration: { ports: environmentRuntimeFacts.configuration!.ports } },
                    accounting: { kind: 'sample', samples: [
                    { nativeResourceId: 'actual-container-id', cpuPercent: null, memoryBytes: 256 },
                ] } } });
            expect(environmentAccounting).toBe(3);
            environmentRuntimeFacts = { ...environmentRuntimeFacts, freshness: 'unavailable' };
            expect(await reader.execute('machines.services.detail', { ...target, serviceId: 'private-instance/private_web' }, context))
                .toMatchObject({ ok: true, result: { kind: 'service', runtimeFacts: environmentRuntimeFacts } });
            environmentRuntimeFacts = { configuration: null, observedAt: null, freshness: 'unavailable' };
            expect(await reader.execute('machines.services.detail', { ...target, serviceId: 'private-instance/private_web' }, context))
                .toMatchObject({ ok: true, result: { kind: 'service', runtimeFacts: environmentRuntimeFacts } });
            for (const [request] of http.mock.calls) expect(request.headers).toMatchObject({ Authorization: `Bearer ${readerToken}` });
            expect(environmentStops).toBe(0);
            const readEnvironmentHeader = http.getMockImplementation();
            if (!readEnvironmentHeader) throw new Error('Expected captured Account HTTP boundary');
            http.mockRestore();
            releaseHome(); releaseHome = () => {};
            const recovered = MachineServicesDetailResultV1Schema.parse(await runtime.execute({ actionId: 'machines.services.detail',
                input: { ...target, serviceId: 'recovered-watch' }, context }));
            expect(recovered).toMatchObject({ kind: 'service', service: { serviceId: 'recovered-watch', generation: expect.any(String),
                nativeInstance: { adapter, nativeResourceId: 'user/worker.service' }, baseUrl: 'http://127.0.0.1:45432', port: 45432 },
                accounting: { kind: 'sample', samples: [{ nativeResourceId: 'user/worker.service', cpuPercent: null, memoryBytes: 128 }] } });
            if (recovered.kind !== 'service' || !recovered.service.watchRevision) throw new Error('Expected recovered exact watch');
            // Native observation can retire while its persisted watch and plugin
            // registry remain unchanged. Exact detail is a fresh recovery demand.
            await registry.projectManagedServices.retireMachineServices(target);
            const restored = MachineServicesDetailResultV1Schema.parse(await runtime.execute({ actionId: 'machines.services.detail',
                input: { ...target, serviceId: 'recovered-watch' }, context }));
            expect(restored).toMatchObject({ kind: 'service', service: { serviceId: 'recovered-watch', state: 'running' } });
            if (restored.kind !== 'service') throw new Error('Expected restored native observation');
            expect(restored.service.generation).not.toBe(recovered.service.generation);
            expect(await runtime.execute({ actionId: 'machines.services.unwatch', input: { ...target, watchId: 'recovered-watch',
                expectedRevision: recovered.service.watchRevision }, context })).toMatchObject({ kind: 'applied' });
            writes = 0;
            await runtime.reconcile();
            expect(JSON.parse(await readFile(nativeState, 'utf8'))).toMatchObject({ discovers: 0, inspects: 2, accountings: 6, controls: [] });
            const discovered = MachineServicesDiscoveryResultV1Schema.parse(await runtime.execute({ actionId: 'machines.services.discovery', input: target, context }));
            expect(discovered).toMatchObject({ kind: 'snapshot', candidates: [{ name: 'Native worker', nativeResourceId: 'user/worker.service' }],
                failures: [{ adapter, code: 'second_source_unavailable' }] });
            if (discovered.kind !== 'snapshot' || !discovered.candidates[0]) throw new Error('Expected actual native candidate');
            const candidate = discovered.candidates[0];
            const watchInput = { ...target, candidateId: candidate.candidateId, expectedRevision: candidate.revision, lifecyclePurpose: 'deployment' as const };
            expect(await runtime.execute({ actionId: 'machines.services.watch', context, input: { ...watchInput, expectedRevision: 'stale' } }))
                .toMatchObject({ kind: 'conflict' });
            expect(writes).toBe(0);
            await new Promise<void>(resolve => nativeBoundary.listen(0, '127.0.0.1', resolve));
            const address = nativeBoundary.address();
            if (!address || typeof address === 'string') throw new Error('Expected native discovery boundary');
            await writeFile(nativeState, JSON.stringify({ ...JSON.parse(await readFile(nativeState, 'utf8')),
                discoveryPauseUrl: `http://127.0.0.1:${address.port}/discovery` }));
            const changingBasis = runtime.execute({ actionId: 'machines.services.watch', input: watchInput, context });
            await pausedDiscovery;
            metadataBasis++;
            releaseDiscovery();
            expect(await changingBasis).toEqual({ kind: 'unavailable', reason: 'admission_unavailable' });
            expect(writes).toBe(0);
            const nativeAfterPause = JSON.parse(await readFile(nativeState, 'utf8'));
            delete nativeAfterPause.discoveryPauseUrl;
            await writeFile(nativeState, JSON.stringify(nativeAfterPause));
            const watched = MachineServiceWatchMutationResultV1Schema.parse(await runtime.execute({ actionId: 'machines.services.watch', input: watchInput, context }));
            expect(watched).toMatchObject({ kind: 'applied', watch: { adapter, nativeResourceId: candidate.nativeResourceId, lifecyclePurpose: 'deployment' } });
            expect(writes).toBe(1);
            const listed = MachineServicesListResultV1Schema.parse(await runtime.execute({ actionId: 'machines.services.list', input: target, context }));
            if (listed.kind !== 'snapshot' || !listed.services[0]) throw new Error('Expected admitted service');
            const service = listed.services[0];
            expect(service).toMatchObject({ authority: 'machine', lifecyclePurpose: 'deployment', state: 'running',
                nativeInstance: { adapter, nativeResourceId: 'user/worker.service' }, baseUrl: 'http://127.0.0.1:45432', port: 45432,
                generation: expect.any(String), native: { phase: 'running', readiness: 'not_reported' },
                capabilities: { start: false, stop: true, restart: false, logs: true, accounting: true } });
            expect(await runtime.execute({ actionId: 'machines.services.detail', input: { ...target, serviceId: service.serviceId,
                expectedGeneration: service.generation! }, context })).toEqual({ kind: 'service', service,
                    runtimeFacts: { configuration: null, observedAt: expect.any(Number), freshness: 'current' },
                    accounting: { kind: 'sample', samples: [{ nativeResourceId: 'user/worker.service', cpuPercent: null, memoryBytes: 128 }] } });
            await writeFile(nativeState, JSON.stringify({ ...JSON.parse(await readFile(nativeState, 'utf8')), accountingUncertain: true }));
            await expect(runtime.execute({ actionId: 'machines.services.detail', input: { ...target, serviceId: service.serviceId,
                expectedGeneration: service.generation! }, context })).rejects.toMatchObject({ code: 'plugin_exec_termination_incomplete' });
            const nativeAfterUncertain = JSON.parse(await readFile(nativeState, 'utf8'));
            delete nativeAfterUncertain.accountingUncertain;
            await writeFile(nativeState, JSON.stringify(nativeAfterUncertain));
            expect(await runtime.execute({ actionId: 'machines.services.detail', input: { ...target, serviceId: service.serviceId,
                expectedGeneration: 'retired-generation' }, context })).toEqual({ kind: 'unavailable', reason: 'unavailable' });
            const logsHttp = vi.spyOn(axios, 'request').mockImplementation(readEnvironmentHeader);
            environmentReadable = false;
            const adoptedLogsInput = { ...target, serviceId: service.serviceId };
            const environmentLogsInput = { ...target, serviceId: 'private-instance/private_web' };
            expect(JSON.parse(await readFile(nativeState, 'utf8')).logs).toBe(0);
            let staleGenerationReads = 0;
            expect(await withMachineServiceTarget({ request: { ...adoptedLogsInput, expectedGeneration: 'retired-generation' }, ...target,
                assertCurrent: async () => {} }, async () => { staleGenerationReads++; return 'must not read'; }))
                .toMatchObject({ ok: false, errorCode: 'service_generation_changed' });
            expect(staleGenerationReads).toBe(0);
            expect(await reader.execute(logsActionId, adoptedLogsInput, context)).toEqual({ ok: true, result: { kind: 'page', page: {
                sourceRevision: 'user/worker.service', text: 'adopted native output', nextCursor: null, truncated: false,
            } } });
            expect(logsHttp).not.toHaveBeenCalled();
            expect(JSON.parse(await readFile(nativeState, 'utf8')).logs).toBe(1);
            const controlInput = { ...adoptedLogsInput, expectedGeneration: service.generation!, operation: 'stop' };
            let controllerCredentialsCurrent = true;
            // This is the receiving host after authenticated person ingress. A raw
            // CLI/API token cannot promote itself to present-user authority.
            const createServiceController = (observeOperations: boolean) => createCliActionExecutorHarness({ token: readerToken,
                credentials: { token: readerToken, encryption: null }, mode: 'plain', ctx: null,
                sessionId: 'cli-global', serverId: target.serverId, serverHttpBaseUrl: 'https://services-reader.invalid',
                isCredentialCurrent: async () => controllerCredentialsCurrent,
                actionsSettingsProvider: { getActionsSettings: () => logsSettings },
                machineActionDirectTargetTransport: { machineId: target.machineId, machineServiceAction: runtime.execute,
                    invoke: async () => { throw new Error('Local service control must not re-enter Machine RPC'); } },
            }, observeOperations ? { runActionOperation: operations.runActionOperation } : {}).executor;
            const serviceController = createServiceController(true);
            let activeServiceController = serviceController;
            const personControl = { surface: 'ui' as const, authority: 'present_user' as const, serverId: target.serverId };
            const refusedControl = await serviceController.execute('machines.services.control', { ...controlInput, expectedGeneration: 'retired-generation' }, personControl);
            expect(refusedControl).toMatchObject({ ok: false, errorCode: 'service_generation_changed' });
            expect(JSON.parse(await readFile(nativeState, 'utf8')).controls).toEqual([]);
            // The receiving RPC retains its verified original Account; local
            // UI calls instead acquire this host's captured Account context.
            expect(await serviceController.execute('machines.services.control', controlInput,
                { ...personControl, surface: 'rpc', runtimeAccountId: 'another-account' }))
                .toMatchObject({ ok: false, errorCode: 'project_requester_authority_unavailable' });
            controllerCredentialsCurrent = false;
            await expect(serviceController.prepare('machines.services.control', controlInput, personControl))
                .rejects.toMatchObject({ code: 'scope-retired' });
            controllerCredentialsCurrent = true;
            expect(JSON.parse(await readFile(nativeState, 'utf8')).controls).toEqual([]);
            expect(await serviceController.prepare('machines.services.control', controlInput, { surface: 'agent', serverId: target.serverId }))
                .toMatchObject({ kind: 'settled', result: { ok: false } });
            expect(JSON.parse(await readFile(nativeState, 'utf8')).controls).toEqual([]);
            environmentReadable = true;
            expect(await serviceController.execute('machines.services.control', { ...controlInput,
                serviceId: environmentLogsInput.serviceId, expectedGeneration: registry.projectManagedServices.listProjectServices()
                    .find(handle => handle.serviceId === environmentLogsInput.serviceId)!.instanceId }, personControl))
                .toMatchObject({ ok: false, errorCode: 'service_control_denied' });
            expect(environmentStops).toBe(0);
            const environmentControlInput = { ...controlInput, serviceId: environmentLogsInput.serviceId,
                expectedGeneration: environmentHandle.instanceId };
            const beforeControlSettings = logsSettings;
            environmentControllable = true;
            const controlAction = 'machines.services.control';
            const requiredControl = ActionsSettingsV1Schema.parse({ v: 1,
                actions: { [controlAction]: { approvalRequiredSurfaces: ['ui', 'agent', 'cli'] } } });
            const waivedControl = ActionsSettingsV1Schema.parse({ v: 1,
                approvalWaivedSurfaces: { [controlAction]: ['ui', 'agent', 'cli'] } });
            for (const surface of ['ui', 'agent', 'cli'] as const) {
                const invocation = { surface, authority: surface === 'agent' ? 'account_automation' as const : 'present_user' as const,
                    serverId: target.serverId, interactivePresentation: 'unavailable' as const };
                const machineScope = { kind: 'machine' as const, machineId: target.machineId };
                const environmentScope = { kind: 'environment' as const, environmentId: release.environmentId };
                logsSettings = setScopedActionApprovalPreference({ actionId: controlAction, scope: environmentScope, surface,
                    mode: 'required', settings: setScopedActionApprovalPreference({ actionId: controlAction, scope: machineScope,
                        surface, mode: 'waived', settings: requiredControl }) });
                expect(await serviceController.prepare(controlAction, environmentControlInput, invocation))
                    .toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'action_interactive_review_required' } });
                expect(await serviceController.prepare(controlAction, controlInput, invocation)).toMatchObject({ kind: 'ready' });
                logsSettings = setScopedActionApprovalPreference({ actionId: controlAction, scope: environmentScope, surface,
                    mode: 'waived', settings: setScopedActionApprovalPreference({ actionId: controlAction, scope: machineScope,
                        surface, mode: 'required', settings: requiredControl }) });
                expect(await serviceController.prepare(controlAction, environmentControlInput, invocation)).toMatchObject({ kind: 'ready' });
                expect(await serviceController.prepare(controlAction, controlInput, invocation))
                    .toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'action_interactive_review_required' } });
                logsSettings = setScopedActionApprovalPreference({ actionId: controlAction, scope: machineScope, surface,
                    mode: 'waived', settings: requiredControl });
                expect(await serviceController.prepare(controlAction, environmentControlInput, invocation))
                    .toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'action_interactive_review_required' } });
                logsSettings = setScopedActionApprovalPreference({ actionId: controlAction, scope: machineScope, surface,
                    mode: 'required', settings: waivedControl });
                expect(await serviceController.prepare(controlAction, environmentControlInput, invocation)).toMatchObject({ kind: 'ready' });
            }
            expect(environmentStops).toBe(0);
            expect(JSON.parse(await readFile(nativeState, 'utf8')).controls).toEqual([]);
            logsSettings = beforeControlSettings;
            environmentControllable = false;
            let controlRpc: RpcHandler<unknown, unknown> | undefined;
            registerDaemonLocalServicesMachineRpcHandlers({ registerHandler(method, handler) {
                // The transport carries unknown bytes; the real registered handler owns its codec.
                if (method === RPC_METHODS.MACHINES_SERVICE_CONTROL) controlRpc = handler as RpcHandler<unknown, unknown>;
            } }, { machineId: target.machineId, serverId: target.serverId, projectManagedServices: registry.projectManagedServices,
                resolveLauncherActionExecutor: () => activeServiceController });
            expect(controlRpc).toBeDefined();
            if (!controlRpc) throw new Error('Expected canonical service control RPC');
            activeServiceController = createServiceController(false);
            expect(await controlRpc(controlInput, { signal: new AbortController().signal,
                localActionContext: { surface: 'ui', authority: 'present_user' } })).toMatchObject({
                ok: false, errorCode: 'service_operation_unavailable',
                details: { reason: 'service_operation_admission_unavailable', remedy: 'reconnect_machine', retryable: true },
                failureCause: { phase: 'service.control.admission', errorCode: 'service_operation_admission_unavailable' },
            });
            expect(JSON.parse(await readFile(nativeState, 'utf8')).controls).toEqual([]);
            activeServiceController = serviceController;
            for (const [status, expected] of [
                ['unsupported', { kind: 'unsupported', reason: 'unsupported' }],
                ['accepted', { kind: 'accepted', operation: { operationId: expect.any(String) } }],
                ['termination_incomplete', { kind: 'outcome_unknown', operation: { operationId: expect.any(String) } }],
            ] as const) {
                await writeFile(nativeState, JSON.stringify({ ...JSON.parse(await readFile(nativeState, 'utf8')), stopStatus: status }));
                expect.soft(await controlRpc(controlInput, { signal: new AbortController().signal,
                    localActionContext: { surface: 'ui', authority: 'present_user' } })).toMatchObject(expected);
                expect(JSON.parse(await readFile(nativeState, 'utf8')).phase).not.toBe('stopped');
                const retained = MachineServicesListResultV1Schema.parse(await runtime.execute({
                    actionId: 'machines.services.list', input: target, context,
                }));
                expect(retained.kind === 'snapshot' && retained.services.find(row => row.serviceId === service.serviceId))
                    .toMatchObject({ state: 'running', baseUrl: 'http://127.0.0.1:45432', port: 45432,
                        native: { phase: 'running' } });
            }
            const beforeSettledStop = JSON.parse(await readFile(nativeState, 'utf8'));
            delete beforeSettledStop.stopStatus;
            await writeFile(nativeState, JSON.stringify(beforeSettledStop));
            const controlled = await controlRpc(controlInput, { signal: new AbortController().signal,
                localActionContext: { surface: 'ui', authority: 'present_user' } });
            expect(controlled).toMatchObject({ kind: 'observed', serviceId: service.serviceId,
                generation: service.generation, state: 'stopped', operation: { operationId: expect.any(String) } });
            expect(JSON.parse(await readFile(nativeState, 'utf8')).controls).toEqual(['stop', 'stop', 'stop', 'stop']);
            environmentReadable = false;
            expect(await reader.execute(logsActionId, environmentLogsInput, context))
                .toMatchObject({ ok: false, errorCode: 'service_unavailable' });
            expect(environmentLogs).toBe(0);
            environmentReadable = true;
            expect(await reader.prepare(logsActionId, environmentLogsInput, context))
                .toMatchObject({ kind: 'settled', result: { ok: false } });
            expect(environmentLogs).toBe(0);
            logsSettings = setScopedActionApprovalPreference({ actionId: logsActionId,
                scope: { kind: 'environment', environmentId: 'private-environment' }, surface: 'cli', mode: 'waived', settings: logsBaseSettings });
            expect(await reader.prepare(logsActionId, adoptedLogsInput, context))
                .toMatchObject({ kind: 'settled', result: { ok: false } });
            expect(JSON.parse(await readFile(nativeState, 'utf8')).logs).toBe(1);
            expect(await reader.execute(logsActionId, environmentLogsInput, context))
                .toMatchObject({ ok: true, result: { kind: 'page', page: { text: 'private Environment output' } } });
            expect(environmentLogs).toBe(1);
            expect(await reader.execute(logsActionId, { ...adoptedLogsInput,
                scope: { kind: 'environment', environmentId: 'private-environment' } }, context)).toMatchObject({ ok: false });
            expect(JSON.parse(await readFile(nativeState, 'utf8')).logs).toBe(1);
            const resourceHandlers = new Map<string, RpcHandler<unknown, unknown>>();
            const resourceOptions = {
                resolveRuntimeRegistry: async () => registry!,
                resolveHostActionExecutor: () => reader,
                readHostResourceAccountId: () => 'environment-reader',
            };
            registerDaemonContributionRegistryProjectionHandler({ registerHandler(method, handler) {
                resourceHandlers.set(method, handler as RpcHandler<unknown, unknown>);
            } }, resourceOptions);
            const readResource = resourceHandlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ);
            if (!readResource) throw new Error('Expected the canonical Resource snapshot transport');
            const openResource = resourceHandlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN)!;
            const nextResource = resourceHandlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT)!;
            const closeResource = resourceHandlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE)!;
            const resource = { hostRead: 'machines.services.logs', input: adoptedLogsInput,
                expectedGeneration: service.generation, sourceRevision: 'user/worker.service' };
            const resourceRequest = { machineId: target.machineId, resource };
            const resourceContext = { signal: new AbortController().signal, localActionContext: context };
            const servicesResource = { hostRead: 'machines.services.list', input: target };
            const servicesRequest = { machineId: target.machineId, resource: servicesResource, subscriptionId: 'machine-services-list' };
            const actionReads = vi.spyOn(reader, 'execute');
            const listReads = () => actionReads.mock.calls.filter(([actionId]) => actionId === 'machines.services.list').length;
            const watchedHandle = registry.projectManagedServices.listMachineServices().find(handle => handle.serviceId === service.serviceId);
            if (!watchedHandle) throw new Error('Expected the admitted native watch');
            // The settled control witness has no endpoint. Establish the real
            // adapter's stopped observation before measuring equal arrivals.
            expect(await watchedHandle.inspectCurrentOccurrence()).toMatchObject({
                state: 'stopped', nativePhase: 'stopped', baseUrl: 'http://127.0.0.1:45432',
            });
            const accountChannel = await createRequesterCurrentnessSocketHarness();
            let accountChanges: ChangeEntry[] = [];
            let accountCursor = 0;
            const accountHttp = vi.spyOn(axios, 'get').mockImplementation(async url => {
                const path = new URL(url).pathname;
                if (path === '/v1/account/encryption/currentness') return { status: 200,
                    data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
                if (path === '/v2/changes') return { status: 200, data: { changes: accountChanges, nextCursor: accountCursor } };
                throw new Error('Unexpected local Account observation read');
            });
            // The installed Account/Home holder and local retained read share one existing feed.
            const ownAccount = acquireRequesterAccountEncryptionCurrentness({ accountId: 'environment-reader', token: readerToken,
                serverBaseUrl: 'https://services-reader.invalid' });
            try {
            await ownAccount.read();
            await accountChannel.settleTransport();
            const accountingSamples = async () => ({ native: JSON.parse(await readFile(nativeState, 'utf8')).accountings,
                environment: environmentAccounting });
            const beforeProjectionAccounting = await accountingSamples();
            expect(await openResource(servicesRequest, resourceContext)).toMatchObject({ ok: true });
            expect(accountChannel.clients).toHaveLength(1);
            expect.soft(await accountingSamples()).toEqual(beforeProjectionAccounting);
            const beforeEqualObservations = listReads();
            for (let index = 0; index < 100; index++) await watchedHandle.inspectCurrentOccurrence();
            expect(listReads()).toBe(beforeEqualObservations);
            await writeFile(nativeState, JSON.stringify({ ...JSON.parse(await readFile(nativeState, 'utf8')), phase: 'running' }));
            await watchedHandle.inspectCurrentOccurrence();
            expect(await nextResource({ ...servicesRequest, waitMs: DAEMON_PLUGIN_UI_RESOURCE_WATCH_MIN_WAIT_MS }, resourceContext))
                .toMatchObject({ ok: true, status: 'event', event: { kind: 'invalidated' } });
            expect.soft(listReads(), 'a changed producer fact needs no speculative list read').toBe(beforeEqualObservations);
            const servicesRead = DaemonPluginUiResourceReadResponseSchema.parse(await readResource({ machineId: target.machineId, resource: servicesResource }, resourceContext));
            if (!servicesRead.ok) throw new Error('Expected admitted pushed Services snapshot');
            expect(MachineServicesListResultV1Schema.parse(JSON.parse(Buffer.from(servicesRead.bytesBase64, 'base64').toString('utf8'))))
                .toMatchObject({ kind: 'snapshot', services: expect.arrayContaining([
                    expect.objectContaining({ serviceId: service.serviceId, state: 'running', native: { phase: 'running', readiness: 'not_reported' } }),
                ]) });
            expect.soft(listReads(), 'one consumed Services change needs one admitted list read').toBe(beforeEqualObservations + 1);
            expect.soft(await accountingSamples(), 'push projections do not sample native accounting').toEqual(beforeProjectionAccounting);
            const beforeExplicitAccounting = await accountingSamples();
            expect(await reader.execute('machines.services.list', target, context)).toMatchObject({ ok: true,
                result: { kind: 'snapshot', services: expect.arrayContaining([expect.objectContaining({ serviceId: service.serviceId, state: 'running' })]) } });
            expect(await accountingSamples(), 'explicit accounting demand still samples each admitted handle').toEqual({
                native: beforeExplicitAccounting.native + 1, environment: beforeExplicitAccounting.environment + 2,
            });
            expect(listReads(), 'accounting publication does not recursively reread the list').toBe(beforeEqualObservations + 2);
            expect(await closeResource(servicesRequest, resourceContext)).toMatchObject({ ok: true });
            const hiddenListReads = listReads();
            await writeFile(nativeState, JSON.stringify({ ...JSON.parse(await readFile(nativeState, 'utf8')), phase: 'stopped' }));
            await watchedHandle.inspectCurrentOccurrence();
            expect(listReads()).toBe(hiddenListReads);
            expect(await openResource(servicesRequest, resourceContext)).toMatchObject({ ok: true });
            expect(accountChannel.clients).toHaveLength(1);
            accountChanges = [{ ...buildAccountIdentitiesChangeV1(), cursor: ++accountCursor, changedAt: accountCursor }];
            await accountChannel.hintAccountChange(accountCursor);
            expect(await nextResource({ ...servicesRequest, waitMs: DAEMON_PLUGIN_UI_RESOURCE_WATCH_MIN_WAIT_MS }, resourceContext))
                .toMatchObject({ ok: true, status: 'event', event: { kind: 'error', code: 'expired_resource' } });
            } finally {
                await closeResource(servicesRequest, resourceContext);
                await ownAccount.dispose();
                await accountChannel.close();
                accountHttp.mockRestore();
            }
            actionReads.mockRestore();
            const followRequest = { ...resourceRequest, subscriptionId: 'native-machine-logs' };
            const followTarget = { machineId: target.machineId, resource, subscriptionId: followRequest.subscriptionId };
            const beforeResourceSettings = logsSettings;
            const beforeRequiredRead = JSON.parse(await readFile(nativeState, 'utf8'));
            // Substitute Home transport verification, not Action admission. This
            // received context has neither a local caller nor an original UI Action.
            const received = { signal: new AbortController().signal, transportRequestId: 'machine-log-resource',
                machineAdmission: SocketRpcMachineAdmissionContextV1Schema.parse({ actorAccountId: 'environment-reader',
                    custodianAccountId: 'environment-reader', machineId: target.machineId,
                    installationId: 'installation', role: 'use', encryptionMode: 'plain' }),
                verifyMachineAdmissionCurrent: async () => true };
            for (const settings of [ActionsSettingsV1Schema.parse({ v: 1 }),
                setScopedActionApprovalPreference({ actionId: logsActionId, scope: { kind: 'machine', machineId: target.machineId },
                    surface: 'rpc', mode: 'required', settings: logsBaseSettings })]) {
                logsSettings = settings;
                expect(await readResource(resourceRequest, received)).toMatchObject({ ok: false, code: 'service_admission_unavailable' });
                expect(await openResource(followRequest, received)).toMatchObject({ ok: false, code: 'service_admission_unavailable' });
                expect(JSON.parse(await readFile(nativeState, 'utf8'))).toEqual(beforeRequiredRead);
            }
            logsSettings = setScopedActionApprovalPreference({ actionId: logsActionId,
                scope: { kind: 'machine', machineId: target.machineId }, surface: 'cli', mode: 'required', settings: logsBaseSettings });
            expect(await readResource(resourceRequest, resourceContext)).toMatchObject({ ok: false });
            expect(await openResource(followRequest, resourceContext)).toMatchObject({ ok: false });
            expect(JSON.parse(await readFile(nativeState, 'utf8'))).toEqual(beforeRequiredRead);
            logsSettings = setScopedActionApprovalPreference({ actionId: logsActionId,
                scope: { kind: 'machine', machineId: target.machineId }, surface: 'cli', mode: 'waived', settings: logsBaseSettings });
            const beforeInitialPage = JSON.parse(await readFile(nativeState, 'utf8'));
            expect(await reader.execute(logsActionId, adoptedLogsInput, { ...context,
                machineServiceLogsResource: { expectedGeneration: 'retired-generation' } }))
                .toMatchObject({ ok: false });
            expect(JSON.parse(await readFile(nativeState, 'utf8'))).toEqual(beforeInitialPage);
            // First-open custody constrains the genuine generation before its
            // source revision exists; it must return that admitted native page.
            expect.soft(await reader.execute(logsActionId, adoptedLogsInput, { ...context,
                machineServiceLogsResource: { expectedGeneration: service.generation! } }))
                .toMatchObject({ ok: true, result: { kind: 'page', page: { sourceRevision: 'user/worker.service' } } });
            // A host Machine consumer has genuine Account/Action custody and no plugin occurrence.
            // The real Resource dispatcher must borrow the same logs Action and native adapter.
            expect.soft(await readResource(resourceRequest, resourceContext)).toMatchObject({
                ok: true, contentType: 'application/json', bytesBase64: Buffer.from(JSON.stringify({
                    kind: 'page', page: { sourceRevision: 'user/worker.service', text: 'adopted native output', nextCursor: null, truncated: false },
                })).toString('base64'),
            });
            const environmentBeforeResource = environmentLogs;
            const environmentResource = { ...resource, input: environmentLogsInput,
                expectedGeneration: environmentHandle.instanceId, sourceRevision: 'private_web' };
            expect(await readResource({ ...resourceRequest, resource: environmentResource }, resourceContext)).toMatchObject({ ok: false });
            expect(await openResource({ ...followRequest, resource: environmentResource }, resourceContext)).toMatchObject({ ok: false });
            expect(environmentLogs).toBe(environmentBeforeResource);
            // Both front doors consume the mounted Environment scope and the
            // native producer's opaque cursor. A Machine preference cannot
            // replace that scope even when the transport runs on this Machine.
            logsSettings = setScopedActionApprovalPreference({ actionId: logsActionId,
                scope: { kind: 'environment', environmentId: release.environmentId }, surface: 'cli', mode: 'waived', settings:
                    setScopedActionApprovalPreference({ actionId: logsActionId,
                        scope: { kind: 'machine', machineId: target.machineId }, surface: 'cli', mode: 'required', settings: logsBaseSettings }) });
            const initialEnvironmentLog = await reader.execute(logsActionId, environmentLogsInput, context);
            if (!initialEnvironmentLog.ok) throw new Error('Expected admitted Environment log Action');
            const initialEnvironmentPage = ManagedServiceNativeLogResultV1Schema.parse(initialEnvironmentLog.result);
            if (initialEnvironmentPage.kind !== 'page' || !initialEnvironmentPage.page.nextCursor)
                throw new Error('Expected native continuation cursor');
            const continuedEnvironmentResource = { ...environmentResource, input: { ...environmentLogsInput,
                cursor: initialEnvironmentPage.page.nextCursor } };
            const continuedEnvironmentLog = DaemonPluginUiResourceReadResponseSchema.parse(await readResource({
                ...resourceRequest, resource: continuedEnvironmentResource,
            }, resourceContext));
            if (!continuedEnvironmentLog.ok) throw new Error('Expected admitted Environment log Resource');
            const continuedEnvironmentPage = ManagedServiceNativeLogResultV1Schema.parse(JSON.parse(
                Buffer.from(continuedEnvironmentLog.bytesBase64, 'base64').toString('utf8')));
            expect(continuedEnvironmentPage).toEqual({ kind: 'page', page: {
                sourceRevision: 'private_web', text: expect.stringContaining('\ncontinued 🌍 '),
                nextCursor: { sourceRevision: 'private_web', token: 'native-position-2' }, truncated: false,
            } });
            if (continuedEnvironmentPage.kind !== 'page' || !continuedEnvironmentPage.page.nextCursor)
                throw new Error('Expected continued native position');
            expect(continuedEnvironmentPage.page.text).not.toContain('synthetic-private-log-material');
            expect(continuedEnvironmentPage.page.text).not.toContain('�');
            expect(await reader.execute(logsActionId, { ...environmentLogsInput, cursor: continuedEnvironmentPage.page.nextCursor }, context))
                .toMatchObject({ ok: true, result: { kind: 'page', page: { text: '', nextCursor: continuedEnvironmentPage.page.nextCursor } } });
            expect(environmentLogs).toBe(environmentBeforeResource + 3);
            // A finite admitted page settles even if access is withdrawn while
            // the native read completes. Withdrawal governs the next read.
            afterEnvironmentLogRead = () => { environmentReadable = false; };
            expect.soft(await reader.execute(logsActionId, { ...environmentLogsInput, cursor: initialEnvironmentPage.page.nextCursor }, context))
                .toMatchObject({ ok: true, result: { kind: 'page', page: {
                    sourceRevision: 'private_web', text: expect.stringContaining('\ncontinued 🌍 '),
                } } });
            const logsAfterActionWithdrawal = environmentLogs;
            expect(await reader.execute(logsActionId, environmentLogsInput, context))
                .toMatchObject({ ok: false, errorCode: 'service_unavailable' });
            expect(environmentLogs).toBe(logsAfterActionWithdrawal);
            environmentReadable = true;
            expect.soft(await readResource({ ...resourceRequest, resource: continuedEnvironmentResource }, resourceContext))
                .toMatchObject({ ok: true, contentType: 'application/json' });
            afterEnvironmentLogRead = undefined;
            const logsAfterWithdrawal = environmentLogs;
            expect(await reader.execute(logsActionId, environmentLogsInput, context)).toMatchObject({ ok: false, errorCode: 'service_unavailable' });
            expect(await readResource({ ...resourceRequest, resource: continuedEnvironmentResource }, resourceContext))
                .toMatchObject({ ok: false, code: 'service_unavailable' });
            expect(environmentLogs).toBe(logsAfterWithdrawal);
            environmentReadable = true;
            const environmentFollow = { ...followRequest, subscriptionId: 'environment-runtime-logs', resource: continuedEnvironmentResource };
            const environmentFollowTarget = { machineId: target.machineId,
                subscriptionId: environmentFollow.subscriptionId, resource: continuedEnvironmentResource };
            duringEnvironmentLogWatch = () => { environmentReadable = false; };
            expect.soft(await openResource(environmentFollow, resourceContext)).toMatchObject({ ok: false, code: 'service_unavailable' });
            expect.soft(environmentLogWatchDisposals).toBe(1);
            duringEnvironmentLogWatch = undefined;
            environmentReadable = true;
            expect(await openResource(environmentFollow, resourceContext)).toMatchObject({ ok: true });
            expect(environmentLogWatchCursor).toEqual(continuedEnvironmentPage.page.nextCursor);
            if (!emitEnvironmentLog) throw new Error('Expected the native Environment log subscription');
            const environmentLogUpdate: ManagedServiceNativeLogResultV1 = { kind: 'page', page: {
                sourceRevision: 'private_web', text: 'new runtime output', nextCursor: continuedEnvironmentPage.page.nextCursor, truncated: false,
            } };
            const readsBeforeEvent = environmentLogs;
            const authorityReadsBeforeEvent = logsHttp.mock.calls.length;
            emitEnvironmentLog(environmentLogUpdate);
            expect(await nextResource(environmentFollowTarget, resourceContext)).toMatchObject({
                ok: true, status: 'event', event: { kind: 'invalidated' },
            });
            expect.soft(logsHttp.mock.calls).toHaveLength(authorityReadsBeforeEvent + 1);
            expect(environmentLogs).toBe(readsBeforeEvent);
            environmentReadable = false;
            const authorityReadsBeforeRevocation = logsHttp.mock.calls.length;
            emitEnvironmentLog(environmentLogUpdate);
            expect.soft(await nextResource(environmentFollowTarget, resourceContext)).toMatchObject({
                ok: true, status: 'event', event: { kind: 'error', code: 'expired_resource', diagnostics: ['service_unavailable'] },
            });
            expect.soft(logsHttp.mock.calls).toHaveLength(authorityReadsBeforeRevocation + 1);
            await vi.waitFor(() => expect(environmentLogWatchDisposals).toBe(2));
            expect(environmentLogs).toBe(readsBeforeEvent);
            expect(await readResource({ ...resourceRequest, resource: continuedEnvironmentResource }, resourceContext))
                .toMatchObject({ ok: false, code: 'service_unavailable' });
            expect(environmentLogs).toBe(readsBeforeEvent);
            environmentReadable = true;
            expect(await openResource(environmentFollow, resourceContext)).toMatchObject({ ok: true });
            expect(await closeResource(environmentFollowTarget, resourceContext)).toMatchObject({ ok: true, closed: true });
            expect(environmentLogWatchDisposals).toBe(3);
            expect(await openResource(environmentFollow, resourceContext)).toMatchObject({ ok: true });
            if (!emitEnvironmentLog) throw new Error('Expected reopened Environment native demand');
            emitEnvironmentLog(environmentLogUpdate);
            // The owner forwards a current native event; currentness can then
            // retire while its async Environment read is still completing.
            environmentServiceCurrent = false;
            expect(await nextResource({ ...environmentFollowTarget, waitMs: DAEMON_PLUGIN_UI_RESOURCE_WATCH_MIN_WAIT_MS }, resourceContext)).toMatchObject({
                ok: true, status: 'event', event: { kind: 'error', code: 'expired_resource' },
            });
            await vi.waitFor(() => expect(environmentLogWatchDisposals).toBe(4));
            environmentServiceCurrent = true;
            logsSettings = setScopedActionApprovalPreference({ actionId: logsActionId,
                scope: { kind: 'machine', machineId: target.machineId }, surface: 'cli', mode: 'waived', settings: logsBaseSettings });
            const changedSourceBytes = Buffer.from(JSON.stringify({ kind: 'source-changed', sourceRevision: 'user/worker.service' })).toString('base64');
            expect(await readResource({ ...resourceRequest, resource: { ...resource, sourceRevision: 'retired-source' } }, resourceContext))
                .toMatchObject({ ok: true, bytesBase64: changedSourceBytes });
            expect(await readResource({ ...resourceRequest, resource: { ...resource, input: { ...adoptedLogsInput,
                cursor: { sourceRevision: 'retired-source', token: 'original-native-cursor' } } } }, resourceContext))
                .toMatchObject({ ok: true, bytesBase64: changedSourceBytes });
            expect(await openResource(followRequest, resourceContext)).toMatchObject({ ok: true, digest: expect.any(String) });
            expect(await nextResource(followTarget, resourceContext)).toMatchObject({ ok: true, status: 'event', event: { kind: 'invalidated' } });
            expect(await closeResource(followTarget, resourceContext)).toMatchObject({ ok: true, closed: true });
            expect(JSON.parse(await readFile(nativeState, 'utf8'))).toMatchObject({ logWatches: 1, logDisposals: 1 });
            const beforeResume = JSON.parse(await readFile(nativeState, 'utf8'));
            logsSettings = setScopedActionApprovalPreference({ actionId: logsActionId,
                scope: { kind: 'machine', machineId: target.machineId }, surface: 'cli', mode: 'required', settings: logsBaseSettings });
            expect(await openResource(followRequest, resourceContext)).toMatchObject({ ok: false });
            expect(JSON.parse(await readFile(nativeState, 'utf8'))).toEqual(beforeResume);
            logsSettings = setScopedActionApprovalPreference({ actionId: logsActionId,
                scope: { kind: 'machine', machineId: target.machineId }, surface: 'cli', mode: 'waived', settings: logsBaseSettings });
            expect(await openResource({ ...followRequest, resource: { ...resource, expectedGeneration: 'retired-generation' } }, resourceContext))
                .toMatchObject({ ok: false });
            expect(JSON.parse(await readFile(nativeState, 'utf8'))).toEqual(beforeResume);
            expect(await openResource(followRequest, resourceContext)).toMatchObject({ ok: true });
            const beforeExplicitClose = JSON.parse(await readFile(nativeState, 'utf8'));
            expect(await nextResource(followTarget, resourceContext)).toMatchObject({ ok: true,
                status: 'event', event: { kind: 'invalidated' } });
            expect(await closeResource(followTarget, resourceContext)).toMatchObject({ ok: true, closed: true });
            expect(JSON.parse(await readFile(nativeState, 'utf8'))).toMatchObject({ logs: beforeExplicitClose.logs,
                logWatches: 2, logDisposals: 2 });
            expect(await closeResource(followTarget, resourceContext)).toMatchObject({ ok: true, closed: false });
            expect(await openResource(followRequest, resourceContext)).toMatchObject({ ok: true });
            logsSettings = beforeResourceSettings;
            logsHttp.mockRestore();
            const before = JSON.parse(await readFile(nativeState, 'utf8'));
            expect(before).toMatchObject({ logWatches: 3, logDisposals: 2 });
            if (metadata.status !== 'ready') throw new Error('Expected opened metadata');
            metadata = { ...metadata, metadataVersion: metadata.metadataVersion + 1, metadata: { ...metadata.metadata, displayName: 'Unrelated edit' } };
            await runtime.reconcile();
            await runtime.reconcile();
            expect(JSON.parse(await readFile(nativeState, 'utf8'))).toEqual(before);
            const reloaded = createMachineServicesRuntime({ target, readMetadata: () => metadata, captureMetadataPort: () => port });
            await reloaded.reconcile();
            const afterReload = MachineServicesListResultV1Schema.parse(await reloaded.execute({ actionId: 'machines.services.list', input: target, context }));
            expect(afterReload).toEqual({ ...listed, services: listed.services.map(row => ({ ...row, state: 'stopped', baseUrl: 'http://127.0.0.1:45432', port: 45432,
                health: { ...row.health, status: 'down', reason: 'stopped', observedAtMs: expect.any(Number), expectedDown: 'stop' }, native: {
                phase: 'stopped', readiness: 'not_reported',
            } })) });
            await writeFile(nativeState, JSON.stringify({ ...JSON.parse(await readFile(nativeState, 'utf8')),
                stopPauseUrl: `http://127.0.0.1:${address.port}/native-stop` }));
            const retiringControl = Promise.resolve(controlRpc(controlInput, { signal: new AbortController().signal,
                localActionContext: { surface: 'ui', authority: 'present_user' } })).catch((error: unknown) => error);
            await pausedNativeStop;
            controllerCredentialsCurrent = false;
            const staleLogRead = withMachineServiceTarget({ request: adoptedLogsInput, ...target,
                assertCurrent: async () => {} }, async captured => {
                expect(captured.instanceId).toBe(service.generation);
                expect(await reloaded.execute({ actionId: 'machines.services.unwatch', input: { ...target,
                    watchId: service.watchId!, expectedRevision: service.watchRevision! }, context })).toMatchObject({ kind: 'applied' });
                return 'retired generation output must not escape';
            });
            // Retirement withdraws new reads immediately, while the admitted
            // native effect still owns its eventual settlement.
            await new Promise<void>(resolve => setImmediate(resolve));
            releaseNativeStop();
            const retiredSettlement = await retiringControl;
            expect.soft(retiredSettlement).toMatchObject({ kind: 'accepted', operation: { operationId: expect.any(String) } });
            expect.soft(retiredSettlement).not.toHaveProperty('state');
            expect.soft(retiredSettlement).not.toHaveProperty('generation');
            const beforeRetiredRead = JSON.parse(await readFile(nativeState, 'utf8'));
            await expect(serviceController.prepare(logsActionId, adoptedLogsInput, context))
                .rejects.toMatchObject({ code: 'scope-retired' });
            expect(JSON.parse(await readFile(nativeState, 'utf8')).logs).toBe(beforeRetiredRead.logs);
            controllerCredentialsCurrent = true;
            const staleLogResult = await staleLogRead;
            expect(staleLogResult).toMatchObject({ ok: false, errorCode: 'service_unavailable' });
            expect(await nextResource(followTarget, resourceContext)).toMatchObject({ ok: true, status: 'event',
                event: { kind: 'error', code: 'expired_resource' } });
            await closeResource(followTarget, resourceContext);
            expect(JSON.parse(await readFile(nativeState, 'utf8'))).toMatchObject({ logWatches: 3, logDisposals: 3 });
            expect(registry.projectManagedServices.listMachineServices()).toEqual([]);
            expect(JSON.parse(await readFile(nativeState, 'utf8'))).toMatchObject({ controls: ['stop', 'stop', 'stop', 'stop', 'stop'] });
            expect(metadata).toMatchObject({ metadata: { displayName: 'Unrelated edit', serviceWatchesV1: { v: 1, watches: [] } } });
            await reloaded.dispose();
            expect(environmentStops).toBe(0);
            expect(observationReleases).toBe(0);
            environmentControllable = true;
            logsSettings = waivedControl;
            const controlHttp = vi.spyOn(axios, 'request').mockImplementation(readEnvironmentHeader);
            try {
                expect(await serviceController.execute(controlAction, environmentControlInput, personControl))
                    .toMatchObject({ ok: true, result: { kind: 'observed', serviceId: environmentControlInput.serviceId } });
                expect(environmentStops).toBe(1);
            } finally { controlHttp.mockRestore(); }
            // Final registry disposal must collect a still-demanded native
            // Resource too, not only watches explicitly closed by a client.
            expect(await runtime.execute({ actionId: 'machines.services.watch', input: watchInput, context })).toMatchObject({ kind: 'applied' });
            const finalServices = MachineServicesListResultV1Schema.parse(await runtime.execute({ actionId: 'machines.services.list', input: target, context }));
            if (finalServices.kind !== 'snapshot') throw new Error('Expected the final admitted native service');
            const finalService = finalServices.services.find(row => row.authority === 'machine');
            if (!finalService?.generation) throw new Error('Expected final native generation');
            logsSettings = setScopedActionApprovalPreference({ actionId: logsActionId,
                scope: { kind: 'machine', machineId: target.machineId }, surface: 'cli', mode: 'waived', settings: logsBaseSettings });
            expect(await openResource({ ...followRequest, resource: { ...resource,
                input: { ...adoptedLogsInput, serviceId: finalService.serviceId }, expectedGeneration: finalService.generation } }, resourceContext))
                .toMatchObject({ ok: true });
            expect(JSON.parse(await readFile(nativeState, 'utf8'))).toMatchObject({ logWatches: 4, logDisposals: 3 });
            await writeFile(nativeState, JSON.stringify({ ...JSON.parse(await readFile(nativeState, 'utf8')),
                logDisposalPauseUrl: `http://127.0.0.1:${address.port}/logs-dispose` }));
            let shutdownSettled = false;
            const shutdown = pluginReloadController.shutdown().then(() => { shutdownSettled = true; });
            await pausedLogDisposal;
            expect(JSON.parse(await readFile(nativeState, 'utf8'))).toMatchObject({ logWatches: 4, logDisposals: 3 });
            expect(shutdownSettled).toBe(false);
            releaseLogDisposal();
            await shutdown;
            expect(JSON.parse(await readFile(nativeState, 'utf8'))).toMatchObject({ logWatches: 4, logDisposals: 4 });
        } finally {
            releaseNativeStop();
            releaseDiscovery();
            releaseLogDisposal();
            if (nativeBoundary.listening) await new Promise<void>((resolve, reject) => nativeBoundary.close(error => error ? reject(error) : resolve()));
            releaseHome();
            vi.restoreAllMocks();
            await runtime.dispose();
            await pluginReloadController.shutdown();
            await registry?.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });
});
