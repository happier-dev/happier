/**
 * `get` — the only operation the contract lets conclude absence, and the only one
 * that reads one entry by route. **This source never exercises that arm.**
 *
 * `sources/SCM.md` §4.6: GitLab V1 never emits `absent`. GitLab documents the item
 * `404` as project-or-item-not-found, and authorization hides items the account may
 * not see behind that same status — a confidential item, a restricted project and a
 * deleted item are one response. No parent reread narrows that: a readable project
 * says nothing about an item hidden inside it. `absent` is a claim that the entry is
 * gone and it deletes the user's row, so the conclusion here is `unresolved`, which
 * keeps the row stale and read-only until the user removes it.
 *
 * GitLab never reaches `merged` either: a merge request cannot change project, and a
 * project moving between groups keeps its id, so the identity scope survives the
 * move. A known repository locator must still match the response. A first read
 * uses the immutable project id and takes its current locator from the response.
 */

import type {
  TriageGetInputV1,
  TriageGetResultV1,
  TriageSourceEntryLocalRefV1,
  TriageSourceFailureV1,
  TriagePullRequestStatusV1,
} from '@happier-dev/triage-protocol/v1';
import { TriageIdentifierV1ProtocolSchema } from '@happier-dev/plugin-sdk/protocol';
import { fitActionResultTextV1 } from '@happier-dev/triage-sources/projection/actionResultText';

import { authorizeGitlabConfiguredInstance } from './configuredInstance.js';
import {
  admitGitlabItemIdentity,
  GITLAB_SCOPE_OUTSIDE_BINDING_FAILURE,
  resolveGitlabItemRoute,
} from './admission.js';
import { GITLAB_PLUGIN_ID, GITLAB_TRIAGE_DETAIL_ACTION_IDS, GITLAB_TRIAGE_KIND_IDS } from './contribution.js';
import { GITLAB_CHANGES_PAGE_SIZE_V1 } from './detail/routes.js';
import { readGitlabComparisonEndpoints } from './mapping/mergeRequestHead.js';
import { buildGitlabComparisonRepositoryKey, readGitlabProjectIdWithinOrigin } from './identity.js';
import {
  requestGitlabJson,
  type GitlabConnectedAccounts,
  type GitlabHttpFetcher,
} from './http/gitlabClient.js';
import { readGitlabViewerIdentity } from './invocation.js';
import { decodeGitlabRow, projectGitlabMergeStatus } from './mapping/gitlabEntry.js';
import { boundGitlabText } from './mapping/bounded.js';
import type { GitlabMappedEntry } from './types.js';
import { deriveGitlabItemInvolvement } from './mapping/gitlabInvolvement.js';
import { projectGitlabSourceFailure } from './sourceFailure.js';
import { projectGitlabPresentObservation } from './sourceObservation.js';
import { buildGitlabItemUrl } from './detail/routes.js';
import type { GitlabDetailRouteInputV1 } from './detail/routes.js';
import type { GitlabDetailReadDependenciesV1 } from './detail/reads.js';
import { readGitlabPipelineStatusesPage } from './detail/reads.js';
import { projectGitlabOpeningChecksFact } from './detail/projection.js';

type GitlabOverviewReadContext = Readonly<{ route: GitlabDetailRouteInputV1; dependencies: GitlabDetailReadDependenciesV1 }>;

export type GitlabGetOperationInput = Readonly<{
  requestId?: string;
  get: TriageGetInputV1;
  connectedAccounts: GitlabConnectedAccounts;
  fetcher: GitlabHttpFetcher;
  signal: AbortSignal;
  nowMs: number;
}>;

function unresolved(
  localRef: TriageSourceEntryLocalRefV1,
  failure: TriageSourceFailureV1,
  requestId?: string,
): TriageGetResultV1 {
  return { kind: 'unresolved', localRef,
    failure: requestId === undefined || failure.requestId !== undefined ? failure : { ...failure, requestId },
  };
}

async function executeGitlabTriageEntry(
  input: GitlabGetOperationInput,
  captureDescription?: (description: string | null, entry: GitlabMappedEntry, readContext: GitlabOverviewReadContext,
    native: Readonly<Record<string, unknown>>) => void,
): Promise<TriageGetResultV1> {
  const localRef = input.get.localRef;
  const identity = admitGitlabItemIdentity({
    localRef,
    admissibleKinds: GITLAB_TRIAGE_KIND_IDS,
  });
  if (!identity.ok) return unresolved(localRef, identity.failure, input.requestId);

  const authorized = await authorizeGitlabConfiguredInstance({
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    instance: input.get.instance,
    connectedAccounts: input.connectedAccounts,
    signal: input.signal,
  });
  if (authorized.kind === 'failed') {
    return unresolved(localRef, projectGitlabSourceFailure(authorized.failure), input.requestId);
  }
  const { origin, invocation } = authorized.resolved;

  const { kindId, iid } = identity.identity;
  const locator = input.get.lastKnownLocator;
  let route: Parameters<typeof buildGitlabItemUrl>[0];
  if (locator === undefined) {
    const projectId = readGitlabProjectIdWithinOrigin(identity.identity, origin);
    if (projectId === null) return unresolved(localRef, GITLAB_SCOPE_OUTSIDE_BINDING_FAILURE, input.requestId);
    route = { origin, kindId, iid, projectId };
  } else {
    const routed = resolveGitlabItemRoute(identity.identity, origin, locator.routingToken);
    if (!routed.ok) return unresolved(localRef, routed.failure, input.requestId);
    route = routed.route;
  }

  const item = await requestGitlabJson({
    invocation,
    url: buildGitlabItemUrl(route),
    fetcher: input.fetcher,
    signal: input.signal,
    nowMs: input.nowMs,
  });

  if (item.kind === 'failed') {
    if (item.failure.code === 'not-found') {
      // Reported as the conservative class rather than the transport's generic one:
      // the row survives, and nothing downstream may read this as deletion.
      return unresolved(localRef, {
        class: 'permission',
        code: 'item-unreadable',
        detail: 'GitLab answers a hidden, confidential and removed item identically.',
      }, input.requestId);
    }
    return unresolved(localRef, projectGitlabSourceFailure(item.failure), input.requestId);
  }

  const decoded = decodeGitlabRow({ kindId, origin, row: item.response.body });
  if (decoded.kind !== 'mapped') {
    return unresolved(localRef, {
      class: 'unsupportedContract',
      code: 'undecodable-item',
      detail: `The GitLab response could not be identified: ${decoded.reason}.`,
    }, input.requestId);
  }
  const entry = decoded.entry;
  if (entry.identity.collisionScope !== localRef.collisionScope
    || entry.identity.entryId !== localRef.entryId) {
    // A different reference is invalid here, never a redirect.
    return unresolved(localRef, {
      class: 'unsupportedContract',
      code: 'identity-mismatch',
      detail: 'GitLab answered with an entry other than the one addressed.',
    }, input.requestId);
  }
  if ('repositoryKey' in route && entry.locator.routingToken !== route.repositoryKey) {
    return unresolved(localRef, {
      class: 'unsupportedContract',
      code: 'locator-mismatch',
      detail: 'GitLab answered from a repository other than the source-minted locator.',
    }, input.requestId);
  }
  if (captureDescription !== undefined) {
    const body = item.response.body as Readonly<Record<string, unknown>>;
    captureDescription(typeof body.description === 'string' ? body.description : null, entry, {
      route: { origin, kindId, iid, repositoryKey: entry.locator.repositoryKey },
      dependencies: { invocation, fetcher: input.fetcher, signal: input.signal, nowMs: input.nowMs },
    }, body);
  }

  const viewer = await readGitlabViewerIdentity({
    invocation,
    fetcher: input.fetcher,
    signal: input.signal,
    nowMs: input.nowMs,
  });
  if (viewer.kind === 'failed') {
    return unresolved(localRef, projectGitlabSourceFailure(viewer.failure), input.requestId);
  }
  const involvement = deriveGitlabItemInvolvement({
    viewerUsername: viewer.viewer.username,
    author: entry.snapshot.author?.username ?? null,
    assignees: entry.snapshot.assignees.map((actor) => actor.username),
    reviewers: entry.snapshot.reviewers.map((actor) => actor.username),
    subscribed: entry.viewer.involvement.includes('subscribed'),
  });

  const projected = projectGitlabPresentObservation({ ...entry, viewer: { involvement } });
  const endpoints = kindId === 'merge-request' ? readGitlabComparisonEndpoints(item.response.body) : null;
  const number = Number(entry.identity.entryId);
  if (endpoints === null || !Number.isSafeInteger(number)) return projected;
  return { ...projected, comparisonSource: { kind: 'pullRequest', locator: {
    providerId: 'gitlab', repository: buildGitlabComparisonRepositoryKey(origin, entry.locator.repositoryKey), number,
    baseOid: endpoints.baseOid, headOid: endpoints.headOid,
    sourceAction: { action: { pluginId: GITLAB_PLUGIN_ID, localId: GITLAB_TRIAGE_DETAIL_ACTION_IDS.listChanges },
      input: { v: 1, instance: input.get.instance, localRef, routingToken: entry.locator.routingToken,
        limit: GITLAB_CHANGES_PAGE_SIZE_V1, comparison: true } },
  } } };
}

export async function getGitlabTriageEntry(
  input: GitlabGetOperationInput,
): Promise<TriageGetResultV1> {
  let description: string | null = null;
  const captured: { readContext?: GitlabOverviewReadContext } = {};
  const observed = await executeGitlabTriageEntry(input, (value, _entry, readContext) => {
    description = value;
    captured.readContext = readContext;
  });
  if (observed.kind !== 'present') return observed;
  let result = observed;
  if (result.localRef.kindId === 'merge-request') {
    const read = captured.readContext === undefined ? null : await readGitlabPipelineStatusesPage({
      route: captured.readContext.route,
      perPage: 1,
      position: { kind: 'first' },
    }, captured.readContext.dependencies);
    const fact = projectGitlabOpeningChecksFact(read?.ok ? read.value : null, result.nativeRevision ?? null);
    result = { ...result, snapshot: { ...result.snapshot, facts: [...result.snapshot.facts, fact] } };
  }
  const project = (text: string, descriptionTruncated: boolean) => ({
    ...result,
    detailData: { overview: {
      kind: 'overview' as const,
      observedAtMs: input.nowMs,
      observation: result,
      ...(description === null ? {} : { description: text }),
      descriptionTruncated,
    } },
  });
  // Fit the entire get envelope, including its transient native projection.
  return fitActionResultTextV1(description ?? '', project);
}

/** The Overview consumes the same exact current read as `get`, plus GitLab's body. */
export async function readGitlabTriageEntryForOverview(
  input: GitlabGetOperationInput,
): Promise<Readonly<{
  result: TriageGetResultV1;
  description: string | null;
  readContext: GitlabOverviewReadContext | null;
  pullRequest: Readonly<{
    branch: TriagePullRequestStatusV1['branch'];
    merge: TriagePullRequestStatusV1['merge'];
    reviewers: readonly string[];
    changesRequested: boolean;
    projectionTruncated: boolean;
  }> | null;
}>> {
  let description: string | null = null;
  let readContext: GitlabOverviewReadContext | null = null;
  let pullRequest: Awaited<ReturnType<typeof readGitlabTriageEntryForOverview>>['pullRequest'] = null;
  const result = await executeGitlabTriageEntry(input, (value, entry, admitted, native) => {
    description = value;
    readContext = admitted;
    if (entry.identity.kindId !== 'merge-request') return;
    const head = entry.snapshot.branches?.source;
    const base = entry.snapshot.branches?.target;
    const boundedHead = head ? boundGitlabText(head) : null;
    const boundedBase = base ? boundGitlabText(base) : null;
    const revision = TriageIdentifierV1ProtocolSchema.safeParse(entry.snapshot.nativeRevision);
    const nativeState = entry.snapshot.detailedMergeStatus === null ? null : boundGitlabText(entry.snapshot.detailedMergeStatus);
    pullRequest = {
      branch: boundedHead || boundedBase || revision.success ? {
        ...(boundedHead ? { head: boundedHead.text } : {}),
        ...(boundedBase ? { base: boundedBase.text } : {}),
        ...(revision.success ? { headRevision: revision.data } : {}),
      } : null,
      merge: { ...projectGitlabMergeStatus(entry.snapshot.detailedMergeStatus),
        ...(entry.snapshot.draft === true ? { state: 'blocked' as const, blocker: 'draft_status' } : {}),
        draft: entry.snapshot.draft,
        // GitLab reports has_conflicts:false while mergeability is still being
        // computed. Only its settled native answer proves conflict freedom.
        conflicts: native.has_conflicts === true || entry.snapshot.detailedMergeStatus === 'conflict' ? true
          : native.has_conflicts === false && (native.merge_status === 'can_be_merged'
            || entry.snapshot.detailedMergeStatus === 'mergeable') ? false : null,
        nativeState: nativeState === null || nativeState.truncated ? null : nativeState.text,
      },
      reviewers: entry.snapshot.reviewers.map((reviewer) => reviewer.username),
      changesRequested: entry.snapshot.detailedMergeStatus === 'requested_changes',
      projectionTruncated: (boundedHead?.truncated ?? false) || (boundedBase?.truncated ?? false)
        || (nativeState?.truncated ?? false) || (entry.snapshot.nativeRevision !== null && !revision.success),
    };
  });
  return Object.freeze({ result, description, pullRequest, readContext });
}
