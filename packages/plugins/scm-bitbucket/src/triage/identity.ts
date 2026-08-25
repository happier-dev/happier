/**
 * Bitbucket Cloud triage identity.
 *
 * Atlassian documents `repository.uuid` as "The repository's immutable id… Doing this guarantees
 * your URLs will survive renaming of the repository by its owner, or even transfer of the
 * repository to a different user." Every UUID crosses the wire wrapped in literal curly braces,
 * and both the `workspace` and `repo_slug` path segments accept "the UUID in curly braces".
 * Dropping a brace produces a well-formed request that 404s, so the braces are preserved verbatim
 * here and percent-encoded — never stripped — at the URL boundary.
 */

export const BITBUCKET_FORGE_HOST_ID = 'bitbucket.org';

/**
 * The forge DEPLOYMENT an entry from this source belongs to.
 *
 * Bitbucket Cloud is the only deployment this source reaches, and this constant
 * derives from the host id above rather than repeating it, so admitting a
 * Bitbucket Data Center deployment would have to make the deployment a
 * configured fact here instead of silently inheriting Cloud's identity. It is
 * the same string a project's resolved `ScmHostingProviderRef.baseUrl`
 * canonicalizes to.
 */
export const BITBUCKET_TRIAGE_DEPLOYMENT_BASE_URL_V1 = `https://${BITBUCKET_FORGE_HOST_ID}`;
export const BITBUCKET_COLLISION_SCOPE_PREFIX = 'bitbucket:';

const BRACED_UUID_PATTERN = /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i;

export function readBitbucketBracedUuid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return BRACED_UUID_PATTERN.test(value) ? value : null;
}

export function encodeBitbucketPathSegment(value: string): string {
  return encodeURIComponent(value);
}

export function buildBitbucketCollisionScope(repositoryUuid: unknown): string | null {
  const uuid = readBitbucketBracedUuid(repositoryUuid);
  return uuid === null ? null : `${BITBUCKET_COLLISION_SCOPE_PREFIX}${uuid}`;
}

/**
 * The inverse of {@link buildBitbucketCollisionScope}, for the one caller that receives a scope
 * rather than a provider row: an authoritative `get` addresses its entry by the scope the target
 * hands back. A scope this source did not mint yields `null` rather than a guessed repository.
 */
export function readBitbucketCollisionScopeRepositoryUuid(scope: unknown): string | null {
  if (typeof scope !== 'string') return null;
  if (!scope.startsWith(BITBUCKET_COLLISION_SCOPE_PREFIX)) return null;
  return readBitbucketBracedUuid(scope.slice(BITBUCKET_COLLISION_SCOPE_PREFIX.length));
}

/**
 * Bitbucket pull-request ids are integers unique within their repository, which is why the
 * collision scope is the repository UUID rather than the workspace. The displayed number and the
 * entry id coincide on this forge; that is a Bitbucket fact, not permission to key on a row field.
 */
export function readBitbucketEntryId(rawId: unknown): string | null {
  if (typeof rawId !== 'number' || !Number.isSafeInteger(rawId) || rawId <= 0) return null;
  return String(rawId);
}

/** The grammar `readBitbucketEntryId` produces, read back from an already-minted local ref. */
/** Bitbucket numbers a pull request and a comment the same way: a positive integer, as text. */
const BITBUCKET_POSITIVE_ID_PATTERN = /^[1-9][0-9]*$/u;

/**
 * Whether an id carried on a local ref is one this source could have minted.
 *
 * A read that is handed something else fails at the provider; a **write** must never reach the
 * provider at all, because the path it would build addresses whatever that segment happens to
 * encode. So the grammar is checked before the route exists rather than inside the request.
 */
export function isBitbucketEntryId(value: string): boolean {
  return BITBUCKET_POSITIVE_ID_PATTERN.test(value);
}

/**
 * Whether a comment id is one this source could have read.
 *
 * Same grammar and the same reason, stated separately because it guards a different segment: the
 * resolve and reopen writes build a path from a comment id, and an id this source did not mint
 * must not become part of a URL a credential is sent to.
 */
export function isBitbucketCommentId(value: string): boolean {
  return BITBUCKET_POSITIVE_ID_PATTERN.test(value);
}

/**
 * `full_name` is "the concatenation of the repository owner's username and the slugified name".
 * Both halves are mutable, so this is a replaceable locator and never a join key.
 */
export function buildBitbucketRepositoryKey(fullName: unknown): string | null {
  if (typeof fullName !== 'string') return null;
  const segments = fullName.split('/');
  if (segments.length !== 2) return null;
  const [workspace, repository] = segments;
  if (!workspace || !repository) return null;
  return `${workspace.toLowerCase()}/${repository.toLowerCase()}`;
}
