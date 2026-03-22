import type { Machine } from '@/sync/domains/state/storageTypes';

export function createMachineFixture(overrides: Partial<Machine> = {}): Machine {
    const createdAt = overrides.createdAt ?? 1;
    const updatedAt = overrides.updatedAt ?? createdAt;

    return {
        id: 'machine-1',
        seq: 1,
        createdAt,
        updatedAt,
        active: true,
        activeAt: updatedAt,
        metadata: {
            host: 'tester.local',
            platform: 'darwin',
            happyCliVersion: '0.0.0-test',
            happyHomeDir: '/Users/tester/.happy-dev',
            homeDir: '/Users/tester',
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
        ...overrides,
    };
}

export function createMachineListByServerIdFixture(
    machines: Machine[],
    serverId: string = 'server-a',
): Record<string, Machine[]> {
    return {
        [serverId]: machines,
    };
}
