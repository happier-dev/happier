/**
 * App Store Connect allows `include=...` relationships on the builds collection endpoint
 * with `filter[app]=...`, but rejects the same `include` on `/v1/apps/{id}/builds`.
 *
 * @param {{ ascAppId: string; limit?: number }} input
 * @returns {string}
 */
export function buildAscBuildsListUrl(input) {
  const ascAppId = String(input?.ascAppId ?? '').trim();
  const limit = Number.isFinite(input?.limit) ? Number(input.limit) : 200;
  const url = new URL('/v1/builds', 'https://api.appstoreconnect.apple.com');
  url.searchParams.set('filter[app]', ascAppId);
  url.searchParams.set('include', 'preReleaseVersion,betaGroups,betaAppReviewSubmission');
  url.searchParams.set('limit', String(limit));
  return url.toString();
}
