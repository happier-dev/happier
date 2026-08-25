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
 * project moving between groups keeps its id, so the scope survives the move. That is
 * the intended consequence of keying on the project id.
 */

import type {
  TriageGetInputV1,
  TriageGetResultV1,
  TriageSourceEntryLocalRefV1,
  TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import { authorizeGitlabConfiguredInstance } from './configuredInstance.js';
import {
  admitGitlabItemIdentity,
  resolveGitlabItemRoute,
} from './admission.js';
import { GITLAB_TRIAGE_KIND_IDS } from './contribution.js';
import {
  buildGitlabApiUrl,
  requestGitlabJson,
  type GitlabConnectedAccounts,
  type GitlabHttpFetcher,
} from './http/gitlabClient.js';
import { readGitlabViewerIdentity } from './invocation.js';
import { decodeGitlabRow } from './mapping/gitlabEntry.js';
import { deriveGitlabItemInvolvement } from './mapping/gitlabInvolvement.js';
import { projectGitlabSourceFailure } from './sourceFailure.js';
import { projectGitlabPresentObservation } from './sourceObservation.js';
import type { GitlabKindId } from './types.js';

const KIND_ITEM_SEGMENT: Readonly<Record<GitlabKindId, string>> = Object.freeze({
  'merge-request': 'merge_requests',
  issue: 'issues',
});

export type GitlabGetOperationInput = Readonly<{
  get: TriageGetInputV1;
  connectedAccounts: GitlabConnectedAccounts;
  fetcher: GitlabHttpFetcher;
  signal: AbortSignal;
  nowMs: number;
}>;

function unresolved(
  localRef: TriageSourceEntryLocalRefV1,
  failure: TriageSourceFailureV1,
): TriageGetResultV1 {
  return { kind: 'unresolved', localRef, failure };
}

export async function getGitlabTriageEntry(
  input: GitlabGetOperationInput,
): Promise<TriageGetResultV1> {
  const localRef = input.get.localRef;
  const identity = admitGitlabItemIdentity({
    localRef,
    admissibleKinds: GITLAB_TRIAGE_KIND_IDS,
  });
  if (!identity.ok) return unresolved(localRef, identity.failure);

  const authorized = await authorizeGitlabConfiguredInstance({
    instance: input.get.instance,
    connectedAccounts: input.connectedAccounts,
    signal: input.signal,
  });
  if (authorized.kind === 'failed') {
    return unresolved(localRef, projectGitlabSourceFailure(authorized.failure));
  }
  const { origin, invocation } = authorized.resolved;

  const routed = resolveGitlabItemRoute(identity.identity, origin);
  if (!routed.ok) return unresolved(localRef, routed.failure);
  const { projectId, iid, kindId } = routed.route;

  const item = await requestGitlabJson({
    invocation,
    url: buildGitlabApiUrl(
      origin,
      `/projects/${projectId}/${KIND_ITEM_SEGMENT[kindId]}/${iid}`,
    ),
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
      });
    }
    return unresolved(localRef, projectGitlabSourceFailure(item.failure));
  }

  const decoded = decodeGitlabRow({ kindId, origin, row: item.response.body });
  if (decoded.kind !== 'mapped') {
    return unresolved(localRef, {
      class: 'unsupportedContract',
      code: 'undecodable-item',
      detail: `The GitLab response could not be identified: ${decoded.reason}.`,
    });
  }
  const entry = decoded.entry;
  if (entry.identity.collisionScope !== localRef.collisionScope
    || entry.identity.entryId !== localRef.entryId) {
    // A different reference is invalid here, never a redirect.
    return unresolved(localRef, {
      class: 'unsupportedContract',
      code: 'identity-mismatch',
      detail: 'GitLab answered with an entry other than the one addressed.',
    });
  }

  const viewer = await readGitlabViewerIdentity({
    invocation,
    fetcher: input.fetcher,
    signal: input.signal,
    nowMs: input.nowMs,
  });
  const involvement = deriveGitlabItemInvolvement({
    viewerUsername: viewer.kind === 'identified' ? viewer.viewer.username : null,
    author: entry.snapshot.author?.username ?? null,
    assignees: entry.snapshot.assignees.map((actor) => actor.username),
    reviewers: entry.snapshot.reviewers.map((actor) => actor.username),
    subscribed: entry.viewer.involvement.includes('subscribed'),
  });

  return projectGitlabPresentObservation({ ...entry, viewer: { involvement } });
}
