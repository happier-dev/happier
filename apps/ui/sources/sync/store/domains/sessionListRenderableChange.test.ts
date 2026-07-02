import { describe, expect, it } from 'vitest';

import type { SessionListRenderableSession } from '../../domains/session/listing/sessionListRenderable';
import { resolveSessionListRenderableChangeImpact } from './sessionListRenderableChange';

function makeRenderable(partial: Partial<SessionListRenderableSession> & Pick<SessionListRenderableSession, 'id'>): SessionListRenderableSession {
    return {
        id: partial.id,
        seq: partial.seq ?? 0,
        createdAt: partial.createdAt ?? 0,
        updatedAt: partial.updatedAt ?? 0,
        active: partial.active ?? false,
        activeAt: partial.activeAt ?? 0,
        archivedAt: partial.archivedAt ?? null,
        pendingVersion: partial.pendingVersion,
        pendingCount: partial.pendingCount,
        metadataVersion: partial.metadataVersion ?? 0,
        agentStateVersion: partial.agentStateVersion ?? 0,
        metadata: partial.metadata ?? null,
        thinking: partial.thinking ?? false,
        thinkingAt: partial.thinkingAt ?? 0,
        presence: partial.presence ?? 0,
        optimisticThinkingAt: partial.optimisticThinkingAt ?? null,
        thinkingGraceUntil: partial.thinkingGraceUntil ?? null,
        owner: partial.owner,
        accessLevel: partial.accessLevel,
        canApprovePermissions: partial.canApprovePermissions,
        hasPendingPermissionRequests: partial.hasPendingPermissionRequests,
        hasPendingUserActionRequests: partial.hasPendingUserActionRequests,
        keepVisibleWhenInactive: partial.keepVisibleWhenInactive,
    };
}

describe('resolveSessionListRenderableChangeImpact', () => {
    it('returns no rebuild impact for identical renderables', () => {
        const previous = makeRenderable({
            id: 's1',
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            metadata: { path: '/repo', machineId: 'm1' } as any,
            metadataVersion: 3,
            agentStateVersion: 4,
            pendingCount: 0,
            pendingVersion: 1,
            accessLevel: 'edit',
            canApprovePermissions: true,
        });

        expect(resolveSessionListRenderableChangeImpact(previous, previous)).toEqual({
            didWarmCacheRelevantRenderableChange: false,
            isWarmCacheProgressOnlyChange: false,
            needsSessionListIndexRebuild: false,
            needsProjectManagerUpdate: false,
            needsReachablePeerReevaluation: false,
        });
    });

    it('marks warm-cache changes without forcing list or project rebuilds', () => {
        const previous = makeRenderable({
            id: 's1',
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            metadata: { path: '/repo', machineId: 'm1' } as any,
            metadataVersion: 3,
            agentStateVersion: 4,
            pendingCount: 0,
            pendingVersion: 1,
            accessLevel: 'edit',
            canApprovePermissions: true,
        });
        const next = makeRenderable({
            ...previous,
            pendingCount: 2,
            pendingVersion: 3,
        });

        expect(resolveSessionListRenderableChangeImpact(previous, next)).toEqual({
            didWarmCacheRelevantRenderableChange: true,
            isWarmCacheProgressOnlyChange: false,
            needsSessionListIndexRebuild: false,
            needsProjectManagerUpdate: false,
            needsReachablePeerReevaluation: false,
        });
    });

    it('classifies active streaming progress as warm-cache-only progress without reachability reevaluation', () => {
        const previous = makeRenderable({
            id: 's1',
            seq: 1,
            createdAt: 1,
            updatedAt: 2,
            meaningfulActivityAt: 2,
            active: true,
            activeAt: 2,
            metadata: { path: '/repo', machineId: 'm1' } as any,
            metadataVersion: 3,
            agentStateVersion: 4,
            pendingCount: 0,
            pendingVersion: 1,
            accessLevel: 'edit',
            canApprovePermissions: true,
        });
        const next = makeRenderable({
            ...previous,
            seq: 2,
            updatedAt: 3,
            meaningfulActivityAt: 3,
            activeAt: 3,
        });

        expect(resolveSessionListRenderableChangeImpact(previous, next)).toEqual({
            didWarmCacheRelevantRenderableChange: true,
            isWarmCacheProgressOnlyChange: true,
            needsSessionListIndexRebuild: false,
            needsProjectManagerUpdate: false,
            needsReachablePeerReevaluation: false,
        });
    });

    it('marks all rebuild impacts for a new renderable', () => {
        const next = makeRenderable({
            id: 's1',
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 2,
            metadata: { path: '/repo', machineId: 'm1' } as any,
            metadataVersion: 3,
            agentStateVersion: 4,
            pendingCount: 0,
            pendingVersion: 1,
            accessLevel: 'edit',
            canApprovePermissions: true,
        });

        expect(resolveSessionListRenderableChangeImpact(undefined, next)).toEqual({
            didWarmCacheRelevantRenderableChange: true,
            isWarmCacheProgressOnlyChange: false,
            needsSessionListIndexRebuild: true,
            needsProjectManagerUpdate: true,
            needsReachablePeerReevaluation: true,
        });
    });
});
