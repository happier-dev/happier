import * as React from 'react';
import {
  Banner, Button, Form, MarkdownEditor, ReviewPublicationEntry, ReviewPublicationSheet, reviewPublicationFindingTitle, reviewPublicationPublish, Stack, Status,
  useHappierReviewPublicationEvidence, usePluginTranslation, useReviewPublicationSelection, type ReviewCommentProposalReadV1,
  type ReviewPublicationBlockedCause,
} from '@happier-dev/plugin-ui';
import {
  buildReviewCommentPublicationEntryV1, buildReviewPublicationSummaryV1, parseReviewCommentPublicationPlanV1,
  serializeReviewPublicationSummaryForForgeV1, type ReviewCommentPublicationPlanV1,
} from '@happier-dev/plugin-sdk/reviews';
import type { TriageDetailSurfaceInputV1 } from '@happier-dev/triage-protocol/v1';
import { useTriageReviewPublicationDraftV1 } from '@happier-dev/triage-sources/ui';
import { GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import { GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1 } from '../../triage/contribution.js';
import {
  githubReviewPublicationCredential, GithubPullRequestReviewPublicationResultV1Schema,
  GITHUB_REVIEW_VERDICTS_V1, type GithubPullRequestReviewVerdictV1,
} from '../../triage/mutations/contracts.js';
import type { GithubRepositoryCapabilitiesV1 } from '../../triage/capabilities.js';
import {
  buildGithubIssueCommentInputV1, buildGithubPullRequestThreadReplyInputV1,
  buildGithubPullRequestReviewPublicationInputV1,
  type GithubMutationResultV1,
} from './mutations.js';
import type { GithubReadStateV1 } from './panelState.js';
import type { GithubObservedEntryHandlerV1 } from './useGithubWrite.js';

/** The incumbent detail host retains capability, admission and settlement ownership. */
type PublicationWriteControlProps = Readonly<{
  localId: string;
  payload: NonNullable<ReturnType<typeof buildGithubIssueCommentInputV1>>
    | NonNullable<ReturnType<typeof buildGithubPullRequestThreadReplyInputV1>>
    | NonNullable<ReturnType<typeof buildGithubPullRequestReviewPublicationInputV1>> | null;
  title: string;
  titleKey?: string;
  variant?: 'primary' | 'secondary';
  parseResult: (value: unknown) => GithubMutationResultV1 | null;
  onObserved: GithubObservedEntryHandlerV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
  operation: keyof GithubRepositoryCapabilitiesV1['operations'];
}>;

function parseReviewPublicationResult(value: unknown): GithubMutationResultV1 | null {
  const parsed = GithubPullRequestReviewPublicationResultV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function ReviewProposalContinuation({ read }: Readonly<{ read: ReviewCommentProposalReadV1 }>): React.ReactElement | null {
  return read.loadMore === undefined ? null : <Button title="Load more comments"
    titleKey="plugins.github.ui.loadMoreComments" variant="secondary"
    busy={read.status === 'loading'} onPress={read.loadMore} />;
}

/**
 * Publishes exactly one already-canonical Review Comment. This is intentionally
 * fed by the one detail-mounted public proposal reader: issue and thread writes
 * never invent project/comment identity and never mount another cache lifecycle.
 */
export function SingleProposalPublicationWrite({
  input,
  WriteControl,
  publicationProposals,
  kind,
  threadId,
  onObserved,
  capabilities,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  WriteControl: React.ComponentType<PublicationWriteControlProps>;
  publicationProposals: ReviewCommentProposalReadV1;
  kind: 'issue-comment' | 'thread-reply';
  threadId?: string;
  onObserved: GithubObservedEntryHandlerV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const { proposals, status: proposalRead } = publicationProposals;
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (proposalRead !== 'ready') return;
    setSelectedId((selected) => (
      selected !== null && proposals.some((proposal) => proposal.id === selected)
        ? selected
        : proposals[0]?.id ?? null
    ));
  }, [proposalRead, proposals]);

  const publicationPlan = React.useMemo<ReviewCommentPublicationPlanV1 | null>(() => {
    if (proposalRead !== 'ready' || selectedId === null) return null;
    const proposal = proposals.find((candidate) => candidate.id === selectedId);
    if (proposal === undefined || typeof proposal.body !== 'string') return null;
    return parseReviewCommentPublicationPlanV1({
      target: Object.freeze({
        providerId: 'github',
        ...githubReviewPublicationCredential(input.instance.binding),
        subtarget: kind === 'thread-reply' && threadId !== undefined
          ? Object.freeze({ kindId: 'review-thread' as const, targetId: threadId })
          : null,
        entryRef: Object.freeze({
          sourceId: `${GITHUB_PLUGIN_ID}/github-forge`,
          kindId: input.observation.entryRef.kindId,
          collisionScope: input.observation.entryRef.collisionScope,
          entryId: input.observation.entryRef.entryId,
        }),
      }),
      baseRevision: null,
      headRevision: null,
      entries: Object.freeze([buildReviewCommentPublicationEntryV1(proposal)]),
      verdict: null,
    });
  }, [input, kind, proposalRead, proposals, selectedId, threadId]);
  const payload = React.useMemo(() => {
    if (publicationPlan === null) return null;
    return kind === 'thread-reply' && threadId !== undefined
      ? buildGithubPullRequestThreadReplyInputV1(input, publicationPlan, threadId)
      : buildGithubIssueCommentInputV1(input, publicationPlan);
  }, [input, kind, publicationPlan, threadId]);
  const localId = kind === 'thread-reply'
    ? GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestThreadReply
    : GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueComment;
  const title = kind === 'thread-reply' ? 'Post selected reply' : 'Post selected issue comment';
  const titleKey = kind === 'thread-reply'
    ? 'plugins.github.mutations.threadReply.confirmation.confirmLabel'
    : 'plugins.github.mutations.issueComment.confirmation.confirmLabel';

  return (
    <Stack gap="small">
      {proposalRead === 'loading'
        ? <Status tone="muted" label={text('plugins.github.ui.mutations.review.proposals.loading', 'Reading review proposals…')} />
        : null}
      {proposalRead === 'failed'
        ? (
          <Banner
            tone="danger"
            title={text('plugins.github.ui.mutations.review.proposals.failed', 'Review proposals are unavailable')}
            description={text('plugins.github.ui.mutations.review.proposals.failed.description', 'Happier could not read the proposed comments linked to this entry.')}
          />
        )
        : null}
      {proposalRead === 'ready' && proposals.length === 0
        ? <Status tone="muted" label={text('plugins.github.ui.mutations.review.proposals.empty', 'No proposed review comment is linked to this entry yet.')} />
        : null}
      {proposalRead === 'ready' && proposals.length > 0
        ? (
          <Form.Select
            label={text('plugins.github.ui.mutations.review.proposal', 'Review comment')}
            options={proposals.map((proposal) => ({
              value: proposal.id,
              label: typeof proposal.body === 'string' ? proposal.body : '',
            }))}
            {...(selectedId === null ? {} : { value: selectedId })}
            required
            onChange={(value) => { if (typeof value === 'string') setSelectedId(value); }}
          />
        )
        : null}
      <ReviewProposalContinuation read={publicationProposals} />
      <WriteControl
        localId={localId}
        payload={payload}
        title={title}
        titleKey={titleKey}
        parseResult={parseReviewPublicationResult}
        onObserved={onObserved}
        capabilities={capabilities}
        operation={kind === 'thread-reply' ? 'pullRequestThreadReply' : 'issueComment'}
      />
    </Stack>
  );
}

/**
 * The pull request's Publish step. Closed, it is one entry row among the pull request's changes; open, its sheet
 * replaces them (`open` belongs to the section that hides them). It stays mounted either way, so the draft survives.
 */
export function PullRequestReviewPublicationWrite({
  input,
  WriteControl,
  onObserved,
  publicationProposals,
  capabilities,
  open,
  onOpenChange,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  WriteControl: React.ComponentType<PublicationWriteControlProps>;
  onObserved: GithubObservedEntryHandlerV1;
  publicationProposals: ReviewCommentProposalReadV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const [verdict, setVerdict] = React.useState<GithubPullRequestReviewVerdictV1>('comment');
  const { proposals, status: proposalRead } = publicationProposals;
  const [selectedIds, setSelectedIds] = useReviewPublicationSelection(proposals);
  const [verdictBody, setVerdictBody] = React.useState('');
  const [includeWalkthrough, setIncludeWalkthrough] = React.useState(true);
  const { quality, walkthrough } = useHappierReviewPublicationEvidence(input.admittedReview?.reviewId, input.admittedReview?.roundOrdinal);
  const draftFindings = React.useMemo(
    () => proposals.map((proposal) => ({ id: proposal.id, title: reviewPublicationFindingTitle(proposal) })),
    [proposals],
  );
  const draftSelection = React.useMemo(
    () => ({ findings: draftFindings, selectedIds, setSelectedIds }),
    [draftFindings, selectedIds, setSelectedIds],
  );
  const draftWalkthrough = React.useMemo(
    () => walkthrough?.length ? { included: includeWalkthrough, setIncluded: setIncludeWalkthrough } : null,
    [includeWalkthrough, walkthrough?.length],
  );
  const verdictOptions = React.useMemo(() => GITHUB_REVIEW_VERDICTS_V1.map((value) => ({
    value,
    label: value === 'requestChanges'
      ? text('plugins.github.ui.mutations.review.verdict.requestChanges', 'Request changes')
      : value === 'approve'
        ? text('plugins.github.ui.mutations.review.verdict.approve', 'Approve')
        : text('plugins.github.ui.mutations.review.verdict.comment', 'Comment'),
  })), [text]);
  const draft = useTriageReviewPublicationDraftV1({
    open, selection: draftSelection, walkthrough: draftWalkthrough, verdictOptions, setVerdict, setSummary: setVerdictBody,
  });
  const selected = React.useMemo(
    () => proposals.filter(proposal => selectedIds.includes(proposal.id)),
    [proposals, selectedIds],
  );
  const publish = reviewPublicationPublish(text, { proposalCount: proposals.length, entryCount: selected.length });
  const publication = React.useMemo(() => {
    if (proposalRead !== 'ready') return null;
    const revision = input.observation.snapshot.reviewRevision;
    if (revision === undefined) return null;
    const entries = selected.map(buildReviewCommentPublicationEntryV1);
    const authoredBody = verdictBody.trim();
    if (authoredBody === '') return null;
    const summary = buildReviewPublicationSummaryV1({
      verdict: { kind: verdict, body: authoredBody },
      headRevision: revision.headSha,
      findings: selected.flatMap(proposal => proposal.finding ? [{ ...proposal.finding, happierCommentId: proposal.id }] : []),
      reviewId: input.admittedReview?.reviewId,
      quality,
      walkthrough: includeWalkthrough ? walkthrough : undefined,
    });
    const plan = parseReviewCommentPublicationPlanV1({
      target: Object.freeze({
        providerId: 'github',
        ...githubReviewPublicationCredential(input.instance.binding),
        subtarget: null,
        entryRef: Object.freeze({
          sourceId: `${GITHUB_PLUGIN_ID}/github-forge`,
          kindId: input.observation.entryRef.kindId,
          collisionScope: input.observation.entryRef.collisionScope,
          entryId: input.observation.entryRef.entryId,
        }),
      }),
      baseRevision: revision.baseSha,
      headRevision: revision.headSha,
      entries: Object.freeze(entries),
      verdict: Object.freeze({ kind: verdict, body: serializeReviewPublicationSummaryForForgeV1(summary) }),
    });
    return { plan, summary };
  }, [includeWalkthrough, input, proposalRead, quality, selected, verdict, verdictBody, walkthrough]);
  const payload = React.useMemo(
    () => publication === null || publish.blocked
      ? null
      : buildGithubPullRequestReviewPublicationInputV1(input, publication.plan),
    [input, publication, publish.blocked],
  );
  // Why Publish cannot run, from the same facts the plan above is built from.
  const blocked: ReviewPublicationBlockedCause | null = proposalRead === 'loading' ? 'proposalsLoading'
    : proposalRead === 'failed' ? 'proposalsFailed'
      : input.observation.snapshot.reviewRevision === undefined ? 'revisionUnknown'
        : verdictBody.trim() === '' ? 'summaryMissing'
          : publish.blocked ? 'noFindingChecked'
            : payload === null ? 'planRejected'
              : null;
  if (!open) {
    return <ReviewPublicationEntry forgeName="GitHub" proposalCount={proposals.length} selectedCount={selected.length}
      onPress={() => onOpenChange(true)} testID="github-review-publication-entry" />;
  }
  return (
    <ReviewPublicationSheet
      forgeName="GitHub"
      testID="github-review-publication"
      blocked={blocked}
      onCancel={() => onOpenChange(false)}
      verdict={{
        options: verdictOptions,
        value: verdict,
        onChange: draft.setVerdict,
      }}
      summary={<MarkdownEditor
        accessibilityLabel={text('plugins.github.ui.mutations.review.summary', 'Summary')}
        value={verdictBody}
        onChange={setVerdictBody}
      />}
      notices={<>
        {proposalRead === 'loading' ? (
          <Status
            tone="muted"
            label={text('plugins.github.ui.mutations.review.proposals.loading', 'Reading review proposals…')}
          />
        ) : null}
        {proposalRead === 'failed' ? (
          <Banner
            tone="danger"
            title={text('plugins.github.ui.mutations.review.proposals.failed', 'Review proposals are unavailable')}
            description={text('plugins.github.ui.mutations.review.proposals.failed.description', 'Happier could not read the proposed comments linked to this pull request.')}
          />
        ) : null}
        {proposalRead === 'ready' && proposals.length === 0 ? (
          <Status
            tone="muted"
            label={text('plugins.github.ui.mutations.review.proposals.empty', 'No proposed review comment is linked to this pull request yet.')}
          />
        ) : null}
        <ReviewProposalContinuation read={publicationProposals} />
      </>}
      proposals={proposals}
      selectedIds={selectedIds}
      onSelectedIdsChange={draft.setSelectedIds}
      walkthrough={walkthrough?.length
        ? { included: includeWalkthrough, onChange: draft.setWalkthroughIncluded, stopCount: walkthrough.length }
        : null}
      preview={publication?.summary ?? null}
      inlineCommentCount={publication?.plan.entries.length ?? selected.length}
      // One publish action, named for what the plan posts (UI refinements 2026-11-26 09:26Z).
      actions={<WriteControl
        localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestSubmitReview}
        payload={payload}
        title={publish.title}
        variant="primary"
        parseResult={parseReviewPublicationResult}
        onObserved={onObserved}
        capabilities={capabilities}
        operation="pullRequestSubmitReview"
      />}
    />
  );
}
