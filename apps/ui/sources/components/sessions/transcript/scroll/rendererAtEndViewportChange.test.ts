import { describe, expect, it } from 'vitest';

import { resolveRendererAtEndViewportChange } from './rendererAtEndViewportChange';

describe('resolveRendererAtEndViewportChange', () => {
    it('publishes a user-scroll detach as position-unknown runtime-only viewport state', () => {
        // The detach emit exists so append/send paths stop marking live tail. It carries NO
        // position authority: a fabricated distance (the old Number.MAX_SAFE_INTEGER pill
        // sentinel) was stored by sync as a real restore distance and drove native re-entries
        // into a clamped scroll-to-top plus an unbounded older-page materialization spiral.
        const state = resolveRendererAtEndViewportChange({
            isAtEnd: false,
            isFollowing: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
        }, { cause: 'user' });
        expect(state).toEqual({
            isPinned: false,
            shouldPersistViewport: false,
            shouldRestoreViewport: true,
        });
        expect(state !== null && 'offsetY' in state).toBe(false);
    });

    it('publishes a user-scroll tail arrival as the durable live-tail default', () => {
        expect(resolveRendererAtEndViewportChange({
            isAtEnd: true,
            isFollowing: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
        }, { cause: 'user' })).toEqual({
            isPinned: true,
            offsetY: 0,
            shouldRestoreViewport: false,
        });
    });

    it('suppresses layout/initial-geometry tail arrivals: physical at-end is not semantic live-tail intent', () => {
        // Renderer-caused at-end facts (initial mount placement, underfilled geometry,
        // ResizeObserver ticks while streaming) must never mark live-tail intent in sync —
        // that path deletes the durable detached anchor (USER-REALITY-DIVERGENCE RC-2:
        // observed as a ~110Hz markSessionLiveTailIntent storm that wiped switch-restore
        // anchors on live sessions).
        expect(resolveRendererAtEndViewportChange({
            isAtEnd: true,
            isFollowing: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
        }, { cause: 'layout' })).toBeNull();
    });

    it('suppresses layout-caused transient detaches so a pinned session stays live-tail in sync', () => {
        // Streamed growth can flip physical at-end false for a frame while Legend maintains
        // the tail. Publishing that as a semantic detach would make send paths skip live-tail
        // marking for a user who never left the bottom.
        expect(resolveRendererAtEndViewportChange({
            isAtEnd: false,
            isFollowing: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
        }, { cause: 'layout' })).toBeNull();
    });

    it('uses semantic following rather than exact physical end for every user transition', () => {
        expect(resolveRendererAtEndViewportChange({
            isAtEnd: false,
            isFollowing: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
        }, { cause: 'user' })).toEqual({
            isPinned: true,
            offsetY: 0,
            shouldRestoreViewport: false,
        });
    });

    it('leaves every explicit command destination to the owning semantic flow', () => {
        const detached = {
            isAtEnd: false,
            isFollowing: false,
            isNearEnd: false,
            isWithinMaintainScrollAtEndThreshold: false,
        } as const;
        expect(resolveRendererAtEndViewportChange(detached, { cause: 'layout' })).toBeNull();
        // Legend can need several physical frames to materialize and land a command.
        // Neither an intermediate detach nor the end of a target window is semantic
        // live-tail authority. Explicit return/own-send flows publish following themselves.
        expect(resolveRendererAtEndViewportChange(detached, { cause: 'command' })).toBeNull();
        expect(resolveRendererAtEndViewportChange({
            isAtEnd: true,
            isFollowing: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
        }, { cause: 'command' })).toBeNull();
    });
});
