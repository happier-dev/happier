import { describe, expect, it } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';
import { decideDurableSessionRealtimeRoute } from './sessionRealtimeRouting';

function buildSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 's1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        latestTurnStatus: 'in_progress',
        latestTurnStatusObservedAt: 1,
        ...overrides,
    };
}

describe('decideDurableSessionRealtimeRoute', () => {
    it('keeps the full transcript path when routing is disabled', () => {
        expect(decideDurableSessionRealtimeRoute({
            updateType: 'new-message',
            mode: 'disabled',
            session: buildSession(),
            visible: false,
            fullContentConsumerActive: false,
        })).toEqual({ route: 'fullTranscriptApply', reason: 'routing-disabled' });
    });

    it('chooses projection-only for hidden complete new-message projections', () => {
        expect(decideDurableSessionRealtimeRoute({
            updateType: 'new-message',
            mode: 'enabled',
            session: buildSession(),
            visible: false,
            fullContentConsumerActive: false,
        })).toEqual({ route: 'projectionOnly', reason: 'hidden-projection-only' });
    });

    it('keeps hidden new-message updates on the projection path when latest-turn fields are missing', () => {
        expect(decideDurableSessionRealtimeRoute({
            updateType: 'new-message',
            mode: 'enabled',
            session: buildSession({ latestTurnStatus: null, latestTurnStatusObservedAt: null }),
            visible: false,
            fullContentConsumerActive: false,
        })).toEqual({ route: 'projectionOnly', reason: 'hidden-projection-only' });
    });

    it('keeps hidden cache-only new-message updates on the projection path with partial projection fields', () => {
        expect(decideDurableSessionRealtimeRoute({
            updateType: 'new-message',
            mode: 'enabled',
            session: undefined,
            sessionProjection: { latestTurnStatus: null, latestTurnStatusObservedAt: Number.NaN },
            visible: false,
            fullContentConsumerActive: false,
        })).toEqual({ route: 'projectionOnly', reason: 'hidden-projection-only' });
    });

    it('marks hidden message-updated payloads stale when projection fields are complete', () => {
        expect(decideDurableSessionRealtimeRoute({
            updateType: 'message-updated',
            mode: 'enabled',
            session: buildSession(),
            visible: false,
            fullContentConsumerActive: false,
        })).toEqual({ route: 'markTranscriptStale', reason: 'message-updated-stale' });
    });

    it('marks hidden message-updated payloads stale when latest-turn fields are missing', () => {
        expect(decideDurableSessionRealtimeRoute({
            updateType: 'message-updated',
            mode: 'enabled',
            session: buildSession({ latestTurnStatus: null, latestTurnStatusObservedAt: null }),
            visible: false,
            fullContentConsumerActive: false,
        })).toEqual({ route: 'markTranscriptStale', reason: 'message-updated-stale' });
    });

    it('keeps hidden new-message updates on the projection path when no session projection exists yet', () => {
        expect(decideDurableSessionRealtimeRoute({
            updateType: 'new-message',
            mode: 'enabled',
            session: undefined,
            visible: false,
            fullContentConsumerActive: false,
        })).toEqual({ route: 'projectionOnly', reason: 'hidden-projection-only' });
    });

    it('uses full transcript apply for visible or live-consumer sessions', () => {
        expect(decideDurableSessionRealtimeRoute({
            updateType: 'new-message',
            mode: 'enabled',
            session: buildSession(),
            visible: true,
            fullContentConsumerActive: false,
        }).route).toBe('fullTranscriptApply');

        expect(decideDurableSessionRealtimeRoute({
            updateType: 'new-message',
            mode: 'enabled',
            session: buildSession(),
            visible: false,
            fullContentConsumerActive: true,
        }).route).toBe('fullTranscriptApply');
    });
});
