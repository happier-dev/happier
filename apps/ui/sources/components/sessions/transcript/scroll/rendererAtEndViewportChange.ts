import type { TranscriptViewportChangeState } from '../chatListTypes';
import type { TranscriptRendererAtEndState } from '../viewport/shell/renderer/types';

/** Maps explicit renderer movement causes into the app-owned semantic live-tail state. */
export function resolveRendererAtEndViewportChange(
    state: TranscriptRendererAtEndState,
    context: Readonly<{ cause: 'user' | 'layout' | 'command' }>,
): TranscriptViewportChangeState | null {
    // PHYSICAL at-end facts (initial mount placement, underfilled geometry, ResizeObserver
    // ticks during streaming, Legend's own maintain writes) are projection inputs only.
    // SEMANTIC live-tail/detach intent may change ONLY on user-caused movement; renderer-caused
    // facts must never mark live tail in sync (that path deletes the durable detached anchor)
    // nor flip a pinned session to observed-detached (that path makes sends skip live-tail).
    // This includes command-attributed following at the physical end of a target window:
    // the command's owning flow publishes its semantic destination, including explicit returns.
    if (context.cause !== 'user') return null;
    if (state.isFollowing) {
        return {
            isPinned: true,
            offsetY: 0,
            shouldRestoreViewport: false,
        };
    }
    // Detach carries pin intent only, never a fabricated position: the renderer knows the
    // viewport left the tail but does not measure a restore distance here. Real positions
    // arrive through scroll/anchor observation emits; the sync boundary preserves prior
    // offset metadata for this position-unknown shape. (A fabricated sentinel distance was
    // previously stored as a real restore target and corrupted session re-entry.)
    return {
        isPinned: false,
        shouldPersistViewport: false,
        shouldRestoreViewport: true,
    };
}
