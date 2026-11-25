import * as React from 'react';
import {
  buildReviewCommentPublicationEntryV1, buildReviewPublicationSummaryV1, serializeReviewPublicationSummaryForForgeV1,
} from '@happier-dev/plugin-sdk/reviews';
import type { PluginUiActionControlController } from '@happier-dev/plugin-sdk/ui';
import {
  Banner,
  Button,
  Form,
  MarkdownEditor,
  ReviewPublicationEntry,
  ReviewPublicationSheet,
  type ReviewPublicationBlockedCause,
  reviewPublicationFindingTitle,
  reviewPublicationPublish,
  Stack,
  Status,
  Text,
  Action,
  projectPluginActionControlExecutionV1,
  isPluginActionConfirmationDeclined,
  useHappierReviewPublicationEvidence,
  usePluginTranslation,
  useReviewPublicationSelection,
  type PluginActionExecution,
  type PluginTranslate,
  type ReviewCommentProposalReadV1,
  type ReviewCommentProposalWithBodyV1,
} from '@happier-dev/plugin-ui';
import {
  describeTriageSourceFailureV1,
  isTriageSourceConnectedAccountInstanceV1,
  type TriageDetailSurfaceInputV1,
} from '@happier-dev/triage-protocol/v1';
import {
  completeTriagePostMutationIfNeeded,
  useTriagePostMutationCompletion,
  useTriageReviewPublicationDraftV1,
} from '@happier-dev/triage-sources/ui';

import {
  GITLAB_PLUGIN_ID,
  GITLAB_TRIAGE_MUTATION_ACTION_IDS,
} from '../../triage/contribution.js';
import {
  GITLAB_REVIEW_VERDICT_KINDS_V1,
  GitlabIssueCommentInputV1Schema,
  GitlabMergeRequestReviewCommentCreateInputV1Schema,
  GitlabMergeRequestReviewPublicationInputV1Schema,
  GitlabMergeRequestThreadReplyInputV1Schema,
  GitlabReviewPublicationResultV1Schema,
  type GitlabMergeRequestReviewPublicationInputV1,
  type GitlabReviewPublicationResultV1,
} from '../../triage/mutations/contracts.js';

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
  if (!isTriageSourceConnectedAccountInstanceV1(input.instance)) return null;
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

function mutationTargetOf(input: TriageDetailSurfaceInputV1) {
  return {
    v: 1 as const,
    instance: input.instance,
    localRef: localRefOf(input),
    routingToken: input.observation.locator.routingToken,
  };
}

export function buildGitlabMergeRequestReviewPublicationInputV1(
  input: TriageDetailSurfaceInputV1,
  proposals: readonly GitlabStringReviewProposalV1[],
  verdict: GitlabMergeRequestReviewPublicationInputV1['publicationPlan']['verdict'],
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
      entries: proposals.map(buildReviewCommentPublicationEntryV1),
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
      entries: [buildReviewCommentPublicationEntryV1(proposal)],
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
      entries: [buildReviewCommentPublicationEntryV1(proposal)],
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
      entries: [buildReviewCommentPublicationEntryV1(proposal)],
      verdict: null,
    },
  });
  return parsed.success ? parsed.data : null;
}

function publicationMayHaveChanged(execution: PluginActionExecution<unknown>): boolean {
  if (execution.status === 'error') {
    // Only the host's current-intent rejection proves the Action handler never ran. Any other
    // error may have followed dispatch, so the aggregate must perform its canonical exact get.
    return !isPluginActionConfirmationDeclined(execution);
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
        : describeTriageSourceFailureV1(result.failure, 'GitLab could not complete the publication preflight.', text);
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
    : ` ${describeTriageSourceFailureV1(result.failure, '', text)}`;
  return (
    <Banner
      tone={complete ? 'secondary' : 'warning'}
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
    if (isPluginActionConfirmationDeclined(execution)) {
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
  return <Stack gap="small">
    {read.status === 'loading'
      ? <Status tone="muted" label={text('plugins.gitlab.ui.publication.loading', 'Reading proposed review comments…')} />
      : read.status === 'failed' ? (
        <Banner
          tone="danger"
          title={text('plugins.gitlab.ui.publication.proposalsFailed', 'Proposed review comments are unavailable')}
        />
      ) : read.proposals.length === 0
      ? <Status tone="muted" label={text('plugins.gitlab.ui.publication.empty', 'No proposed review comment is linked to this entry yet.')} />
      : null}
    {read.loadMore === undefined ? null : <Button title={text('plugins.triage.detailStory.showMore', 'Read more')}
      variant="secondary" busy={read.status === 'loading'} onPress={read.loadMore} />}
  </Stack>;
}

const GITLAB_VERDICT_CHOICES = Object.freeze([
  'none',
  ...GITLAB_REVIEW_VERDICT_KINDS_V1,
] as const);
type GitlabVerdictChoice = (typeof GITLAB_VERDICT_CHOICES)[number];

/** The merge request's Publish step: an entry row while closed, its sheet while open; the draft survives either way. */
export function GitlabMergeRequestPublicationControls({
  input,
  proposals,
  open,
  onOpenChange,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  proposals: GitlabReviewProposalReadV1;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const completePostMutation = useTriagePostMutationCompletion();
  const [submitExecution, setSubmitExecution] = React.useState<PluginActionExecution<unknown>>({ status: 'idle' });
  const [createExecution, setCreateExecution] = React.useState<PluginActionExecution<unknown>>({ status: 'idle' });
  const [selectedIds, setSelectedIds] = useReviewPublicationSelection(proposals.proposals);
  const [verdict, setVerdict] = React.useState<GitlabVerdictChoice>('none');
  const [summary, setSummary] = React.useState('');
  const [acknowledgement, setAcknowledgement] = React.useState<readonly string[] | null>(null);
  const [includeWalkthrough, setIncludeWalkthrough] = React.useState(true);
  const { quality, walkthrough } = useHappierReviewPublicationEvidence(input.admittedReview?.reviewId, input.admittedReview?.roundOrdinal);

  React.useEffect(() => {
    setAcknowledgement(null);
  }, [includeWalkthrough, quality, selectedIds, summary, verdict, walkthrough]);

  const draftFindings = React.useMemo(
    () => proposals.proposals.map((proposal) => ({ id: proposal.id, title: reviewPublicationFindingTitle(proposal) })),
    [proposals.proposals],
  );
  const walkthroughOffered = verdict !== 'none' && (walkthrough?.length ?? 0) > 0;
  const draftWalkthrough = React.useMemo(
    () => walkthroughOffered ? { included: includeWalkthrough, setIncluded: setIncludeWalkthrough } : null,
    [includeWalkthrough, walkthroughOffered],
  );
  // The checklist and the switch edit the draft through the same change its mounted commands make.
  const draft = useTriageReviewPublicationDraftV1({ findings: draftFindings, selectedIds, setSelectedIds, walkthrough: draftWalkthrough });
  const selected = proposals.proposals.filter((proposal) => selectedIds.includes(proposal.id));
  const summaryBody = summary.trim();
  const headRevision = input.observation.snapshot.reviewRevision?.headSha;
  const publication = verdict === 'none' || !headRevision || summaryBody === ''
    ? null : { kind: verdict, summary: buildReviewPublicationSummaryV1({
        verdict: { kind: verdict, body: summaryBody },
        headRevision,
        findings: selected.flatMap(proposal => proposal.finding ? [{ ...proposal.finding, happierCommentId: proposal.id }] : []),
        reviewId: input.admittedReview?.reviewId,
        quality,
        walkthrough: includeWalkthrough ? walkthrough : undefined,
      }) };
  const verdictValue: GitlabMergeRequestReviewPublicationInputV1['publicationPlan']['verdict'] = publication === null
    ? null
    : { kind: publication.kind, body: serializeReviewPublicationSummaryForForgeV1(publication.summary) };
  const verdictNeedsBody = verdict !== 'none' && summaryBody === '';
  const publish = reviewPublicationPublish(text, { proposalCount: proposals.proposals.length, entryCount: selected.length });
  const submitPayload = publish.blocked ? null : buildGitlabMergeRequestReviewPublicationInputV1(
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

  const submitControl = (payload: NonNullable<typeof submitPayload>): PluginUiActionControlController => ({
    prepare() {
      setSubmitExecution({ status: 'pending' });
      return { input: payload };
    },
    onSettled(execution) {
      const settled = projectPluginActionControlExecutionV1(execution, text);
      setSubmitExecution(settled);
      if (settled.status === 'success') {
        const parsed = GitlabReviewPublicationResultV1Schema.safeParse(settled.result);
        if (parsed.success && parsed.data.kind === 'rejected'
          && parsed.data.reason === 'preexisting_drafts' && parsed.data.preexistingDraftIds !== undefined) {
          setAcknowledgement(parsed.data.preexistingDraftIds);
        } else setAcknowledgement(null);
      }
      void completeTriagePostMutationIfNeeded(completePostMutation, settled, publicationMayHaveChanged);
    },
  });
  const createControl: PluginUiActionControlController = {
    prepare() {
      if (createPayload === null) return null;
      setCreateExecution({ status: 'pending' });
      return { input: createPayload };
    },
    onSettled(execution) {
      const settled = projectPluginActionControlExecutionV1(execution, text);
      setCreateExecution(settled);
      void completeTriagePostMutationIfNeeded(completePostMutation, settled, publicationMayHaveChanged);
    },
  };

  // Why Publish cannot run, from the same facts the plan above is built from.
  const blocked: ReviewPublicationBlockedCause | null = submitPayload !== null && !verdictNeedsBody && acknowledgement === null
    ? null
    : proposals.status === 'loading' ? 'proposalsLoading'
    : proposals.status === 'failed' ? 'proposalsFailed'
      : !headRevision ? 'revisionUnknown'
        : acknowledgement !== null ? 'pendingDrafts'
          : verdictNeedsBody ? 'summaryMissing'
            : publish.blocked ? 'noFindingChecked'
              : selected.length === 0 && verdict === 'none' ? 'nothingToPublish'
                : 'planRejected';
  if (!open) {
    return <ReviewPublicationEntry forgeName="GitLab" proposalCount={proposals.proposals.length}
      selectedCount={selected.length} onPress={() => onOpenChange(true)} testID="gitlab-review-publication-entry" />;
  }
  return (
    <Stack gap="medium">
      <ReviewPublicationSheet
        forgeName="GitLab"
        testID="gitlab-review-publication"
        description={text('plugins.gitlab.ui.publication.description',
          'Publish proposed comments linked to this merge request. GitLab’s unrelated drafts stay pending.')}
        blocked={blocked}
        onCancel={() => onOpenChange(false)}
        verdict={{
          options: GITLAB_VERDICT_CHOICES.map((value) => ({
            value,
            label: value === 'none'
              ? text('plugins.gitlab.ui.publication.verdict.none', 'No verdict')
              : value === 'approve'
                ? text('plugins.gitlab.ui.publication.verdict.approve', 'Approve')
                : value === 'requestChanges'
                  ? text('plugins.gitlab.ui.publication.verdict.requestChanges', 'Request changes')
                  : text('plugins.gitlab.ui.publication.verdict.comment', 'Comment'),
          })),
          value: verdict,
          onChange: (value) => {
            const next = GITLAB_VERDICT_CHOICES.find((candidate) => candidate === value);
            if (next !== undefined) setVerdict(next);
          },
        }}
        summary={<MarkdownEditor
          accessibilityLabel={text('plugins.gitlab.ui.publication.summary', 'Summary')}
          value={summary}
          onChange={setSummary}
        />}
        notices={<ProposalReadState read={proposals} />}
        proposals={proposals.proposals}
        selectedIds={selectedIds}
        onSelectedIdsChange={draft.setSelectedIds}
        walkthrough={walkthroughOffered && walkthrough
          ? { included: includeWalkthrough, onChange: draft.setWalkthroughIncluded, stopCount: walkthrough.length }
          : null}
        preview={submitPayload?.publicationPlan.verdict && publication ? publication.summary : null}
        inlineCommentCount={submitPayload?.publicationPlan.entries.length ?? selected.length}
        // The quieter standalone comment first, Publish last: the one filled control ends the row.
        actions={<>
          <Action.Control
            title={text('plugins.gitlab.ui.publication.createComment', 'Publish selected comment')}
            variant="secondary"
            disabled={createPayload === null}
            action={{
              pluginId: GITLAB_PLUGIN_ID,
              localId: GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestReviewCommentCreate,
            }}
            controller={createControl}
          />
          <Action.Control
            title={publish.title}
            variant="primary"
            disabled={blocked !== null}
            action={{
              pluginId: GITLAB_PLUGIN_ID,
              localId: GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestSubmitReview,
            }}
            controller={submitPayload === null ? { prepare: () => null, onSettled() {} } : submitControl(submitPayload)}
          />
        </>}
      />
      <PublicationOutcome execution={submitExecution} />
      {acknowledgedPayload === null ? null : (
        <Action.Control
          title={text(
            'plugins.gitlab.ui.publication.continueWithoutDrafts',
            'Continue without publishing existing drafts',
          )}
          variant="secondary"
          action={{
            pluginId: GITLAB_PLUGIN_ID,
            localId: GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestSubmitReview,
          }}
          controller={submitControl(acknowledgedPayload)}
        />
      )}
      <PublicationOutcome execution={createExecution} />
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
  const [replyExecution, setReplyExecution] = React.useState<PluginActionExecution<unknown>>({ status: 'idle' });
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
      <Action.Control
        title={text('plugins.gitlab.ui.publication.reply.publish', 'Publish reply')}
        variant="secondary"
        disabled={payload === null}
        action={{
          pluginId: GITLAB_PLUGIN_ID,
          localId: GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestThreadReply,
        }}
        controller={{
          prepare() {
            if (payload === null) return null;
            setReplyExecution({ status: 'pending' });
            return { input: payload };
          },
          onSettled(execution) {
            const settled = projectPluginActionControlExecutionV1(execution, text);
            setReplyExecution(settled);
            void completeTriagePostMutationIfNeeded(completePostMutation, settled, publicationMayHaveChanged);
          },
        }}
      />
      <PublicationOutcome execution={replyExecution} />
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
  const [commentExecution, setCommentExecution] = React.useState<PluginActionExecution<unknown>>({ status: 'idle' });
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
      <Action.Control
        title={text('plugins.gitlab.ui.publication.issue.publish', 'Publish comment')}
        variant="primary"
        disabled={payload === null}
        action={{
          pluginId: GITLAB_PLUGIN_ID,
          localId: GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueComment,
        }}
        controller={{
          prepare() {
            if (payload === null) return null;
            setCommentExecution({ status: 'pending' });
            return { input: payload };
          },
          onSettled(execution) {
            const settled = projectPluginActionControlExecutionV1(execution, text);
            setCommentExecution(settled);
            void completeTriagePostMutationIfNeeded(completePostMutation, settled, publicationMayHaveChanged);
          },
        }}
      />
      <PublicationOutcome execution={commentExecution} />
    </Stack>
  );
}
