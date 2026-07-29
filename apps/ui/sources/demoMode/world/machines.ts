import type { Machine } from '@/sync/domains/state/storageTypes';

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
        active: false,
        activeAt: params.updatedAt - 86_400_000,
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

export function buildDemoMachines(): Machine[] {
    return [
        createDemoMachine({
            id: DEMO_MACHINE_ID,
            host: 'macbook-pro.local',
            displayName: 'MacBook Pro',
            platform: 'darwin',
            updatedAt: DEMO_NOW_MS - 5_000,
        }),
        createDemoMachine({
            id: DEMO_SECONDARY_MACHINE_ID,
            host: 'studio.local',
            displayName: 'Studio',
            platform: 'darwin',
            updatedAt: DEMO_NOW_MS - 120_000,
        }),
    ];
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
