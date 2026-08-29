import {
  decodeGithubJsonResponse,
  type GithubApiClientV1,
} from '../observations/githubApiClient.js';

import { classifyGithubResponseFailure, classifyGithubTransportFailure, isGithubSuccessStatus } from './errors.js';
import { buildGithubApiUrl, type GithubRepositoryRouteV1 } from './locator.js';
import type { GithubTriageFailureV1 } from './types.js';

/**
 * Repository reads that identity and absence depend on.
 *
 * Two callers need this, for different reasons:
 *  - scan, because a `/search/issues` item is not guaranteed to carry the numeric
 *    repository id the collision scope is built from, and identity may not be guessed
 *    from the mutable `owner/name` path;
 *  - get, because a bare `404`/`410` is permission-masked, so absence needs a private
 *    confirming read of the repository with the SAME credential.
 *
 * Results are memoized for the invocation only. Nothing here is cached across
 * invocations, and no credential is captured: the client owns that, once.
 */

/**
 * The merge methods this repository's own settings permit.
 *
 * Each entry is present ONLY when GitHub explicitly stated it. GitHub omits
 * `allow_*` from the repository object for some credentials and visibilities, and
 * an omitted setting is unknown — never `false`. Treating silence as a
 * prohibition would refuse a merge the repository actually allows, which is the
 * reasonless refusal this vertical exists to avoid.
 */
export type GithubRepositoryMergeSettingsV1 = Readonly<{
  merge: boolean | null;
  squash: boolean | null;
  rebase: boolean | null;
}>;

export type GithubRepositoryReadV1 =
  | Readonly<{
    kind: 'readable';
    repositoryId: string;
    mergeSettings: GithubRepositoryMergeSettingsV1;
    archived: boolean | null;
    hasIssues: boolean | null;
  }>
  | Readonly<{ kind: 'unreadable'; failure: GithubTriageFailureV1 }>;

export type GithubRepositoryReaderV1 = Readonly<{
  read(route: GithubRepositoryRouteV1): Promise<GithubRepositoryReadV1>;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readDeclaredBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readMergeSettings(body: unknown): GithubRepositoryMergeSettingsV1 {
  const raw = isRecord(body) ? body : {};
  return Object.freeze({
    merge: readDeclaredBoolean(raw.allow_merge_commit),
    squash: readDeclaredBoolean(raw.allow_squash_merge),
    rebase: readDeclaredBoolean(raw.allow_rebase_merge),
  });
}

function readPositiveDecimal(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 1 ? String(value) : null;
  }
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  return /^[1-9][0-9]*$/u.test(candidate) ? candidate : null;
}

export function createGithubRepositoryReader(input: Readonly<{
  client: GithubApiClientV1;
  now: () => number;
}>): GithubRepositoryReaderV1 {
  const cache = new Map<string, Promise<GithubRepositoryReadV1>>();

  const readOnce = async (route: GithubRepositoryRouteV1): Promise<GithubRepositoryReadV1> => {
    let response;
    try {
      response = await input.client.request({
        url: buildGithubApiUrl(['repos', route.owner, route.name]),
      });
    } catch (error) {
      return Object.freeze({ kind: 'unreadable', failure: classifyGithubTransportFailure(error) });
    }
    if (!isGithubSuccessStatus(response.status)) {
      return Object.freeze({
        kind: 'unreadable',
        failure: classifyGithubResponseFailure(response, input.now()),
      });
    }
    let body: unknown;
    try {
      body = decodeGithubJsonResponse(response);
    } catch (error) {
      return Object.freeze({ kind: 'unreadable', failure: classifyGithubTransportFailure(error) });
    }
    const repositoryId = isRecord(body) ? readPositiveDecimal(body.id) : null;
    if (repositoryId === null) {
      return Object.freeze({
        kind: 'unreadable',
        failure: Object.freeze({
          class: 'unsupportedContract',
          code: 'github_repository_identity_missing',
        }),
      });
    }
    return Object.freeze({
      kind: 'readable',
      repositoryId,
      mergeSettings: readMergeSettings(body),
      archived: isRecord(body) ? readDeclaredBoolean(body.archived) : null,
      hasIssues: isRecord(body) ? readDeclaredBoolean(body.has_issues) : null,
    });
  };

  return Object.freeze({
    read(route: GithubRepositoryRouteV1): Promise<GithubRepositoryReadV1> {
      const key = `${route.owner.toLowerCase()}/${route.name.toLowerCase()}`;
      const existing = cache.get(key);
      if (existing !== undefined) return existing;
      const pending = readOnce(route);
      cache.set(key, pending);
      return pending;
    },
  });
}
