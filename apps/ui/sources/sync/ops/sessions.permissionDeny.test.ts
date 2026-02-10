import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';

const { mockSessionRPC } = vi.hoisted(() => ({
    mockSessionRPC: vi.fn(),
}));

vi.mock('../api/session/apiSocket', () => ({
    apiSocket: {
        sessionRPC: mockSessionRPC,
    },
}));

// sessions.ts imports sync, which pulls native modules in node/vitest.
vi.mock('../sync', () => ({
    sync: {
        encryption: {
            getSessionEncryption: () => null,
            getMachineEncryption: () => null,
        },
    },
}));

import { sessionDeny } from './sessions';

const initialStorageState = storage.getState();

function buildSession(sessionId: string): Session {
    return {
        id: sessionId,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: true,
        thinkingAt: 1,
        presence: 'online',
    };
}

describe('sessionDeny', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        mockSessionRPC.mockReset();
    });

    it('clears local thinking state after a deny/abort permission decision', async () => {
        const sessionId = 's_permission_deny';
        storage.getState().applySessions([buildSession(sessionId)]);
        storage.getState().markSessionOptimisticThinking(sessionId);
        mockSessionRPC.mockResolvedValue(undefined);

        await sessionDeny(sessionId, 'perm_1', undefined, undefined, 'abort');

        const session = storage.getState().sessions[sessionId];
        expect(session?.thinking).toBe(false);
        expect(session?.optimisticThinkingAt ?? null).toBeNull();
        expect(mockSessionRPC).toHaveBeenCalledWith(
            sessionId,
            'permission',
            expect.objectContaining({ id: 'perm_1', approved: false, decision: 'abort' }),
        );
    });
});
