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
