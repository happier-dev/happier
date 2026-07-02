import { describe, expect, it } from 'vitest';

import type { SessionListRenderableSession } from './sessionListRenderable';
import { shouldRebuildSessionListIndexForRowStateChange } from './sessionListIndexRebuildImpact';

function createRenderable(
    id: string,
    overrides?: Partial<SessionListRenderableSession>,
    ): SessionListRenderableSession {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: { path: '' },
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        hasPendingPermissionRequests: false,
        hasPendingUserActionRequests: false,
        hasUnreadMessages: false,
        keepVisibleWhenInactive: false,
        ...overrides,
    };
}

describe('shouldRebuildSessionListIndexForRowStateChange', () => {
    it('returns false when only updatedAt changes', () => {
        const previous: Record<string, SessionListRenderableSession> = {
            s1: createRenderable('s1', { updatedAt: 1 }),
        };
        const next: Record<string, SessionListRenderableSession> = {
            s1: createRenderable('s1', { updatedAt: 2 }),
        };

        expect(shouldRebuildSessionListIndexForRowStateChange(previous, next)).toBe(false);
    });

    it('returns true when meaningful activity changes for an inactive date-grouped session', () => {
        const previous: Record<string, SessionListRenderableSession> = {
            s1: createRenderable('s1', { active: false, updatedAt: 1, meaningfulActivityAt: 10 }),
        };
        const next: Record<string, SessionListRenderableSession> = {
            s1: createRenderable('s1', { active: false, updatedAt: 1, meaningfulActivityAt: 20 }),
        };

        expect(shouldRebuildSessionListIndexForRowStateChange(previous, next, {
            groupInactiveSessionsByProject: false,
            inactiveGroupingV1: 'date',
        })).toBe(true);
    });

    it('returns false when raw updatedAt changes without meaningful activity for an inactive date-grouped session', () => {
        const previous: Record<string, SessionListRenderableSession> = {
            s1: createRenderable('s1', { active: false, updatedAt: 1, meaningfulActivityAt: 10 }),
        };
        const next: Record<string, SessionListRenderableSession> = {
            s1: createRenderable('s1', { active: false, updatedAt: 2, meaningfulActivityAt: 10 }),
        };

        expect(shouldRebuildSessionListIndexForRowStateChange(previous, next, {
            groupInactiveSessionsByProject: false,
            inactiveGroupingV1: 'date',
        })).toBe(false);
    });

    it('returns false when updatedAt changes for an inactive project-grouped session', () => {
        const previous: Record<string, SessionListRenderableSession> = {
            s1: createRenderable('s1', { active: false, updatedAt: 1 }),
        };
        const next: Record<string, SessionListRenderableSession> = {
            s1: createRenderable('s1', { active: false, updatedAt: 2 }),
        };

        expect(shouldRebuildSessionListIndexForRowStateChange(previous, next, {
            groupInactiveSessionsByProject: true,
            inactiveGroupingV1: 'project',
        })).toBe(false);
    });

    it('returns true when a session is added', () => {
        const previous: Record<string, SessionListRenderableSession> = {
            s1: createRenderable('s1'),
        };
        const next: Record<string, SessionListRenderableSession> = {
            s1: createRenderable('s1'),
            s2: createRenderable('s2'),
        };

        expect(shouldRebuildSessionListIndexForRowStateChange(previous, next)).toBe(true);
    });

    it('returns true when a session is removed', () => {
        const previous: Record<string, SessionListRenderableSession> = {
            s1: createRenderable('s1'),
            s2: createRenderable('s2'),
        };
        const next: Record<string, SessionListRenderableSession> = {
            s1: createRenderable('s1'),
        };

        expect(shouldRebuildSessionListIndexForRowStateChange(previous, next)).toBe(true);
    });

    it('returns true when a structural field changes (path)', () => {
        const previous: Record<string, SessionListRenderableSession> = {
            s1: createRenderable('s1', { metadata: { ...createRenderable('s1').metadata!, path: '/a' } }),
        };
        const next: Record<string, SessionListRenderableSession> = {
            s1: createRenderable('s1', { metadata: { ...createRenderable('s1').metadata!, path: '/b' } }),
        };

        expect(shouldRebuildSessionListIndexForRowStateChange(previous, next)).toBe(true);
    });

    it('returns true when active changes', () => {
        const previous: Record<string, SessionListRenderableSession> = {
            s1: createRenderable('s1', { active: true }),
        };
        const next: Record<string, SessionListRenderableSession> = {
            s1: createRenderable('s1', { active: false }),
        };

        expect(shouldRebuildSessionListIndexForRowStateChange(previous, next)).toBe(true);
    });
});
