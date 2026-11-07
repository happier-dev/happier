import { readGithubRepositoryIdFromCollisionScope } from '../identity.js';
import type { GithubRepositoryRouteV1 } from '../locator.js';
import type { GithubTriageEntryLocalRefV1 } from '../types.js';

/**
 * The entry a GraphQL node actually hangs on, in GitHub's own casing.
 *
 * Review threads and comments are addressed by opaque GLOBAL node ids, so a
 * write that names one must first prove it belongs to the admitted entry. Both
 * the thread writes and the comment edit decode and compare it here, once.
 */
export type GithubNodeEntryV1 = Readonly<{
  repositoryId: string;
  owner: string;
  repository: string;
  entryNumber: string;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `null` unless every half of the owning entry decoded: a half-read entry proves nothing. */
export function decodeGithubNodeEntry(entry: unknown, repository: unknown): GithubNodeEntryV1 | null {
  if (!isRecord(entry) || typeof entry.number !== 'number') return null;
  if (!isRecord(repository) || typeof repository.name !== 'string') return null;
  const repositoryId = typeof repository.databaseId === 'number'
    && Number.isSafeInteger(repository.databaseId)
    && repository.databaseId >= 1
    ? String(repository.databaseId)
    : typeof repository.databaseId === 'string'
      && /^[1-9][0-9]*$/u.test(repository.databaseId.trim())
      ? repository.databaseId.trim()
      : null;
  if (repositoryId === null) return null;
  const owner = repository.owner;
  if (!isRecord(owner) || typeof owner.login !== 'string') return null;
  return Object.freeze({
    repositoryId,
    owner: owner.login,
    repository: repository.name,
    entryNumber: String(entry.number),
  });
}

/**
 * Whether the node's entry is the one this invocation was admitted for.
 *
 * Owner and repository compare case-insensitively because GitHub answers in its
 * canonical casing while the routing token is lowercased; the entry number is
 * the exact digits the local ref carries, and the numeric repository id guards
 * a path reused by another repository.
 */
export function githubNodeEntryMatches(
  read: GithubNodeEntryV1,
  localRef: GithubTriageEntryLocalRefV1,
  route: GithubRepositoryRouteV1,
): boolean {
  const expectedRepositoryId = readGithubRepositoryIdFromCollisionScope(localRef.collisionScope);
  return expectedRepositoryId !== null
    && read.repositoryId === expectedRepositoryId
    && read.owner.toLowerCase() === route.owner.toLowerCase()
    && read.repository.toLowerCase() === route.name.toLowerCase()
    && read.entryNumber === localRef.entryId;
}
