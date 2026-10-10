import { describe, expect, it, vi } from 'vitest';
import { createLocalServiceActionConfirmationNonceV1 } from '@happier-dev/protocol/local/services/actions/v1';

import { createLocalServiceActionRoutes } from './routes';
import { createLocalServiceInventoryRegistry } from '../inventory/registry';
import type { NormalizedLocalServiceInventorySnapshot } from '../inventory/scanner';
import { createManagedServicesOwner, type ProjectManagedServiceSupervisionInput } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { authorizeResolvedProjectExecLaunchForHost, createProjectNativeEnvironmentIoForHost } from '@/plugins/runtime/invocation/services/exec';

const inventorySnapshot: NormalizedLocalServiceInventorySnapshot = {
    v: 1,
    machineId: 'machine-a',
    generatedAt: 1_000,
    refreshState: 'idle',
    diagnostics: [],
    entries: [{
        id: 'entry-a',
        machineId: 'machine-a',
        address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
        port: 5173,
        protocol: 'tcp',
        detectedAt: 1_000,
        lastSeenAt: 1_000,
        state: 'listening',
        source: 'detected',
        labels: [],
        confidence: 'high',
        // `terminate_detected` eligibility requires an owned process, not merely a resolvable
        // one: a recovered process fact plus `high` ownership (terminal-registry match or the
        // daemon's own OS identity). Without both, the policy layer denies with
        // `ownership_not_established` and the confirmation gate below is never reached.
        processOwnershipConfidence: 'high',
        workspaceAssociationConfidence: 'high',
        diagnostics: [],
        provenance: {
            process: { pid: 4_321, lineagePids: [4_321], command: 'npm run dev', redacted: true },
        },
    }],
};

describe('createLocalServiceActionRoutes', () => {
    it.each(['unsupported', 'accepted', 'termination_incomplete'] as const)(
        'preserves the canonical %s native Stop outcome through real service controls',
        async stopOutcome => {
            const owner = createManagedServicesOwner({
                processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
                // This Project-only owner admits no Plugin scope/dependency request.
                dependencies() { throw new Error('Project service control does not use Plugin dependencies'); },
                resolveScope() { return null; },
            });
            const workspace = {
                id: 'workspace-one', serverId: 'server-one', machineId: 'machine-one',
                rootPath: process.cwd(), createdAtMs: 1,
            };
            const declaration = {
                workspaceRefId: workspace.id,
                selection: { kind: 'manifest' as const, name: 'worker' },
            };
            const reviewedEffectDigest = 'reviewed-worker-effect';
            const instance = {
                adapter: { pluginId: 'acme.native', localId: 'compose' },
                nativeResourceId: 'retained-control-resource',
            };
            let stoppable = false;
            let nativeStopped = false;
            const supervision: ProjectManagedServiceSupervisionInput = {
                workspace, declaration, cwd: workspace.rootPath,
                requester: {
                    serverId: workspace.serverId, accountId: 'requester-one',
                    machineId: workspace.machineId, installationId: 'installation-one',
                },
                serviceId: 'project:workspace-one:manifest:worker',
                specIdentity: reviewedEffectDigest,
                isCurrent: () => true,
                authorizeLaunch: ({ signal }) => authorizeResolvedProjectExecLaunchForHost({
                    signal, assertCurrent() {},
                    projectLaunch: {
                        status: 'ready', reviewedEffectDigest,
                        environment: {
                            selection: { kind: 'host' }, root: workspace.rootPath, platform: process.platform,
                            io: createProjectNativeEnvironmentIoForHost({ resolveTool: async () => null }),
                        },
                    },
                    launch: {
                        command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
                        cwd: workspace.rootPath, env: {},
                    },
                }),
                processSpec: {
                    startupTimeoutMs: 1_000,
                    mode: {
                        kind: 'native',
                        instance,
                        // Native resource inspection and Stop are external OS/tool IO.
                        lifecycle: {
                            inspect: async observed => {
                                expect(observed).toEqual(instance);
                                return {
                                    phase: nativeStopped ? 'stopped' : 'running',
                                    readiness: 'not_reported',
                                    endpoint: null,
                                };
                            },
                            stop: async observed => {
                                expect(observed).toEqual(instance);
                                if (stoppable) {
                                    nativeStopped = true;
                                    return { status: 'stopped' };
                                }
                                return { status: stopOutcome };
                            },
                        },
                    },
                },
            };
            try {
                const handle = await owner.superviseProject(supervision);
                const routes = createLocalServiceActionRoutes({
                    machineId: workspace.machineId,
                    inventoryRegistry: createLocalServiceInventoryRegistry(),
                    projectManagedServices: owner,
                    verifyConfirmationNonce: request => request.confirmationNonce === createLocalServiceActionConfirmationNonceV1(request),
                });
                const target = {
                    kind: 'managed_service' as const,
                    managedServiceId: handle.instanceId,
                    machineId: workspace.machineId,
                    workspaceId: workspace.id,
                    cwd: workspace.rootPath,
                    declaration,
                };
                const request = {
                    requestId: 'retained-native-control',
                    target,
                    action: 'stop_managed' as const,
                    force: false,
                };
                const confirmed = {
                    ...request,
                    confirmationNonce: createLocalServiceActionConfirmationNonceV1(request),
                };
                // The SDK wrapper preserves the supervisor's unsupported vs
                // unconfirmed distinction through its canonical typed errors.
                const reasonCode = stopOutcome === 'unsupported'
                    ? 'plugin_managed_service_unavailable'
                    : 'plugin_managed_server_termination_incomplete';
                const result = await routes.execute(confirmed);
                expect(result).toMatchObject({ status: 'failed', reasonCode });
                expect(result.auditEvents.at(-1)).toMatchObject({ result: 'failed', reasonCode });
                expect(nativeStopped).toBe(false);
                expect(handle.snapshot()).toMatchObject({ mode: 'native', state: 'running', nativePhase: 'running' });
                expect(owner.resolveProjectService(target)).toMatchObject({ status: 'found', handle });
                expect(await owner.superviseProject(supervision)).toBe(handle);
                expect(owner.readRetainedSemanticCustodyCount()).toBe(1);

                stoppable = true;
                expect(await routes.execute(confirmed)).toMatchObject({ status: 'succeeded' });
                expect(nativeStopped).toBe(true);
                expect(handle.snapshot().state).toBe('stopped');
                expect(owner.resolveProjectService(target)).toEqual({ status: 'unknown' });
                expect(owner.readRetainedSemanticCustodyCount()).toBe(0);
            } finally {
                stoppable = true;
                await owner.dispose();
            }
        },
    );
    it('undoes Forget through the same action after rescanning and restarting the inventory owner', async () => {
        let annotations: import('../inventory/registry').LocalServiceInventoryAnnotationsV1 | null = null;
        const store = { read: () => annotations, write: (next: NonNullable<typeof annotations>) => { annotations = next; } };
        const first = createLocalServiceInventoryRegistry({ annotations: store });
        first.replaceSnapshot(inventorySnapshot);
        const target = { kind: 'inventory_entry', inventoryEntryId: 'entry-a', machineId: 'machine-a' } as const;
        const request = { requestId: 'forget', target, action: 'forget', force: false } as const;
        const forgotten = await createLocalServiceActionRoutes({ machineId: 'machine-a', inventoryRegistry: first }).execute(request);
        const undoKey = 'machine-a:tcp:loopback:127.0.0.1:5173';
        const restarted = createLocalServiceInventoryRegistry({ annotations: store });
        restarted.replaceSnapshot({
            ...inventorySnapshot,
            generatedAt: 3_000,
            entries: [{ ...inventorySnapshot.entries[0], id: 'entry-b', lastSeenAt: 3_000 }],
        });
        expect(restarted.getSnapshot().entries).toEqual([]);
        const routes = createLocalServiceActionRoutes({ machineId: 'machine-a', inventoryRegistry: restarted });
        const undoRequest = { ...request, requestId: 'undo', undoKey, target: { ...target, inventoryEntryId: undoKey } };
        expect(await routes.execute({ ...undoRequest, target: { ...target, inventoryEntryId: 'another-entry' } }))
            .toMatchObject({ status: 'denied', reasonCode: 'wrong_target_kind' });
        expect(restarted.getSnapshot().entries).toEqual([]);
        expect(store.read()?.forgottenFallbackKeys).toHaveLength(1);
        expect(await routes.execute(undoRequest)).toMatchObject({ status: 'succeeded' });
        expect(forgotten).toMatchObject({ status: 'succeeded', undoKey });
        expect(restarted.getSnapshot().entries).toMatchObject([{ id: 'entry-b', lastSeenAt: 3_000 }]);
        expect(store.read()?.forgottenFallbackKeys).toEqual([]);
        const restored = createLocalServiceInventoryRegistry({ annotations: store });
        restored.replaceSnapshot(inventorySnapshot);
        expect(restored.getSnapshot().entries).toHaveLength(1);
        expect(await routes.execute({ ...undoRequest, target: { ...target, machineId: 'machine-b' } }))
            .toMatchObject({ status: 'denied', reasonCode: 'wrong_machine' });
    });

    it('executes forget by hiding the canonical inventory target and future matching snapshots', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        inventoryRegistry.replaceSnapshot(inventorySnapshot);
        // Termination is the OS/process boundary. Forget must only change projection even
        // when the exact detected process is eligible for the distinct terminate action.
        const terminateDetectedService = vi.fn(async () => ({ status: 'succeeded' as const }));
        const routes = createLocalServiceActionRoutes({
            machineId: 'machine-a',
            inventoryRegistry,
            terminateEnabled: () => true,
            verifyConfirmationNonce: () => true,
            terminateDetectedService,
            now: () => 2_000,
        });

        const result = await routes.execute({
            requestId: 'request-forget',
            target: { kind: 'inventory_entry', inventoryEntryId: 'entry-a', machineId: 'machine-a' },
            action: 'forget',
            force: false,
        });

        expect(result).toMatchObject({
            v: 1,
            requestId: 'request-forget',
            action: 'forget',
            status: 'succeeded',
        });
        expect(result.auditEvents.map((event: (typeof result.auditEvents)[number]) => event.result)).toEqual([
            'requested',
            'succeeded',
        ]);
        expect(inventoryRegistry.getSnapshot().entries).toEqual([]);

        inventoryRegistry.replaceSnapshot({
            ...inventorySnapshot,
            generatedAt: 3_000,
            entries: [{ ...inventorySnapshot.entries[0], id: 'entry-b' }],
        });
        expect(inventoryRegistry.getSnapshot().entries).toEqual([]);
        expect(terminateDetectedService).not.toHaveBeenCalled();
    });


    // The managed local-service runtime was removed as a producerless spine (RU2 surfaces
    // finalization, DEC-6). The protocol still declares a `managed_service` action target, so
    // the route must answer it — the contract under test is that the answer is a constant,
    // audited denial and never an execution path.
    it.each(['stop_managed', 'restart_managed'] as const)(
        'denies %s: no managed service can be resolved on any machine',
        async (action) => {
            const inventoryRegistry = createLocalServiceInventoryRegistry();
            inventoryRegistry.replaceSnapshot(inventorySnapshot);
            const routes = createLocalServiceActionRoutes({
                machineId: 'machine-a',
                inventoryRegistry,
                verifyConfirmationNonce: () => true,
                now: () => 2_000,
            });

            const result = await routes.execute({
                requestId: `request-${action}`,
                target: { kind: 'managed_service', managedServiceId: 'plugin-a:web', machineId: 'machine-a' },
                action,
                confirmationNonce: 'confirm-a',
                force: false,
            });

            expect(result).toMatchObject({
                v: 1,
                requestId: `request-${action}`,
                action,
                status: 'denied',
                reasonCode: 'unknown_managed_service',
            });
            expect(result.auditEvents.map((event: (typeof result.auditEvents)[number]) => [event.result, event.reasonCode])).toEqual([
                ['requested', undefined],
                ['denied', 'unknown_managed_service'],
            ]);
        },
    );

    it('denies a target addressed to a different machine before evaluating action policy', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        inventoryRegistry.replaceSnapshot(inventorySnapshot);
        const routes = createLocalServiceActionRoutes({
            machineId: 'machine-a',
            inventoryRegistry,
            now: () => 2_000,
        });

        const result = await routes.execute({
            requestId: 'request-a',
            target: { kind: 'inventory_entry', inventoryEntryId: 'entry-a', machineId: 'machine-b' },
            action: 'forget',
            force: false,
        });

        expect(result).toMatchObject({
            v: 1,
            requestId: 'request-a',
            action: 'forget',
            status: 'denied',
            reasonCode: 'wrong_machine',
        });
        expect(result.auditEvents.map((event: (typeof result.auditEvents)[number]) => [event.result, event.reasonCode])).toEqual([
            ['requested', undefined],
            ['denied', 'wrong_machine'],
        ]);
        // The entry is still visible: a wrong-machine request must not mutate local state.
        expect(inventoryRegistry.getSnapshot().entries).toHaveLength(1);
    });

    // Confirmation gating used to be covered only through the managed stop path. It is a live
    // contract for `terminate_detected`, so it is re-pinned on the surviving action.
    it('requires a confirmation nonce before a confirmation-gated action executes', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        inventoryRegistry.replaceSnapshot(inventorySnapshot);
        let executed = false;
        const routes = createLocalServiceActionRoutes({
            machineId: 'machine-a',
            inventoryRegistry,
            terminateEnabled: () => true,
            verifyConfirmationNonce: () => true,
            terminateDetectedService: async () => {
                executed = true;
                return { status: 'succeeded' as const };
            },
            now: () => 2_000,
        });

        const result = await routes.execute({
            requestId: 'request-terminate',
            target: { kind: 'inventory_entry', inventoryEntryId: 'entry-a', machineId: 'machine-a' },
            action: 'terminate_detected',
            force: false,
        });

        expect(result).toMatchObject({ status: 'denied', reasonCode: 'confirmation_required' });
        expect(executed).toBe(false);
    });

    it('rejects a confirmation-gated action when the nonce verifier denies the request', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        inventoryRegistry.replaceSnapshot(inventorySnapshot);
        let executed = false;
        const routes = createLocalServiceActionRoutes({
            machineId: 'machine-a',
            inventoryRegistry,
            terminateEnabled: () => true,
            verifyConfirmationNonce: () => false,
            terminateDetectedService: async () => {
                executed = true;
                return { status: 'succeeded' as const };
            },
            now: () => 2_000,
        });

        const result = await routes.execute({
            requestId: 'request-terminate',
            target: { kind: 'inventory_entry', inventoryEntryId: 'entry-a', machineId: 'machine-a' },
            action: 'terminate_detected',
            confirmationNonce: 'confirm-a',
            force: false,
        });

        expect(result).toMatchObject({ status: 'denied', reasonCode: 'confirmation_nonce_invalid' });
        expect(executed).toBe(false);
    });
});
