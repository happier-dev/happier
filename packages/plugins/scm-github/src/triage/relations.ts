import type { TriageSourceEntrySnapshotV1 } from '@happier-dev/triage-protocol/v1';

import { decodeGithubJsonResponse } from '../observations/githubApiClient.js';
import { GITHUB_PLUGIN_ID } from '../observations/githubProviderContracts.js';
import { GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 } from './contribution.js';
import { isGithubSuccessStatus } from './errors.js';
import type { GithubGetDependenciesV1 } from './get.js';
import { buildGithubEntryLocalRef, readGithubRepositoryIdFromCollisionScope } from './identity.js';
import { buildGithubApiUrl, type GithubRepositoryRouteV1 } from './locator.js';
import { decodeGithubIssueBody, projectGithubEntry } from './mapping/entry.js';
import { toTriageLocator } from './mapping/protocol.js';
import type { GithubRepositoryReaderV1 } from './repositories.js';
import { readValidatedGithubFollowUpPage } from './scan/link.js';
import type { GithubTriageEntryLocalRefV1 } from './types.js';

type Relations = NonNullable<TriageSourceEntrySnapshotV1['relations']>;
type ChildEntry = NonNullable<NonNullable<Relations['children']>['entries']>[number];

/** Live REST issue relations (GitHub API 2026-03-10); no Happier-side mirror. */
export async function readGithubIssueRelations(
  localRef: GithubTriageEntryLocalRefV1,
  route: GithubRepositoryRouteV1,
  repositories: GithubRepositoryReaderV1,
  dependencies: GithubGetDependenciesV1,
  summary?: Relations['children'],
): Promise<Relations | undefined> {
  const base = ['repos', route.owner, route.name, 'issues', localRef.entryId];
  const read = async (url: string) => {
    dependencies.signal?.throwIfAborted();
    try {
      const response = await dependencies.client.request({ url });
      if (!isGithubSuccessStatus(response.status)) return null;
      return { response, body: decodeGithubJsonResponse(response) };
    } catch {
      dependencies.signal?.throwIfAborted();
      return null;
    }
  };
  const ref = async (body: unknown, includePresentation = false): Promise<ChildEntry | null> => {
    // Related issues may belong to another repository. Its own live immutable id
    // establishes identity; the current issue's repository must never be guessed.
    const view = decodeGithubIssueBody(body, null);
    if (view === null || view.kindId !== 'issue') return null;
    let repositoryId = view.repositoryId;
    if (repositoryId === null) {
      const repository = await repositories.read({ owner: view.owner, name: view.name });
      if (repository.kind !== 'readable') return null;
      repositoryId = repository.repositoryId;
    }
    const projection = includePresentation ? projectGithubEntry(view, repositoryId) : null;
    const related = projection?.localRef ?? buildGithubEntryLocalRef({ kindId: 'issue', repositoryId, nativeItemId: view.number });
    return related === null ? null : {
      source: { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 },
      ...related,
      ...(projection === null ? {} : { title: projection.snapshot.title, locator: toTriageLocator(projection.locator) }),
    };
  };
  const list = async (tail: readonly string[], includePresentation = false) => {
    // GitHub's documented REST maximum is 100 per page; follow every provider
    // continuation rather than imposing a second relation-count ceiling.
    let url = `${buildGithubApiUrl([...base, ...tail])}?per_page=100`;
    const entries: ChildEntry[] = [];
    let completed = 0;
    while (true) {
      const page = await read(url);
      if (page === null || !Array.isArray(page.body)) return null;
      for (const body of page.body) {
        const entryRef = await ref(body, includePresentation);
        if (entryRef === null) return null;
        entries.push(entryRef);
        if (typeof body === 'object' && body !== null && 'state' in body && body.state === 'closed') completed += 1;
      }
      const next = readValidatedGithubFollowUpPage(page.response.headers, url,
        readGithubRepositoryIdFromCollisionScope(localRef.collisionScope));
      if (next.kind === 'invalid') return null;
      if (next.kind === 'ended') return { entries, completed };
      url = next.url;
    }
  };
  const [parentPage, children, blockers] = await Promise.all([
    read(buildGithubApiUrl([...base, 'parent'])),
    list(['sub_issues'], true),
    list(['dependencies', 'blocked_by']),
  ]);
  const parent = parentPage === null ? null : await ref(parentPage.body);
  const childSummary = children === null ? summary : {
    total: children.entries.length,
    completed: children.completed,
    entries: children.entries,
    complete: true as const,
  };
  if (parent === null && childSummary === undefined && blockers === null) return undefined;
  return {
    ...(parent === null ? {} : { parent }),
    ...(childSummary === undefined ? {} : { children: childSummary }),
    ...(blockers === null ? {} : { blockedBy: blockers.entries }),
  };
}
