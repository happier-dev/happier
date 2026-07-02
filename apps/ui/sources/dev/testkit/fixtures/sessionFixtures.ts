import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

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

export function createSessionListRenderableSessionFixture(
    overrides: Partial<SessionListRenderableSession> = {},
): SessionListRenderableSession {
    const createdAt = overrides.createdAt ?? 1;
    const updatedAt = overrides.updatedAt ?? createdAt;
    const activeAt = overrides.activeAt ?? updatedAt;

    return {
        id: 'session-1',
        seq: 1,
        createdAt,
        updatedAt,
        active: false,
        activeAt,
        archivedAt: null,
        pendingVersion: undefined,
        pendingCount: undefined,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: {
            path: '/Users/tester/project',
            host: 'tester.local',
            homeDir: '/Users/tester',
            machineId: 'machine-1',
        },
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        optimisticThinkingAt: null,
        thinkingGraceUntil: null,
        hasPendingPermissionRequests: false,
        hasPendingUserActionRequests: false,
        pendingRequestObservedAt: null,
        hasUnreadMessages: false,
        keepVisibleWhenInactive: false,
        ...overrides,
    };
}
