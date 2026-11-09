import type { Machine } from '@/sync/domains/state/storageTypes';
import { buildDemoMachineReadings } from './machineReadings';

import { DEMO_HOME_DIR, DEMO_MACHINE_ID, DEMO_NOW_MS, DEMO_SECONDARY_MACHINE_ID } from './constants';

export type CreateDemoMachineFixtureOptions = Partial<Machine>;

function createDemoMachine(params: Readonly<{
    id: string;
    host: string;
    displayName: string;
    platform: string;
    updatedAt: number;
}>): Machine {
    return {
        id: params.id,
        seq: params.updatedAt,
        createdAt: params.updatedAt - 86_400_000,
        updatedAt: params.updatedAt,
        active: true,
        activeAt: params.updatedAt,
        presenceProtocolVersion: 1,
        availability: { kind: 'available' },
        metadata: {
            host: params.host,
            platform: params.platform,
            happyCliVersion: '1.0.0-demo',
            happyHomeDir: `${DEMO_HOME_DIR}/.happy`,
            homeDir: DEMO_HOME_DIR,
            username: 'happier',
            displayName: params.displayName,
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
    };
}

export function buildDemoMachines(readings = buildDemoMachineReadings()): Machine[] {
    return [
        createDemoMachine({
            id: DEMO_MACHINE_ID,
            host: 'macbook-pro',
            displayName: 'MacBook Pro',
            platform: 'darwin',
            updatedAt: DEMO_NOW_MS - 5_000,
        }),
        createDemoMachine({
            id: DEMO_SECONDARY_MACHINE_ID,
            host: 'mac-studio',
            displayName: 'Mac Studio',
            platform: 'darwin',
            updatedAt: DEMO_NOW_MS - 120_000,
        }),
    ].map(machine => ({ ...machine, daemonState: { resources: {
        v: 1, host: readings[machine.id]!.host,
        attention: readings[machine.id]!.vitals.attention,
        vitals: { state: 'reporting' },
        guard: readings[machine.id]!.guard.state,
    } } }));
}

export function createDemoMachineFixture(options: CreateDemoMachineFixtureOptions = {}): Machine {
    const base = buildDemoMachines()[0]!;
    const { metadata: metadataOverrides, ...machineOverrides } = options;
    return {
        ...base,
        ...machineOverrides,
        metadata: {
            ...base.metadata!,
            ...(metadataOverrides ?? {}),
        },
    };
}
