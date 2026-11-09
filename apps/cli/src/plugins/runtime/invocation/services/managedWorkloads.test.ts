import { describe, expect, it } from 'vitest';
import { createManagedServicesOwner } from './managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from './managedProcessSupervisor';
import { createUnavailableManagedServices } from './managedServicesAdapter';
import type { EnvironmentProjectManagedServiceSupervisionInput } from './managedServicesOwner';
import { createProductionPluginInvocationServiceOwners } from './production';
import { exerciseManagedWorkload } from '@/plugins/testkit/managedWorkloadPlugin';
import { createDeploymentTargetRoleAdmissionFixture } from '@/deployments/targets/deploymentTargetRoleAdmission.testkit';
import { admitDeploymentTargetRoleForHost } from '@/deployments/targets/admitDeploymentTargetRoleForHost';
import { createDeploymentTargetRoleWorkloadBindingForHost } from '@/deployments/targets/createDeploymentTargetRoleWorkloadBindingForHost';
import { projectNativeComposeReview } from '@/workspaces/projectSetup/nativeComposeReview';
import type { ManagedServiceNativeObservationV1 } from '@happier-dev/plugin-sdk/managed-services';

const target = { serverId: 'home', machineId: 'machine' };
const serviceId = 'production-machine/web';

function fixture() {
    let phase: 'running' | 'stopped' = 'running';
    let stops = 0;
    let restarts = 0;
    let releases = 0;
    let logReads = 0;
    let logWatchesDisposed = 0;
    let inspections = 0;
    let nativeObservation: ((value: ManagedServiceNativeObservationV1) => void) | undefined;
    const subscribed = Promise.withResolvers<void>();
    const configuration = projectNativeComposeReview({ services: { web: { ports: [
        { target: 8080, published: '8080', host_ip: '127.0.0.1', protocol: 'tcp' },
    ] } } }, process.cwd(), value => value).services[0]!;
    const createOwner = () => createManagedServicesOwner({
        processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
        dependencies: createUnavailableManagedServices().dependencies,
        resolveScope: scope => scope,
    });
    const supervision: EnvironmentProjectManagedServiceSupervisionInput = {
        kind: 'environment', ...target, environmentId: 'production', environmentInstanceId: 'production-machine',
        deploymentId: 'release-1', composeService: 'web', serviceId, specIdentity: 'release-1',
        isCurrent: () => true, releaseObservation: async () => { releases++; },
        release: { environmentId: 'production', environmentInstanceId: 'production-machine', deploymentId: 'release-1',
            machineId: target.machineId, installationId: 'installation', rootPath: process.cwd(), manifestFingerprint: 'manifest',
            assertCurrent: async () => {}, commit: async () => {}, abort: async () => {} },
        nativeEffects: { keys: [] },
        processSpec: { mode: { kind: 'native', observationOnly: true, builtinLifecycle: {
            inspect: async () => { inspections++; return { phase, readiness: phase === 'running' ? 'ready' : 'not_ready', endpoint: 'http://127.0.0.1:8080' }; },
            runtimeFacts: () => ({ configuration, observedAt: 41, freshness: 'current' }),
            observe: async listener => {
                nativeObservation = listener;
                subscribed.resolve();
                return { async dispose() { nativeObservation = undefined; } };
            },
            start: async () => { phase = 'running'; return { phase, readiness: 'ready', endpoint: 'http://127.0.0.1:8080' }; },
            restart: async () => { restarts++; phase = 'running'; return { phase, readiness: 'ready', endpoint: 'http://127.0.0.1:8080' }; },
            stop: async () => { stops++; phase = 'stopped'; return { status: 'stopped' }; },
            logs: async request => {
                if (request.kind === 'watch') return { dispose() { logWatchesDisposed++; } };
                logReads++; return { kind: 'page', page: { sourceRevision: 'release-1', text: 'serving', nextCursor: null, truncated: false } };
            },
        } } },
    };
    const admission = (owner: ReturnType<typeof createOwner>, accountId = 'owner', restore = async () => {}) => owner.bindWorkloads({
        target, disclosure: { requesterAccountId: accountId,
            canReadEnvironments: async () => new Set(accountId === 'owner' ? ['production'] : []) },
        ensureRecovered: restore, signal: new AbortController().signal,
        control: (handle, operation, options) => handle.controlNative!(operation, {
            operation: { operationId: 'plugin-operation', kind: 'workload-control' }, ...options,
        }),
    });
    return { createOwner, supervision, admission, counts: () => ({ stops, restarts, releases, logReads }), phase: () => phase,
        observations: () => ({ inspections, logWatchesDisposed }), subscribed: subscribed.promise,
        reportNotReady() {
            if (!nativeObservation) throw new Error('Expected incumbent native push subscription');
            nativeObservation({ phase: 'running', readiness: 'not_ready', endpoint: 'http://127.0.0.1:8080' });
        } };
}

describe('host-admitted managed workload binding', () => {
    it.each(['deploy', 'observe'] as const)('consumes real %s role admission and Machine recovery without repeating access reads', async role => {
        const f = fixture(); const owner = f.createOwner();
        const deployment = createDeploymentTargetRoleAdmissionFixture(role);
        Object.assign(deployment.state.environment.targetLinks[0]!.targetLink, {
            machineId: deployment.host.machineId, installationId: deployment.host.installationId,
        });
        const admission = await admitDeploymentTargetRoleForHost({ ...deployment.request, executionTarget: 'daemon' }, deployment.host);
        if (!admission.environment || !admission.receipt) throw new Error('Expected admitted deployment');
        const retained = { ...f.supervision, machineId: deployment.host.machineId,
            environmentId: admission.environment.environment.id, deploymentId: admission.receipt.deployment.id,
            release: { ...f.supervision.release, environmentId: admission.environment.environment.id,
                machineId: deployment.host.machineId, deploymentId: admission.receipt.deployment.id } };
        const readsAtAdmission = deployment.state.reads;
        let recoveries = 0;
        const attach = createDeploymentTargetRoleWorkloadBindingForHost({ admission, host: deployment.host,
            context: deployment.request.context, readOwner: () => owner,
            ensureEnvironmentServices: () => owner.restoreEnvironmentServices({ ...target, machineId: deployment.host.machineId }, async () => {
                recoveries++; await owner.superviseProject(retained);
            }) });
        try {
            const result = await attach!({ serviceId });
            if (result.kind !== 'ready') throw new Error('Expected recovered deployment workload');
            expect(await result.workload.control('restart')).toMatchObject({ kind: role === 'deploy' ? 'observed' : 'unsupported' });
            expect(await result.workload.readLogs()).toMatchObject({ kind: 'page' });
            await result.workload.dispose();
            expect(deployment.state.reads).toBe(readsAtAdmission);
            expect(recoveries).toBe(1);
            expect(f.counts().stops).toBe(0);
            expect(f.counts().restarts).toBe(role === 'deploy' ? 1 : 0);
        } finally { await owner.dispose(); }
    });

    it('makes the public author fixture usable through the real invocation service factory', async () => {
        const f = fixture(); const owner = f.createOwner();
        const signal = new AbortController();
        const cleanups: Array<{ dispose(): Promise<void> }> = [];
        const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} }, managedServices: owner });
        try {
            await owner.superviseProject(f.supervision);
            const services = owners.createOperationServices({
                plugin: { id: 'examples.managed-workload', version: '1.0.0' },
                contribution: { id: 'inspect', qualifiedId: 'examples.managed-workload/actions/inspect' },
                occurrenceId: 'workload-fixture', correlationId: 'observe', surface: 'plugin',
                signal: signal.signal, isOccurrenceCurrent: () => true, managedWorkloads: f.admission(owner),
                retainCleanup: cleanup => cleanups.push(cleanup),
            }, { filesystemRoots: { pluginData: process.cwd(), workspace: process.cwd(), projects: new Map() }, hostAccessRequests: [] });
            expect(await exerciseManagedWorkload(services.managedServices, serviceId)).toMatchObject({
                kind: 'observed', control: 'observed', logs: 'page',
            });
            expect(f.counts()).toEqual({ stops: 0, restarts: 1, releases: 0, logReads: 1 });
            const attached = await services.managedServices.observeWorkload({ serviceId });
            if (attached.kind !== 'ready') throw new Error('Expected workload observation');
            await attached.workload.watchLogs({ emit() {} });
            signal.abort();
            await Promise.all(cleanups.map(cleanup => cleanup.dispose()));
            expect(f.observations().logWatchesDisposed).toBe(1);
            expect(() => attached.workload.snapshot()).toThrow(expect.objectContaining({ code: 'plugin_managed_service_unavailable' }));
            expect(f.counts().stops).toBe(0);
            expect(await createUnavailableManagedServices().observeWorkload({ serviceId })).toEqual({
                kind: 'unavailable', reason: 'admission_unavailable',
            });
        } finally { signal.abort(); await owner.dispose(); }
    });

    it('discloses the incumbent generation, controls and reads logs without treating detach as Stop', async () => {
        const f = fixture(); const owner = f.createOwner();
        try {
            const native = await owner.superviseProject(f.supervision);
            await native.inspectCurrentOccurrence();
            const result = await f.admission(owner)({ serviceId });
            expect(result.kind).toBe('ready');
            if (result.kind !== 'ready') throw new Error('Expected admitted workload');
            expect(result.workload.snapshot()).toEqual(owner.machineServiceRows.read(native));
            expect(result.workload.snapshot()).toMatchObject({ health: { status: 'up', freshness: 'current' },
                baseUrl: 'http://127.0.0.1:8080', configuration: { ports: [{ target: 8080, published: '8080' }] } });
            const inspections = f.observations().inspections;
            for (let i = 0; i < 100; i++) result.workload.snapshot();
            expect(f.observations().inspections).toBe(inspections);
            const snapshots: string[] = [];
            const down = Promise.withResolvers<void>();
            const subscription = result.workload.observe(row => {
                snapshots.push(row.health?.status ?? 'unknown');
                if (row.health?.status === 'down') down.resolve();
            });
            await f.subscribed;
            f.reportNotReady();
            await down.promise;
            expect(snapshots.at(-1)).toBe('down');
            expect(await result.workload.control('restart')).toMatchObject({ kind: 'observed' });
            expect(await result.workload.readLogs()).toMatchObject({ kind: 'page', page: { text: 'serving' } });
            await result.workload.watchLogs({ emit() {} });
            subscription.dispose(); await result.workload.dispose();
            expect(f.observations().logWatchesDisposed).toBe(1);
            expect(() => result.workload.snapshot()).toThrow(expect.objectContaining({ code: 'plugin_managed_service_unavailable' }));
            expect(f.phase()).toBe('running');
            // Unhealthy observations also capture logs through the incumbent supervisor.
            expect(f.counts()).toMatchObject({ stops: 0, restarts: 1, releases: 0 });
            expect(snapshots.length).toBeGreaterThan(0);
            expect(native.isCurrent()).toBe(true);
        } finally { await owner.dispose(); }
    });

    it('reconstructs observation on the next owner through incumbent restart recovery without native activation', async () => {
        const f = fixture(); const first = f.createOwner();
        await first.superviseProject(f.supervision);
        await first.dispose();
        expect(f.counts().stops).toBe(0);
        const recovered = f.createOwner(); let recoveries = 0;
        const restore = () => recovered.restoreEnvironmentServices(target, async () => {
            recoveries++;
            await recovered.superviseProject(f.supervision);
        });
        try {
            const attach = f.admission(recovered, 'owner', restore);
            const [a, b] = await Promise.all([attach({ serviceId }), attach({ serviceId })]);
            expect(a.kind).toBe('ready'); expect(b.kind).toBe('ready');
            if (a.kind !== 'ready' || b.kind !== 'ready') throw new Error('Expected recovered workload');
            expect(a.workload.snapshot().generation).toBe(b.workload.snapshot().generation);
            await a.workload.control('stop');
            expect(f.phase()).toBe('stopped');
            expect(recoveries).toBe(1);
            await a.workload.dispose(); await b.workload.dispose();
            expect(f.counts()).toEqual({ stops: 1, restarts: 0, releases: 1, logReads: 0 });
        } finally { await recovered.dispose(); }
    });

    it('uses the existing disclosure owner and reveals no handle to another Account', async () => {
        const f = fixture(); const owner = f.createOwner();
        try {
            await owner.superviseProject(f.supervision);
            expect(await f.admission(owner, 'unrelated')({ serviceId })).toEqual({ kind: 'unavailable', reason: 'denied' });
            const ownerRead = await f.admission(owner)({ serviceId });
            expect(ownerRead.kind).toBe('ready');
            if (ownerRead.kind === 'ready') await ownerRead.workload.dispose();
            expect(f.counts()).toEqual({ stops: 0, restarts: 0, releases: 0, logReads: 0 });
        } finally { await owner.dispose(); }
    });

    it('settles unavailable recovery and cancellation without native work', async () => {
        const f = fixture(); const owner = f.createOwner();
        try {
            expect(await f.admission(owner, 'owner', async () => { throw new Error('native adapter unavailable'); })({ serviceId }))
                .toEqual({ kind: 'unavailable', reason: 'admission_unavailable' });
            const cancelled = new AbortController(); cancelled.abort();
            expect(await f.admission(owner)({ serviceId }, { signal: cancelled.signal }))
                .toEqual({ kind: 'unavailable', reason: 'cancelled' });
            expect(f.counts()).toEqual({ stops: 0, restarts: 0, releases: 0, logReads: 0 });
        } finally { await owner.dispose(); }
    });
});
