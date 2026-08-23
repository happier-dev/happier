/**
 * `gitlab/merge-request/mark-ready`.
 *
 * **There is no mark-as-ready endpoint** (`sources/SCM.md` §4.7.2). `draft` is a
 * boolean on the ordinary update, and `draft_status` appears only as a blocking
 * `detailed_merge_status` value — so this Action uses GitLab GraphQL
 * `mergeRequestSetDraft` against the configured binding's own `/api/graphql`,
 * with `draft: false`. It does **not** use REST `PUT { draft: false }`: that is
 * not GitLab's draft transition contract.
 *
 * The head pin is required because the draft→ready transition fans a
 * notification out to every named reviewer. That fan-out **is** the write: it
 * summons humans to review a specific commit set, and against a stale head they
 * are summoned to code the acting user never saw.
 */

import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

import { buildGitlabGraphqlUrl, requestGitlabJson } from '../http/gitlabClient.js';
import { boundGitlabText } from '../mapping/bounded.js';
import { GITLAB_DETAIL_BOUNDS_V1 } from '../detail/projection.js';
import { projectGitlabSourceFailure } from '../sourceFailure.js';
import {
  GitlabMergeRequestMarkReadyInputV1Schema,
  type GitlabMergeRequestMarkReadyResultV1,
} from './contracts.js';
import {
  GITLAB_MERGE_REQUEST_MUTATION_SUBJECT_V1,
  readGitlabProjectPath,
} from './mergeRequestRow.js';
import {
  confirmGitlabItemMutation,
  gitlabWriteAnswerLost,
  preflightGitlabItemMutation,
  GITLAB_MUTATION_INPUT_INVALID_FAILURE,
} from './preflight.js';

const PROJECT_PATH_UNAVAILABLE_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'gitlab-project-path-unavailable',
  detail: 'GitLab did not name the project path the GraphQL draft transition addresses.',
});

/**
 * The exact document. Variables rather than interpolation, so a project path or
 * IID can never become part of the query text.
 */
const SET_DRAFT_DOCUMENT = `mutation HappierMergeRequestSetDraft($projectPath: ID!, $iid: String!, $draft: Boolean!) {
  mergeRequestSetDraft(input: { projectPath: $projectPath, iid: $iid, draft: $draft }) {
    errors
    mergeRequest { draft }
  }
}`;

const MAX_PROVIDER_MESSAGES = 8;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

/**
 * GraphQL reports refusal in two places and both mean the same thing here: the
 * mutation did not happen. A `200` carrying either is a failed mutation, never a
 * success.
 */
function readMutationErrors(body: unknown): readonly string[] {
  const root = readRecord(body);
  if (root === null) return [];
  const messages: string[] = [];
  const transportErrors = root.errors;
  if (Array.isArray(transportErrors)) {
    for (const entry of transportErrors) {
      const message = typeof entry === 'string' ? entry : readRecord(entry)?.message;
      if (typeof message === 'string' && message.trim() !== '') messages.push(message.trim());
    }
  }
  const payloadErrors = readRecord(readRecord(root.data)?.mergeRequestSetDraft)?.errors;
  if (Array.isArray(payloadErrors)) {
    for (const entry of payloadErrors) {
      if (typeof entry === 'string' && entry.trim() !== '') messages.push(entry.trim());
    }
  }
  return messages
    .slice(0, MAX_PROVIDER_MESSAGES)
    .map((message) => boundGitlabText(message, GITLAB_DETAIL_BOUNDS_V1.labelUtf8Bytes).text);
}

export async function markGitlabMergeRequestReady(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GitlabMergeRequestMarkReadyResultV1> {
  const parsed = GitlabMergeRequestMarkReadyInputV1Schema.safeParse(input);
  if (!parsed.success) {
    return { kind: 'unavailable', failure: GITLAB_MUTATION_INPUT_INVALID_FAILURE };
  }
  const request = parsed.data;

  const preflight = await preflightGitlabItemMutation({
    instance: request.instance,
    localRef: request.localRef,
    subject: GITLAB_MERGE_REQUEST_MUTATION_SUBJECT_V1,
    expectedRevision: request.observedHeadSha,
  }, context);
  if (!preflight.ok) return preflight.refusal;

  // Already ready: the requested state holds, so there is nothing to notify
  // anybody about and no second write to make.
  if (!preflight.row.draft) return { kind: 'ready', item: preflight.row };
  if (preflight.row.state !== 'opened') {
    return {
      kind: 'refused',
      reason: 'notOpen',
      dispatched: false,
      observed: preflight.row,
    };
  }

  const projectPath = readGitlabProjectPath(preflight.body);
  if (projectPath === null) {
    return { kind: 'unavailable', failure: PROJECT_PATH_UNAVAILABLE_FAILURE };
  }

  const write = await requestGitlabJson({
    invocation: preflight.dependencies.invocation,
    url: buildGitlabGraphqlUrl(preflight.route.origin),
    method: 'POST',
    body: {
      query: SET_DRAFT_DOCUMENT,
      variables: { projectPath, iid: preflight.route.iid, draft: false },
    },
    fetcher: preflight.dependencies.fetcher,
    signal: preflight.dependencies.signal,
    nowMs: preflight.dependencies.nowMs,
  });
  if (write.kind === 'failed') {
    if (!gitlabWriteAnswerLost(write)) {
      return { kind: 'unavailable', failure: projectGitlabSourceFailure(write.failure) };
    }
    // The mutation left this process and no answer came back, so the draft may
    // already have cleared and its reviewer notifications may already have gone
    // out. The confirming read below settles it; a second POST would summon
    // those reviewers twice.
  } else {
    const messages = readMutationErrors(write.response.body);
    if (messages.length > 0) {
      return {
        kind: 'refused',
        reason: 'mutationRejected',
        dispatched: true,
        messages,
      };
    }
  }

  const confirmed = await confirmGitlabItemMutation(preflight);
  if (!confirmed.ok) return { kind: 'unconfirmed', failure: confirmed.failure };
  if (confirmed.row.draft) return { kind: 'unconfirmed', observed: confirmed.row };

  // The outcome this Action owes is not "draft is false". It is "the reviewers were
  // summoned to the commit set the user acted on", and GraphQL `mergeRequestSetDraft`
  // takes no head precondition — so the preflight's compare closes nothing after it
  // returns. A head that moved between that compare and this read means the fan-out
  // described a different commit set, or that somebody else cleared the draft; either
  // way the pinned outcome is UNPROVEN and `ready` would assert it.
  //
  // The pin is read through the subject descriptor rather than off the row, so the
  // fact compared here is the same fact the preflight compared. A head this read
  // cannot see does not compare equal to a pin, exactly as in the preflight.
  const observedPin = GITLAB_MERGE_REQUEST_MUTATION_SUBJECT_V1.observedPin(confirmed.row);
  if (observedPin !== request.observedHeadSha) {
    return { kind: 'unconfirmed', observed: confirmed.row };
  }
  return { kind: 'ready', item: confirmed.row };
}
