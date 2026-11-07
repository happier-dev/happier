import { createMachineResourcesPolicyRuntime, type MachineResourcesPolicyRuntime } from '@/daemon/resources/machineResourcesPolicy';

type Availability = 'ready' | 'unavailable' | 'locked';

/**
 * The real Machine resources policy runtime over an in-memory metadata
 * transport (the system boundary). Storage reads policy only through it.
 */
export async function createStoragePolicyFixture(storage: Record<string, unknown> = {}, initial: Availability = 'ready') {
    let metadata: Record<string, unknown> = { resourcesPolicyV1: { v: 1, storage } };
    let metadataVersion = 1;
    let availability: Availability = initial;
    const runtime: MachineResourcesPolicyRuntime = createMachineResourcesPolicyRuntime({ port: {
        read: async () => availability === 'ready' ? { status: 'ready', metadata, metadataVersion } : { status: availability },
        compareAndSwap: async request => {
            if (availability !== 'ready') return { status: availability };
            if (request.expectedMetadataVersion !== metadataVersion) return { status: 'conflict', metadata, metadataVersion };
            metadata = request.metadata; metadataVersion++;
            return { status: 'applied', metadata, metadataVersion };
        },
    } });
    await runtime.reload();
    return Object.assign(runtime, {
        /** Replaces the stored Storage policy and publishes it through the runtime. */
        async setStorage(next: Record<string, unknown>) {
            metadata = { ...metadata, resourcesPolicyV1: { v: 1, storage: next } }; metadataVersion++;
            await runtime.reload();
        },
        async setAvailability(next: Availability) { availability = next; await runtime.reload(); },
    });
}
