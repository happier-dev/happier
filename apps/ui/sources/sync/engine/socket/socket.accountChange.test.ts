import { describe, expect, it, vi } from 'vitest';

import type { ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import { handleUpdateContainer } from './socket';

function buildBaseParams(overrides: Partial<Omit<Parameters<typeof handleUpdateContainer>[0], 'updateData'>> = {}) {
    return {
        encryption: {
            getSessionEncryption: () => null,
            getMachineEncryption: () => null,
            removeSessionEncryption: () => {},
        } as unknown as Parameters<typeof handleUpdateContainer>[0]['encryption'],
        artifactDataKeys: new Map(),
        applySessions: vi.fn(),
        fetchSessions: vi.fn(),
        applyMessages: vi.fn(),
        onSessionVisible: vi.fn(),
        isSessionMessagesLoaded: vi.fn(() => false),
        getSessionMaterializedMaxSeq: vi.fn(() => 0),
        markSessionMaterializedMaxSeq: vi.fn(),
        onMessageGapDetected: vi.fn(),
        assumeUsers: vi.fn(async () => {}),
        applyTodoSocketUpdates: vi.fn(async () => {}),
        invalidateMachines: vi.fn(),
        invalidateSessions: vi.fn(),
        invalidateArtifacts: vi.fn(),
        invalidateFriends: vi.fn(),
        invalidateFriendRequests: vi.fn(),
        invalidateFeed: vi.fn(),
        invalidateAutomations: vi.fn(),
        invalidateTodos: vi.fn(),
        log: { log: vi.fn() },
        ...overrides,
    };
}

describe('socket AccountChange wake', () => {
    it('requests the canonical AccountChange catch-up without interpreting wake content', async () => {
        const onAccountChangeWake = vi.fn();
        const params = buildBaseParams();
        const updateData: ApiUpdateContainer = {
            id: 'u_account_change',
            seq: 9,
            createdAt: 1,
            body: { t: 'account-change' },
        } as ApiUpdateContainer;

        await handleUpdateContainer({
            ...params,
            updateData,
            onAccountChangeWake,
        });

        expect(onAccountChangeWake).toHaveBeenCalledTimes(1);
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect(params.invalidateMachines).not.toHaveBeenCalled();
        expect(params.invalidateArtifacts).not.toHaveBeenCalled();
        expect(params.invalidateAutomations).not.toHaveBeenCalled();
    });
});
