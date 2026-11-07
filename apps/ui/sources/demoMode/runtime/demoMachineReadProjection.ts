import { projectMachineResourceSummaryV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import type { MachineResourceState } from '@/sync/domains/machines/resources/machineResourceStore';
import type { MachineGuardViewState, MachineGuardActivityState } from '@/sync/domains/machines/guard/machineGuardStore';
import type { MachineStorageState } from '@/sync/domains/machines/storage/machineStorageStore';
import type { DemoWorld } from '../world/buildDemoWorld';
import { isSeededDemoHome } from './enterExitDemoMode';

type MachineRead = Readonly<{ resources: MachineResourceState; guard: MachineGuardViewState;
    storage: MachineStorageState; activity: MachineGuardActivityState }>;
type ReadKey = Readonly<{ serverId?: string | null; machineId: string; expectedAccountId?: string | null }>;
let machines: Readonly<Record<string, MachineRead>> = {};
let presets: DemoWorld['machinePresets'] | null = null;

/** Presentation-only read answers. Real Account-bound reads never consume them. */
export function getDemoMachineRead(input: ReadKey): MachineRead | null {
    return input.serverId && !input.expectedAccountId && isSeededDemoHome(input.serverId) ? machines[input.machineId] ?? null : null;
}

export function getDemoMachinePresets(serverId: string) {
    return isSeededDemoHome(serverId) ? presets : null;
}

export function setDemoMachineReadProjection(world: DemoWorld | null): void {
    presets = world?.machinePresets ?? null;
    machines = Object.fromEntries(Object.entries(world?.machineReadings ?? {}).map(([id, reading]) => [id, {
        resources: { status: 'ready', snapshot: reading.vitals, host: reading.host,
            summary: projectMachineResourceSummaryV1(reading.vitals, reading.host), stale: false,
            samples: reading.vitals.sample ? [reading.vitals.sample] : [] },
        guard: { status: 'ready', view: reading.guard, since: 1, pending: false, receivedAtMs: reading.vitals.sample?.sampledAt ?? null },
        storage: { status: 'ready', summary: reading.storage },
        activity: { status: 'ready', list: reading.activity, since: 1 },
    } satisfies MachineRead]));
}
