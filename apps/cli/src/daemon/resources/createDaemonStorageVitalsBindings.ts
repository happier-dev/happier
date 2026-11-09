import type { MachineVitalsSampler } from '../vitals/createMachineVitalsSampler';

/** Storage's projection of the daemon's single machine sampler. */
export function createDaemonStorageVitalsBindings(vitals: Pick<MachineVitalsSampler, 'latest' | 'subscribe'> | null) {
    const readVolumes = () => {
        const disk = vitals?.latest()?.disk;
        return disk?.reported ? disk.volumes : [];
    };
    const readVolumesReported = () => vitals?.latest()?.disk.reported === true;
    const isOnPower = () => vitals?.latest()?.power?.onAC !== false;
    const subscribeProjection = (read: () => string | boolean, listener: () => void) => {
        let previous = read();
        return vitals?.subscribe(() => {
            const next = read();
            if (next === previous) return;
            previous = next;
            listener();
        }) ?? (() => {});
    };
    // Vitals publishes capacity. Storage and maintenance need mount/availability
    // edges to discover returning Trash roots, not changing free-space counters.
    const volumeIdentity = () => JSON.stringify([readVolumesReported(),
        readVolumes().map(volume => [volume.id, volume.mount]).sort()]);
    return {
        readVolumes,
        readVolumesReported,
        subscribeVolumes: (listener: () => void) => subscribeProjection(volumeIdentity, listener),
        isOnPower,
        subscribePower: (listener: () => void) => subscribeProjection(isOnPower, listener),
    };
}
