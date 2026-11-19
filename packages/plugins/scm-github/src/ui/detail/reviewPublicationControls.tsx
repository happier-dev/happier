import * as React from 'react';
import {
  Banner, Button, Form, Stack, Status, usePluginTranslation,
  type ReviewCommentProposalReadV1,
} from '@happier-dev/plugin-ui';
import { parseReviewCommentPublicationPlanV1, type ReviewCommentPublicationPlanV1 } from '@happier-dev/plugin-sdk/reviews';
import type { TriageDetailSurfaceInputV1 } from '@happier-dev/triage-protocol/v1';
import { GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import { GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1 } from '../../triage/contribution.js';
import {
  githubReviewPublicationCredential, GithubPullRequestReviewPublicationResultV1Schema,
  GITHUB_REVIEW_VERDICTS_V1, type GithubPullRequestReviewVerdictV1,
} from '../../triage/mutations/contracts.js';
import type { GithubRepositoryCapabilitiesV1 } from '../../triage/capabilities.js';
import {
  buildGithubIssueCommentInputV1, buildGithubPullRequestThreadReplyInputV1,
  buildGithubPullRequestReviewCommentCreateInputV1, buildGithubPullRequestReviewPublicationInputV1,
  type GithubMutationResultV1,
} from './mutations.js';
import type { GithubReadStateV1 } from './panelState.js';
import type { GithubObservedEntryHandlerV1 } from './useGithubWrite.js';

/** The incumbent detail host retains capability, admission and settlement ownership. */
type PublicationWriteControlProps = Readonly<{
  localId: string;
  payload: NonNullable<ReturnType<typeof buildGithubIssueCommentInputV1>>
    | NonNullable<ReturnType<typeof buildGithubPullRequestThreadReplyInputV1>>
    | NonNullable<ReturnType<typeof buildGithubPullRequestReviewCommentCreateInputV1>>
    | NonNullable<ReturnType<typeof buildGithubPullRequestReviewPublicationInputV1>> | null;
  title: string;
  titleKey: string;
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
      entries: Object.freeze([Object.freeze({
        happierCommentId: proposal.id,
        expectedServerRevision: proposal.serverRevision,
        anchor: proposal.anchor,
        snapshot: proposal.snapshot,
        body: proposal.body,
      })]),
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

export function PullRequestReviewPublicationWrite({
  input,
  WriteControl,
  onObserved,
  publicationProposals,
  capabilities,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  WriteControl: React.ComponentType<PublicationWriteControlProps>;
  onObserved: GithubObservedEntryHandlerV1;
  publicationProposals: ReviewCommentProposalReadV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const [verdict, setVerdict] = React.useState<GithubPullRequestReviewVerdictV1>('comment');
  const { proposals, status: proposalRead } = publicationProposals;
  const [selectedIds, setSelectedIds] = React.useState<readonly string[]>([]);
  const [verdictBody, setVerdictBody] = React.useState('');
  React.useEffect(() => {
    if (proposalRead !== 'ready') return;
    setSelectedIds((selected) => {
      const retained = selected.filter((id) => proposals.some((proposal) => proposal.id === id));
      return retained.length > 0 ? retained : proposals.map((proposal) => proposal.id);
    });
  }, [proposalRead, proposals]);

  const publicationPlan = React.useMemo<ReviewCommentPublicationPlanV1 | null>(() => {
    if (proposalRead !== 'ready') return null;
    const revision = input.observation.snapshot.reviewRevision;
    if (revision === undefined) return null;
    const entries = proposals.flatMap((proposal) => (
      selectedIds.includes(proposal.id) && typeof proposal.body === 'string'
        ? [{
          happierCommentId: proposal.id,
          expectedServerRevision: proposal.serverRevision,
          anchor: proposal.anchor,
          snapshot: proposal.snapshot,
          body: proposal.body,
        }]
        : []
    ));
    const body = verdictBody.trim();
    if (body === '') return null;
    return parseReviewCommentPublicationPlanV1({
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
      verdict: Object.freeze({ kind: verdict, body }),
    });
  }, [input, proposalRead, proposals, selectedIds, verdict, verdictBody]);
  const payload = React.useMemo(
    () => publicationPlan === null
      ? null
      : buildGithubPullRequestReviewPublicationInputV1(input, publicationPlan),
    [input, publicationPlan],
  );
  const standaloneCommentPlan = React.useMemo<ReviewCommentPublicationPlanV1 | null>(() => {
    if (proposalRead !== 'ready') return null;
    const revision = input.observation.snapshot.reviewRevision;
    const proposal = proposals.find((candidate) => selectedIds.includes(candidate.id));
    if (revision === undefined || selectedIds.length !== 1 || proposal === undefined
      || typeof proposal.body !== 'string'
    ) return null;
    return parseReviewCommentPublicationPlanV1({
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
      entries: Object.freeze([Object.freeze({
        happierCommentId: proposal.id,
        expectedServerRevision: proposal.serverRevision,
        anchor: proposal.anchor,
        snapshot: proposal.snapshot,
        body: proposal.body,
      })]),
      verdict: null,
    });
  }, [input, proposalRead, proposals, selectedIds]);
  const standaloneCommentPayload = React.useMemo(
    () => standaloneCommentPlan === null
      ? null
      : buildGithubPullRequestReviewCommentCreateInputV1(input, standaloneCommentPlan),
    [input, standaloneCommentPlan],
  );
  return (
    <Stack gap="small">
      <Form.Select
        label={text('plugins.github.ui.mutations.review.verdict', 'Review verdict')}
        options={GITHUB_REVIEW_VERDICTS_V1.map((value) => ({
          value,
          label: value === 'requestChanges'
            ? text('plugins.github.ui.mutations.review.verdict.requestChanges', 'Request changes')
            : value === 'approve'
              ? text('plugins.github.ui.mutations.review.verdict.approve', 'Approve')
              : text('plugins.github.ui.mutations.review.verdict.comment', 'Comment'),
        }))}
        value={verdict}
        onChange={(value) => {
          const next = GITHUB_REVIEW_VERDICTS_V1.find((candidate) => candidate === value);
          if (next !== undefined) setVerdict(next);
        }}
      />
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
      {proposals.length > 0 ? (
        <Form.Select
          label={text('plugins.github.ui.mutations.review.proposal', 'Review comments')}
          options={proposals.map((proposal) => ({
            value: proposal.id,
            label: typeof proposal.body === 'string' ? proposal.body : '',
          }))}
          value={selectedIds}
          multiple
          required
          onChange={(value) => {
            if (Array.isArray(value)) {
              setSelectedIds(value.filter((item): item is string => typeof item === 'string'));
            }
          }}
        />
      ) : null}
      <ReviewProposalContinuation read={publicationProposals} />
      <Form.TextField
        label={text('plugins.github.ui.mutations.review.summary', 'Review summary')}
        value={verdictBody}
        required
        onChange={setVerdictBody}
      />
      <WriteControl
        localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestSubmitReview}
        payload={payload}
        title="Submit review"
        titleKey="plugins.github.ui.mutations.review.submit"
        parseResult={parseReviewPublicationResult}
        onObserved={onObserved}
        capabilities={capabilities}
        operation="pullRequestSubmitReview"
      />
      <WriteControl
        localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestReviewCommentCreate}
        payload={standaloneCommentPayload}
        title="Publish selected comment"
        titleKey="plugins.github.mutations.reviewCommentCreate.confirmation.confirmLabel"
        parseResult={parseReviewPublicationResult}
        onObserved={onObserved}
        capabilities={capabilities}
        operation="pullRequestReviewCommentCreate"
      />
    </Stack>
  );
}
