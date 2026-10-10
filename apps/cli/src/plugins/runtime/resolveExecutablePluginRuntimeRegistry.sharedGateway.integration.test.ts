import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFailed, vi } from 'vitest';
import type { ManagedServiceHandle } from '@happier-dev/plugin-sdk/managed-services';

import { waitForProcessExit } from '@/testkit/process/spawn';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { readPluginRegistryCommitRecord } from '@/plugins/store/registry/commitRecord';

import type { ResolvedManagedProviderRuntimeInvocationServices } from './resolveExecutablePluginRuntimeRegistry';
import type { PluginRuntimeRegistryLease } from './reload/controller';
import { createDaemonPluginRegistryRuntimeLifecycle } from './reload/registryRuntimeLifecycle';
import { createSharedGatewayRegistryTestkit } from './sharedGatewayRegistry.testkit';

const filesystemBoundary = vi.hoisted(() => ({ beforeStat: undefined as undefined | ((path: unknown) => Promise<void>) }));
// Only the operating-system read may pause; every stat and all admission,
// source/inventory checks still execute their real implementation.
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, async lstat(...args: unknown[]) {
        await filesystemBoundary.beforeStat?.(args[0]);
        return await Reflect.apply(actual.lstat, undefined, args);
    } };
});

it.each(['serving', 'resolving', 'explicitStart', 'withdrawn', 'withdrawnResolving', 'trustWithdrawnResolving', 'unbound'] as const)('G1 retains one real gateway across registry publication and original lease disposal (%s)', async stage => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-shared-registry-'));
    const fixture = createSharedGatewayRegistryTestkit({ directory });
    const { pluginId, peerId, controller, install, createRegistry } = fixture;
    const purposeBindings = stage === 'unbound' ? { v: 1 as const, bindings: [] } : fixture.purposeBindings;
    const leases: PluginRuntimeRegistryLease[] = [];
    const invocations: ResolvedManagedProviderRuntimeInvocationServices[] = [];
    const handles: ManagedServiceHandle[] = [];
    const pendingAcquisitions: Promise<unknown>[] = [];
    let completed = false;
    let phase = 'fixture setup';
    let resumeStat = () => {};
    let resumePublication = () => {};
    onTestFailed(() => { console.error('G1 controller gateway test failed during', phase); });

    const performAcquire = async (consumerId: string) => {
        const lease = controller.tryAcquireRuntimeRegistry();
        if (!lease) throw new Error('Expected current registry lease');
        leases.push(lease);
        const identity = { pluginId, localId: 'gateway' };
        const runtime = await lease.registry.acquireManagedProviderRuntime?.(identity);
        expect(runtime, JSON.stringify(lease.registry.targetActivationFacts)).not.toBeNull();
        if (!runtime) throw new Error('Expected native Provider runtime');
        expect(runtime.isCurrent(), `${consumerId} exact retained native runtime currentness`).toBe(true);
        expect(lease.registry.readPluginOccurrenceId?.(pluginId)).toBe(runtime.activationOccurrenceId);
        const invocation = await lease.registry.createManagedProviderRuntimeInvocationServices?.({ identity,
            sharedGateway: { homeId: 'home', accountId: 'account', connectionId: 'pc_shared', machineId: 'machine', consumerId },
            ...(consumerId === 'explicit-start' ? { operationClaim: { kind: 'explicitStart' as const, machineId: 'machine' } } : {}),
            purposeBindings,
            signal: new AbortController().signal, isCurrent: () => true,
        });
        if (!invocation) throw new Error('Expected admitted shared invocation');
        if (stage === 'unbound') expect(invocation.lifetime).toBeUndefined();
        invocations.push(invocation);
        const result = await runtime.runtime.start({ connectionId: 'pc_shared', reason: 'catalogProbe', endpointTemplateIds: ['api'] }, {
            managedServices: invocation.managedServices, connectedAccounts: invocation.connectedAccounts, signal: new AbortController().signal,
        });
        handles.push(result.service);
        return { lease, invocation, service: result.service, occurrenceId: runtime.activationOccurrenceId, sourceCustody: runtime.sourceCustody };
    };
    const acquire = (consumerId: string) => {
        const pending = performAcquire(consumerId);
        pendingAcquisitions.push(pending);
        return pending;
    };
    const readPid = async (service: ManagedServiceHandle) => {
        const response = await service.request({ pathAndQuery: '/pid' });
        expect(response.status).toBe(200);
        const pid = Number(await new Response(response.body).text());
        expect(Number.isInteger(pid) && pid > 0).toBe(true);
        return pid;
    };
    try {
        await install(pluginId, '1.0.0', true);
        await install(peerId, '1.0.0', false);
        phase = 'initial registry';
        const initial = await controller.acquireRuntimeRegistry({ resolveRuntimeRegistry: () => createRegistry(new Set()) });
        await initial.release();
        phase = 'first consumer';
        let enteredStat!: () => void;
        const statEntered = new Promise<void>(resolve => { enteredStat = resolve; });
        const statResumed = new Promise<void>(resolve => { resumeStat = resolve; });
        const pausesResolution = stage === 'resolving' || stage === 'withdrawnResolving' || stage === 'trustWithdrawnResolving';
        if (pausesResolution) filesystemBoundary.beforeStat = async path => {
            if (typeof path !== 'string' || !path.endsWith(join('tools', process.platform === 'win32' ? 'gateway.exe' : 'gateway'))) return;
            filesystemBoundary.beforeStat = undefined;
            enteredStat();
            await statResumed;
        };
        const firstPending = acquire('old-consumer');
        void firstPending.catch(() => undefined);
        if (stage === 'unbound') {
            phase = 'mandatory shared consumer authority unavailable';
            await expect(firstPending).rejects.toMatchObject({ code: 'plugin_managed_service_unavailable' });
            await expect(access(join(directory, 'gateway-started'))).rejects.toMatchObject({ code: 'ENOENT' });
            completed = true;
            return;
        }
        const firstServing = !pausesResolution ? await firstPending : null;
        if (pausesResolution) await statEntered;
        const incumbentPid = firstServing ? await readPid(firstServing.service) : null;
        const explicitBinding = { homeId: 'home', accountId: 'account', connectionId: 'pc_shared', machineId: 'machine', consumerId: 'explicit-start' };
        let explicit: Awaited<ReturnType<typeof acquire>> | undefined;
        if (stage === 'explicitStart') {
            phase = 'retained public Start consumer';
            const retained = await firstServing!.lease.registry.runManagedProviderExplicitStart?.({ identity: fixture.identity,
                machineId: 'machine', purposeBindings, sharedGateway: explicitBinding, isCurrent: () => true,
                establish: async ({ signal }) => {
                    explicit = await acquire('explicit-start');
                    const projection = await explicit.invocation.projectEndpointAccess({ service: explicit.service,
                        endpoints: [{ endpointTemplateId: 'api', servicePath: '/v1' }], signal, isCurrent: () => true });
                    if (!projection) throw new Error('Expected actual explicit Start endpoint projection');
                    return { status: 'running', projection };
                },
            });
            expect(retained?.status).toBe('established');
            expect(await readPid(explicit!.service)).toBe(incumbentPid);
        }
        if (stage === 'trustWithdrawnResolving') {
            phase = 'durable trust withdrawal before publication during executable resolution';
            let beforePublishEntered!: () => void;
            const publicationEntered = new Promise<void>(resolve => { beforePublishEntered = resolve; });
            const publicationResumed = new Promise<void>(resolve => { resumePublication = resolve; });
            const store = createPluginRegistryStateStore({ happyHomeDir: fixture.happyHomeDir,
                runtimeLifecycle: createDaemonPluginRegistryRuntimeLifecycle({ happyHomeDir: fixture.happyHomeDir,
                    reloadController: controller, managedProviderOperationAuthority: fixture.operationAuthority,
                    resolveCurrentMachineId: () => 'machine',
                    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'home', machineId: 'machine' }),
                    beforePublish: async (_registry, publish) => { beforePublishEntered(); await publicationResumed; publish(); },
                }),
            });
            const beforeCommit = await readPluginRegistryCommitRecord(store.paths);
            const occurrence = controller.readCurrentPluginOccurrenceId?.(pluginId);
            expect(occurrence).toBeTruthy();
            const withdrawal = store.forgetTrustWithResult(pluginId);
            pendingAcquisitions.push(withdrawal);
            void withdrawal.catch(() => undefined);
            await Promise.race([publicationEntered, withdrawal.then(() => { throw new Error('Trust withdrawal failed to reach publication'); })]);
            const afterCommit = await readPluginRegistryCommitRecord(store.paths);
            expect(afterCommit?.pluginOccurrenceIds[pluginId]).toEqual(beforeCommit?.pluginOccurrenceIds[pluginId]);
            expect(controller.isPluginOccurrenceCurrent?.(pluginId, occurrence!)).toBe(false);
            expect(controller.getState().activeRegistry).toBe(leases[0]!.registry);
            resumeStat();
            await expect(firstPending).rejects.toMatchObject({ code: 'plugin_managed_service_establishment_failed' });
            await expect(access(join(directory, 'gateway-started'))).rejects.toMatchObject({ code: 'ENOENT' });
            resumePublication();
            const result = await withdrawal;
            expect(result?.catalog.plugins[pluginId]?.state.enabled).toBe(false);
            expect(result?.catalog.plugins[pluginId]?.install.trust).toBeUndefined();
            completed = true;
            return;
        }
        if (stage === 'withdrawnResolving') {
            phase = 'physical source withdrawal during executable resolution';
            await install(pluginId, '1.0.1', true);
            const changed = await createRegistry(new Set([pluginId]));
            let published!: () => void;
            const publication = new Promise<void>(resolve => { published = resolve; });
            const adoption = controller.adoptPreparedRuntimeRegistry({ registry: changed, changedPluginIds: [pluginId],
                runningSessionDisposition: 'keepRunningSessions', beforePublish: async (_registry, publish) => { publish(); published(); } });
            void adoption.catch(() => undefined);
            await publication;
            resumeStat();
            await expect(firstPending).rejects.toMatchObject({ code: 'plugin_managed_service_establishment_failed' });
            await adoption;
            await expect(access(join(directory, 'gateway-started'))).rejects.toMatchObject({ code: 'ENOENT' });
            completed = true;
            return;
        }
        if (stage === 'withdrawn') {
            phase = 'physical source withdrawal';
            await install(pluginId, '1.0.1', true);
            const changed = await createRegistry(new Set([pluginId]));
            await controller.adoptPreparedRuntimeRegistry({ registry: changed, changedPluginIds: [pluginId], runningSessionDisposition: 'keepRunningSessions' });
            await expect(firstServing!.service.request({ pathAndQuery: '/pid' })).rejects.toMatchObject({ code: 'plugin_managed_service_unavailable' });
            expect(await waitForProcessExit(incumbentPid!)).toBe(true);
            await expect(firstServing!.service.dispose()).resolves.toBeUndefined();
            await firstServing!.lease.release();
            const replacement = await acquire('replacement-source');
            const replacementPid = await readPid(replacement.service);
            expect(replacementPid).not.toBe(incumbentPid);
            await replacement.service.dispose();
            expect(await waitForProcessExit(replacementPid)).toBe(true);
            await replacement.lease.release();
            completed = true;
            return;
        }
        phase = 'unrelated publication';
        await install(peerId, '1.0.1', false);
        const next = await createRegistry(new Set([peerId]));
        await controller.adoptPreparedRuntimeRegistry({ registry: next, changedPluginIds: [peerId], runningSessionDisposition: 'keepRunningSessions' });
        phase = 'second consumer';
        const secondPending = acquire('new-consumer');
        void secondPending.catch(() => undefined);
        if (stage === 'resolving') {
            await leases[0]!.release();
            resumeStat();
        }
        const [first, second] = await Promise.all([firstPending, secondPending]);
        const pid = incumbentPid ?? await readPid(first.service);
        expect(second.occurrenceId).toBe(first.occurrenceId);
        expect(second.sourceCustody).toEqual(first.sourceCustody);
        expect(await readPid(second.service)).toBe(pid);
        phase = 'old root disposal';
        await explicit?.lease.release();
        await first.lease.release();
        expect(await readPid(first.service)).toBe(pid);
        expect(await readPid(second.service)).toBe(pid);
        await first.service.dispose();
        await invocations[0]!.cleanup();
        const third = await acquire('after-old-root-disposal');
        expect(await readPid(third.service)).toBe(pid);
        await second.service.dispose();
        expect(await readPid(third.service)).toBe(pid);
        await third.service.dispose();
        if (explicit) {
            expect(await readPid(explicit.service)).toBe(pid);
            const current = controller.tryAcquireRuntimeRegistry();
            if (!current) throw new Error('Expected current explicit Start retirement owner');
            leases.push(current);
            expect(await current.registry.retireManagedProviderExplicitStart?.({ identity: fixture.identity,
                machineId: 'machine', sharedGateway: explicitBinding })).toBe(true);
            await current.release();
        }
        expect(await waitForProcessExit(pid)).toBe(true);
        phase = 'restart after old root disposal';
        const restarted = await acquire('restart-after-old-root-disposal');
        const restartedPid = await readPid(restarted.service);
        expect(restartedPid).not.toBe(pid);
        await restarted.service.dispose();
        expect(await waitForProcessExit(restartedPid)).toBe(true);
        await restarted.lease.release();
        await Promise.all([second.lease.release(), third.lease.release()]);
        completed = true;
    } finally {
        filesystemBoundary.beforeStat = undefined;
        resumeStat();
        resumePublication();
        await Promise.allSettled(pendingAcquisitions);
        phase += ' / handle cleanup';
        const cleanup = await Promise.allSettled(handles.map(handle => handle.dispose()));
        phase += ' / invocation cleanup';
        await Promise.allSettled(invocations.map(invocation => invocation.cleanup()));
        phase += ' / lease cleanup';
        await Promise.allSettled(leases.map(lease => lease.release()));
        phase += ' / controller shutdown';
        await controller.shutdown();
        fixture.disposeCredentialBoundary();
        await rm(directory, { recursive: true, force: true });
        if (completed) for (const result of cleanup) if (result.status === 'rejected') throw result.reason;
    }
});
