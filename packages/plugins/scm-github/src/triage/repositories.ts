import {
  decodeGithubJsonResponse,
  type GithubApiClientV1,
} from '../observations/githubApiClient.js';

import { classifyGithubResponseFailure, classifyGithubTransportFailure, isGithubSuccessStatus } from './errors.js';
import { buildGithubApiUrl, buildGithubRepositoryKey, parseGithubRoutingToken, type GithubRepositoryRouteV1 } from './locator.js';
import { buildGithubCollisionScope, readGithubRepositoryIdFromCollisionScope } from './identity.js';
import type { GithubTriageFailureV1 } from './types.js';
import { readValidatedGithubFollowUpPage } from './scan/link.js';

export type GithubRepositoryDirectoryPageV1 = Readonly<{
  kind: 'page';
  repositories: readonly Extract<GithubRepositoryReadV1, { kind: 'readable' }>[];
  nextUrl: string | null;
  partial: boolean;
}> | Readonly<{ kind: 'failed'; failure: GithubTriageFailureV1 }>;

/** Shared by source Settings discovery and the explicit All alert walk. */
export async function readGithubRepositoryDirectoryPage(input: Readonly<{
  client: GithubApiClientV1; url: string; now: () => number;
}>): Promise<GithubRepositoryDirectoryPageV1> {
  try {
    const response = await input.client.request({ url: input.url });
    if (!isGithubSuccessStatus(response.status)) return { kind: 'failed', failure: classifyGithubResponseFailure(response, input.now()) };
    const body = decodeGithubJsonResponse(response);
    const search = isRecord(body) ? body : null;
    const rows = new URL(input.url).pathname === '/search/repositories' ? search?.items : body;
    if (!Array.isArray(rows) || rows.length > Number(new URL(input.url).searchParams.get('per_page'))) {
      return { kind: 'failed', failure: { class: 'unsupportedContract', code: 'github_repository_directory_invalid' } };
    }
    const repositories = rows.flatMap(row => {
      const repository = decodeGithubRepositoryMetadata(row);
      return repository?.repositoryKey === null || repository === null ? [] : [repository];
    });
    const next = readValidatedGithubFollowUpPage(response.headers, input.url);
    return { kind: 'page', repositories, nextUrl: next.kind === 'next' ? next.url : null,
      partial: repositories.length !== rows.length || next.kind === 'invalid' || search?.incomplete_results === true
        || (typeof search?.total_count === 'number' && next.kind !== 'next'
          && search.total_count > Number(new URL(input.url).searchParams.get('page') ?? '1') * Number(new URL(input.url).searchParams.get('per_page'))) };
  } catch (error) {
    return { kind: 'failed', failure: classifyGithubTransportFailure(error) };
  }
}

/**
 * Repository reads that identity and absence depend on.
 *
 * Exact entry reads, mutations and security-alert scans consume this reader.
 * A bare `404`/`410` is permission-masked, so absence needs a private confirming
 * read of the repository with the SAME credential. The involvement inbox acquires
 * repository identity alongside current PR checks through checksCondition's batch.
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
export type GithubRepositoryMergeSettingsV1 = Readonly<Record<
  (typeof import('@happier-dev/triage-protocol/v1').TRIAGE_PULL_REQUEST_MERGE_METHODS_V1)[number],
  boolean | null
>>;

export type GithubRepositoryReadV1 =
  | Readonly<{
    kind: 'readable';
    repositoryId: string;
    /** Native GraphQL id from this same repository DTO, when GitHub supplied it. */
    nodeId?: string | null;
    repositoryKey: string | null;
    mergeSettings: GithubRepositoryMergeSettingsV1;
    archived: boolean | null;
    hasIssues: boolean | null;
  }>
  | Readonly<{ kind: 'unreadable'; failure: GithubTriageFailureV1 }>;

export type GithubRepositoryReaderV1 = Readonly<{
  read(route: GithubRepositoryRouteV1 | Readonly<{ repositoryId: string }>): Promise<GithubRepositoryReadV1>;
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

/** One repository DTO decoder shared by exact reads and the selectable directory. */
export function decodeGithubRepositoryMetadata(body: unknown): Extract<GithubRepositoryReadV1, { kind: 'readable' }> | null {
  const repositoryId = isRecord(body) ? readGithubRepositoryIdFromCollisionScope(buildGithubCollisionScope(body.id)) : null;
  if (repositoryId === null) return null;
  const route = isRecord(body) ? parseGithubRoutingToken(body.full_name) : null;
  return {
    kind: 'readable', repositoryId, repositoryKey: route === null ? null : buildGithubRepositoryKey(route),
    nodeId: isRecord(body) && typeof body.node_id === 'string' && body.node_id !== '' ? body.node_id : null,
    mergeSettings: readMergeSettings(body),
    archived: isRecord(body) ? readDeclaredBoolean(body.archived) : null,
    hasIssues: isRecord(body) ? readDeclaredBoolean(body.has_issues) : null,
  };
}

export function createGithubRepositoryReader(input: Readonly<{
  client: GithubApiClientV1;
  now: () => number;
}>): GithubRepositoryReaderV1 {
  const cache = new Map<string, Promise<GithubRepositoryReadV1>>();

  const readOnce = async (url: string): Promise<GithubRepositoryReadV1> => {
    let response;
    try {
      response = await input.client.request({
        url,
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
    const metadata = decodeGithubRepositoryMetadata(body);
    if (metadata === null) {
      return Object.freeze({
        kind: 'unreadable',
        failure: Object.freeze({
          class: 'unsupportedContract',
          code: 'github_repository_identity_missing',
        }),
      });
    }
    return Object.freeze(metadata);
  };

  const readCached = (key: string, url: string): Promise<GithubRepositoryReadV1> => {
    const existing = cache.get(key);
    if (existing !== undefined) return existing;
    const pending = readOnce(url).then((result) => {
      if (result.kind === 'readable') {
        if (result.repositoryKey !== null) cache.set(result.repositoryKey, Promise.resolve(result));
      }
      return result;
    });
    cache.set(key, pending);
    return pending;
  };

  return Object.freeze({
    read(route: GithubRepositoryRouteV1 | Readonly<{ repositoryId: string }>): Promise<GithubRepositoryReadV1> {
      if ('repositoryId' in route) {
        return readCached(`id:${route.repositoryId}`, buildGithubApiUrl(['repositories', route.repositoryId]));
      }
      const key = `${route.owner.toLowerCase()}/${route.name.toLowerCase()}`;
      return readCached(key, buildGithubApiUrl(['repos', route.owner, route.name]));
    },
  });
}
