import type { TranscriptRowLayoutMutationReason } from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';

export type RowLayoutMutationViewportOwnershipAction = 'arm-visible-anchor-hold' | 'none';

/**
 * Viewport-ownership decision for an app-initiated row-local layout mutation.
 *
 * Row collapsibles (tool-row inline expand/collapse, thinking toggles, group unit bodies)
 * notify the transcript through TranscriptRowLayoutMutationContext BEFORE their height
 * commit. Under renderer-owned local height restore (default Legend) that notification is
 * the ONE pre-commit choke point that covers every toggle surface: list-controlled thinking
 * and tool-group setters additionally arm at tap time via prepareLocalHeightChange, but the
 * tool ROW inline toggle never passes that path (live native S-C continuation, 2026-07-11:
 * a row expansion committed +13k px with no hold armed and parked the viewport hours away).
 *
 * The armed hold is the renderer's single keyed visible-anchor hold; re-arming while a live
 * keyed hold or held-'end' exists is a no-op inside the renderer, so double-arming from the
 * tap-time path and this seam cannot compete.
 *
 * Bounded async content replacements/growth (`content-change`) also arm before their owning
 * state commit. `signature-change` mutations are streaming re-signatures, not bounded row
 * replacements — they never arm (the tail-follow and MVCP own those).
 */
export function resolveRowLayoutMutationViewportOwnershipAction(params: Readonly<{
    reason: TranscriptRowLayoutMutationReason;
}>): RowLayoutMutationViewportOwnershipAction {
    if (
        params.reason !== 'expand'
        && params.reason !== 'collapse'
        && params.reason !== 'content-change'
    ) return 'none';
    return 'arm-visible-anchor-hold';
}
