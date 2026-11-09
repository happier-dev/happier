import { describe, expect, it, vi } from 'vitest';

import type { ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import { subscribeSessionPublicLinkInvalidation } from '@/sync/domains/social/sessionPublicLinkInvalidation';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
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
        invalidateFeed: vi.fn(),
        invalidateAutomations: vi.fn(),
        invalidateTodos: vi.fn(),
        log: { log: vi.fn() },
        ...overrides,
    };
}

describe('socket public-link invalidation', () => {
    it.each([
        ['public-share-created', { publicShareId: 'public-share-1', token: 'one-time-secret' }],
        ['public-share-updated', { publicShareId: 'public-share-1' }],
        ['public-share-deleted', {}],
    ] as const)('publishes a secret-free exact-scope wake for durable %s updates', async (type, fields) => {
        const observed = vi.fn();
        const observedHomeChange = vi.fn();
        const unsubscribe = subscribeSessionPublicLinkInvalidation(
            { serverId: 'home-one', sessionId: 'same-session-id' },
            observed,
        );
        const unsubscribeHomeChange = subscribeHomeAccountChange(observedHomeChange);
        const params = buildBaseParams();
        const updateData = {
            id: `update-${type}`,
            seq: 9,
            createdAt: 1,
            body: {
                t: type,
                sessionId: 'same-session-id',
                ...fields,
            },
        } as ApiUpdateContainer;

        try {
            await handleUpdateContainer({
                ...params,
                sourceServerId: 'home-one',
                updateData,
            });
        } finally {
            unsubscribe();
            unsubscribeHomeChange();
        }

        expect(observed).toHaveBeenCalledOnce();
        expect(params.invalidateSessions).toHaveBeenCalledOnce();
        expect(observedHomeChange).toHaveBeenCalledWith({
            serverId: 'home-one',
            entityIds: ['session-public-link:same-session-id'],
            sessionListQueryAffects: false,
            // A wake without typed change kinds conservatively reaches Account settings (c5ffa3b621).
            accountSettingsAffects: true,
        });
        expect(JSON.stringify(observedHomeChange.mock.calls)).not.toContain('one-time-secret');
    });

    it('does not attribute an unqualified socket update to the currently active Home', async () => {
        const observed = vi.fn();
        const unsubscribe = subscribeSessionPublicLinkInvalidation(
            { serverId: 'home-one', sessionId: 'same-session-id' },
            observed,
        );
        const params = buildBaseParams();

        try {
            await handleUpdateContainer({
                ...params,
                updateData: {
                    id: 'update-without-home',
                    seq: 10,
                    createdAt: 1,
                    body: {
                        t: 'public-share-deleted',
                        sessionId: 'same-session-id',
                    },
                } as ApiUpdateContainer,
            });
        } finally {
            unsubscribe();
        }

        expect(observed).not.toHaveBeenCalled();
        expect(params.invalidateSessions).toHaveBeenCalledOnce();
    });
});
