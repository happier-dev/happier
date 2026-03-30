import { describe, expect, it } from 'vitest';

import type { ManagedServiceRestartPolicy } from '../core/managedServiceTypes';

import {
    applyManagedServiceRegistryStatus,
    createManagedServiceRegistry,
    listManagedServiceRegistryEntries,
} from './serviceRegistry';

const DEFAULT_RESTART_POLICY: ManagedServiceRestartPolicy = {
    maxRestartAttempts: 3,
    baseDelayMs: 250,
    maxDelayMs: 5_000,
    jitterMs: 0,
};

describe('serviceRegistry', () => {
    it('creates deterministic registry entries from descriptors', () => {
        const registry = createManagedServiceRegistry([
            {
                serviceId: 'workspace_replication',
                displayName: 'Workspace replication',
                restartPolicy: DEFAULT_RESTART_POLICY,
            },
            {
                serviceId: 'ipc_bridge',
                displayName: 'IPC bridge',
                restartPolicy: DEFAULT_RESTART_POLICY,
            },
        ]);

        expect(registry.serviceIds).toEqual(['workspace_replication', 'ipc_bridge']);
        expect(listManagedServiceRegistryEntries(registry)).toEqual([
            {
                descriptor: {
                    serviceId: 'workspace_replication',
                    displayName: 'Workspace replication',
                    restartPolicy: DEFAULT_RESTART_POLICY,
                },
                status: {
                    serviceId: 'workspace_replication',
                    lifecycleState: 'stopped',
                    updatedAtMs: 0,
                },
                health: {
                    status: 'offline',
                    isDegraded: false,
                    reason: 'stopped',
                },
            },
            {
                descriptor: {
                    serviceId: 'ipc_bridge',
                    displayName: 'IPC bridge',
                    restartPolicy: DEFAULT_RESTART_POLICY,
                },
                status: {
                    serviceId: 'ipc_bridge',
                    lifecycleState: 'stopped',
                    updatedAtMs: 0,
                },
                health: {
                    status: 'offline',
                    isDegraded: false,
                    reason: 'stopped',
                },
            },
        ]);
    });

    it('rejects duplicate service ids during registry creation', () => {
        expect(() =>
            createManagedServiceRegistry([
                {
                    serviceId: 'workspace_replication',
                    displayName: 'Workspace replication',
                    restartPolicy: DEFAULT_RESTART_POLICY,
                },
                {
                    serviceId: 'workspace_replication',
                    displayName: 'Workspace replication duplicate',
                    restartPolicy: DEFAULT_RESTART_POLICY,
                },
            ]),
        ).toThrow('Duplicate managed service descriptor: workspace_replication');
    });

    it('applies status updates and derives health from managed-service state', () => {
        const registry = createManagedServiceRegistry([
            {
                serviceId: 'workspace_replication',
                displayName: 'Workspace replication',
                restartPolicy: DEFAULT_RESTART_POLICY,
            },
        ]);

        const updatedRegistry = applyManagedServiceRegistryStatus({
            registry,
            status: {
                serviceId: 'workspace_replication',
                lifecycleState: 'crashed',
                updatedAtMs: 42,
                lastRestartDecision: {
                    type: 'restart_after_delay',
                    attempt: 2,
                    delayMs: 500,
                },
            },
        });

        expect(listManagedServiceRegistryEntries(updatedRegistry)).toEqual([
            {
                descriptor: {
                    serviceId: 'workspace_replication',
                    displayName: 'Workspace replication',
                    restartPolicy: DEFAULT_RESTART_POLICY,
                },
                status: {
                    serviceId: 'workspace_replication',
                    lifecycleState: 'crashed',
                    updatedAtMs: 42,
                    lastRestartDecision: {
                        type: 'restart_after_delay',
                        attempt: 2,
                        delayMs: 500,
                    },
                },
                health: {
                    status: 'degraded',
                    isDegraded: true,
                    reason: 'restart_scheduled',
                },
            },
        ]);
    });

    it('rejects status updates for unmanaged services', () => {
        const registry = createManagedServiceRegistry([
            {
                serviceId: 'workspace_replication',
                displayName: 'Workspace replication',
                restartPolicy: DEFAULT_RESTART_POLICY,
            },
        ]);

        expect(() =>
            applyManagedServiceRegistryStatus({
                registry,
                status: {
                    serviceId: 'ipc_bridge',
                    lifecycleState: 'running',
                    updatedAtMs: 10,
                },
            }),
        ).toThrow('Unknown managed service: ipc_bridge');
    });
});
