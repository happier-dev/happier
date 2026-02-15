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
        artifactDataKeys: new Map<string, Uint8Array>(),
        applySessions: vi.fn(),
        fetchSessions: vi.fn(),
        applyMessages: vi.fn(),
        onSessionVisible: vi.fn(),
        isSessionMessagesLoaded: vi.fn(() => false),
        getSessionMaterializedMaxSeq: vi.fn(() => 0),
        markSessionMaterializedMaxSeq: vi.fn(),
        invalidateMessagesForSession: vi.fn(),
        assumeUsers: vi.fn(async () => {}),
        applyTodoSocketUpdates: vi.fn(async () => {}),
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

describe('socket automation updates', () => {
    it('invalidates automation sync on automation-upsert updates', async () => {
        const params = buildBaseParams();
        const updateData: ApiUpdateContainer = {
            id: 'u_automation',
            seq: 1,
            createdAt: 1,
            body: {
                t: 'automation-upsert',
                automationId: 'a1',
                version: 1,
                enabled: true,
                updatedAt: 1,
            },
        } as ApiUpdateContainer;

        await handleUpdateContainer({
            ...params,
            updateData,
        });

        expect(params.invalidateAutomations).toHaveBeenCalledTimes(1);
        expect(params.invalidateSessions).not.toHaveBeenCalled();
        expect(params.invalidateTodos).not.toHaveBeenCalled();
    });
});
