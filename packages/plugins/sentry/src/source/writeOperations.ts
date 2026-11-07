import type { SentrySourceContext } from '../api/sentryApiClient.js';
import {
  TriageTaskWriteResultV1Schema,
  type TriageTaskWriteResultV1,
  type TriageSourceObservationV1,
  type TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';
import { settleAtMostOnceProviderWrite } from '@happier-dev/triage-sources/runtime';

import { createSentryApiClient, type SentryApiOutcomeV1, type SentryIssueUpdateV1 } from '../api/sentryApiClient.js';
import { classifySentryFailure } from '../api/sentryFailure.js';
import { readSentryIssue, type SentryGetOutcomeV1 } from '../entries/getIssueOutcome.js';
import { SENTRY_FAILURE_CODES } from '../sentryContracts.js';
import { admitSentryEntryInvocation } from './operations.js';
import { toTriagePresentObservation, toTriageFailure } from './observation.js';
import { SentryIssueAssignInputV1Schema, SentryIssueWriteInputV1Schema } from './writeContracts.js';

type Present = Extract<TriageSourceObservationV1, { kind: 'present' }>;
type Target = ReturnType<typeof SentryIssueWriteInputV1Schema.parse>;

async function writeSentryIssue(
  target: Target,
  update: SentryIssueUpdateV1,
  context: SentrySourceContext,
): Promise<TriageTaskWriteResultV1> {
  const admitted = admitSentryEntryInvocation({
    localInstanceKey: target.instance.localInstanceKey,
    configurationToken: target.instance.configuration.token,
    localRef: target.localRef,
  });
  if (!admitted.ok) return { kind: 'failed', failure: admitted.failure };
  const client = await createSentryApiClient(context, {
    account: target.instance.binding.account, deployment: admitted.deployment, nowMs: Date.now,
  });
  const read = () => readSentryIssue(client, admitted.instance, target.localRef.entryId);
  const before = await read();
  if (before.kind === 'merged') return { kind: 'refused', reason: 'sentry-issue-merged' };
  if (before.kind === 'unresolved') return { kind: 'failed', failure: toTriageFailure(before.failure) };
  if (context.signal.aborted) {
    return { kind: 'failed', failure: { class: 'transient', code: SENTRY_FAILURE_CODES.cancelled } };
  }

  const matches = (current: Extract<SentryGetOutcomeV1, { kind: 'present' }>) => (
    'status' in update
      ? current.nativeStatus === update.status
        && (update.status !== 'ignored' || current.nativeSubstatus === update.substatus)
      : update.assignedTo === null ? current.assignedTo === null
      : current.assignedTo !== null && current.assignedTo !== undefined
        && `${current.assignedTo.type}:${current.assignedTo.id}` === update.assignedTo
  );
  const settlement = await settleAtMostOnceProviderWrite<SentryApiOutcomeV1, Present, TriageSourceFailureV1>({
    dispatch: () => client.updateIssue({
      organizationId: admitted.instance.organizationId,
      issueId: target.localRef.entryId,
      update,
    }),
    // A successful response or an answer-lost/server failure requires a fresh read.
    // This invocation never replays even a naturally idempotent PUT.
    mayHaveChanged: (outcome) => outcome.kind === 'failed'
      || outcome.response.status >= 500
      || (outcome.response.status >= 200 && outcome.response.status < 300),
    confirm: async () => {
      const current = await read();
      if (current.kind === 'unresolved') return { kind: 'uncertain', failure: toTriageFailure(current.failure) };
      if (current.kind === 'merged') return { kind: 'uncertain' };
      const observation = toTriagePresentObservation(current.snapshot);
      return { kind: matches(current) ? 'applied' : 'uncertain', observation };
    },
  });
  if (settlement.kind !== 'settled') return TriageTaskWriteResultV1Schema.parse(settlement);
  const outcome = settlement.result;
  const failure = outcome.kind === 'failed' ? outcome.failure : classifySentryFailure({
    kind: 'status', operation: 'issue', nowMs: Date.now(), response: outcome.response,
  });
  return { kind: 'failed', failure: toTriageFailure(failure) };
}

export async function resolveSentryIssue(input: unknown, context: SentrySourceContext): Promise<TriageTaskWriteResultV1> {
  return writeSentryIssue(SentryIssueWriteInputV1Schema.parse(input), { status: 'resolved' }, context);
}

export async function archiveSentryIssue(input: unknown, context: SentrySourceContext): Promise<TriageTaskWriteResultV1> {
  return writeSentryIssue(SentryIssueWriteInputV1Schema.parse(input), { status: 'ignored', substatus: 'archived_forever' }, context);
}

export async function assignSentryIssue(input: unknown, context: SentrySourceContext): Promise<TriageTaskWriteResultV1> {
  const { assignee, ...target } = SentryIssueAssignInputV1Schema.parse(input);
  return writeSentryIssue(target, { assignedTo: assignee === null ? null : `${assignee.type}:${assignee.id}` }, context);
}
