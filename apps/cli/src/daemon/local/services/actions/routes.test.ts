import { describe, expect, it } from 'vitest';

import { createLocalServiceActionRoutes } from './routes';
import { createLocalServiceInventoryRegistry } from '../inventory/registry';
import type { NormalizedLocalServiceInventorySnapshot } from '../inventory/scanner';

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
    it('executes forget by hiding the canonical inventory target and future matching snapshots', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        inventoryRegistry.replaceSnapshot(inventorySnapshot);
        const routes = createLocalServiceActionRoutes({
            machineId: 'machine-a',
            inventoryRegistry,
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
