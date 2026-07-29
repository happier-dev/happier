import type { TranscriptNavigationAnchorCandidate } from './deriveCurrentTranscriptAnchor';

/**
 * Where a jump landing PUT the reader, for as long as that landing still owns
 * the viewport. Session-scoped so a warm host reused for another session cannot
 * inherit it.
 */
export type TranscriptNavigationLandedAnchor = Readonly<{
    anchorId: string;
    sessionId: string;
}>;

/**
 * The one retention rule for a landed navigation anchor.
 *
 * A landing is user intent and outranks geometric containment — but only until
 * the reader takes the viewport back. Genuine user movement (the app-owned drag
 * fact on native, the renderer's own movement classification on web) releases it
 * immediately, so normal scrollspy resumes on the very same frame; a session
 * change or the anchor leaving the anchor set releases it too, because neither
 * can still describe where the reader is.
 */
export function resolveRetainedTranscriptNavigationLandedAnchor(input: Readonly<{
    anchors: readonly TranscriptNavigationAnchorCandidate[];
    genuineUserMovement: boolean;
    landed: TranscriptNavigationLandedAnchor | null | undefined;
    sessionId: string;
}>): TranscriptNavigationLandedAnchor | null {
    const landed = input.landed;
    if (!landed) return null;
    if (input.genuineUserMovement) return null;
    if (landed.sessionId !== input.sessionId) return null;
    if (!input.anchors.some((anchor) => anchor.id === landed.anchorId)) return null;
    return landed;
}
