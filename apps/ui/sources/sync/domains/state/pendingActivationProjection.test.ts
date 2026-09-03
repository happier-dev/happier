import { describe, expect, it } from 'vitest';

import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { buildPendingChangedSessionPatch } from '@/sync/engine/socket/pendingChangedSessionPatch';
import type { Session } from './storageTypes';
import { buildSessionListCacheEntryFromRenderable, buildSessionListRenderableFromCacheEntry } from './warmCacheAdapters';

const authorization = { requestId: 'pending-1', requestedAt: 200, status: 'waiting' as const };

function createSession(): Session {
    return {
        id: 's1', seq: 0, createdAt: 1, updatedAt: 2, active: false, activeAt: 100,
        pendingActivationAuthorization: authorization,
        metadata: { path: '/tmp', host: 'host', machineId: 'm1' }, metadataVersion: 1,
        agentState: null, agentStateVersion: 1, thinking: false, thinkingAt: 0, presence: 100,
    };
}

describe('pending activation Session projection', () => {
    it('round-trips the current protocol shape through Session renderable and warm cache', () => {
        const renderable = buildSessionListRenderableFromSession(createSession());
        expect(renderable.pendingActivationAuthorization).toEqual(authorization);
        expect(buildSessionListRenderableFromCacheEntry(buildSessionListCacheEntryFromRenderable(renderable)).pendingActivationAuthorization).toEqual(authorization);
    });

    it('applies socket object and explicit null while omission preserves the current value', () => {
        expect(buildPendingChangedSessionPatch({ pendingCount: 1, pendingVersion: 2, pendingActivationAuthorization: authorization })).toMatchObject({ pendingActivationAuthorization: authorization });
        expect(buildPendingChangedSessionPatch({ pendingCount: 1, pendingVersion: 3, pendingActivationAuthorization: null })).toHaveProperty('pendingActivationAuthorization', null);
        expect(buildPendingChangedSessionPatch({ pendingCount: 1, pendingVersion: 4 })).not.toHaveProperty('pendingActivationAuthorization');
    });
});
