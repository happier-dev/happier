import * as React from 'react';
import type {
  ReviewCommentPublicationPlanV1,
} from '@happier-dev/plugin-sdk/reviews';
import {
  Banner,
  Button,
  Divider,
  Form,
  Row,
  Stack,
  Text,
  useExecutePluginAction,
  useReviewCommentProposalsForEntry,
  usePluginTranslation,
  type PluginActionExecution,
  type PluginTranslate,
  type TextTone,
} from '@happier-dev/plugin-ui';
import {
  describeTriageSourceFailureV1 as failureDescription,
  type TriageDetailSurfaceInputV1,
} from '@happier-dev/triage-protocol/v1';
import {
  completeTriagePostMutationIfNeeded,
  useTriagePostMutationCompletion,
} from '@happier-dev/triage-sources/ui';

import { BITBUCKET_PLUGIN_ID } from '../../bitbucketContracts.js';
import { BITBUCKET_TRIAGE_MUTATION_ACTION_IDS } from '../../triage/source/mutationActions.js';
import {
  BitbucketCommentResolutionResultV1Schema,
  BitbucketMutationResultV1Schema,
  BitbucketReviewPublicationResultV1Schema,
  type BitbucketMergeStrategyV1,
} from '../../triage/source/mutationContracts.js';
import type { BitbucketProjectedCommentRowV1 } from '../../triage/detail/projection.js';
import type { BitbucketDetailOverviewV1 } from '../../triage/source/detail.js';

import { useBitbucketEntryLocalRef } from './panelReaders.js';

/**
 * The Bitbucket Cloud pull-request writes, as controls a user can actually press.
 *
 * Both Actions declare `placementBindings: ['detailsPanel']`, and that declaration surfaces
 * nothing here: the only host consumer of an Action placement named `detailsPanel` is the browser
 * shell, over the separate `browserAction` contribution family. A Triage source's detail renderer
 * is a plugin artifact the host mounts whole, so an Action it does not render is an Action nobody
 * can reach. These controls are that rendering, and nothing more — the confirmation in front of
 * each write is host-owned manifest metadata, raised by the canonical Action gate before the
 * handler runs, so nothing here asks "are you sure".
 *
 * Every value that decides what the forge does is chosen in the open, beside the button:
 *
 * - The merge strategy is **required and unselected on arrival**, because Bitbucket writes it
 *   permanently into the repository's history and none of its three is a safe guess.
 * - The source-branch decision is a visible switch rather than a wire default, so the value the
 *   request carries is one the user looked at. `close_source_branch` is never defaulted at the
 *   Action, and it is not defaulted invisibly here either.
 * - The head pin is the exact commit this mount was handed — `observation.nativeRevision`, which
 *   both sources publish as the source-branch commit their read observed. It is never re-read at
 *   press time: that would be the race the pin exists to close.
 *
 * A write that settles is reported where it happened. `applied`, `pending`, `refused` and
 * `rejected` are four different facts and are never collapsed: a queued merge is not a merge, a
 * refusal wrote nothing, and an outcome the transport could not settle must not invite a blind
 * retry.
 */

/** What one settled write is presented as. */
type SettledMutationV1 = Readonly<{
  tone: TextTone;
  title: string;
  detail?: string;
}>;

const MERGE_ACTION = Object.freeze({
  pluginId: BITBUCKET_PLUGIN_ID,
  localId: BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.merge,
});
const DECLINE_ACTION = Object.freeze({
  pluginId: BITBUCKET_PLUGIN_ID,
  localId: BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.decline,
});
const RESOLVE_COMMENT_ACTION = Object.freeze({
  pluginId: BITBUCKET_PLUGIN_ID,
  localId: BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.resolveComment,
});
const UNRESOLVE_COMMENT_ACTION = Object.freeze({
  pluginId: BITBUCKET_PLUGIN_ID,
  localId: BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.unresolveComment,
});
const SUBMIT_REVIEW_ACTION = Object.freeze({
  pluginId: BITBUCKET_PLUGIN_ID,
  localId: BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.submitReview,
});
const CREATE_REVIEW_COMMENT_ACTION = Object.freeze({
  pluginId: BITBUCKET_PLUGIN_ID,
  localId: BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.createReviewComment,
});
const REPLY_REVIEW_COMMENT_ACTION = Object.freeze({
  pluginId: BITBUCKET_PLUGIN_ID,
  localId: BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.replyToReviewComment,
});

/**
 * The host code that proves the user was asked and said no.
 *
 * It settles before the Action handler is entered, so it is the one rejection this panel may
 * describe as having written nothing. Every other failure code is reported as an incomplete
 * write, because the generic transport cannot tell a refused dispatch from a handler that ran.
 */
const CURRENT_INTENT_REJECTED = 'plugin_action_current_intent_rejected';

/**
 * The facts that are true of every write before its own result is read.
 *
 * Every dispatch can end in the host's own refusal, an unknown outcome or a transport failure, and
 * those three sentences do not vary with the write that ran. The `published` arm carries the value
 * the handler returned, so each caller reads its own published result from one owner — a second
 * copy is how one control would start describing a declined confirmation as a provider failure.
 */
function projectExecutionEnvelope(
  execution: PluginActionExecution<unknown>,
  text: PluginTranslate,
): SettledMutationV1 | null | Readonly<{ published: unknown }> {
  if (execution.status === 'idle' || execution.status === 'pending') return null;
  if (execution.status === 'outcomeUnknown') {
    return {
      tone: 'warning',
      title: text(
        'plugins.bitbucket.ui.mutations.outcomeUnknown',
        'The outcome is unknown. Reload this pull request before trying again.',
      ),
    };
  }
  if (execution.status === 'error') {
    return execution.code === CURRENT_INTENT_REJECTED
      ? {
        tone: 'neutral',
        title: text(
          'plugins.bitbucket.ui.mutations.declined',
          'You declined the confirmation, so nothing was written.',
        ),
      }
      : {
        tone: 'danger',
        title: text(
          'plugins.bitbucket.ui.mutations.failed',
          'This did not complete. Reload this pull request to see where it stands.',
        ),
      };
  }
  return { published: execution.result };
}

/** Whether an envelope reached the handler's own published result. */
function isPublishedResult(
  envelope: SettledMutationV1 | null | Readonly<{ published: unknown }>,
): envelope is Readonly<{ published: unknown }> {
  return envelope !== null && 'published' in envelope;
}

/** What this build says when it cannot read the result its own Action published. */
function unreadableResult(text: PluginTranslate): SettledMutationV1 {
  return {
    tone: 'danger',
    title: text(
      'plugins.bitbucket.ui.mutations.unreadable',
      'This build could not read what Bitbucket answered.',
    ),
  };
}

/** Whether Bitbucket's pull-request result established that provider state may have changed. */
export function bitbucketEntryWriteMayHaveChangedProviderStateV1(
  execution: PluginActionExecution<unknown>,
): boolean {
  if (execution.status !== 'success') return false;
  const parsed = BitbucketMutationResultV1Schema.safeParse(execution.result);
  return parsed.success && (
    parsed.data.kind === 'applied'
    || parsed.data.kind === 'pending'
    || parsed.data.kind === 'uncertain'
  );
}

/** Whether Bitbucket's comment result established that provider state may have changed. */
export function bitbucketCommentWriteMayHaveChangedProviderStateV1(
  execution: PluginActionExecution<unknown>,
): boolean {
  if (execution.status !== 'success') return false;
  const parsed = BitbucketCommentResolutionResultV1Schema.safeParse(execution.result);
  return parsed.success && (
    parsed.data.kind === 'applied'
    || parsed.data.kind === 'rejected'
    || parsed.data.kind === 'uncertain'
  );
}

/** Whether canonical review publication dispatched at least one possibly visible provider effect. */
export function bitbucketReviewPublicationMayHaveChangedProviderStateV1(
  execution: PluginActionExecution<unknown>,
): boolean {
  if (execution.status !== 'success') return false;
  const parsed = BitbucketReviewPublicationResultV1Schema.safeParse(execution.result);
  if (!parsed.success || parsed.data.kind !== 'settled') return false;
  const verdict = parsed.data.publication.verdict;
  const effects = [
    ...parsed.data.publication.entries.map((entry) => entry.outcome),
    ...('kind' in verdict
      ? []
      : [verdict.outcome]),
  ];
  return effects.some((effect) => effect.kind === 'published' || effect.kind === 'uncertain');
}

function projectSettledMutation(
  operation: 'merge' | 'decline',
  execution: PluginActionExecution<unknown>,
  text: PluginTranslate,
): SettledMutationV1 | null {
  const envelope = projectExecutionEnvelope(execution, text);
  if (!isPublishedResult(envelope)) return envelope;

  const parsed = BitbucketMutationResultV1Schema.safeParse(envelope.published);
  if (!parsed.success) return unreadableResult(text);
  const result = parsed.data;
  switch (result.kind) {
    case 'applied':
      return {
        tone: 'success',
        title: operation === 'merge'
          ? text(
            'plugins.bitbucket.ui.mutations.merge.applied',
            'Merged. Bitbucket confirmed this pull request is merged.',
          )
          : text(
            'plugins.bitbucket.ui.mutations.decline.applied',
            'Declined. Bitbucket confirmed this pull request is declined.',
          ),
      };
    case 'pending':
      return {
        tone: 'warning',
        title: operation === 'merge'
          ? text(
            'plugins.bitbucket.ui.mutations.merge.pending',
            'Bitbucket accepted the merge but has not reported it as merged yet.',
          )
          : text(
            'plugins.bitbucket.ui.mutations.decline.pending',
            'Bitbucket accepted the decline but has not reported it yet.',
          ),
      };
    case 'refused':
      return {
        tone: 'warning',
        title: result.reason === 'head-advanced'
          ? text(
            'plugins.bitbucket.ui.mutations.refused.headAdvanced',
            'Nothing was written: new commits arrived after the ones you looked at.',
          )
          : text(
            'plugins.bitbucket.ui.mutations.refused.notOpen',
            'Nothing was written: this pull request is no longer open.',
          ),
      };
    case 'rejected':
      return {
        tone: 'danger',
        title: result.reason === 'provider-rejected'
          ? text(
            'plugins.bitbucket.ui.mutations.rejected.provider',
            "Bitbucket refused this write in the pull request's current state.",
          )
          : text(
            'plugins.bitbucket.ui.mutations.rejected.oversized',
            'Bitbucket timed out on a response too large to return.',
          ),
      };
    case 'unchanged':
      return {
        tone: 'warning',
        title: text(
          'plugins.bitbucket.ui.mutations.unchanged',
          'Bitbucket did not apply this write.',
        ),
      };
    case 'uncertain':
      return {
        tone: 'warning',
        title: text(
          'plugins.bitbucket.ui.mutations.uncertain',
          'Bitbucket may have applied this write. Reload the pull request before trying again.',
        ),
        ...(result.failure === undefined ? {} : {
          detail: failureDescription(result.failure, ''),
        }),
      };
    case 'unavailable': {
      const title = text(
        'plugins.bitbucket.ui.mutations.unavailable',
        'Bitbucket could not complete this write.',
      );
      return { tone: 'danger', title, detail: failureDescription(result.failure, title) };
    }
  }
}

function SettledMutationBanner({
  settled,
}: Readonly<{ settled: SettledMutationV1 | null }>): React.ReactElement | null {
  if (settled === null) return null;
  return (
    <Banner
      tone={settled.tone}
      title={settled.title}
      {...(settled.detail === undefined ? {} : { description: settled.detail })}
    />
  );
}

function reviewPublicationBanner(
  execution: PluginActionExecution<unknown>,
  text: PluginTranslate,
): SettledMutationV1 | null {
  const envelope = projectExecutionEnvelope(execution, text);
  if (!isPublishedResult(envelope)) return envelope;
  const parsed = BitbucketReviewPublicationResultV1Schema.safeParse(envelope.published);
  if (!parsed.success) return unreadableResult(text);
  if (parsed.data.kind === 'rejected') return {
    tone: 'warning',
    title: text('plugins.bitbucket.ui.mutations.review.rejected', 'Nothing was published.'),
    detail: parsed.data.reason.replaceAll('_', ' '),
  };
  const verdict = parsed.data.publication.verdict;
  const effects = [
    ...parsed.data.publication.entries.map((entry) => entry.outcome),
    ...('kind' in verdict
      ? []
      : [verdict.outcome]),
  ];
  const published = effects.filter((effect) => effect.kind === 'published').length;
  const uncertain = effects.filter((effect) => effect.kind === 'uncertain').length;
  const failed = effects.length - published - uncertain;
  const summaryLanded = !('kind' in verdict)
    && verdict.outcome.kind !== 'published'
    && verdict.outcome.kind !== 'skippedPriorFailure'
    && verdict.outcome.externalRef !== undefined;
  const partialDetail = `${published} published · ${uncertain} uncertain · ${failed} not published`
    + (summaryLanded ? ' · review summary visible on Bitbucket' : '');
  return uncertain > 0
    ? { tone: 'warning', title: text('plugins.bitbucket.ui.mutations.review.uncertain', 'Some review effects are uncertain. Reload before trying again.'), detail: partialDetail }
    : failed > 0
      ? { tone: 'warning', title: text('plugins.bitbucket.ui.mutations.review.partial', 'The review was only partly published.'), detail: partialDetail }
      : { tone: 'success', title: text('plugins.bitbucket.ui.mutations.review.published', 'Bitbucket confirmed every review effect.'), detail: `${published} published` };
}

function bitbucketReviewPublicationTarget(
  input: TriageDetailSurfaceInputV1,
  subtarget: ReviewCommentPublicationPlanV1['target']['subtarget'],
): ReviewCommentPublicationPlanV1['target'] {
  return {
    providerId: 'bitbucket',
    configuredAccountId: input.instance.binding.account.accountId,
    subtarget,
    entryRef: {
      sourceId: `${BITBUCKET_PLUGIN_ID}/bitbucket-forge`,
      kindId: input.observation.entryRef.kindId,
      collisionScope: input.observation.entryRef.collisionScope,
      entryId: input.observation.entryRef.entryId,
    },
  };
}

function BitbucketReviewPublicationControls({
  input,
}: Readonly<{ input: TriageDetailSurfaceInputV1 }>): React.ReactElement {
  const text = usePluginTranslation();
  const completeMutation = useTriagePostMutationCompletion();
  const localRef = useBitbucketEntryLocalRef(input);
  const submit = useExecutePluginAction(SUBMIT_REVIEW_ACTION);
  const create = useExecutePluginAction(CREATE_REVIEW_COMMENT_ACTION);
  const { proposals, status } = useReviewCommentProposalsForEntry({
    linkedSessionIds: input.linkedSessions.map((linked) => linked.sessionId),
    entry: { kind: 'pullRequest', url: input.observation.locator.webUrl },
  });
  const [selectedIds, setSelectedIds] = React.useState<readonly string[]>([]);
  const [verdict, setVerdict] = React.useState<'comment' | 'approve' | 'requestChanges'>('comment');
  const [summary, setSummary] = React.useState('');
  React.useEffect(() => {
    if (status !== 'ready') return;
    setSelectedIds((selected) => {
      const retained = selected.filter((id) => proposals.some((proposal) => proposal.id === id));
      return retained.length > 0 ? retained : proposals.map((proposal) => proposal.id);
    });
  }, [proposals, status]);

  const selected = proposals.filter((proposal) => selectedIds.includes(proposal.id));
  const revision = input.observation.snapshot.reviewRevision;
  const entries = selected.flatMap((proposal) => typeof proposal.body !== 'string' ? [] : [{
    happierCommentId: proposal.id,
    expectedServerRevision: proposal.serverRevision,
    anchor: proposal.anchor,
    snapshot: proposal.snapshot,
    body: proposal.body,
  }]);
  const trimmedSummary = summary.trim();
  const plan: ReviewCommentPublicationPlanV1 | null = revision === undefined || trimmedSummary === ''
    ? null
    : {
      target: bitbucketReviewPublicationTarget(input, null),
      baseRevision: revision.baseSha,
      headRevision: revision.headSha,
      entries,
      verdict: { kind: verdict, body: trimmedSummary },
    };
  const single = revision === undefined || entries.length !== 1 ? null : {
    target: bitbucketReviewPublicationTarget(input, null),
    baseRevision: revision.baseSha,
    headRevision: revision.headSha,
    entries,
    verdict: null,
  } satisfies ReviewCommentPublicationPlanV1;
  const complete = (execution: PluginActionExecution<unknown>) => completeTriagePostMutationIfNeeded(
    completeMutation, execution, bitbucketReviewPublicationMayHaveChangedProviderStateV1,
  );

  return (
    <Stack gap="small">
      <Text variant="label" valueKey="plugins.bitbucket.ui.mutations.review.title" fallback="Review publication" />
      {status === 'loading' ? <Text variant="caption" tone="neutral" valueKey="plugins.bitbucket.ui.mutations.review.loadingProposals" fallback="Reading linked review proposals…" /> : null}
      {status === 'failed' ? <Banner tone="danger" title="Review proposals are unavailable" titleKey="plugins.bitbucket.ui.mutations.review.proposalsUnavailable" /> : null}
      {status === 'ready' && proposals.length === 0 ? <Text variant="caption" tone="neutral" valueKey="plugins.bitbucket.ui.mutations.review.noProposals" fallback="No proposed review comments are linked to this pull request." /> : null}
      {proposals.length > 0 ? (
        <Form.Select
          label={text('plugins.bitbucket.ui.mutations.review.comments', 'Review comments')}
          options={proposals.map((proposal) => ({ value: proposal.id, label: proposal.body }))}
          value={selectedIds}
          multiple
          required
          onChange={(value) => { if (Array.isArray(value)) setSelectedIds(value.filter((item): item is string => typeof item === 'string')); }}
        />
      ) : null}
      <Form.Select
        label={text('plugins.bitbucket.ui.mutations.review.verdict', 'Review verdict')}
        value={verdict}
        options={[
          { value: 'comment', label: text('plugins.bitbucket.ui.mutations.review.comment', 'Comment') },
          { value: 'approve', label: text('plugins.bitbucket.ui.mutations.review.approve', 'Approve') },
          { value: 'requestChanges', label: text('plugins.bitbucket.ui.mutations.review.requestChanges', 'Request changes') },
        ]}
        onChange={(value) => {
          if (value === 'comment' || value === 'approve' || value === 'requestChanges') {
            setVerdict(value);
          }
        }}
      />
      <Form.TextField label={text('plugins.bitbucket.ui.mutations.review.summary', 'Review summary')} value={summary} onChange={setSummary} />
      <Row gap="small">
        <Button title={text('plugins.bitbucket.ui.mutations.review.submit', 'Submit review')} disabled={plan === null} busy={submit.execution.status === 'pending'} onPress={() => { if (plan !== null) void submit.execute({ v: 1, instance: input.instance, localRef, publicationPlan: plan }).then(complete); }} />
        <Button title={text('plugins.bitbucket.ui.mutations.reviewComment.publish', 'Publish comment')} variant="secondary" disabled={single === null} busy={create.execution.status === 'pending'} onPress={() => { if (single !== null) void create.execute({ v: 1, instance: input.instance, localRef, publicationPlan: single }).then(complete); }} />
      </Row>
      <SettledMutationBanner settled={reviewPublicationBanner(submit.execution, text)} />
      <SettledMutationBanner settled={reviewPublicationBanner(create.execution, text)} />
    </Stack>
  );
}

/** Reply publication belongs to the Comments plane and selects only provider ids rendered there. */
export function BitbucketReviewCommentReplyControls({
  input,
  comments,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  comments: readonly BitbucketProjectedCommentRowV1[];
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  const completeMutation = useTriagePostMutationCompletion();
  const localRef = useBitbucketEntryLocalRef(input);
  const reply = useExecutePluginAction(REPLY_REVIEW_COMMENT_ACTION);
  const { proposals, status } = useReviewCommentProposalsForEntry({
    linkedSessionIds: input.linkedSessions.map((linked) => linked.sessionId),
    entry: { kind: 'pullRequest', url: input.observation.locator.webUrl },
  });
  const eligibleComments = React.useMemo(
    () => comments.filter((comment) => !comment.deleted),
    [comments],
  );
  const [proposalId, setProposalId] = React.useState<string | null>(null);
  const [parentCommentId, setParentCommentId] = React.useState<string | null>(null);
  React.useEffect(() => {
    setProposalId((current) => proposals.some((proposal) => proposal.id === current)
      ? current
      : proposals[0]?.id ?? null);
  }, [proposals]);
  React.useEffect(() => {
    setParentCommentId((current) => eligibleComments.some((comment) => comment.id === current)
      ? current
      : eligibleComments[0]?.id ?? null);
  }, [eligibleComments]);
  const proposal = proposals.find((candidate) => candidate.id === proposalId);
  const entry = proposal === undefined ? null : {
    happierCommentId: proposal.id,
    expectedServerRevision: proposal.serverRevision,
    anchor: proposal.anchor,
    snapshot: proposal.snapshot,
    body: proposal.body,
  };
  const plan: ReviewCommentPublicationPlanV1 | null = entry === null || parentCommentId === null
    ? null
    : {
      target: bitbucketReviewPublicationTarget(input, {
        kindId: 'review-comment',
        targetId: parentCommentId,
      }),
      baseRevision: null,
      headRevision: null,
      entries: [entry],
      verdict: null,
    };
  if (eligibleComments.length === 0) return null;
  return (
    <Stack gap="small">
      <Text variant="label" valueKey="plugins.bitbucket.ui.mutations.review.replyTitle" fallback="Reply with a review proposal" />
      {status === 'failed' ? <Banner tone="danger" title="Review proposals are unavailable" titleKey="plugins.bitbucket.ui.mutations.review.proposalsUnavailable" /> : null}
      {proposals.length > 0 ? (
        <Form.Select
          label={text('plugins.bitbucket.ui.mutations.review.replyProposal', 'Reply proposal')}
          options={proposals.map((candidate) => ({ value: candidate.id, label: candidate.body }))}
          {...(proposalId === null ? {} : { value: proposalId })}
          onChange={(value) => { if (typeof value === 'string') setProposalId(value); }}
        />
      ) : null}
      <Form.Select
        label={text('plugins.bitbucket.ui.mutations.review.replyComment', 'Comment to reply to')}
        options={eligibleComments.map((comment) => ({
          value: comment.id,
          label: `${comment.author ?? text('plugins.bitbucket.ui.someone', 'Someone')}: ${comment.body}`,
        }))}
        {...(parentCommentId === null ? {} : { value: parentCommentId })}
        onChange={(value) => { if (typeof value === 'string') setParentCommentId(value); }}
      />
      <Button
        title={text('plugins.bitbucket.ui.mutations.reviewReply.publish', 'Post reply')}
        variant="secondary"
        disabled={plan === null}
        busy={reply.execution.status === 'pending'}
        onPress={() => {
          if (plan === null || parentCommentId === null) return;
          void reply.execute({
            v: 1,
            instance: input.instance,
            localRef,
            parentCommentId,
            publicationPlan: plan,
          }).then((execution) => completeTriagePostMutationIfNeeded(
            completeMutation,
            execution,
            bitbucketReviewPublicationMayHaveChangedProviderStateV1,
          ));
        }}
      />
      <SettledMutationBanner settled={reviewPublicationBanner(reply.execution, text)} />
    </Stack>
  );
}

/**
 * The Bitbucket write controls for one mounted pull request.
 *
 * They exist only while the entry is open, because merge and decline are the transitions of an
 * open pull request and Bitbucket refuses both on any other state. An entry that is already
 * merged, declined or superseded is not offered a control that could only be refused.
 */
export function BitbucketMutationControls({
  input,
  overview,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  overview: BitbucketDetailOverviewV1;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  const completeMutation = useTriagePostMutationCompletion();
  const localRef = useBitbucketEntryLocalRef(input);
  const merge = useExecutePluginAction(MERGE_ACTION);
  const decline = useExecutePluginAction(DECLINE_ACTION);
  const [strategy, setStrategy] = React.useState<BitbucketMergeStrategyV1 | null>(null);
  const [closeSourceBranch, setCloseSourceBranch] = React.useState(false);
  const [message, setMessage] = React.useState('');

  const observedHeadCommit = input.observation.nativeRevision;
  const trimmedMessage = message.trim();
  const mergeable = strategy !== null && observedHeadCommit !== undefined;

  const runMerge = React.useCallback(() => {
    if (strategy === null || observedHeadCommit === undefined) return;
    void merge.execute({
      v: 1,
      instance: input.instance,
      localRef,
      observedHeadCommit,
      closeSourceBranch,
      mergeStrategy: strategy,
      ...(trimmedMessage === '' ? {} : { message: trimmedMessage }),
    }).then((execution) => completeTriagePostMutationIfNeeded(
      completeMutation,
      execution,
      bitbucketEntryWriteMayHaveChangedProviderStateV1,
    ));
  }, [
    closeSourceBranch,
    completeMutation,
    input.instance,
    localRef,
    merge,
    observedHeadCommit,
    strategy,
    trimmedMessage,
  ]);

  const runDecline = React.useCallback(() => {
    void decline.execute({ v: 1, instance: input.instance, localRef })
      .then((execution) => completeTriagePostMutationIfNeeded(
        completeMutation,
        execution,
        bitbucketEntryWriteMayHaveChangedProviderStateV1,
      ));
  }, [completeMutation, decline, input.instance, localRef]);

  if (overview.state.presentation !== 'active') return null;

  const mergeSettled = projectSettledMutation('merge', merge.execution, text);
  const declineSettled = projectSettledMutation('decline', decline.execution, text);

  return (
    <Stack gap="large">
      <Divider />
      <Text
        variant="label"
        valueKey="plugins.bitbucket.ui.mutations.title"
        fallback="Pull request actions"
      />
      <BitbucketReviewPublicationControls input={input} />
      <Divider />
      <Stack gap="small">
        <Form.Select
          label={text('plugins.bitbucket.ui.mutations.merge.strategy', 'Merge strategy')}
          options={[
            {
              value: 'merge_commit',
              label: text('plugins.bitbucket.ui.mutations.merge.strategy.mergeCommit', 'Merge commit'),
            },
            {
              value: 'squash',
              label: text('plugins.bitbucket.ui.mutations.merge.strategy.squash', 'Squash'),
            },
            {
              value: 'fast_forward',
              label: text('plugins.bitbucket.ui.mutations.merge.strategy.fastForward', 'Fast-forward'),
            },
          ]}
          {...(strategy === null ? {} : { value: strategy })}
          onChange={(next) => {
            // Only Bitbucket's own three strategies are selectable, so anything else selects
            // nothing rather than becoming a strategy by assertion.
            if (next === 'merge_commit' || next === 'squash' || next === 'fast_forward') {
              setStrategy(next);
            }
          }}
        />
        <Text
          variant="caption"
          tone="neutral"
          valueKey="plugins.bitbucket.ui.mutations.merge.strategyRequired"
          fallback="Choose a merge strategy. Bitbucket writes it into this repository's history permanently."
        />
        <Form.Toggle
          label={text(
            'plugins.bitbucket.ui.mutations.merge.closeSourceBranch',
            'Delete the source branch after merging',
          )}
          value={closeSourceBranch}
          onChange={setCloseSourceBranch}
        />
        <Form.TextField
          label={text('plugins.bitbucket.ui.mutations.merge.message', 'Merge commit message')}
          labelKey="plugins.bitbucket.ui.mutations.merge.message"
          placeholder={text(
            'plugins.bitbucket.ui.mutations.merge.messagePlaceholder',
            "Leave empty to keep Bitbucket's own message",
          )}
          placeholderKey="plugins.bitbucket.ui.mutations.merge.messagePlaceholder"
          multiline
          value={message}
          onChange={setMessage}
        />
        {observedHeadCommit !== undefined ? null : (
          <Text
            variant="caption"
            tone="warning"
            valueKey="plugins.bitbucket.ui.mutations.merge.headUnavailable"
            fallback="Bitbucket did not report the source commit of this pull request, so it cannot be merged from here."
          />
        )}
        <Row gap="small">
          <Button
            title={text('plugins.bitbucket.ui.mutations.merge.button', 'Merge')}
            titleKey="plugins.bitbucket.ui.mutations.merge.button"
            variant="primary"
            disabled={!mergeable}
            busy={merge.execution.status === 'pending'}
            onPress={runMerge}
          />
        </Row>
        <SettledMutationBanner settled={mergeSettled} />
      </Stack>
      <Stack gap="small">
        <Text
          variant="caption"
          tone="neutral"
          valueKey="plugins.bitbucket.ui.mutations.decline.description"
          fallback="Bitbucket cannot reopen a declined pull request."
        />
        <Row gap="small">
          <Button
            title={text('plugins.bitbucket.ui.mutations.decline.button', 'Decline')}
            titleKey="plugins.bitbucket.ui.mutations.decline.button"
            variant="secondary"
            busy={decline.execution.status === 'pending'}
            onPress={runDecline}
          />
        </Row>
        <SettledMutationBanner settled={declineSettled} />
      </Stack>
    </Stack>
  );
}

/* --------------------------------------------------------- comment resolution */

/**
 * What one resolve or reopen settled into.
 *
 * It reads a different published vocabulary from merge and decline, because what changed is the
 * comment rather than the entry — but the execution envelope in front of it is the same one, read
 * from the same owner.
 */
function projectSettledCommentResolution(
  operation: 'resolve' | 'reopen',
  execution: PluginActionExecution<unknown>,
  text: PluginTranslate,
): SettledMutationV1 | null {
  const envelope = projectExecutionEnvelope(execution, text);
  if (!isPublishedResult(envelope)) return envelope;

  const parsed = BitbucketCommentResolutionResultV1Schema.safeParse(envelope.published);
  if (!parsed.success) return unreadableResult(text);
  const result = parsed.data;
  switch (result.kind) {
    case 'applied':
      return {
        tone: 'success',
        title: operation === 'resolve'
          ? text(
            'plugins.bitbucket.ui.mutations.comment.resolved',
            'Resolved. Bitbucket confirmed this thread is resolved.',
          )
          : text(
            'plugins.bitbucket.ui.mutations.comment.reopened',
            'Reopened. Bitbucket confirmed this thread is open again.',
          ),
      };
    case 'refused':
      return {
        tone: 'neutral',
        title: text(
          'plugins.bitbucket.ui.mutations.comment.alreadyInResolution',
          'Nothing was written: this thread already reads that way.',
        ),
      };
    case 'rejected':
      // Bitbucket accepted the write and the comment does not show it — including a deployment
      // that reports no resolution at all, which cannot prove the effect either way.
      return {
        tone: 'danger',
        title: text(
          'plugins.bitbucket.ui.mutations.comment.unconfirmed',
          'Bitbucket accepted this but the comment does not show it. Re-read the comments.',
        ),
      };
    case 'unchanged':
      return {
        tone: 'warning',
        title: text(
          'plugins.bitbucket.ui.mutations.comment.unchanged',
          'Bitbucket did not apply this thread change.',
        ),
      };
    case 'uncertain':
      return {
        tone: 'warning',
        title: text(
          'plugins.bitbucket.ui.mutations.comment.uncertain',
          'Bitbucket may have changed this thread. Reload it before trying again.',
        ),
        ...(result.failure === undefined ? {} : {
          detail: failureDescription(result.failure, ''),
        }),
      };
    case 'unavailable': {
      const title = text(
        'plugins.bitbucket.ui.mutations.unavailable',
        'Bitbucket could not complete this write.',
      );
      return { tone: 'danger', title, detail: failureDescription(result.failure, title) };
    }
  }
}

/**
 * The resolve and reopen controls for exactly one comment.
 *
 * Which control exists follows what the comment currently reads, and the tri-state is honoured
 * rather than collapsed: a `resolved` thread is offered Reopen, an `unresolved` one Resolve, and a
 * thread whose deployment reported NO resolution is offered both — because this build does not
 * know which one applies, and guessing on the reader's behalf is the failure the tri-state exists
 * to prevent.
 *
 * There is no pull-request state condition. Merge and decline are transitions of an open pull
 * request; resolving a review thread is not, and people resolve stale threads on merged and
 * declined pull requests all the time.
 */
export function BitbucketCommentResolutionControls({
  input,
  comment,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  comment: BitbucketProjectedCommentRowV1;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  const completeMutation = useTriagePostMutationCompletion();
  const localRef = useBitbucketEntryLocalRef(input);
  const resolve = useExecutePluginAction(RESOLVE_COMMENT_ACTION);
  const reopen = useExecutePluginAction(UNRESOLVE_COMMENT_ACTION);

  const runResolve = React.useCallback(() => {
    void resolve.execute({ v: 1, instance: input.instance, localRef, commentId: comment.id })
      .then((execution) => completeTriagePostMutationIfNeeded(
        completeMutation,
        execution,
        bitbucketCommentWriteMayHaveChangedProviderStateV1,
      ));
  }, [comment.id, completeMutation, input.instance, localRef, resolve]);

  const runReopen = React.useCallback(() => {
    void reopen.execute({ v: 1, instance: input.instance, localRef, commentId: comment.id })
      .then((execution) => completeTriagePostMutationIfNeeded(
        completeMutation,
        execution,
        bitbucketCommentWriteMayHaveChangedProviderStateV1,
      ));
  }, [comment.id, completeMutation, input.instance, localRef, reopen]);

  // A deleted comment has no thread left to resolve, and Bitbucket keeps the row only as a
  // tombstone. Offering a write against it would be offering something that can only fail.
  if (comment.deleted) return null;

  const offersResolve = comment.resolution !== 'resolved';
  const offersReopen = comment.resolution !== 'unresolved';

  return (
    <Stack gap="small">
      {comment.resolution !== 'unknown' ? null : (
        <Text
          variant="caption"
          tone="neutral"
          valueKey="plugins.bitbucket.ui.mutations.comment.resolutionUnknown"
          fallback="Bitbucket did not report whether this thread is resolved."
        />
      )}
      <Row gap="small">
        {!offersResolve ? null : (
          <Button
            title={text('plugins.bitbucket.ui.mutations.comment.resolve', 'Resolve')}
            variant="secondary"
            accessibilityLabel={text(
              'plugins.bitbucket.ui.mutations.comment.resolveLabel',
              'Resolve comment {comment}',
              { comment: comment.id },
            )}
            busy={resolve.execution.status === 'pending'}
            onPress={runResolve}
          />
        )}
        {!offersReopen ? null : (
          <Button
            title={text('plugins.bitbucket.ui.mutations.comment.reopen', 'Reopen')}
            variant="secondary"
            accessibilityLabel={text(
              'plugins.bitbucket.ui.mutations.comment.reopenLabel',
              'Reopen comment {comment}',
              { comment: comment.id },
            )}
            busy={reopen.execution.status === 'pending'}
            onPress={runReopen}
          />
        )}
      </Row>
      <SettledMutationBanner settled={projectSettledCommentResolution('resolve', resolve.execution, text)} />
      <SettledMutationBanner settled={projectSettledCommentResolution('reopen', reopen.execution, text)} />
    </Stack>
  );
}
