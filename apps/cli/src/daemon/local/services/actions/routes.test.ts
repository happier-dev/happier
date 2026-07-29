import { describe, expect, it } from 'vitest';

import { createLocalServiceActionRoutes } from './routes';
import { createLocalServiceInventoryRegistry } from '../inventory/registry';
import { createManagedLocalServiceRegistry } from '../managed/registry';
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
        processOwnershipConfidence: 'medium',
        workspaceAssociationConfidence: 'high',
        diagnostics: [],
    }],
};

describe('createLocalServiceActionRoutes', () => {
    it('executes forget by hiding the canonical inventory target and future matching snapshots', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        const managedRegistry = createManagedLocalServiceRegistry();
        inventoryRegistry.replaceSnapshot(inventorySnapshot);
        const routes = createLocalServiceActionRoutes({
            machineId: 'machine-a',
            inventoryRegistry,
            managedRegistry,
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

    it('resolves managed targets through the registry and denies stop execution until a stop executor exists', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        const managedRegistry = createManagedLocalServiceRegistry();
        managedRegistry.startDetectAfterLaunch({
            id: 'plugin-a:web',
            owner: { kind: 'plugin', pluginId: 'plugin-a' },
            minimumConfidence: 'medium',
            process: { pid: 300, startedAt: 1_000 },
            routeName: 'plugin-a-web',
        });
        const routes = createLocalServiceActionRoutes({
            machineId: 'machine-a',
            inventoryRegistry,
            managedRegistry,
            now: () => 2_000,
        });

        const result = await routes.execute({
            requestId: 'request-a',
            target: { kind: 'managed_service', managedServiceId: 'plugin-a:web', machineId: 'machine-a' },
            action: 'stop_managed',
            confirmationNonce: 'confirm-a',
            force: false,
        });

        expect(result).toMatchObject({
            v: 1,
            requestId: 'request-a',
            action: 'stop_managed',
            status: 'denied',
            reasonCode: 'managed_stop_unavailable',
        });
        expect(result.auditEvents.map((event: (typeof result.auditEvents)[number]) => [event.result, event.reasonCode])).toEqual([
            ['requested', undefined],
            ['denied', 'managed_stop_unavailable'],
        ]);
        expect(managedRegistry.getService('plugin-a:web')).not.toBeNull();
    });

    it('requires confirmation before executing managed stop', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        const managedRegistry = createManagedLocalServiceRegistry();
        managedRegistry.startDetectAfterLaunch({
            id: 'plugin-a:web',
            owner: { kind: 'plugin', pluginId: 'plugin-a' },
            minimumConfidence: 'medium',
            process: { pid: 300, startedAt: 1_000 },
            routeName: 'plugin-a-web',
        });
        const routes = createLocalServiceActionRoutes({
            machineId: 'machine-a',
            inventoryRegistry,
            managedRegistry,
            managedStopEnabled: () => true,
            now: () => 2_000,
        });

        const result = await routes.execute({
            requestId: 'request-stop',
            target: { kind: 'managed_service', managedServiceId: 'plugin-a:web', machineId: 'machine-a' },
            action: 'stop_managed',
            force: false,
        });

        expect(result).toMatchObject({
            v: 1,
            requestId: 'request-stop',
            action: 'stop_managed',
            status: 'denied',
            reasonCode: 'confirmation_required',
        });
        expect(managedRegistry.getService('plugin-a:web')).not.toBeNull();
    });

    it('rejects managed stop when the confirmation nonce verifier denies the request', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        const managedRegistry = createManagedLocalServiceRegistry();
        managedRegistry.startDetectAfterLaunch({
            id: 'plugin-a:web',
            owner: { kind: 'plugin', pluginId: 'plugin-a' },
            minimumConfidence: 'medium',
            process: { pid: 300, startedAt: 1_000 },
            routeName: 'plugin-a-web',
        });
        const routes = createLocalServiceActionRoutes({
            machineId: 'machine-a',
            inventoryRegistry,
            managedRegistry,
            managedStopEnabled: () => true,
            verifyConfirmationNonce: () => false,
            now: () => 2_000,
        });

        const result = await routes.execute({
            requestId: 'request-stop',
            target: { kind: 'managed_service', managedServiceId: 'plugin-a:web', machineId: 'machine-a' },
            action: 'stop_managed',
            confirmationNonce: 'confirm-a',
            force: false,
        });

        expect(result).toMatchObject({
            v: 1,
            requestId: 'request-stop',
            action: 'stop_managed',
            status: 'denied',
            reasonCode: 'confirmation_nonce_invalid',
        });
        expect(managedRegistry.getService('plugin-a:web')).not.toBeNull();
    });

    it('does not execute managed stop without a concrete stop owner even when enabled and confirmed', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        const managedRegistry = createManagedLocalServiceRegistry();
        managedRegistry.startDetectAfterLaunch({
            id: 'plugin-a:web',
            owner: { kind: 'plugin', pluginId: 'plugin-a' },
            minimumConfidence: 'medium',
            process: { pid: 300, startedAt: 1_000 },
            routeName: 'plugin-a-web',
        });
        const routes = createLocalServiceActionRoutes({
            machineId: 'machine-a',
            inventoryRegistry,
            managedRegistry,
            managedStopEnabled: () => true,
            verifyConfirmationNonce: () => true,
            now: () => 2_000,
        });

        const result = await routes.execute({
            requestId: 'request-stop',
            target: { kind: 'managed_service', managedServiceId: 'plugin-a:web', machineId: 'machine-a' },
            action: 'stop_managed',
            confirmationNonce: 'confirm-a',
            force: false,
        });

        expect(result).toMatchObject({
            v: 1,
            requestId: 'request-stop',
            action: 'stop_managed',
            status: 'denied',
            reasonCode: 'managed_stop_executor_unavailable',
        });
        expect(result.auditEvents.map((event: (typeof result.auditEvents)[number]) => [event.result, event.reasonCode])).toEqual([
            ['requested', undefined],
            ['confirmed', undefined],
            ['denied', 'managed_stop_executor_unavailable'],
        ]);
        expect(managedRegistry.getService('plugin-a:web')).not.toBeNull();
    });

    it('returns an audited failure when the managed stop owner throws', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        const managedRegistry = createManagedLocalServiceRegistry();
        managedRegistry.startDetectAfterLaunch({
            id: 'plugin-a:web',
            owner: { kind: 'plugin', pluginId: 'plugin-a' },
            minimumConfidence: 'medium',
            process: { pid: 300, startedAt: 1_000 },
            routeName: 'plugin-a-web',
        });
        const routes = createLocalServiceActionRoutes({
            machineId: 'machine-a',
            inventoryRegistry,
            managedRegistry,
            managedStopEnabled: () => true,
            verifyConfirmationNonce: () => true,
            stopManagedService: () => {
                throw new Error('dispose failed');
            },
            now: () => 2_000,
        });

        const result = await routes.execute({
            requestId: 'request-stop',
            target: { kind: 'managed_service', managedServiceId: 'plugin-a:web', machineId: 'machine-a' },
            action: 'stop_managed',
            confirmationNonce: 'confirm-a',
            force: false,
        });

        expect(result).toMatchObject({
            v: 1,
            requestId: 'request-stop',
            action: 'stop_managed',
            status: 'failed',
            reasonCode: 'managed_stop_executor_failed',
        });
        expect(result.auditEvents.map((event: (typeof result.auditEvents)[number]) => [event.result, event.reasonCode])).toEqual([
            ['requested', undefined],
            ['confirmed', undefined],
            ['failed', 'managed_stop_executor_failed'],
        ]);
        expect(managedRegistry.getService('plugin-a:web')).not.toBeNull();
    });

    it('executes confirmed managed stop through the registry and verifies removal', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        const managedRegistry = createManagedLocalServiceRegistry();
        managedRegistry.startDetectAfterLaunch({
            id: 'plugin-a:web',
            owner: { kind: 'plugin', pluginId: 'plugin-a' },
            minimumConfidence: 'medium',
            process: { pid: 300, startedAt: 1_000 },
            routeName: 'plugin-a-web',
        });
        const routes = createLocalServiceActionRoutes({
            machineId: 'machine-a',
            inventoryRegistry,
            managedRegistry,
            managedStopEnabled: () => true,
            verifyConfirmationNonce: () => true,
            stopManagedService: ({ service }) => (
                managedRegistry.stopIntentional(service.id).ok
                    ? { status: 'succeeded' }
                    : { status: 'denied', reasonCode: 'unknown_managed_service' }
            ),
            now: () => 2_000,
        });

        const result = await routes.execute({
            requestId: 'request-stop',
            target: { kind: 'managed_service', managedServiceId: 'plugin-a:web', machineId: 'machine-a' },
            action: 'stop_managed',
            confirmationNonce: 'confirm-a',
            force: false,
        });

        expect(result).toMatchObject({
            v: 1,
            requestId: 'request-stop',
            action: 'stop_managed',
            status: 'succeeded',
        });
        expect(result.auditEvents.map((event: (typeof result.auditEvents)[number]) => event.result)).toEqual([
            'requested',
            'confirmed',
            'succeeded',
        ]);
        expect(managedRegistry.getService('plugin-a:web')).toBeNull();
    });

    it('fails managed stop when the stop owner does not remove the service', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        const managedRegistry = createManagedLocalServiceRegistry();
        managedRegistry.startDetectAfterLaunch({
            id: 'plugin-a:web',
            owner: { kind: 'plugin', pluginId: 'plugin-a' },
            minimumConfidence: 'medium',
            process: { pid: 300, startedAt: 1_000 },
            routeName: 'plugin-a-web',
        });
        const routes = createLocalServiceActionRoutes({
            machineId: 'machine-a',
            inventoryRegistry,
            managedRegistry,
            managedStopEnabled: () => true,
            verifyConfirmationNonce: () => true,
            stopManagedService: () => ({ status: 'succeeded' }),
            now: () => 2_000,
        });

        const result = await routes.execute({
            requestId: 'request-stop',
            target: { kind: 'managed_service', managedServiceId: 'plugin-a:web', machineId: 'machine-a' },
            action: 'stop_managed',
            confirmationNonce: 'confirm-a',
            force: false,
        });

        expect(result).toMatchObject({
            v: 1,
            requestId: 'request-stop',
            action: 'stop_managed',
            status: 'failed',
            reasonCode: 'managed_stop_verification_failed',
        });
        expect(result.auditEvents.map((event: (typeof result.auditEvents)[number]) => [event.result, event.reasonCode])).toEqual([
            ['requested', undefined],
            ['confirmed', undefined],
            ['failed', 'managed_stop_verification_failed'],
        ]);
        expect(managedRegistry.getService('plugin-a:web')).not.toBeNull();
    });

    it('routes confirmed managed restart through the canonical fail-closed restart owner', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        const managedRegistry = createManagedLocalServiceRegistry();
        managedRegistry.startDetectAfterLaunch({
            id: 'plugin-a:web',
            owner: { kind: 'plugin', pluginId: 'plugin-a' },
            minimumConfidence: 'medium',
            process: { pid: 300, startedAt: 1_000 },
            routeName: 'plugin-a-web',
        });
        const routes = createLocalServiceActionRoutes({
            machineId: 'machine-a',
            inventoryRegistry,
            managedRegistry,
            managedRestartEnabled: () => true,
            verifyConfirmationNonce: () => true,
            now: () => 2_000,
        });

        const result = await routes.execute({
            requestId: 'request-restart',
            target: { kind: 'managed_service', managedServiceId: 'plugin-a:web', machineId: 'machine-a' },
            action: 'restart_managed',
            confirmationNonce: 'confirm-a',
            force: false,
        });

        expect(result).toMatchObject({
            v: 1,
            requestId: 'request-restart',
            action: 'restart_managed',
            status: 'denied',
            reasonCode: 'restart_not_configured',
        });
        expect(result.auditEvents.map((event: (typeof result.auditEvents)[number]) => [event.result, event.reasonCode])).toEqual([
            ['requested', undefined],
            ['confirmed', undefined],
            ['denied', 'restart_not_configured'],
        ]);
        expect(managedRegistry.getService('plugin-a:web')).not.toBeNull();
    });

    it('returns an audited failure when the managed restart owner throws', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        const managedRegistry = createManagedLocalServiceRegistry();
        managedRegistry.startDetectAfterLaunch({
            id: 'plugin-a:web',
            owner: { kind: 'plugin', pluginId: 'plugin-a' },
            minimumConfidence: 'medium',
            process: { pid: 300, startedAt: 1_000 },
            routeName: 'plugin-a-web',
        });
        const routes = createLocalServiceActionRoutes({
            machineId: 'machine-a',
            inventoryRegistry,
            managedRegistry,
            managedRestartEnabled: () => true,
            verifyConfirmationNonce: () => true,
            restartManagedService: () => {
                throw new Error('restart failed');
            },
            now: () => 2_000,
        });

        const result = await routes.execute({
            requestId: 'request-restart',
            target: { kind: 'managed_service', managedServiceId: 'plugin-a:web', machineId: 'machine-a' },
            action: 'restart_managed',
            confirmationNonce: 'confirm-a',
            force: false,
        });

        expect(result).toMatchObject({
            v: 1,
            requestId: 'request-restart',
            action: 'restart_managed',
            status: 'failed',
            reasonCode: 'managed_restart_executor_failed',
        });
        expect(result.auditEvents.map((event: (typeof result.auditEvents)[number]) => [event.result, event.reasonCode])).toEqual([
            ['requested', undefined],
            ['confirmed', undefined],
            ['failed', 'managed_restart_executor_failed'],
        ]);
        expect(managedRegistry.getService('plugin-a:web')).not.toBeNull();
    });

    it('executes confirmed managed restart through the injected restart owner', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        const managedRegistry = createManagedLocalServiceRegistry();
        managedRegistry.startDetectAfterLaunch({
            id: 'plugin-a:web',
            owner: { kind: 'plugin', pluginId: 'plugin-a' },
            minimumConfidence: 'medium',
            process: { pid: 300, startedAt: 1_000 },
            routeName: 'plugin-a-web',
        });
        const routes = createLocalServiceActionRoutes({
            machineId: 'machine-a',
            inventoryRegistry,
            managedRegistry,
            managedRestartEnabled: (service) => service.id === 'plugin-a:web',
            verifyConfirmationNonce: () => true,
            restartManagedService: ({ service }) => {
                expect(service.id).toBe('plugin-a:web');
                return { status: 'succeeded' };
            },
            now: () => 2_000,
        });

        const result = await routes.execute({
            requestId: 'request-restart',
            target: { kind: 'managed_service', managedServiceId: 'plugin-a:web', machineId: 'machine-a' },
            action: 'restart_managed',
            confirmationNonce: 'confirm-a',
            force: false,
        });

        expect(result).toMatchObject({
            v: 1,
            requestId: 'request-restart',
            action: 'restart_managed',
            status: 'succeeded',
        });
        expect(result.auditEvents.map((event: (typeof result.auditEvents)[number]) => event.result)).toEqual([
            'requested',
            'confirmed',
            'succeeded',
        ]);
    });

    it('denies managed targets for a different machine before evaluating action policy', async () => {
        const inventoryRegistry = createLocalServiceInventoryRegistry();
        const managedRegistry = createManagedLocalServiceRegistry();
        managedRegistry.startDetectAfterLaunch({
            id: 'plugin-a:web',
            owner: { kind: 'plugin', pluginId: 'plugin-a' },
            minimumConfidence: 'medium',
            process: { pid: 300, startedAt: 1_000 },
            routeName: 'plugin-a-web',
        });
        const routes = createLocalServiceActionRoutes({
            machineId: 'machine-a',
            inventoryRegistry,
            managedRegistry,
            managedStopEnabled: () => true,
            now: () => 2_000,
        });

        const result = await routes.execute({
            requestId: 'request-a',
            target: { kind: 'managed_service', managedServiceId: 'plugin-a:web', machineId: 'machine-b' },
            action: 'stop_managed',
            confirmationNonce: 'confirm-a',
            force: false,
        });

        expect(result).toMatchObject({
            v: 1,
            requestId: 'request-a',
            action: 'stop_managed',
            status: 'denied',
            reasonCode: 'wrong_machine',
        });
        expect(result.auditEvents.map((event: (typeof result.auditEvents)[number]) => [event.result, event.reasonCode])).toEqual([
            ['requested', undefined],
            ['denied', 'wrong_machine'],
        ]);
        expect(managedRegistry.getService('plugin-a:web')).not.toBeNull();
    });
});
