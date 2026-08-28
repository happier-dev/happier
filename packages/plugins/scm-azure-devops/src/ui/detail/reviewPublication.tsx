import * as React from 'react';
import type {
  ReviewCommentPublicationVerdictV1,
} from '@happier-dev/plugin-sdk/reviews';
import {
  Banner,
  Button,
  Form,
  Row,
  Stack,
  Status,
  Text,
  useExecutePluginAction,
  useReviewCommentProposalsForEntry,
  usePluginTranslation,
  type PluginActionExecution,
  type ReviewCommentProposalWithBodyV1,
  type PluginTranslate,
} from '@happier-dev/plugin-ui';
import {
  describeTriageSourceFailureV1 as failureDescription,
  type TriageDetailSurfaceInputV1,
} from '@happier-dev/triage-protocol/v1';
import {
  completeTriagePostMutationIfNeeded,
  useTriagePostMutationCompletion,
} from '@happier-dev/triage-sources/ui';

import { AZURE_DEVOPS_PLUGIN_ID } from '../../azureDevopsContracts.js';
import { AZURE_DEVOPS_TRIAGE_CONTRIBUTION_ID } from '../../triage/descriptor.js';
import { AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS } from '../../triage/mutationActions.js';
import {
  AzureReviewPublicationResultV1Schema,
  AzureSubmitReviewInputV1Schema,
  AzureThreadCommentCreateInputV1Schema,
  AzureThreadReplyInputV1Schema,
  type AzureReviewPublicationResultV1,
  type AzureSubmitReviewInputV1,
  type AzureThreadCommentCreateInputV1,
  type AzureThreadReplyInputV1,
} from '../../triage/mutations/contracts.js';
import type { AzureProjectedThreadRowV1 } from '../../triage/detail/projection.js';

function localRefOf(input: TriageDetailSurfaceInputV1) {
  return {
    kindId: input.observation.entryRef.kindId,
    collisionScope: input.observation.entryRef.collisionScope,
    entryId: input.observation.entryRef.entryId,
  };
}

function publicationTargetOf(
  input: TriageDetailSurfaceInputV1,
  subtarget: Readonly<{ kindId: 'review-thread'; targetId: string }> | null = null,
) {
  return {
    providerId: 'azure-devops',
    configuredAccountId: input.instance.binding.account.accountId,
    entryRef: {
      sourceId: `${AZURE_DEVOPS_PLUGIN_ID}/${AZURE_DEVOPS_TRIAGE_CONTRIBUTION_ID}`,
      kindId: input.observation.entryRef.kindId,
      collisionScope: input.observation.entryRef.collisionScope,
      entryId: input.observation.entryRef.entryId,
    },
    subtarget,
  };
}

function publicationEntries(proposals: readonly ReviewCommentProposalWithBodyV1[]) {
  return proposals.map((proposal) => ({
    happierCommentId: proposal.id,
    expectedServerRevision: proposal.serverRevision,
    anchor: proposal.anchor,
    snapshot: proposal.snapshot,
    body: proposal.body,
  }));
}

function mutationTargetOf(input: TriageDetailSurfaceInputV1) {
  return {
    v: 1 as const,
    instance: input.instance,
    localRef: localRefOf(input),
    routingToken: input.observation.locator.routingToken,
  };
}

export function buildAzureSubmitReviewInputV1(
  input: TriageDetailSurfaceInputV1,
  proposals: readonly ReviewCommentProposalWithBodyV1[],
  verdict: ReviewCommentPublicationVerdictV1 | null,
): AzureSubmitReviewInputV1 | null {
  const revision = input.observation.snapshot.reviewRevision;
  if (revision === undefined) return null;
  const parsed = AzureSubmitReviewInputV1Schema.safeParse({
    ...mutationTargetOf(input),
    publicationPlan: {
      target: publicationTargetOf(input),
      baseRevision: revision.baseSha,
      headRevision: revision.headSha,
      entries: publicationEntries(proposals),
      verdict,
    },
  });
  return parsed.success ? parsed.data : null;
}

export function buildAzureThreadCommentCreateInputV1(
  input: TriageDetailSurfaceInputV1,
  proposal: ReviewCommentProposalWithBodyV1,
): AzureThreadCommentCreateInputV1 | null {
  const revision = input.observation.snapshot.reviewRevision;
  if (revision === undefined) return null;
  const parsed = AzureThreadCommentCreateInputV1Schema.safeParse({
    ...mutationTargetOf(input),
    publicationPlan: {
      target: publicationTargetOf(input),
      baseRevision: revision.baseSha,
      headRevision: revision.headSha,
      entries: publicationEntries([proposal]),
      verdict: null,
    },
  });
  return parsed.success ? parsed.data : null;
}

export function buildAzureThreadReplyInputV1(
  input: TriageDetailSurfaceInputV1,
  proposal: ReviewCommentProposalWithBodyV1,
  threadId: string,
  parentCommentId: string,
): AzureThreadReplyInputV1 | null {
  const parsed = AzureThreadReplyInputV1Schema.safeParse({
    ...mutationTargetOf(input),
    threadId: Number(threadId),
    parentCommentId: Number(parentCommentId),
    publicationPlan: {
      target: publicationTargetOf(input, {
        kindId: 'review-thread',
        targetId: threadId,
      }),
      baseRevision: null,
      headRevision: null,
      entries: publicationEntries([proposal]),
      verdict: null,
    },
  });
  return parsed.success ? parsed.data : null;
}

function publicationMayHaveChanged(execution: PluginActionExecution<unknown>): boolean {
  if (execution.status !== 'success') return false;
  const parsed = AzureReviewPublicationResultV1Schema.safeParse(execution.result);
  // A success envelope with an unreadable provider result cannot prove that no remote effect
  // happened. Re-observe the target just as we do for an explicit uncertain result.
  if (!parsed.success) return true;
  if (parsed.data.kind !== 'settled') return false;
  const effects = parsed.data.publication.entries.map((entry) => entry.outcome);
  const verdict = 'outcome' in parsed.data.publication.verdict
    ? parsed.data.publication.verdict.outcome
    : null;
  return effects.some((effect) => effect.kind === 'published' || effect.kind === 'uncertain')
    || verdict?.kind === 'published'
    || verdict?.kind === 'uncertain'
    // For Azure's compound verdict, a failed markerless vote can still follow a confirmed,
    // user-visible summary thread. The canonical verdict result preserves that thread reference.
    || (verdict !== null && 'externalRef' in verdict && verdict.externalRef !== undefined);
}

function publicationRequiresReload(execution: PluginActionExecution<unknown>): boolean {
  if (execution.status === 'outcomeUnknown') return true;
  if (execution.status !== 'success') return false;
  const parsed = AzureReviewPublicationResultV1Schema.safeParse(execution.result);
  if (!parsed.success) return true;
  if (parsed.data.kind !== 'settled') return false;
  return parsed.data.publication.entries.some((entry) => entry.outcome.kind === 'uncertain')
    || ('outcome' in parsed.data.publication.verdict
      && parsed.data.publication.verdict.outcome.kind === 'uncertain');
}

function PublicationOutcome({ execution }: Readonly<{
  execution: PluginActionExecution<unknown>;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  if (execution.status === 'idle' || execution.status === 'pending') return null;
  if (execution.status === 'outcomeUnknown') {
    return <Banner tone="warning" title={text('plugins.azureDevops.ui.publication.unknown', 'Publication outcome unknown')} description={text('plugins.azureDevops.ui.publication.unknown.description', 'Reload the pull request before deciding whether to try again.')} />;
  }
  if (execution.status === 'error') {
    return <Banner tone="danger" title={text('plugins.azureDevops.ui.publication.failed', 'Review publication did not complete')} />;
  }
  const parsed = AzureReviewPublicationResultV1Schema.safeParse(execution.result);
  if (!parsed.success) {
    return <Banner tone="danger" title={text('plugins.azureDevops.ui.publication.unreadable', 'This build could not read what Azure DevOps answered.')} />;
  }
  return <PublicationResult result={parsed.data} text={text} />;
}

function PublicationResult({ result, text }: Readonly<{
  result: AzureReviewPublicationResultV1;
  text: PluginTranslate;
}>): React.ReactElement {
  if (result.kind === 'rejected') {
    const title = result.reason === 'base-advanced' || result.reason === 'head-advanced'
      ? text('plugins.azureDevops.ui.publication.stale', 'Nothing was published because the pull request changed.')
      : result.reason === 'unsupported-anchor'
        ? text('plugins.azureDevops.ui.publication.unsupportedAnchor', 'Nothing was published because Azure DevOps cannot place one of these comments safely.')
        : result.reason === 'thread-not-found'
          ? text('plugins.azureDevops.ui.publication.threadMissing', 'Nothing was published because this thread no longer exists.')
          : text('plugins.azureDevops.ui.publication.rejected', 'Nothing was published because the review no longer passed its preflight checks.');
    return (
      <Banner
        tone="warning"
        title={title}
        {...(result.failure === undefined
          ? {}
          : { description: failureDescription(result.failure, '') })}
      />
    );
  }
  const outcomes = result.publication.entries.map((entry) => entry.outcome);
  const published = outcomes.filter((outcome) => outcome.kind === 'published').length;
  const uncertain = outcomes.filter((outcome) => outcome.kind === 'uncertain').length;
  const failed = outcomes.filter((outcome) => outcome.kind === 'failed').length;
  const skipped = outcomes.filter((outcome) => outcome.kind === 'skippedPriorFailure').length;
  const verdict = 'outcome' in result.publication.verdict
    ? result.publication.verdict.outcome.kind
    : 'notRequested';
  const verdictSummaryPublished = 'outcome' in result.publication.verdict
    && 'externalRef' in result.publication.verdict.outcome
    && result.publication.verdict.outcome.externalRef !== undefined
    && result.publication.verdict.outcome.kind !== 'published';
  const complete = published === outcomes.length
    && uncertain === 0
    && failed === 0
    && (verdict === 'published' || verdict === 'notRequested');
  const counts = text(
    'plugins.azureDevops.ui.publication.result',
    '{published}/{total} comments published; {uncertain} unconfirmed; {failed} failed; {skipped} not attempted. Verdict: {verdict}.',
    { published, total: outcomes.length, uncertain, failed, skipped, verdict },
  );
  const detail = verdictSummaryPublished
    ? `${counts} ${text('plugins.azureDevops.ui.publication.summaryPublished', 'The review summary was published.')}`
    : counts;
  return (
    <Banner
      tone={complete ? 'success' : 'warning'}
      title={complete
        ? text('plugins.azureDevops.ui.publication.complete', 'Review published')
        : uncertain > 0 || verdict === 'uncertain'
          ? text('plugins.azureDevops.ui.publication.unknown', 'Publication outcome unknown')
          : text('plugins.azureDevops.ui.publication.partial', 'Review partially published')}
      description={result.failure === undefined
        ? detail
        : `${detail} ${failureDescription(result.failure, '')}`.trim()}
    />
  );
}

const VERDICTS = Object.freeze(['none', 'comment', 'approve', 'requestChanges'] as const);
type VerdictChoice = (typeof VERDICTS)[number];

export function AzureReviewPublicationControls({ input }: Readonly<{
  input: TriageDetailSurfaceInputV1;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const proposals = useReviewCommentProposalsForEntry({
    linkedSessionIds: input.linkedSessions.map((session) => session.sessionId),
    entry: { kind: 'pullRequest', url: input.observation.locator.webUrl },
  });
  const completion = useTriagePostMutationCompletion();
  const submit = useExecutePluginAction({ pluginId: AZURE_DEVOPS_PLUGIN_ID, localId: AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.submitReview });
  const create = useExecutePluginAction({ pluginId: AZURE_DEVOPS_PLUGIN_ID, localId: AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.threadCommentCreate });
  const [selectedIds, setSelectedIds] = React.useState<readonly string[]>([]);
  const [verdict, setVerdict] = React.useState<VerdictChoice>('none');
  const [summary, setSummary] = React.useState('');
  React.useEffect(() => {
    if (proposals.status !== 'ready') return;
    setSelectedIds((current) => {
      const retained = current.filter((id) => proposals.proposals.some((item) => item.id === id));
      return retained.length > 0 ? retained : proposals.proposals.map((proposal) => proposal.id);
    });
  }, [proposals]);
  const selected = proposals.proposals.filter((proposal) => selectedIds.includes(proposal.id));
  const body = summary.trim();
  const verdictValue: ReviewCommentPublicationVerdictV1 | null = verdict === 'none' || body === ''
    ? null
    : { kind: verdict, body };
  const submitPayload = buildAzureSubmitReviewInputV1(input, selected, verdictValue);
  // Mirrors the public Reviews routing owner: file-scoped proposals stay provider-preflighted;
  // anything without a file belongs in the real user-authored verdict summary.
  const selectedRequiresVerdict = selected.some((proposal) => !('filePath' in proposal.anchor));
  const createPayload = selected.length === 1
    ? buildAzureThreadCommentCreateInputV1(input, selected[0]!)
    : null;
  const execute = React.useCallback((kind: 'submit' | 'create') => {
    const action = kind === 'submit' ? submit : create;
    const payload = kind === 'submit' ? submitPayload : createPayload;
    if (payload === null) return;
    void action.execute(payload).then((settled) => completeTriagePostMutationIfNeeded(
      completion,
      settled,
      publicationMayHaveChanged,
    ));
  }, [completion, create, createPayload, submit, submitPayload]);
  const verdictNeedsBody = verdict !== 'none' && body === '';
  return (
    <Stack gap="small">
      <Text variant="label" valueKey="plugins.azureDevops.ui.publication.title" fallback="Publish review" />
      {proposals.status === 'loading' ? <Status tone="muted" label={text('plugins.azureDevops.ui.publication.loading', 'Reading proposed review comments…')} /> : null}
      {proposals.status === 'failed' ? <Banner tone="danger" title={text('plugins.azureDevops.ui.publication.proposalsFailed', 'Proposed review comments are unavailable')} /> : null}
      {proposals.status === 'ready' && proposals.proposals.length === 0 ? <Status tone="muted" label={text('plugins.azureDevops.ui.publication.empty', 'No proposed review comment is linked to this pull request yet.')} /> : null}
      {proposals.proposals.length === 0 ? null : (
        <Form.Select
          label={text('plugins.azureDevops.ui.publication.comments', 'Review comments')}
          options={proposals.proposals.map((proposal) => ({ value: proposal.id, label: proposal.body }))}
          value={selectedIds}
          multiple
          onChange={(value) => {
            if (Array.isArray(value)) setSelectedIds(value.filter((item): item is string => typeof item === 'string'));
          }}
        />
      )}
      <Form.Select
        label={text('plugins.azureDevops.ui.publication.verdict', 'Review verdict')}
        options={VERDICTS.map((value) => ({
          value,
          label: value === 'none' ? text('plugins.azureDevops.ui.publication.verdict.none', 'No verdict')
            : value === 'requestChanges' ? text('plugins.azureDevops.ui.publication.verdict.requestChanges', 'Request changes')
              : value === 'approve' ? text('plugins.azureDevops.ui.publication.verdict.approve', 'Approve')
                : text('plugins.azureDevops.ui.publication.verdict.comment', 'Comment'),
        }))}
        value={verdict}
        onChange={(value) => {
          const next = VERDICTS.find((candidate) => candidate === value);
          if (next !== undefined) setVerdict(next);
        }}
      />
      <Form.TextField label={text('plugins.azureDevops.ui.publication.summary', 'Review summary')} value={summary} onChange={setSummary} />
      {verdictNeedsBody ? <Text variant="caption" tone="warning" valueKey="plugins.azureDevops.ui.publication.summaryRequired" fallback="Add a summary before publishing this verdict." /> : null}
      {selectedRequiresVerdict && verdict === 'none' ? (
        <Text
          variant="caption"
          tone="warning"
          valueKey="plugins.azureDevops.ui.publication.diffLessNeedsVerdict"
          fallback="Submitting comments without a file as a review requires a verdict and summary."
        />
      ) : null}
      <Row gap="small">
        <Button title={text('plugins.azureDevops.ui.publication.submit', 'Submit review')} variant="primary" disabled={submitPayload === null || verdictNeedsBody || (selectedRequiresVerdict && verdict === 'none') || publicationRequiresReload(submit.execution)} busy={submit.execution.status === 'pending'} onPress={() => execute('submit')} />
        <Button title={text('plugins.azureDevops.ui.publication.createThread', 'Publish as new thread')} variant="secondary" disabled={createPayload === null || publicationRequiresReload(create.execution)} busy={create.execution.status === 'pending'} onPress={() => execute('create')} />
      </Row>
      <PublicationOutcome execution={submit.execution} />
      <PublicationOutcome execution={create.execution} />
    </Stack>
  );
}

export function AzureThreadReplyPublicationControl({ input, thread }: Readonly<{
  input: TriageDetailSurfaceInputV1;
  thread: AzureProjectedThreadRowV1;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const proposals = useReviewCommentProposalsForEntry({
    linkedSessionIds: input.linkedSessions.map((session) => session.sessionId),
    entry: { kind: 'pullRequest', url: input.observation.locator.webUrl },
  });
  const completion = useTriagePostMutationCompletion();
  const reply = useExecutePluginAction({ pluginId: AZURE_DEVOPS_PLUGIN_ID, localId: AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.threadReply });
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const selected = proposals.proposals.find((proposal) => proposal.id === selectedId) ?? null;
  const parent = thread.comments.at(-1);
  const payload = selected === null || parent === undefined
    ? null
    : buildAzureThreadReplyInputV1(input, selected, thread.id, parent.id);
  return (
    <Stack gap="small">
      <Text variant="label" valueKey="plugins.azureDevops.ui.publication.reply.title" fallback="Publish a proposed reply" />
      {proposals.status === 'loading' ? <Status tone="muted" label={text('plugins.azureDevops.ui.publication.loading', 'Reading proposed review comments…')} /> : null}
      {proposals.status === 'failed' ? <Banner tone="danger" title={text('plugins.azureDevops.ui.publication.proposalsFailed', 'Proposed review comments are unavailable')} /> : null}
      {proposals.proposals.length > 0 ? (
        <Form.Select
          label={text('plugins.azureDevops.ui.publication.reply.proposal', 'Proposed reply')}
          options={proposals.proposals.map((proposal) => ({ value: proposal.id, label: proposal.body }))}
          {...(selectedId === null ? {} : { value: selectedId })}
          onChange={(value) => setSelectedId(typeof value === 'string' ? value : null)}
        />
      ) : null}
      <Button
        title={text('plugins.azureDevops.ui.publication.reply.publish', 'Publish reply')}
        variant="secondary"
        disabled={payload === null || publicationRequiresReload(reply.execution)}
        busy={reply.execution.status === 'pending'}
        onPress={() => {
          if (payload === null) return;
          void reply.execute(payload).then((settled) => completeTriagePostMutationIfNeeded(
            completion,
            settled,
            publicationMayHaveChanged,
          ));
        }}
      />
      <PublicationOutcome execution={reply.execution} />
    </Stack>
  );
}
