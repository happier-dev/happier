/**
 * The query contract of `GET /v1/sessions/:sessionId/messages`, as the real
 * route enforces it.
 *
 * Test doubles for that route each re-implemented their own idea of the query
 * and answered `200` to everything, which made them strictly MORE permissive
 * than production. A double that cannot reject cannot fail: the bounded
 * native-return replay walk shipped sending `beforeSeq` and `afterSeq`
 * together — the one pair the route refuses — and every bounded fetch would
 * have returned `400` live while the suite stayed green.
 *
 * This is the single owner of that contract for doubles. Mirrors the
 * `superRefine` in
 * `apps/server/sources/app/api/routes/session/registerSessionMessageRoutes.ts`;
 * when the route gains or drops a rule, change it here rather than in each
 * double.
 */

/** Present means present AND non-blank, the way a query string reaches the route. */
function hasQueryValue(searchParams: URLSearchParams, name: string): boolean {
  const raw = searchParams.get(name);
  return typeof raw === 'string' && raw.trim().length > 0;
}

/**
 * The message the real route would answer `400` with, or `null` when the query
 * is one it accepts.
 */
export function findTranscriptMessagesQueryRejection(searchParams: URLSearchParams): string | null {
  const projection = searchParams.get('projection');
  const scope = searchParams.get('scope');

  if (projection === 'turns' && hasQueryValue(searchParams, 'afterSeq')) {
    return 'projection=turns pages backwards only';
  }
  if (projection === 'turns' && scope === 'all') {
    return 'projection=turns requires a single chain scope';
  }
  if (hasQueryValue(searchParams, 'beforeSeq') && hasQueryValue(searchParams, 'afterSeq')) {
    return 'beforeSeq and afterSeq are mutually exclusive';
  }
  if (scope === 'sidechain' && !hasQueryValue(searchParams, 'sidechainId')) {
    return 'sidechainId is required when scope=sidechain';
  }
  return null;
}

/**
 * Structural shape of a Node `ServerResponse`, so a double can use this without
 * the testkit depending on `node:http`.
 */
type RejectableResponse = {
  statusCode: number;
  setHeader: (name: string, value: string) => unknown;
  end: (body?: string) => unknown;
};

/**
 * Answers `400` and returns true when the route would reject this query, so a
 * double can guard its handler with a single early return:
 *
 * ```ts
 * if (respondTranscriptMessagesQueryRejection(url.searchParams, res)) return;
 * ```
 */
export function respondTranscriptMessagesQueryRejection(
  searchParams: URLSearchParams,
  res: RejectableResponse,
): boolean {
  const rejection = findTranscriptMessagesQueryRejection(searchParams);
  if (rejection === null) return false;
  res.statusCode = 400;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: rejection }));
  return true;
}
