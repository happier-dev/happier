import { readBitbucketApiUrl } from './apiUrl.js';
import { createBitbucketFailure, type BitbucketTriageFailure } from './failures.js';

/**
 * Bitbucket's published pagination contract: collections are wrapped in
 * `{ size?, page?, pagelen, next?, previous?, values }`, `pagelen` has a global minimum of 10 and a
 * maximum of 100, `size` "is an optional element that is not provided in all responses, as it can
 * be expensive to compute", and `next` "should be treated as an opaque location that is not to be
 * constructed by clients or even assumed to be predictable".
 */
export const BITBUCKET_MIN_PAGE_LENGTH = 10;
export const BITBUCKET_MAX_PAGE_LENGTH = 100;

/**
 * The pull-request collection's own `pagelen` ceiling, which is lower than the global one.
 *
 * Atlassian's pagination section publishes the 100 maximum above and then says "some APIs may
 * specify a different default"; the repository pull-request collection is one of them. Asking it
 * for more than 50 rows answers `400 {"type":"error","error":{"message":"Invalid pagelen"}}` — it
 * rejects rather than clamps — so a geometry built from the global maximum would fail every lane
 * request and render an account with pull requests as an account with none.
 */
export const BITBUCKET_MAX_PULL_REQUEST_PAGE_LENGTH = 50;

/**
 * `pagelen` belongs to the invocation, not to a route builder: one bounded walk fixes one native
 * page size and applies it here, so no caller can shrink or rewrite page geometry mid-walk.
 */
export function withBitbucketPageLength(url: string, nativePageSize: number): string {
  const parsed = new URL(url);
  parsed.searchParams.set('pagelen', String(Math.min(nativePageSize, BITBUCKET_MAX_PAGE_LENGTH)));
  return parsed.toString();
}

export type BitbucketPageGeometry = Readonly<{ scanLimit: number; nativePageSize: number }>;

export type BitbucketPageGeometryResult =
  | Readonly<{ ok: true; geometry: BitbucketPageGeometry }>
  | Readonly<{ ok: false; failure: BitbucketTriageFailure }>;

/**
 * The pull-request walk's fixed page geometry.
 *
 * A scan limit below the provider's page minimum cannot be served: the smallest page Bitbucket will
 * return already exceeds the projection budget, so the walk could only stall or fetch and discard.
 * That is refused here, before any provider I/O. The upper bound is the pull-request collection's
 * own ceiling rather than the global one, because that is the route every lane page is fetched from.
 */
export function resolveBitbucketPageGeometry(scanLimit: number): BitbucketPageGeometryResult {
  if (!Number.isSafeInteger(scanLimit) || scanLimit < BITBUCKET_MIN_PAGE_LENGTH) {
    return {
      ok: false,
      failure: createBitbucketFailure(
        'unsupportedContract',
        'scan-limit-below-provider-page-minimum',
      ),
    };
  }
  return {
    ok: true,
    geometry: {
      scanLimit,
      nativePageSize: Math.min(scanLimit, BITBUCKET_MAX_PULL_REQUEST_PAGE_LENGTH),
    },
  };
}

export type BitbucketPageEnvelope = Readonly<{
  values: readonly unknown[];
  next: string | null;
  page: number | null;
  pagelen: number | null;
  size: number | null;
}>;

export type BitbucketPageEnvelopeResult =
  | Readonly<{ ok: true; envelope: BitbucketPageEnvelope }>
  | Readonly<{ ok: false; failure: BitbucketTriageFailure }>;

function readOptionalPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * The envelope itself is strict: a body that is not the documented wrapper is an unsupported
 * contract, not an empty page. Individual `values` entries stay untyped here and are decoded
 * tolerantly one row at a time by the entry decoders.
 */
export function decodeBitbucketPageEnvelope(body: unknown): BitbucketPageEnvelopeResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, failure: createBitbucketFailure('unsupportedContract', 'page-not-an-object') };
  }
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.values)) {
    return { ok: false, failure: createBitbucketFailure('unsupportedContract', 'page-values-missing') };
  }
  if (record.next !== undefined
    && record.next !== null
    && (typeof record.next !== 'string' || record.next.length === 0)) {
    return {
      ok: false,
      failure: createBitbucketFailure('unsupportedContract', 'page-next-invalid'),
    };
  }
  return {
    ok: true,
    envelope: {
      values: record.values,
      next: typeof record.next === 'string' ? record.next : null,
      page: readOptionalPositiveInteger(record.page),
      pagelen: readOptionalPositiveInteger(record.pagelen),
      size: readOptionalPositiveInteger(record.size),
    },
  };
}

export type BitbucketNextPageResolution =
  | Readonly<{ kind: 'end' }>
  | Readonly<{ kind: 'next'; url: string }>
  | Readonly<{ kind: 'invalid'; failure: BitbucketTriageFailure }>;

/**
 * A forge-supplied URL is never fetched without an origin check. The absence of `next` is the only
 * end-of-collection proof; no extra item is fetched and discarded as a sentinel.
 */
export function resolveBitbucketNextPageUrl(
  envelope: BitbucketPageEnvelope,
): BitbucketNextPageResolution {
  if (envelope.next === null) return { kind: 'end' };
  const validated = readBitbucketApiUrl(envelope.next);
  if (validated === null) {
    return {
      kind: 'invalid',
      failure: createBitbucketFailure('unsupportedContract', 'untrusted-next-link'),
    };
  }
  return { kind: 'next', url: validated };
}
