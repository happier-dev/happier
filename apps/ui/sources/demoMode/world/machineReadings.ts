import { MachineVitalsSnapshotV1Schema } from '@happier-dev/protocol/machines/vitals/machineVitalsRpcV1';
import { MachineVitalsHostFactsV1Schema } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import { MachineGuardViewV1Schema } from '@happier-dev/protocol/machines/guard/guardRpcV1';
import { MachineGuardActivityListV1Schema } from '@happier-dev/protocol/machines/guard/activityV1';
import { HappierStorageSummaryV1Schema } from '@happier-dev/protocol/storage/storageV1';
import { ManagedMachinePresetV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';

import { DEMO_MACHINE_ID, DEMO_NOW_MS, DEMO_SECONDARY_MACHINE_ID } from './constants';

const GiB = 1024 ** 3;

/** Static daemon read answers for the local demo: no RPC demand or credential admission. */
export function buildDemoMachineReadings() {
    return Object.fromEntries([
        [DEMO_MACHINE_ID, 12, 36, 1024, 612, 24],
        [DEMO_SECONDARY_MACHINE_ID, 24, 64, 2048, 1380, 38],
    ].map(([id, cores, memory, disk, free, cpu]) => {
        const host = MachineVitalsHostFactsV1Schema.parse({ logicalCores: cores, memoryTotalBytes: Number(memory) * GiB,
            bootedAt: DEMO_NOW_MS - 3 * 86_400_000 });
        const totalBytes = Number(disk) * GiB;
        const freeBytes = Number(free) * GiB;
        const memoryAvailable = Math.round(Number(memory) * 0.6 * GiB);
        const vitals = MachineVitalsSnapshotV1Schema.parse({ state: 'reporting',
            attention: { level: 'calm', reasons: [] },
            sample: { v: 1, sampledAt: DEMO_NOW_MS, intervalMs: 15_000,
                cpu: { reported: true, busyPct: cpu, load1: 2.14 },
                memory: { reported: true, totalBytes: host.memoryTotalBytes, availableBytes: memoryAvailable,
                    usedBytes: host.memoryTotalBytes - memoryAvailable, pressure: { level: 'calm', source: 'kernel_level' } },
                disk: { reported: true, homeVolumeId: 'data', volumes: [{ id: 'data', label: 'Macintosh HD', mount: '/',
                    totalBytes, availableBytes: freeBytes }] },
                network: { reported: true, rxBps: 184_320, txBps: 32_768 },
                power: { onAC: true }, thermal: { state: 'nominal' } },
            series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] } });
        const guard = MachineGuardViewV1Schema.parse({
            policy: { memoryGuard: { enabled: true }, idleSessions: { enabled: true }, idleTerminals: { enabled: true },
                leftBehind: { mode: 'ask' }, keepAwake: 'on_power' }, policyRevision: 1,
            state: { v: 1, capabilities: { memoryPressure: { status: 'available' },
                ceiling: { status: 'unavailable', reason: 'not_linux' }, keepAwake: { modes: ['off', 'on', 'on_power'] } },
                keepAwakeHolding: true },
            ladder: { steps: [], excluded: [], summary: { candidatesBytes: 0, inUseBytes: 0,
                workingBytes: 4 * GiB, workingSessions: 2, notHappiersBytes: 0, leftAloneSessions: 0 } },
            othersWorkCount: 0, idle: [], idleTerminals: [], leftBehind: { count: 0, footprintBytes: 0 },
            keepAwake: { holding: true, workingSessions: 2 }, recentActivity: [], recentActivityOthers: 0,
        });
        const storage = HappierStorageSummaryV1Schema.parse({ revision: 1, sizedAt: DEMO_NOW_MS,
            volumes: [{ volume: { volumeId: 'data', mountPath: '/', label: 'Macintosh HD' }, totalBytes, freeBytes,
                happierBytes: 8 * GiB, pileBytes: 0, trashBytes: 0, canGoBytes: 0 }],
            categories: [], suggestionsTop: [], suggestionsSafeTop: [], suggestionsSafeTotalCount: 0, suggestionsSafeFreesBytes: 0,
            pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] }, trash: { count: 0, allocatedBytes: 0 },
            wholeDisk: { enabled: true, scans: [] } });
        const activity = MachineGuardActivityListV1Schema.parse({ entries: [{ v: 1, id: `housekeeping-${id}`,
            at: DEMO_NOW_MS - 42 * 60_000, kind: 'housekeeping', rule: 'housekeeping',
            subject: { kind: 'housekeeping', logs: 12, recordings: 0, trashEntries: 0 },
            outcome: 'done', freedBytes: 84 * 1024 ** 2, attribution: { kind: 'unknown' } }],
            counts: { stopped: 0, cleanedUp: 1, needsLook: 0, others: 0 }, asOf: DEMO_NOW_MS });
        return [String(id), { host, vitals, guard, storage, activity }] as const;
    }));
}

export function buildDemoMachinePresets() {
    return ['Daily development', 'Clean review workspace'].map((name, index) => ManagedMachinePresetV1Schema.parse({
        id: `demo-setup-${index}`, homeId: 'demo-home', revision: 1, name,
        owner: { kind: 'account', accountId: 'demo-home' },
        setup: { scripts: [{ body: index === 0 ? 'git config pull.rebase true' : 'git config diff.algorithm histogram', affects: 'none' }] },
    }));
}

