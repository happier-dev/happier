import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

import type { GitlabRequestResult } from '../http/gitlabClient.js';
import { projectGitlabSourceFailure } from '../sourceFailure.js';
import type { GitlabMutationSubjectV1 } from './preflight.js';
import {
  confirmGitlabItemMutation,
  gitlabWriteAnswerLost,
  preflightGitlabItemMutation,
} from './preflight.js';

type NamedRow = Readonly<{ projectId: number; iid: string }>;

export type GitlabMemberDeltaResult<TRow extends NamedRow> =
  | Readonly<{ kind: 'changed'; item: TRow }>
  | Readonly<{ kind: 'reconfirmationRequired'; observed: TRow }>
  | Readonly<{
    kind: 'refused';
    reason: 'mutationRejected';
    dispatched: true;
    messages?: readonly string[];
  }>
  | Readonly<{ kind: 'unconfirmed'; observed?: TRow; failure?: TriageSourceFailureV1 }>
  | Readonly<{ kind: 'unavailable'; failure: TriageSourceFailureV1 }>;

const MEMBERS_UNAVAILABLE_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'gitlab-member-list-unavailable',
  detail: 'GitLab did not return the member list needed to prove a delta.',
});

function deltaHolds(
  operation: 'add' | 'remove',
  selected: readonly string[],
  current: readonly string[],
): boolean {
  return operation === 'add'
    ? selected.every((name) => current.includes(name))
    : selected.every((name) => !current.includes(name));
}

/**
 * The one read-before-delta/write/confirm sequence shared by GitLab reviewer,
 * assignee, and label changes. The callback is only the provider-native write;
 * it cannot replace the preflight, confirmation, or preservation proof.
 */
export async function runGitlabMemberDelta<TRow extends NamedRow>(
  input: Readonly<{
    instance: Parameters<typeof preflightGitlabItemMutation>[0]['instance'];
    localRef: Readonly<{ kindId: string; entryId: string; collisionScope: string }>;
    subject: GitlabMutationSubjectV1<TRow>;
    expectedRevision: string;
    operation: 'add' | 'remove';
    selected: readonly string[];
    members: (row: TRow) => readonly string[] | undefined;
    write: (preflight: Extract<Awaited<ReturnType<typeof preflightGitlabItemMutation<TRow>>>, { ok: true }>) => Promise<
      GitlabRequestResult | Readonly<{ kind: 'unavailable'; failure: TriageSourceFailureV1 }>
    >;
    mutationErrors?: (body: unknown) => readonly string[];
  }>,
  context: PluginInvocationContext,
): Promise<GitlabMemberDeltaResult<TRow>> {
  const preflight = await preflightGitlabItemMutation({
    instance: input.instance,
    localRef: input.localRef,
    subject: input.subject,
    expectedRevision: input.expectedRevision,
  }, context);
  if (!preflight.ok) return preflight.refusal;

  const before = input.members(preflight.row);
  if (before === undefined) return { kind: 'unavailable', failure: MEMBERS_UNAVAILABLE_FAILURE };
  if (deltaHolds(input.operation, input.selected, before)) {
    return { kind: 'changed', item: preflight.row };
  }

  const write = await input.write(preflight);
  if (write.kind === 'unavailable') return write;
  if (write.kind === 'failed') {
    if (!gitlabWriteAnswerLost(write)) {
      return { kind: 'unavailable', failure: projectGitlabSourceFailure(write.failure) };
    }
  } else {
    const messages = input.mutationErrors?.(write.response.body) ?? [];
    if (messages.length > 0) {
      return { kind: 'refused', reason: 'mutationRejected', dispatched: true, messages };
    }
  }

  const confirmed = await confirmGitlabItemMutation(preflight);
  if (!confirmed.ok) return { kind: 'unconfirmed', failure: confirmed.failure };
  const after = input.members(confirmed.row);
  if (after === undefined || !deltaHolds(input.operation, input.selected, after)) {
    return { kind: 'unconfirmed', observed: confirmed.row };
  }

  const selected = new Set(input.selected);
  const unrelatedBefore = before.filter((name) => !selected.has(name));
  if (!unrelatedBefore.every((name) => after.includes(name))) {
    return { kind: 'unconfirmed', observed: confirmed.row };
  }
  return { kind: 'changed', item: confirmed.row };
}
