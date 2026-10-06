import { describe, expect, it } from 'vitest';
import type { SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';
import { createSessionBoardSourceAvailabilityResolver, resolveSessionBoardItemPresentation } from './sessionBoardItemPresentation';

const source: SessionSurfaceItemV1['source'] = {
    kind: 'widget',
    instance: { v: 1, id: 'widget-b', definition: { kind: 'installed', surface: { pluginId: 'acme.review', localId: 'review-status-widget' } },
        bindings: { session: { kind: 'value', value: { serverId: 'home-a', sessionId: 'session-b' } } } },
};

describe('configured Session widget presentation', () => {
    it('does not exclude pinned B because physical A has no plugin projection', () => {
        const resolveSourceAvailability = createSessionBoardSourceAvailabilityResolver();
        expect(resolveSourceAvailability(source)).toEqual({ kind: 'available' });
        const item: SessionSurfaceItemV1 = { v: 1, title: 'Review status', frame: 'card', height: { mode: 'auto', fallback: 'regular' }, source };
        expect(resolveSessionBoardItemPresentation({
            state: { kind: 'ready', item }, mountMode: 'preview', canEdit: true,
            canOpenElsewhere: true, resolveSourceAvailability,
        }).kind).toBe('preview');
    });
});
