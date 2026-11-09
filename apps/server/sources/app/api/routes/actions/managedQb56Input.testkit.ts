import { ManagedAcquireInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';

// Credential-free capture: impl-C/qa-shots5/qb56/{attempt,prepared}.json,
// 2026-10-18T04:52:56.574Z. Preserve the captured choices and request correlation.
// The current admission fixture explicitly reviews a sandbox identity.
export const managedQb56RequestId = '887f79a3-8bf6-4152-a141-312b294b1b23';
const controller = { machineId: '8af4e544-25b4-4d2a-a5e2-5cf759e40b46',
    installationId: '204630bf-252c-4541-b841-2413b155c606' };
const launch = { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1,
    name: 'happier-qb56-defaults', choices: { instance: 'happier-qb56-defaults', store: '/home/happier/.lima',
        image: 'https://cloud-images.ubuntu.com/releases/noble/release-20260926/ubuntu-24.04-server-cloudimg-amd64.img',
        arch: 'x86_64', vmType: 'qemu', cpus: 1, memoryGiB: 1, diskGiB: 4, mounts: [] } };
const retention = { kind: 'unused', afterMs: 3_600_000, effect: 'stop' };
const parsed = ManagedAcquireInputV1Schema.parse({
    enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
    selection: { kind: 'one-off', homeId: 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN', controller, launch,
        retention, wakeOnAcceptedMessage: true },
    reviewedFacts: { launch, controller, optionStatus: 'current', billing: { location: 'local', stoppedBilling: 'not-billed' },
        nativeFacts: { size: { id: '1/1/4', title: 'happier-qb56-defaults', cpuCores: 1,
            memoryBytes: 1_073_741_824, diskBytes: 4_294_967_296 },
            image: { id: launch.choices.image, title: 'ubuntu-24.04-server-cloudimg-amd64.img', description: 'cloud-images.ubuntu.com' } },
        prerequisites: ['qemu-x86-64', 'qemu-img'].map(localId => ({ requirement: { kind: 'managedDependency',
            id: { pluginId: 'happier.machine.lima', localId } }, status: 'available' })),
        retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] }, retention, wakeOnAcceptedMessage: true },
});
if (parsed.selection.kind !== 'one-off') throw new Error('QB56 capture must retain its one-off selection');
export const managedQb56Input = { ...parsed, selection: parsed.selection };
