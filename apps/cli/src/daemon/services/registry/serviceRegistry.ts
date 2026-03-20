import { deriveManagedServiceHealth, type ManagedServiceHealth } from '../core/managedServiceHealth';
import type {
    ManagedServiceLifecycleState,
    ManagedServiceRestartDecision,
    ManagedServiceRestartPolicy,
} from '../core/managedServiceTypes';

export type ManagedServiceDescriptor = Readonly<{
    serviceId: string;
    displayName: string;
    restartPolicy: ManagedServiceRestartPolicy;
}>;

export type ManagedServiceRegistryStatus = Readonly<{
    serviceId: string;
    lifecycleState: ManagedServiceLifecycleState;
    updatedAtMs: number;
    lastRestartDecision?: ManagedServiceRestartDecision;
}>;

export type ManagedServiceRegistryEntry = Readonly<{
    descriptor: ManagedServiceDescriptor;
    status: ManagedServiceRegistryStatus;
    health: ManagedServiceHealth;
}>;

export type ManagedServiceRegistry = Readonly<{
    serviceIds: readonly string[];
    entriesByServiceId: Readonly<Record<string, ManagedServiceRegistryEntry>>;
}>;

function createStoppedStatus(serviceId: string): ManagedServiceRegistryStatus {
    return {
        serviceId,
        lifecycleState: 'stopped',
        updatedAtMs: 0,
    };
}

function createRegistryEntry(
    descriptor: ManagedServiceDescriptor,
    status: ManagedServiceRegistryStatus,
): ManagedServiceRegistryEntry {
    return {
        descriptor,
        status,
        health: deriveManagedServiceHealth({
            lifecycleState: status.lifecycleState,
            lastRestartDecision: status.lastRestartDecision,
        }),
    };
}

export function createManagedServiceRegistry(
    descriptors: readonly ManagedServiceDescriptor[],
): ManagedServiceRegistry {
    const serviceIds: string[] = [];
    const entriesByServiceId: Record<string, ManagedServiceRegistryEntry> = {};

    for (const descriptor of descriptors) {
        if (entriesByServiceId[descriptor.serviceId] !== undefined) {
            throw new Error(`Duplicate managed service descriptor: ${descriptor.serviceId}`);
        }

        serviceIds.push(descriptor.serviceId);
        entriesByServiceId[descriptor.serviceId] = createRegistryEntry(
            descriptor,
            createStoppedStatus(descriptor.serviceId),
        );
    }

    return {
        serviceIds,
        entriesByServiceId,
    };
}

export function applyManagedServiceRegistryStatus(params: Readonly<{
    registry: ManagedServiceRegistry;
    status: ManagedServiceRegistryStatus;
}>): ManagedServiceRegistry {
    const currentEntry = params.registry.entriesByServiceId[params.status.serviceId];

    if (currentEntry === undefined) {
        throw new Error(`Unknown managed service: ${params.status.serviceId}`);
    }

    return {
        serviceIds: params.registry.serviceIds,
        entriesByServiceId: {
            ...params.registry.entriesByServiceId,
            [params.status.serviceId]: createRegistryEntry(currentEntry.descriptor, params.status),
        },
    };
}

export function listManagedServiceRegistryEntries(
    registry: ManagedServiceRegistry,
): readonly ManagedServiceRegistryEntry[] {
    return registry.serviceIds.map((serviceId) => registry.entriesByServiceId[serviceId]);
}
