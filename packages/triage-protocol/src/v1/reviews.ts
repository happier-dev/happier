import { buildTriageEntryRouteSegmentV1, readTriageEntryRouteSegmentV1 } from './entryRoute.js';
import { TRIAGE_APP_PAGE_LOCAL_ID_V1 } from './actionEditorLaunch.js';
import type { TriageEntryRefV1 } from './identity.js';

/** The built-in Review source and its stable per-Review attention address. */
export const REVIEW_TRIAGE_SOURCE_V1 = { pluginId: 'happier.triage', localId: 'reviews' } as const;
export function reviewTriageLocalRefV1(reviewId: string) {
    return { kindId: 'review', collisionScope: 'reviews', entryId: reviewId } as const;
}
export function isReviewTriageEntryRefV1(ref: TriageEntryRefV1): boolean {
    return ref.source.pluginId === REVIEW_TRIAGE_SOURCE_V1.pluginId && ref.source.localId === REVIEW_TRIAGE_SOURCE_V1.localId
        && ref.kindId === 'review' && ref.collisionScope === 'reviews';
}
export function reviewTriageRouteV1(reviewId: string): string {
    return buildTriageEntryRouteSegmentV1({ source: REVIEW_TRIAGE_SOURCE_V1, ...reviewTriageLocalRefV1(reviewId) });
}
export function readReviewTriageRouteV1(pluginId: string, pageId: string, subPath?: string): string | null {
    if (pluginId !== REVIEW_TRIAGE_SOURCE_V1.pluginId || pageId !== TRIAGE_APP_PAGE_LOCAL_ID_V1 || subPath === undefined) return null;
    const ref = readTriageEntryRouteSegmentV1(subPath);
    return ref && isReviewTriageEntryRefV1(ref) ? ref.entryId : null;
}
