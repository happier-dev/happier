import { describe, expect, it } from 'vitest';

import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { buildPendingChangedSessionPatch } from '@/sync/engine/socket/pendingChangedSessionPatch';
import type { Session } from './storageTypes';
import { buildSessionListCacheEntryFromRenderable, buildSessionListRenderableFromCacheEntry } from './warmCacheAdapters';
import { SessionListCacheEntryV1Schema } from './warmCachePersistence';
import { areStoredSessionsEqual } from '@/sync/store/domains/areStoredSessionsEqual';
import { resolvePendingActivationBanner } from '@/components/sessions/pending/resolvePendingActivationBanner';

const authorization = { requestId: 'pending-1', requestedAt: 200, status: 'waiting' as const };
const failureDetails = { reason: 'spawn-rejected' as const, spawnErrorCode: 'SPAWN_VALIDATION_FAILED' as const,
    runtimeReason: 'no_eligible_member' as const };

function createSession(): Session {
    return {
        id: 's1', seq: 0, createdAt: 1, updatedAt: 2, active: false, activeAt: 100,
        pendingActivationAuthorization: authorization,
        metadata: null, ownerMetadataView: { path: '/tmp', host: 'host', machineId: 'm1' } as any, metadataVersion: 1,
        agentState: null, agentStateVersion: 1, thinking: false, thinkingAt: 0, presence: 100,
    };
}

describe('pending activation Session projection', () => {
    it('keeps a failed activation cause visible after a socket update and warm restoration', () => {
        const failedAuthorization = { ...authorization, status: 'failed' as const, failureCode: 'runtime_start_failed' as const };
        const patch = buildPendingChangedSessionPatch({ pendingCount: 1, pendingVersion: 2,
            pendingActivationAuthorization: failedAuthorization, pendingActivationFailureDetails: failureDetails });
        const failedSession = { ...createSession(), ...patch };
        const cacheEntry = SessionListCacheEntryV1Schema.parse(buildSessionListCacheEntryFromRenderable(
            buildSessionListRenderableFromSession(failedSession)));
        const restored = buildSessionListRenderableFromCacheEntry(cacheEntry);
        expect(resolvePendingActivationBanner({ authorization: restored.pendingActivationAuthorization,
            failureDetails: restored.pendingActivationFailureDetails, activeAt: 100, active: false,
            machineReachable: true, canWrite: true, pendingMessages: [] })).toMatchObject({
            kind: 'failed', titleKey: 'connectedServices.diagnostics.title.no_eligible_group_member',
        });
        expect(areStoredSessionsEqual({ ...failedSession, pendingActivationFailureDetails: null }, failedSession)).toBe(false);
        expect(buildPendingChangedSessionPatch({ pendingCount: 1, pendingVersion: 3,
            pendingActivationFailureDetails: null })).toHaveProperty('pendingActivationFailureDetails', null);
        expect(buildPendingChangedSessionPatch({ pendingCount: 1, pendingVersion: 4 }))
            .not.toHaveProperty('pendingActivationFailureDetails');
    });
    it('round-trips the protocol shape through Session renderable and warm cache', () => {
        const renderable = buildSessionListRenderableFromSession(createSession());
        expect(renderable.pendingActivationAuthorization).toEqual(authorization);
        const cacheEntry = SessionListCacheEntryV1Schema.parse(buildSessionListCacheEntryFromRenderable(renderable));
        expect(buildSessionListRenderableFromCacheEntry(cacheEntry).pendingActivationAuthorization).toEqual(authorization);
    });

    it('applies socket object and explicit null while omission preserves the current value', () => {
        expect(buildPendingChangedSessionPatch({ pendingCount: 1, pendingVersion: 2, pendingActivationAuthorization: authorization })).toMatchObject({ pendingActivationAuthorization: authorization });
        expect(buildPendingChangedSessionPatch({ pendingCount: 1, pendingVersion: 3, pendingActivationAuthorization: null })).toHaveProperty('pendingActivationAuthorization', null);
        expect(buildPendingChangedSessionPatch({ pendingCount: 1, pendingVersion: 4 })).not.toHaveProperty('pendingActivationAuthorization');
    });
});
