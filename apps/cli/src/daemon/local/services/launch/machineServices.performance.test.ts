import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { buildAccountIdentitiesChangeV1, type ChangeEntry } from '@happier-dev/protocol/changes';
import { acquireRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { MachineServicesDetailResultV1Schema, MachineServicesListResultV1Schema,
    type MachineMetadataFieldReadV1, type MachineServiceWatchV1 } from '@happier-dev/protocol';
import type { Machine } from '@/api/types';
import { readOpenedMachineMetadataSnapshot } from '@/api/machine/machineMetadataPublication';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import type { ProjectNativeRuntimeFacts } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { createDeploymentSourceMaterializationPort } from '@/deployments/targets/ownServer/exactCommitRelease';
import { createScmBackendRegistry } from '@/scm/registry';
import { createMachineServicesRuntime } from './machineServices';

describe('Machine Services exact demand cost', () => {
    it('feeds exact Environment health rows from native pushes without unrelated reads or clock-only publications', async () => {
        const fixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController, runtimeOptions: { pluginIds: [] } });
        const target = { serverId: 'home', machineId: 'machine' };
        const runtime = createMachineServicesRuntime({ target, readMetadata: () => ({ status: 'ready', metadataVersion: 1,
            metadata: { serviceWatchesV1: { v: 1, watches: [] } } }),
            captureMetadataPort() { throw new Error('Health reads cannot write metadata'); } });
        const owner = fixture.registry.projectManagedServices;
        const document = 'services:\n  web:\n    image: example/web\n  worker:\n    image: example/worker\n';
        const materializer = createDeploymentSourceMaterializationPort({ registry: createScmBackendRegistry([]), async admit(input) {
            return { environmentId: input.environmentId, environmentInstanceId: input.environmentId,
                deploymentId: input.deploymentId, machineId: target.machineId, installationId: 'installation',
                deploymentRoot: join(fixture.happyHomeDir, 'deployments'), artifactDirectory: join(fixture.happyHomeDir, 'artifacts'),
                definition: { kind: 'stored' as const, contentRevision: 1, document,
                    composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['web', 'worker'] },
                async assertCurrent() {} };
        } });
        const states = new Map<string, { phase: 'running' | 'stopped'; readiness: 'ready' | 'not_ready'; observedAt: number }>();
        const releases = new Map<string, Awaited<ReturnType<typeof materializer.materialize>>>();
        const owned: Array<Awaited<ReturnType<typeof owner.superviseProject>>> = [];
        const supervise = async (environmentId: string, composeService: string) => {
            let release = releases.get(environmentId);
            if (!release) {
                release = await materializer.materialize({ environmentId, deploymentId: `${environmentId}-deployment` });
                await release.commit();
                releases.set(environmentId, release);
            }
            const state = { phase: 'running' as 'running' | 'stopped', readiness: 'ready' as 'ready' | 'not_ready', observedAt: 41 };
            states.set(`${environmentId}/${composeService}`, state);
            const handle = await owner.superviseProject({ kind: 'environment', ...target, environmentId, environmentInstanceId: environmentId,
                deploymentId: release.deploymentId, release, composeService, serviceId: `${environmentId}/${composeService}`,
                specIdentity: `${environmentId}/${composeService}`, isCurrent: () => true, releaseObservation: async () => {}, nativeEffects: { keys: [] },
                processSpec: { mode: { kind: 'native', observationOnly: true, builtinLifecycle: {
                    async inspect() { return { phase: state.phase, readiness: state.readiness, endpoint: null }; },
                    runtimeFacts() { return { configuration: null, observedAt: state.observedAt, freshness: 'current' }; },
                    async stop() { state.phase = 'stopped'; return { status: 'stopped' }; },
                } } },
            });
            owned.push(handle);
            return handle;
        };
        const demand = new AbortController();
        let retained: { dispose(): void | Promise<void> } | undefined;
        let publications = 0;
        let reads = 0;
        const context = { surface: 'cli' as const, authority: 'present_user' as const };
        const read = async (observe = false) => {
            reads++;
            return MachineServicesListResultV1Schema.parse(await runtime.execute({ actionId: 'machines.services.list',
                input: { ...target, environmentId: 'environment' }, canReadEnvironments: async ids => new Set(ids),
                context: { ...context, ...(observe ? { machineServicesListResource: {
                    signal: demand.signal, invalidate() { publications++; }, retire() { demand.abort(); },
                    accept(subscription: { dispose(): void | Promise<void> }) { retained = subscription; },
                } } : {}) },
            }));
        };
        try {
            const web = await supervise('environment', 'web');
            const worker = await supervise('environment', 'worker');
            const unrelated = await supervise('another', 'web');
            const initial = await read(true);
            expect(initial).toMatchObject({ kind: 'snapshot', services: [
                { serviceId: 'environment/web', state: 'healthy', health: { observedAtMs: 41, freshness: 'current' },
                    deployment: { deploymentId: 'environment-deployment', installationId: 'installation', service: { machineId: 'machine' } } },
                { serviceId: 'environment/worker' },
            ] });
            const sibling = owner.machineServiceRows.read(worker);
            for (let index = 0; index < 8; index++) {
                states.get('another/web')!.readiness = index % 2 ? 'ready' : 'not_ready';
                await unrelated.inspectCurrentOccurrence();
                states.get('environment/web')!.observedAt++;
                await web.inspectCurrentOccurrence();
            }
            expect({ publications, reads }, 'other Environment changes and equal native observations are quiet').toEqual({ publications: 0, reads: 1 });
            states.get('environment/web')!.readiness = 'not_ready';
            await web.inspectCurrentOccurrence();
            expect(publications, 'one selected native health change wakes one existing Resource').toBe(1);
            expect(await read()).toMatchObject({ kind: 'snapshot', services: [
                { state: 'unhealthy', health: { observedAtMs: 49, freshness: 'current', reason: 'not_ready' } },
                { serviceId: 'environment/worker' },
            ] });
            expect(owner.machineServiceRows.read(worker)).toBe(sibling);
            await web.controlNative('stop', { operation: { operationId: 'stop-selected', kind: 'serviceControl' } });
            await web.inspectCurrentOccurrence();
            expect(await read()).toMatchObject({ kind: 'snapshot', services: [
                { state: 'stopped', native: { phase: 'stopped' }, health: { expectedDown: 'stop' } },
                { serviceId: 'environment/worker' },
            ] });
        } finally {
            demand.abort(); await retained?.dispose();
            for (const handle of owned) await handle.dispose();
            await runtime.dispose(); await fixture.dispose();
        }
    });

    it('reads narrow cached health metadata without inflating lists or inspecting native state', async () => {
        const fixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController, runtimeOptions: { pluginIds: [] } });
        const target = { serverId: 'home', machineId: 'machine' };
        const metadata: MachineMetadataFieldReadV1 = { status: 'ready', metadataVersion: 1,
            metadata: { serviceWatchesV1: { v: 1, watches: [] } } };
        const runtime = createMachineServicesRuntime({ target, readMetadata: () => metadata,
            captureMetadataPort() { throw new Error('Read-only Services cannot write metadata'); } });
        const context = { surface: 'cli' as const, authority: 'present_user' as const };
        // The receiving Action supplies the captured Account access result.
        const canReadEnvironments = async (ids: readonly string[]) => new Set(ids.filter(id => id === 'environment'));
        let inspections = 0;
        let samples = 0;
        let facts: ProjectNativeRuntimeFacts = { configuration: {
            name: 'web', replicas: null, resources: { cpus: null, memory: null },
            restartPolicy: 'unless-stopped', healthcheck: 'absent',
            ports: [
                { target: 5432, published: '15432', bindAddress: '10.20.0.7', protocol: 'tcp' },
                { target: '8080', published: 18080, bindAddress: '127.0.0.1', protocol: 'udp' },
            ],
            mounts: [{ type: 'bind', source: '/private/data', target: '/data', readOnly: true }],
        }, observedAt: 41, freshness: 'current', accounting: { startedAtMs: 1700000000000 }, healthSince: 1700000001000 };
        try {
            const document = 'services:\n  web:\n    image: example/web\n  worker:\n    image: example/worker\n';
            const materializer = createDeploymentSourceMaterializationPort({ registry: createScmBackendRegistry([]), async admit() {
                return { environmentId: 'environment', environmentInstanceId: 'instance', deploymentId: 'deployment',
                    machineId: target.machineId, installationId: 'installation', deploymentRoot: join(fixture.happyHomeDir, 'deployments'),
                    artifactDirectory: join(fixture.happyHomeDir, 'artifacts'), definition: { kind: 'stored' as const, contentRevision: 1,
                        document, composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`,
                        profiles: [], services: ['web', 'worker'] }, async assertCurrent() {} };
            } });
            const release = await materializer.materialize({ environmentId: 'environment', deploymentId: 'deployment' });
            await release.commit();
            for (const composeService of ['web', 'worker'] as const) await fixture.registry.projectManagedServices.superviseProject({
                kind: 'environment', ...target, environmentId: release.environmentId, environmentInstanceId: release.environmentInstanceId,
                deploymentId: release.deploymentId, release, composeService, serviceId: `${release.environmentInstanceId}/${composeService}`,
                specIdentity: composeService, isCurrent: () => true, releaseObservation: async () => {}, nativeEffects: { keys: [] },
                // Only the native lifecycle IO is substituted; materialization,
                // supervision, disclosure and result parsing remain canonical.
                processSpec: { mode: { kind: 'native', observationOnly: true, builtinLifecycle: {
                    async inspect() { inspections++; return { phase: 'running', readiness: 'not_reported', endpoint: null,
                        displayName: `happier-${composeService === 'web' ? '' : 'g-'}${'a'.repeat(64)}` }; },
                    runtimeFacts() { return facts; },
                    async readAccounting() {
                        samples++;
                        facts = { ...facts, accounting: { ...facts.accounting, memoryBytes: 2097152 } };
                        return { kind: 'sample' as const, samples: [{ nativeResourceId: composeService, cpuPercent: null, memoryBytes: 2097152 }] };
                    },
                    async stop() { throw new Error('Reading Services must not stop native work'); },
                } } },
            });
            const nativeAtRest = inspections;
            const list = async () => MachineServicesListResultV1Schema.parse(await runtime.execute({
                actionId: 'machines.services.list', input: target, context, canReadEnvironments,
            }));
            const detail = async () => MachineServicesDetailResultV1Schema.parse(await runtime.execute({
                actionId: 'machines.services.detail', input: { ...target, serviceId: 'instance/web' }, context, canReadEnvironments,
            }));
            const listed = await list();
            expect(listed).toMatchObject({ kind: 'snapshot', services: [
                { serviceId: 'instance/web', accounting: { memoryBytes: 2097152, startedAtMs: 1700000000000 }, health: { observedAtMs: 41, freshness: 'current', since: 1700000001000 } },
                { serviceId: 'instance/worker', accounting: { memoryBytes: 2097152, startedAtMs: 1700000000000 }, health: { observedAtMs: 41, freshness: 'current', since: 1700000001000 } },
            ] });
            expect(samples, 'one explicit list samples each visible service once').toBe(2);
            if (listed.kind === 'snapshot') for (const service of listed.services) {
                expect(service.native?.displayName, 'generated Compose identities are not presentation names').toBeUndefined();
            }
            expect(JSON.stringify(listed)).not.toContain('/private/data');
            expect(JSON.stringify(listed)).not.toContain('runtimeFacts');
            if (listed.kind === 'snapshot') for (const service of listed.services) {
                expect(service.configuration).toEqual({ ports: facts.configuration!.ports });
            }
            expect(await detail()).toMatchObject({ kind: 'service', runtimeFacts: facts });
            facts = { ...facts, freshness: 'unavailable' };
            expect(await detail()).toMatchObject({ kind: 'service', runtimeFacts: facts });
            facts = { configuration: null, observedAt: null, freshness: 'unavailable' };
            expect(await detail()).toMatchObject({ kind: 'service', runtimeFacts: facts });
            for (let index = 0; index < 10; index++) await list();
            expect(inspections).toBe(nativeAtRest);
            // A retained Services read consumes the real Account observer, not a native-event ACL poll.
            const channel = await createRequesterCurrentnessSocketHarness();
            let cursor = 0;
            let changes: ChangeEntry[] = [];
            let feedReads = 0;
            const http = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
                if (url.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
                    updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null } };
                if (new URL(url).pathname !== '/v2/changes') throw new Error('Unexpected Services observer HTTP read');
                feedReads++;
                return { status: 200, data: { changes, nextCursor: cursor } };
            });
            const account = acquireRequesterAccountEncryptionCurrentness({ accountId: 'services-reader', token: 'services-reader',
                serverBaseUrl: 'https://services-access.example' });
            const demand = new AbortController();
            let retired = 0;
            let held: { dispose(): void | Promise<void> } | undefined;
            const observation: NonNullable<ActionExecutorContext['machineServicesListResource']> = {
                signal: demand.signal, invalidate() {},
                retire() { retired++; demand.abort(); }, accept(subscription) { held = subscription; },
            };
            try {
                await account.read();
                await channel.settleTransport();
                const samplesBeforeWatchAdmission = samples;
                const result = await runtime.execute({ actionId: 'machines.services.list', input: target,
                    context: { ...context, machineServicesListResource: observation }, canReadEnvironments,
                    async observeEnvironmentAccessChanges(listener) {
                        const unsubscribe = account.subscribeEnvironmentAccess(listener);
                        return { async dispose() { unsubscribe(); } };
                    } });
                expect(result).toMatchObject({ kind: 'snapshot', services: [{ environmentId: 'environment' }, { environmentId: 'environment' }] });
                expect(samples, 'watch admission projects the retained baseline without native samples').toBe(samplesBeforeWatchAdmission);
                await vi.waitFor(() => expect(feedReads).toBe(1));
                expect(retired).toBe(0);
                changes = [{ ...buildAccountIdentitiesChangeV1(), cursor: ++cursor, changedAt: cursor }];
                await channel.hintAccountChange(cursor);
                await vi.waitFor(() => expect(retired).toBe(1));
                expect(inspections).toBe(nativeAtRest);
            } finally {
                demand.abort();
                await held?.dispose();
                await account.dispose();
                await channel.close();
                http.mockRestore();
            }
        } finally { await runtime.dispose(); await fixture.dispose(); }
    });

    it('retains equal rows and siblings without native reads, then exposes one changed watch', async () => {
        const fixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController, runtimeOptions: { pluginIds: [] } });
        const target = { serverId: 'home', machineId: 'machine' };
        const adapter = { pluginId: 'example.native', localId: 'service' };
        const watches = ['web', 'worker'].map(watchId => ({
            v: 1 as const, watchId, name: watchId, adapter, nativeResourceId: watchId,
            lifecyclePurpose: 'deployment' as const,
        }));
        let metadata: MachineMetadataFieldReadV1 = { status: 'ready', metadataVersion: 1,
            metadata: { serviceWatchesV1: { v: 1, watches } } };
        let nativeReads = 0;
        let nativeStops = 0;
        const runtime = createMachineServicesRuntime({ target, readMetadata: () => metadata,
            captureMetadataPort: () => ({ read: async () => metadata,
                compareAndSwap: async () => ({ status: 'unavailable' as const }) }) });
        const supervise = (watch: MachineServiceWatchV1) => fixture.registry.projectManagedServices.superviseMachine({
            ...target, watch, isCurrent: () => true, releaseObservation: async () => {},
            lifecycle: {
                async inspect() { nativeReads++; return { phase: 'running', readiness: 'not_reported', endpoint: null,
                    displayName: `happier-${'a'.repeat(64)}` }; },
                async stop() { nativeStops++; return { status: 'stopped' }; },
            },
        });
        try {
            const initialHandles = await Promise.all(watches.map(supervise));
            const read = async () => {
                const value = await runtime.execute({ actionId: 'machines.services.list', input: target,
                    context: { surface: 'cli', authority: 'present_user' } });
                if (!('kind' in value) || value.kind !== 'snapshot' || !('services' in value)) throw new Error('Expected retained service rows');
                return value.services;
            };
            const first = await read();
            expect(first[0]?.native?.displayName, 'non-Compose native names remain visible').toBe(`happier-${'a'.repeat(64)}`);
            const nativeAtRest = nativeReads;
            for (let index = 0; index < 10; index++) {
                const equal = await read();
                expect(equal[0]).toBe(first[0]);
                expect(equal[1]).toBe(first[1]);
            }
            expect(nativeReads).toBe(nativeAtRest);
            metadata = { status: 'ready', metadataVersion: 2, metadata: { serviceWatchesV1: { v: 1,
                watches: [watches[0]!, { ...watches[1]!, name: 'Renamed worker' }] } } };
            const changed = await read();
            expect(changed[0]).toBe(first[0]);
            expect(changed[1]).not.toBe(first[1]);
            expect(changed[1]).toMatchObject({ serviceId: 'worker', name: 'Renamed worker' });
            expect((await read())[1]).toBe(changed[1]);
            expect(nativeReads).toBe(nativeAtRest);
            expect(nativeStops).toBe(0);
            expect(initialHandles[1]!.retirementSignal.aborted).toBe(true);
            expect(initialHandles[1]!.watch.name).toBe('worker');
            // A changed watch gets a new canonical occurrence; the retained old handle stays unchanged.
            const restored = await supervise({ ...watches[1]!, name: 'Renamed worker' });
            const replacement = await supervise({ ...watches[1]!, name: 'Renamed again' });
            expect(replacement).not.toBe(restored);
            expect(restored.retirementSignal.aborted).toBe(true);
            expect(restored.watch.name).toBe('Renamed worker');
            expect(replacement.watch.name).toBe('Renamed again');
            expect(fixture.registry.projectManagedServices.listMachineServices().find(handle => handle.watch.watchId === 'web'))
                .toBe(initialHandles[0]);
            expect(nativeStops).toBe(0);
        } finally {
            await runtime.dispose();
            await fixture.dispose();
        }
        expect(nativeStops).toBe(0);
    });

    it('retains admitted keyed watches across exact reads and unrelated metadata changes', async () => {
        const target = { serverId: 'home', machineId: 'machine' };
        let admissions = 0;
        const watches: MachineServiceWatchV1[] = Array.from({ length: 384 }, (_, index) => ({
            v: 1, watchId: `watch-${index}`, get name() { admissions++; return `Worker ${index}`; },
            adapter: { pluginId: 'acme.unavailable', localId: 'native' },
            nativeResourceId: `user/worker-${index}.service`, lifecyclePurpose: 'deployment',
        }));
        const policy = { v: 1 as const, watches };
        const machine: Machine = { id: target.machineId, encryptionMode: 'plain', metadataVersion: 1,
            daemonState: null, daemonStateVersion: 0, metadata: { host: 'test', platform: 'linux', happyCliVersion: '0.3.0',
                homeDir: '/home/test', happyHomeDir: '/home/test/.happier', serviceWatchesV1: policy } };
        let contentReady = true;
        let reads = 0;
        const runtime = createMachineServicesRuntime({ target, readMetadata() {
            reads++; return readOpenedMachineMetadataSnapshot(machine, contentReady);
        },
            captureMetadataPort() { throw new Error('A detail read cannot write metadata'); } });
        const fixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            runtimeOptions: { pluginIds: [] } });
        const context = { surface: 'cli' as const, authority: 'present_user' as const };
        const detail = () => runtime.execute({ actionId: 'machines.services.detail', context,
            input: { ...target, serviceId: 'watch-17' } });
        try {
            await runtime.reconcile();
            admissions = 0; reads = 0;
            expect(await detail()).toMatchObject({ kind: 'service', service: { name: 'Worker 17', state: 'unknown' } });
            expect(admissions).toBe(0);
            // Admission/currentness plus the pre/post-disclosure projection bases.
            expect(reads).toBeLessThanOrEqual(4);
            machine.metadataVersion++;
            machine.metadata = { ...machine.metadata!, displayName: 'Unrelated change' };
            expect(await detail()).toMatchObject({ kind: 'service', service: { name: 'Worker 17' } });
            expect(admissions).toBe(0);
            machine.metadataVersion++;
            machine.metadata = { ...machine.metadata!, serviceWatchesV1: {
                v: 1, watches: watches.map(watch => watch.watchId === 'watch-17' ? { ...watch, name: 'Renamed worker' } : watch),
            } };
            expect(await detail()).toMatchObject({ kind: 'service', service: { name: 'Renamed worker' } });
            contentReady = false;
            expect(await detail()).toEqual({ kind: 'unavailable', reason: 'admission_unavailable' });
            contentReady = true;
            expect(await detail()).toMatchObject({ kind: 'service', service: { name: 'Renamed worker' } });
        } finally { await runtime.dispose(); await fixture.dispose(); }
    });
});
