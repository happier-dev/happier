import type { Session } from '@/sync/domains/state/storageTypes';

export function createSessionFixture(overrides: Partial<Session> = {}): Session {
    const createdAt = overrides.createdAt ?? 1;
    const updatedAt = overrides.updatedAt ?? createdAt;

    return {
        id: 'session-1',
        seq: 1,
        createdAt,
        updatedAt,
        active: false,
        activeAt: updatedAt,
        metadata: {
            path: '/Users/tester/project',
            host: 'tester.local',
            homeDir: '/Users/tester',
            machineId: 'machine-1',
        } as Session['metadata'],
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    };
}
