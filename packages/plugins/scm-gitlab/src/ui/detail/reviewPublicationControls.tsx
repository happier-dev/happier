import * as React from 'react';
import type { ReviewCommentPublicationVerdictV1 } from '@happier-dev/plugin-sdk/reviews';
import {
  Banner,
  Button,
  Form,
  Row,
  Stack,
  Status,
  Text,
  useExecutePluginAction,
  usePluginTranslation,
  type PluginActionExecution,
  type PluginTranslate,
  type ReviewCommentProposalReadV1,
  type ReviewCommentProposalWithBodyV1,
} from '@happier-dev/plugin-ui';
import {
  describeTriageSourceFailureV1,
  type TriageDetailSurfaceInputV1,
} from '@happier-dev/triage-protocol/v1';
import {
  completeTriagePostMutationIfNeeded,
  useTriagePostMutationCompletion,
} from '@happier-dev/triage-sources/ui';

import {
  GITLAB_PLUGIN_ID,
  GITLAB_TRIAGE_MUTATION_ACTION_IDS,
} from '../../triage/contribution.js';
import {
  GitlabIssueCommentInputV1Schema,
  GitlabMergeRequestReviewCommentCreateInputV1Schema,
  GitlabMergeRequestReviewPublicationInputV1Schema,
  GitlabMergeRequestThreadReplyInputV1Schema,
  GitlabReviewPublicationResultV1Schema,
  type GitlabReviewPublicationResultV1,
} from '../../triage/mutations/contracts.js';
import { GITLAB_CURRENT_INTENT_REJECTED_CODE } from './mutations.js';

export type GitlabStringReviewProposalV1 = ReviewCommentProposalWithBodyV1;
export type GitlabReviewProposalReadV1 = ReviewCommentProposalReadV1;

function localRefOf(input: TriageDetailSurfaceInputV1) {
  return {
    kindId: input.observation.entryRef.kindId,
    collisionScope: input.observation.entryRef.collisionScope,
    entryId: input.observation.entryRef.entryId,
  };
}

function publicationTargetOf(
  input: TriageDetailSurfaceInputV1,
  subtarget: null | Readonly<{ kindId: 'review-thread'; targetId: string }>,
) {
  return {
    providerId: 'gitlab',
    configuredAccountId: input.instance.binding.account.accountId,
    entryRef: {
      sourceId: `${GITLAB_PLUGIN_ID}/gitlab-forge`,
      kindId: input.observation.entryRef.kindId,
      collisionScope: input.observation.entryRef.collisionScope,
      entryId: input.observation.entryRef.entryId,
    },
    subtarget,
  };
}

function publicationEntry(proposal: GitlabStringReviewProposalV1) {
  return {
    happierCommentId: proposal.id,
    expectedServerRevision: proposal.serverRevision,
    anchor: proposal.anchor,
    snapshot: proposal.snapshot,
    body: proposal.body,
  };
}

function mutationTargetOf(input: TriageDetailSurfaceInputV1) {
  return {
    v: 1 as const,
    instance: input.instance,
    localRef: localRefOf(input),
  };
}

export function buildGitlabMergeRequestReviewPublicationInputV1(
  input: TriageDetailSurfaceInputV1,
  proposals: readonly GitlabStringReviewProposalV1[],
  verdict: ReviewCommentPublicationVerdictV1 | null,
  acknowledgedPreexistingDraftIds?: readonly string[],
) {
  const revision = input.observation.snapshot.reviewRevision;
  if (revision === undefined || (proposals.length === 0 && verdict === null)) return null;
  const parsed = GitlabMergeRequestReviewPublicationInputV1Schema.safeParse({
    ...mutationTargetOf(input),
    publicationPlan: {
      target: publicationTargetOf(input, null),
      baseRevision: revision.baseSha,
      headRevision: revision.headSha,
      entries: proposals.map(publicationEntry),
      verdict,
    },
    ...(acknowledgedPreexistingDraftIds === undefined
      ? {}
      : { acknowledgedPreexistingDraftIds }),
  });
  return parsed.success ? parsed.data : null;
}

export function buildGitlabMergeRequestReviewCommentCreateInputV1(
  input: TriageDetailSurfaceInputV1,
  proposal: GitlabStringReviewProposalV1,
) {
  const revision = input.observation.snapshot.reviewRevision;
  if (revision === undefined) return null;
  const parsed = GitlabMergeRequestReviewCommentCreateInputV1Schema.safeParse({
    ...mutationTargetOf(input),
    publicationPlan: {
      target: publicationTargetOf(input, null),
      baseRevision: revision.baseSha,
      headRevision: revision.headSha,
      entries: [publicationEntry(proposal)],
      verdict: null,
    },
  });
  return parsed.success ? parsed.data : null;
}

export function buildGitlabMergeRequestThreadReplyInputV1(
  input: TriageDetailSurfaceInputV1,
  proposal: GitlabStringReviewProposalV1,
  discussionId: string,
) {
  const parsed = GitlabMergeRequestThreadReplyInputV1Schema.safeParse({
    ...mutationTargetOf(input),
    discussionId,
    publicationPlan: {
      target: publicationTargetOf(input, { kindId: 'review-thread', targetId: discussionId }),
      baseRevision: null,
      headRevision: null,
      entries: [publicationEntry(proposal)],
      verdict: null,
    },
  });
  return parsed.success ? parsed.data : null;
}

export function buildGitlabIssueCommentPublicationInputV1(
  input: TriageDetailSurfaceInputV1,
  proposal: GitlabStringReviewProposalV1,
) {
  const parsed = GitlabIssueCommentInputV1Schema.safeParse({
    ...mutationTargetOf(input),
    publicationPlan: {
      target: publicationTargetOf(input, null),
      baseRevision: null,
      headRevision: null,
      entries: [publicationEntry(proposal)],
      verdict: null,
    },
  });
  return parsed.success ? parsed.data : null;
}

function publicationMayHaveChanged(execution: PluginActionExecution<unknown>): boolean {
  if (execution.status === 'error') {
    // Only the host's current-intent rejection proves the Action handler never ran. Any other
    // error may have followed dispatch, so the aggregate must perform its canonical exact get.
    return execution.code !== GITLAB_CURRENT_INTENT_REJECTED_CODE;
  }
  if (execution.status !== 'success') return false;
  const parsed = GitlabReviewPublicationResultV1Schema.safeParse(execution.result);
  if (!parsed.success || parsed.data.kind !== 'settled') return false;
  const outcomes = [
    ...parsed.data.publication.entries.map((entry) => entry.outcome),
    ...('outcome' in parsed.data.publication.verdict
      ? [parsed.data.publication.verdict.outcome]
      : []),
  ];
  return outcomes.some((outcome) => (
    outcome.kind === 'published' || outcome.kind === 'uncertain'
  ));
}

function PublicationResult({ result, text }: Readonly<{
  result: GitlabReviewPublicationResultV1;
  text: PluginTranslate;
}>): React.ReactElement {
  if (result.kind === 'rejected') {
    const title = result.reason === 'preexisting_drafts'
      ? text(
        'plugins.gitlab.ui.publication.preexistingDrafts',
        'GitLab already has unpublished drafts on this merge request',
      )
      : result.reason === 'base_advanced' || result.reason === 'head_advanced'
        || result.reason === 'start_advanced'
        ? text(
          'plugins.gitlab.ui.publication.changed',
          'Nothing was published because the merge request changed',
        )
        : result.reason === 'unsupported_anchor'
          ? text(
            'plugins.gitlab.ui.publication.anchorUnsupported',
            'GitLab cannot place one of these comments safely',
          )
          : result.reason === 'unsupported_verdict'
            ? text(
              'plugins.gitlab.ui.publication.verdictUnsupported',
              'GitLab does not support this review verdict safely',
            )
            : text(
              'plugins.gitlab.ui.publication.rejected',
              'Nothing was published because the review no longer passed its preflight checks',
            );
    const description = result.reason === 'preexisting_drafts'
      ? result.preexistingDraftCount === undefined
        ? text(
          'plugins.gitlab.ui.publication.preexistingDrafts.descriptionWithoutCount',
          'Happier left the existing drafts pending and published nothing. Continue only if you want to publish this Happier review without those drafts.',
        )
        : text(
          'plugins.gitlab.ui.publication.preexistingDrafts.description',
          'Happier left {count} existing draft(s) pending and published nothing. Continue only if you want to publish this Happier review without those drafts.',
          { count: result.preexistingDraftCount },
        )
      : result.failure === undefined
        ? undefined
        : describeTriageSourceFailureV1(result.failure, 'GitLab could not complete the publication preflight.');
    return <Banner tone="warning" title={title} description={description} />;
  }

  const outcomes = result.publication.entries.map((entry) => entry.outcome);
  const published = outcomes.filter((outcome) => outcome.kind === 'published').length;
  const uncertain = outcomes.filter((outcome) => outcome.kind === 'uncertain').length;
  const failed = outcomes.filter((outcome) => outcome.kind === 'failed').length;
  const skipped = outcomes.filter((outcome) => outcome.kind === 'skippedPriorFailure').length;
  const verdict = 'outcome' in result.publication.verdict
    ? result.publication.verdict.outcome.kind
    : 'notRequested';
  const complete = published === outcomes.length
    && uncertain === 0
    && failed === 0
    && skipped === 0
    && (verdict === 'published' || verdict === 'notRequested');
  const unknown = uncertain > 0 || verdict === 'uncertain';
  const detail = text(
    'plugins.gitlab.ui.publication.result',
    '{published}/{total} comments published; {uncertain} unconfirmed; {failed} failed; {skipped} not attempted. Verdict: {verdict}.',
    { published, total: outcomes.length, uncertain, failed, skipped, verdict },
  );
  const drafts = result.preexistingDraftCount > 0
    ? text(
      'plugins.gitlab.ui.publication.existingDraftsRemain',
      ' {count} existing GitLab draft(s) remain unpublished.',
      { count: result.preexistingDraftCount },
    )
    : '';
  const failure = result.failure === undefined
    ? ''
    : ` ${describeTriageSourceFailureV1(result.failure, '')}`;
  return (
    <Banner
      tone={complete ? 'success' : 'warning'}
      title={complete
        ? text('plugins.gitlab.ui.publication.complete', 'Review published')
        : unknown
          ? text('plugins.gitlab.ui.publication.unknown', 'Publication outcome unknown')
          : text('plugins.gitlab.ui.publication.partial', 'Review partially published')}
      description={`${detail}${drafts}${failure}`.trim()}
    />
  );
}

function PublicationOutcome({ execution }: Readonly<{
  execution: PluginActionExecution<unknown>;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  if (execution.status === 'idle' || execution.status === 'pending') return null;
  if (execution.status === 'outcomeUnknown') {
    return (
      <Banner
        tone="warning"
        title={text('plugins.gitlab.ui.publication.unknown', 'Publication outcome unknown')}
        description={text(
          'plugins.gitlab.ui.publication.unknown.description',
          'Reload this entry before deciding whether to try again. GitLab may already contain the comment.',
        )}
      />
    );
  }
  if (execution.status === 'error') {
    if (execution.code === GITLAB_CURRENT_INTENT_REJECTED_CODE) {
      return (
        <Banner
          tone="neutral"
          title={text('plugins.gitlab.ui.publication.cancelled', 'Publication canceled')}
          description={text(
            'plugins.gitlab.ui.publication.cancelled.description',
            'Nothing was sent to GitLab.',
          )}
        />
      );
    }
    return (
      <Banner
        tone="warning"
        title={text('plugins.gitlab.ui.publication.incomplete', 'Publication did not settle')}
        description={text(
          'plugins.gitlab.ui.publication.incomplete.description',
          'The Action ended without a readable provider result. Reload before trying again.',
        )}
      />
    );
  }
  const parsed = GitlabReviewPublicationResultV1Schema.safeParse(execution.result);
  if (!parsed.success) {
    return (
      <Banner
        tone="warning"
        title={text('plugins.gitlab.ui.publication.unreadable', 'The publication result is unreadable')}
        description={text(
          'plugins.gitlab.ui.publication.unreadable.description',
          'Reload this entry before deciding whether to try again.',
        )}
      />
    );
  }
  return <PublicationResult result={parsed.data} text={text} />;
}

function ProposalReadState({ read }: Readonly<{
  read: GitlabReviewProposalReadV1;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  if (read.status === 'loading') {
    return <Status tone="muted" label={text('plugins.gitlab.ui.publication.loading', 'Reading proposed review comments…')} />;
  }
  if (read.status === 'failed') {
    return (
      <Banner
        tone="danger"
        title={text('plugins.gitlab.ui.publication.proposalsFailed', 'Proposed review comments are unavailable')}
      />
    );
  }
  if (read.proposals.length === 0) {
    return <Status tone="muted" label={text('plugins.gitlab.ui.publication.empty', 'No proposed review comment is linked to this entry yet.')} />;
  }
  return null;
}

const GITLAB_VERDICT_CHOICES = Object.freeze(['none', 'comment', 'approve'] as const);
type GitlabVerdictChoice = (typeof GITLAB_VERDICT_CHOICES)[number];

export function GitlabMergeRequestPublicationControls({
  input,
  proposals,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  proposals: GitlabReviewProposalReadV1;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const completePostMutation = useTriagePostMutationCompletion();
  const submit = useExecutePluginAction({
    pluginId: GITLAB_PLUGIN_ID,
    localId: GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestSubmitReview,
  });
  const create = useExecutePluginAction({
    pluginId: GITLAB_PLUGIN_ID,
    localId: GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestReviewCommentCreate,
  });
  const [selectedIds, setSelectedIds] = React.useState<readonly string[]>([]);
  const [verdict, setVerdict] = React.useState<GitlabVerdictChoice>('none');
  const [summary, setSummary] = React.useState('');
  const [acknowledgement, setAcknowledgement] = React.useState<readonly string[] | null>(null);

  React.useEffect(() => {
    if (proposals.status !== 'ready') return;
    setSelectedIds((current) => {
      const retained = current.filter((id) => proposals.proposals.some((item) => item.id === id));
      return retained.length > 0 ? retained : proposals.proposals.map((proposal) => proposal.id);
    });
  }, [proposals]);

  React.useEffect(() => {
    setAcknowledgement(null);
  }, [selectedIds, summary, verdict]);

  const selected = proposals.proposals.filter((proposal) => selectedIds.includes(proposal.id));
  const summaryBody = summary.trim();
  const verdictValue: ReviewCommentPublicationVerdictV1 | null = verdict === 'none'
    ? null
    : summaryBody === ''
      ? null
      : { kind: verdict, body: summaryBody };
  const verdictNeedsBody = verdict !== 'none' && summaryBody === '';
  const submitPayload = buildGitlabMergeRequestReviewPublicationInputV1(
    input,
    selected,
    verdictValue,
  );
  const acknowledgedPayload = acknowledgement === null
    ? null
    : buildGitlabMergeRequestReviewPublicationInputV1(
      input,
      selected,
      verdictValue,
      acknowledgement,
    );
  const createPayload = selected.length === 1
    ? buildGitlabMergeRequestReviewCommentCreateInputV1(input, selected[0]!)
    : null;

  const runSubmit = React.useCallback((payload: NonNullable<typeof submitPayload>) => {
    void submit.execute(payload).then(async (settled) => {
      if (settled.status === 'success') {
        const parsed = GitlabReviewPublicationResultV1Schema.safeParse(settled.result);
        if (parsed.success && parsed.data.kind === 'rejected'
          && parsed.data.reason === 'preexisting_drafts'
          && parsed.data.preexistingDraftIds !== undefined
        ) setAcknowledgement(parsed.data.preexistingDraftIds);
        else setAcknowledgement(null);
      }
      await completeTriagePostMutationIfNeeded(
        completePostMutation,
        settled,
        publicationMayHaveChanged,
      );
    });
  }, [completePostMutation, submit]);

  const runCreate = React.useCallback(() => {
    if (createPayload === null) return;
    void create.execute(createPayload).then((settled) => completeTriagePostMutationIfNeeded(
      completePostMutation,
      settled,
      publicationMayHaveChanged,
    ));
  }, [completePostMutation, create, createPayload]);

  return (
    <Stack gap="medium">
      <Stack gap="small">
        <Text variant="label" valueKey="plugins.gitlab.ui.publication.title" fallback="Publish review" />
        <Text
          variant="caption"
          tone="neutral"
          valueKey="plugins.gitlab.ui.publication.description"
          fallback="Publish proposed comments linked to this merge request. GitLab’s unrelated drafts stay pending."
        />
      </Stack>
      <ProposalReadState read={proposals} />
      {proposals.proposals.length === 0 ? null : (
        <Form.Select
          label={text('plugins.gitlab.ui.publication.comments', 'Review comments')}
          options={proposals.proposals.map((proposal) => ({
            value: proposal.id,
            label: proposal.body,
          }))}
          value={selectedIds}
          multiple
          onChange={(value) => {
            if (Array.isArray(value)) {
              setSelectedIds(value.filter((item): item is string => typeof item === 'string'));
            }
          }}
        />
      )}
      <Form.Select
        label={text('plugins.gitlab.ui.publication.verdict', 'Review verdict')}
        options={GITLAB_VERDICT_CHOICES.map((value) => ({
          value,
          label: value === 'none'
            ? text('plugins.gitlab.ui.publication.verdict.none', 'No verdict')
            : value === 'approve'
              ? text('plugins.gitlab.ui.publication.verdict.approve', 'Approve')
              : text('plugins.gitlab.ui.publication.verdict.comment', 'Comment'),
        }))}
        value={verdict}
        onChange={(value) => {
          const next = GITLAB_VERDICT_CHOICES.find((candidate) => candidate === value);
          if (next !== undefined) setVerdict(next);
        }}
      />
      <Form.TextField
        label={text('plugins.gitlab.ui.publication.summary', 'Review summary')}
        value={summary}
        onChange={setSummary}
      />
      {verdictNeedsBody ? (
        <Text
          variant="caption"
          tone="warning"
          valueKey="plugins.gitlab.ui.publication.summaryRequired"
          fallback="Add a summary before publishing this verdict."
        />
      ) : null}
      <Row gap="small">
        <Button
          title={text('plugins.gitlab.ui.publication.submit', 'Submit review')}
          variant="primary"
          disabled={submitPayload === null || verdictNeedsBody || acknowledgement !== null}
          busy={submit.execution.status === 'pending'}
          onPress={() => {
            if (submitPayload !== null) runSubmit(submitPayload);
          }}
        />
        <Button
          title={text('plugins.gitlab.ui.publication.createComment', 'Publish selected comment')}
          variant="secondary"
          disabled={createPayload === null}
          busy={create.execution.status === 'pending'}
          onPress={runCreate}
        />
      </Row>
      <PublicationOutcome execution={submit.execution} />
      {acknowledgedPayload === null ? null : (
        <Button
          title={text(
            'plugins.gitlab.ui.publication.continueWithoutDrafts',
            'Continue without publishing existing drafts',
          )}
          variant="secondary"
          busy={submit.execution.status === 'pending'}
          onPress={() => runSubmit(acknowledgedPayload)}
        />
      )}
      <PublicationOutcome execution={create.execution} />
    </Stack>
  );
}

export function GitlabThreadReplyPublicationControl({
  input,
  discussionId,
  proposals,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  discussionId: string;
  proposals: GitlabReviewProposalReadV1;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const completePostMutation = useTriagePostMutationCompletion();
  const reply = useExecutePluginAction({
    pluginId: GITLAB_PLUGIN_ID,
    localId: GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestThreadReply,
  });
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const selected = proposals.proposals.find((proposal) => proposal.id === selectedId) ?? null;
  const payload = selected === null
    ? null
    : buildGitlabMergeRequestThreadReplyInputV1(input, selected, discussionId);
  return (
    <Stack gap="small">
      <Text variant="label" valueKey="plugins.gitlab.ui.publication.reply.title" fallback="Publish a proposed reply" />
      {proposals.proposals.length === 0 ? null : (
        <Form.Select
          label={text('plugins.gitlab.ui.publication.reply.proposal', 'Proposed reply')}
          options={proposals.proposals.map((proposal) => ({
            value: proposal.id,
            label: proposal.body,
          }))}
          {...(selectedId === null ? {} : { value: selectedId })}
          onChange={(value) => setSelectedId(typeof value === 'string' ? value : null)}
        />
      )}
      <Button
        title={text('plugins.gitlab.ui.publication.reply.publish', 'Publish reply')}
        variant="secondary"
        disabled={payload === null}
        busy={reply.execution.status === 'pending'}
        onPress={() => {
          if (payload === null) return;
          void reply.execute(payload).then((settled) => completeTriagePostMutationIfNeeded(
            completePostMutation,
            settled,
            publicationMayHaveChanged,
          ));
        }}
      />
      <PublicationOutcome execution={reply.execution} />
    </Stack>
  );
}

export function GitlabIssueCommentPublicationControl({
  input,
  proposals,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  proposals: GitlabReviewProposalReadV1;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const completePostMutation = useTriagePostMutationCompletion();
  const comment = useExecutePluginAction({
    pluginId: GITLAB_PLUGIN_ID,
    localId: GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueComment,
  });
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const selected = proposals.proposals.find((proposal) => proposal.id === selectedId) ?? null;
  const payload = selected === null
    ? null
    : buildGitlabIssueCommentPublicationInputV1(input, selected);
  return (
    <Stack gap="small">
      <Text variant="label" valueKey="plugins.gitlab.ui.publication.issue.title" fallback="Publish a proposed comment" />
      <ProposalReadState read={proposals} />
      {proposals.proposals.length === 0 ? null : (
        <Form.Select
          label={text('plugins.gitlab.ui.publication.issue.proposal', 'Proposed comment')}
          options={proposals.proposals.map((proposal) => ({
            value: proposal.id,
            label: proposal.body,
          }))}
          {...(selectedId === null ? {} : { value: selectedId })}
          onChange={(value) => setSelectedId(typeof value === 'string' ? value : null)}
        />
      )}
      <Button
        title={text('plugins.gitlab.ui.publication.issue.publish', 'Publish comment')}
        variant="primary"
        disabled={payload === null}
        busy={comment.execution.status === 'pending'}
        onPress={() => {
          if (payload === null) return;
          void comment.execute(payload).then((settled) => completeTriagePostMutationIfNeeded(
            completePostMutation,
            settled,
            publicationMayHaveChanged,
          ));
        }}
      />
      <PublicationOutcome execution={comment.execution} />
    </Stack>
  );
}
