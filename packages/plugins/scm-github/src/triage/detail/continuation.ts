import { GITHUB_MAX_DETAIL_PAGE_SIZE_V1 } from './routes.js';

/**
 * The paging position of one mounted GitHub detail panel.
 *
 * It is this source's own bytes, minted here and parsed only here. A panel can
 * neither request a provider-chosen URL nor hold one: GitHub's `rel="next"` is
 * validated as the same request with only `page` advanced (`scan/link.ts`), and
 * only that page number survives into this token, so the next request is rebuilt
 * from the source's own route template.
 *
 * `perPage` travels with it because a continuation is only meaningful against
 * the geometry it was produced under. A panel that changed page size mid-walk
 * would otherwise resume at a page number that names different rows; the
 * operation compares it with the requested limit and restarts the walk rather
 * than guessing which rows the reader already has.
 *
 * Like the scan continuation, this token is invocation-local, is never
 * persisted, and is never a watermark.
 */

const CONTINUATION_VERSION = 1;

export type GithubDetailFrontierV1 = Readonly<{
  v: 1;
  /** 1-indexed page, exactly as GitHub numbers its own pagination. */
  page: number;
  perPage: number;
}>;

function isAdmissibleGeometry(page: number, perPage: number): boolean {
  return Number.isSafeInteger(page)
    && page >= 1
    && Number.isSafeInteger(perPage)
    && perPage >= 1
    && perPage <= GITHUB_MAX_DETAIL_PAGE_SIZE_V1;
}

export function encodeGithubDetailContinuation(
  frontier: GithubDetailFrontierV1,
): string | null {
  if (!isAdmissibleGeometry(frontier.page, frontier.perPage)) return null;
  return JSON.stringify({
    v: CONTINUATION_VERSION,
    page: frontier.page,
    perPage: frontier.perPage,
  });
}

/**
 * Decodes a continuation this source minted. Anything else — another version, a
 * page this source will not request, or a provider URL — is rejected, and the
 * caller restarts the walk rather than requesting a position nobody can vouch
 * for.
 */
export function decodeGithubDetailContinuation(token: string): GithubDetailFrontierV1 | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(token);
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return null;
  const raw = decoded as Readonly<Record<string, unknown>>;
  const page = raw['page'];
  const perPage = raw['perPage'];
  if (raw['v'] !== CONTINUATION_VERSION) return null;
  if (typeof page !== 'number' || typeof perPage !== 'number') return null;
  if (!isAdmissibleGeometry(page, perPage)) return null;
  return Object.freeze({ v: 1 as const, page, perPage });
}
