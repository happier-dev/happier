/**
 * The GitHub Triage detail surface artifact entry.
 *
 * Triage mounts this renderer inside its own detail pane and hands it exactly one value: the
 * published `TriageDetailSurfaceInputV1` launch input. This file admits that value through the
 * published closed schema rather than casting it — a mount that hands over something else is a
 * contract break the surface reports, not one it renders around.
 *
 * It begins directly below Triage's permanently mounted common header and renders none of that
 * header's facts. The title, kind, state, scope, provider link, attention and Session
 * relationship belong to the aggregate (`CONTRACT.md` §7); repeating them here is a second
 * renderer of one header, and the copy that drifts is the one the user is looking at.
 *
 * What it does own are GitHub's own facts: the event timeline, the files a pull request changes,
 * its check runs and commit statuses, the conversation, and — on a pull request — the feedback on
 * it. Every read has its own lifetime, issued when its tab becomes active and never on mount:
 * GitHub involvement scanning already spends real provider budget, and planes fetched eagerly
 * would multiply it on every detail open.
 *
 * `Feedback` composes the conversation walk with the authoritative reviews and checks reads.
 * The Timeline remains a separate panel: its bounded event history cannot answer who has signed
 * off or which review requests are outstanding. That is also why a pull request has no separate
 * `Comments` tab: its conversation is one of the things `Feedback` unifies, and a second tab
 * would read the same resource again and split one conversation across two places a reviewer has
 * to check.
 *
 * Every panel distinguishes the same four settled outcomes, because on this source they are
 * genuinely different answers: a collection the provider stated as empty says so; a first read
 * that failed says *that* instead, naming itself; a later page that failed keeps the rows the
 * reader already had and shows the failure beside them; and a walk that stopped short of the whole
 * collection keeps its rows and names the reason.
 *
 * Diffs are not rendered here. The rich diff body is held at the shared component catalog under
 * B6, so the Files panel presents the changed-file LIST through the approved `List` family with
 * its counts, its status, its deterministic reading order and its per-file *diff unavailable*
 * state. It neither wraps an app-private diff component nor invents a partial one.
 */

import * as React from 'react';
import { Animated } from 'react-native';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
  createReviewCommentLinkedIssueIdV1,
  parseReviewCommentPublicationPlanV1,
  type ReviewCommentPublicationPlanV1,
  type ReviewCommentV1,
} from '@happier-dev/plugin-sdk/reviews';
import {
  Action,
  Badge,
  Banner,
  Button,
  Divider,
  EmptyState,
  ErrorState,
  Form,
  Item,
  ItemGroup,
  Icon,
  List,
  LoadingState,
  Markdown,
  Metadata,
  Row,
  Screen,
  ScrollArea,
  Stack,
  Status,
  Tabs,
  Text,
  defineUiSurface,
  usePluginTranslation,
  useExecutePluginAction,
  useReviewCommentProposalsForEntry,
  useSurfaceContext,
  type ReviewCommentProposalReadV1,
  type MetadataEntry,
  type PluginActionExecution,
  type PluginTranslate,
} from '@happier-dev/plugin-ui';
import {
  TriageDetailSurfaceInputV1Schema,
  type TriageDetailSurfaceInputV1,
  type TriageLinkedSessionProjectionV1,
  type TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';
import {
  completeTriagePostMutationIfNeeded,
  useTriagePostMutationCompletion,
} from '@happier-dev/triage-sources/ui';
// The presentation rules used below are projections of the Triage contract's own
// closed fact and failure vocabularies, so they are consumed from the one published
// owner rather than re-spelled here: six copies is how one declared `compact` number
// could start meaning two things in one list. They are aliased to this file's local
// vocabulary so the call sites read as the panel language they already are.
import {
  describeTriageSourceFailureV1 as failureDescription,
  formatTriageCountV1 as formatNumber,
  formatTriageTimestampV1 as formatTimestamp,
  projectTriageDetailFieldTextV1 as fieldValueText,
} from '@happier-dev/triage-protocol/v1';

import {
  groupGithubChangedFiles,
  orderGithubChangedFiles,
} from '../triage/detail/files/orderChangedFiles.js';
import type {
  GithubProjectedChangedFileRowV1,
  GithubProjectedCheckRowV1,
  GithubProjectedTimelineRowV1,
} from '../triage/detail/projection.js';
import { GITHUB_CHANGED_FILES_CEILING_V1 } from '../triage/detail/routes.js';
import {
  GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1,
  readGithubTriageKindId,
} from '../triage/contribution.js';
import { GITHUB_PLUGIN_ID } from '../observations/githubProviderContracts.js';
import {
  GithubIssueDeltaResultV1Schema,
  GithubPullRequestMarkReadyResultV1Schema,
  GithubPullRequestMergeResultV1Schema,
  GithubPullRequestReviewPublicationResultV1Schema,
  GithubPullRequestReviewersResultV1Schema,
  GithubPullRequestStateResultV1Schema,
  GithubPullRequestThreadResolutionResultV1Schema,
  GithubPullRequestUpdateBranchResultV1Schema,
  type GithubIssueCloseReasonV1,
  type GithubMergeMethodV1,
  type GithubPullRequestReviewVerdictV1,
} from '../triage/mutations/contracts.js';
import type { GithubTriageKindIdV1 } from '../triage/types.js';
import type { GithubRepositoryCapabilitiesV1 } from '../triage/capabilities.js';

import {
  projectGithubFeedback,
  type GithubFeedbackFindingV1,
  type GithubFeedbackReviewPeopleV1,
  type GithubFeedbackViewV1,
} from './detail/feedback.js';
import {
  projectGithubDetailBody,
  type GithubDetailBodyV1,
  type GithubDetailFieldV1,
} from './detail/model.js';
import {
  useGithubChangedFiles,
  useGithubCapabilities,
  useGithubChecks,
  useGithubFeedbackComments,
  useGithubFeedbackRequests,
  useGithubFeedbackReviews,
  useGithubFeedbackThreads,
  useGithubFeedbackThreadReplies,
  useGithubTimeline,
  type GithubChecksViewV1,
  type GithubPagedControllerV1,
} from './detail/panelReaders.js';
import type { GithubPagedStateV1, GithubReadStateV1 } from './detail/panelState.js';
import {
  GITHUB_ISSUE_CLOSE_REASONS_V1,
  GITHUB_MERGE_METHODS_V1,
  buildGithubIssueCloseInputV1,
  buildGithubIssueCommentInputV1,
  buildGithubIssueAssigneesInputV1,
  buildGithubIssueLabelsInputV1,
  buildGithubIssueReopenInputV1,
  buildGithubPullRequestMarkReadyInputV1,
  buildGithubPullRequestReviewCommentCreateInputV1,
  buildGithubPullRequestReviewPublicationInputV1,
  buildGithubPullRequestMergeInputV1,
  buildGithubPullRequestReviewersInputV1,
  buildGithubPullRequestTargetInputV1,
  buildGithubPullRequestThreadResolutionInputV1,
  buildGithubPullRequestThreadReplyInputV1,
  buildGithubPullRequestUpdateBranchInputV1,
  githubMutationMayHaveChangedProviderStateV1,
  githubOfferedMutationsV1,
  projectGithubMutationOutcomeV1,
  readGithubLabelsV1,
  readGithubNamesV1,
  type GithubMutationOutcomeV1,
  type GithubMutationRefusalReasonV1,
  type GithubMutationResultV1,
} from './detail/mutations.js';
import {
  GITHUB_DEFAULT_DETAIL_TAB_V1,
  githubResolveSelectedTab,
  githubVisibleDetailTabs,
  type GithubDetailTabIdV1,
} from './detail/tabDeclarations.js';
import {
  GITHUB_CHANGED_FILE_STATUS_LABELS_V1,
  GITHUB_CHECK_CONCLUSION_LABELS_V1,
  GITHUB_CHECK_STATUS_LABELS_V1,
  GITHUB_REVIEW_STATE_LABELS_V1,
  GITHUB_TIMELINE_HEADLINES_V1,
  githubChangedFileStatusKey,
  githubCheckConclusionKey,
  githubCheckStatusKey,
  githubDetailFieldLabelKey,
  githubReviewStateKey,
  githubTimelineHeadlineKey,
} from './detail/vocabulary.js';


/**
 * The sentence a walk owes its reader when it stopped without finishing.
 *
 * Only the changed-file plane has a documented ceiling, so only it supplies a
 * ceiling sentence. A plane with no ceiling never claims one — saying "GitHub
 * caps this list" about a timeline would be a fact this product invented.
 */
function incompleteDescription(
  text: PluginTranslate,
  incomplete: 'ceiling' | 'pagination' | null,
  ceilingSentence: string | null,
): string | null {
  if (incomplete === 'pagination') {
    return text(
      'plugins.github.ui.incompletePagination',
      'GitHub offered another page in a form this build will not follow, so this list'
        + ' stops here.',
    );
  }
  return incomplete === 'ceiling' ? ceilingSentence : null;
}

/**
 * The banner a later-page failure owes its reader.
 *
 * It appears only over rows that already arrived. A first-page failure is a
 * different presentation entirely — the panel says it could not look.
 */
function PageFailureBanner({
  state,
}: Readonly<{ state: GithubPagedStateV1<unknown> }>): React.ReactElement | null {
  const text = usePluginTranslation();
  if (state.failure === null) return null;
  return (
    <Banner
      tone="warning"
      title="Showing what was read so far"
      titleKey="plugins.github.ui.partial"
      description={failureDescription(
        state.failure,
        text('plugins.github.ui.readFailed', 'GitHub could not complete this read.'),
      )}
    />
  );
}

/**
 * The explicit refresh every panel offers, and the only one it offers.
 *
 * There is no automatic poll inside a detail tab: a panel that re-read on its own would spend
 * GitHub rate budget for a reader who is not looking at it.
 */
function RefreshRow({
  onRefresh,
  pending,
  accessibilityLabel,
  accessibilityLabelKey,
}: Readonly<{
  onRefresh: () => void;
  /** A walk already in flight; the control stays mounted and inert rather than vanishing. */
  pending: boolean;
  accessibilityLabel: string;
  accessibilityLabelKey?: string;
}>): React.ReactElement {
  return (
    <Row gap="small">
      <Action.Refresh
        onRefresh={onRefresh}
        disabled={pending}
        variant="plain"
        accessibilityLabel={accessibilityLabel}
        accessibilityLabelKey={accessibilityLabelKey}
      />
    </Row>
  );
}

/* ----------------------------------------------------------------------- Writes */

/**
 * The writes an entry offers, presented where its own state is shown: merge, close
 * and reopen on a pull request, close and reopen on an issue.
 *
 * They belong on the Overview panel because that panel IS the applied observation:
 * the state that decides which writes exist, and the head a merge is pinned to,
 * are already the facts on this screen. Hanging them off a live provider read
 * instead would make a write's meaning depend on a panel the reader may never have
 * opened, and its head on a fetch they did not ask for.
 *
 * Nothing here confirms anything, and that is deliberate. Each Action declares
 * host-owned confirmation metadata in the manifest; the host presents it and holds
 * the write until the user decides. A dialog of this surface's own would be a
 * second confirmation lifecycle for one decision, and the copy that drifts is the
 * one standing between a reader and a merge.
 *
 * What this surface does owe is that every press has a settled, visible answer.
 * A control that returned to rest would leave "did that merge?" answerable only by
 * leaving the entry and coming back — and, for the outcome that could not be
 * confirmed, would invite exactly the blind retry the write contract forbids.
 */

const WRITE_REFUSAL_COPY: Readonly<Record<
  GithubMutationRefusalReasonV1,
  Readonly<{ key: string; fallback: string }>
>> = Object.freeze({
  head_advanced: Object.freeze({
    key: 'plugins.github.ui.mutations.refused.head_advanced',
    fallback: 'New commits were pushed since the head shown here, so nothing was merged.',
  }),
  state_changed: Object.freeze({
    key: 'plugins.github.ui.mutations.refused.state_changed',
    fallback: 'The state this entry is in on GitHub cannot make this change.',
  }),
  not_mergeable: Object.freeze({
    key: 'plugins.github.ui.mutations.refused.not_mergeable',
    fallback: 'GitHub will not merge this pull request right now.',
  }),
  merge_method_not_allowed: Object.freeze({
    key: 'plugins.github.ui.mutations.refused.merge_method_not_allowed',
    fallback: 'This repository does not allow that merge method.',
  }),
});

/**
 * GitHub's merge methods in the reader's words. Keyed by the contract's own union,
 * so a method added there fails this build rather than losing its label.
 */
/** GitHub's own closing-reason words, in the reader's language where there is one. */
const ISSUE_CLOSE_REASON_COPY: Readonly<Record<
  GithubIssueCloseReasonV1,
  Readonly<{ key: string; fallback: string }>
>> = Object.freeze({
  completed: Object.freeze({
    key: 'plugins.github.ui.mutations.closeReason.completed',
    fallback: 'Completed',
  }),
  not_planned: Object.freeze({
    key: 'plugins.github.ui.mutations.closeReason.notPlanned',
    fallback: 'Not planned',
  }),
  duplicate: Object.freeze({
    key: 'plugins.github.ui.mutations.closeReason.duplicate',
    fallback: 'Duplicate',
  }),
});

const MERGE_METHOD_COPY: Readonly<Record<
  GithubMergeMethodV1,
  Readonly<{ key: string; fallback: string }>
>> = Object.freeze({
  merge: Object.freeze({
    key: 'plugins.github.ui.mutations.mergeMethod.merge',
    fallback: 'Create a merge commit',
  }),
  squash: Object.freeze({
    key: 'plugins.github.ui.mutations.mergeMethod.squash',
    fallback: 'Squash and merge',
  }),
  rebase: Object.freeze({
    key: 'plugins.github.ui.mutations.mergeMethod.rebase',
    fallback: 'Rebase and merge',
  }),
});

/** The settled answer one write owes the reader who pressed it. */
function WriteOutcome({
  outcome,
}: Readonly<{ outcome: GithubMutationOutcomeV1 }>): React.ReactElement {
  const text = usePluginTranslation();
  if (outcome.kind === 'publication') {
    const fullyPublished = outcome.publishedCount === outcome.totalCount
      && outcome.uncertainCount === 0
      && outcome.failedCount === 0
      && (outcome.verdict === 'published' || outcome.verdict === 'notRequested');
    const verdict = outcome.verdict === 'notRequested'
      ? text('plugins.github.ui.mutations.review.outcome.verdict.notRequested', 'No verdict requested')
      : outcome.verdict === 'published'
        ? text('plugins.github.ui.mutations.review.outcome.verdict.published', 'Verdict published')
        : outcome.verdict === 'uncertain'
          ? text('plugins.github.ui.mutations.review.outcome.verdict.uncertain', 'Verdict unconfirmed')
          : text('plugins.github.ui.mutations.review.outcome.verdict.failed', 'Verdict not published');
    const exact = outcome.totalCount === 0
      ? verdict
      : text(
        'plugins.github.ui.mutations.review.outcome.exact',
        '{published}/{total} review comments published; {uncertain} unconfirmed; {failed} not published. {verdict}.',
        {
          published: outcome.publishedCount,
          total: outcome.totalCount,
          uncertain: outcome.uncertainCount,
          failed: outcome.failedCount,
          verdict,
        },
      );
    const hasUncertainty = outcome.uncertainCount > 0 || outcome.verdict === 'uncertain';
    return (
      <Banner
        tone={fullyPublished ? 'success' : 'warning'}
        title={fullyPublished
          ? text('plugins.github.ui.mutations.review.outcome.published', 'Review published')
          : hasUncertainty
            ? text('plugins.github.ui.mutations.uncertain', 'Outcome unknown')
            : text('plugins.github.ui.mutations.review.outcome.partial', 'Review partially published')}
        description={outcome.failure === null
          ? exact
          : `${exact} ${failureDescription(outcome.failure, '')}`.trim()}
      />
    );
  }
  if (outcome.kind === 'applied') {
    return outcome.effect === 'changed'
      ? (
        <Banner
          tone="success"
          title="Done"
          titleKey="plugins.github.ui.mutations.applied"
          description={text(
            'plugins.github.ui.mutations.applied.description',
            'GitHub now reports the state you asked for.',
          )}
        />
      )
      : (
        <Banner
          tone="info"
          title="Nothing to do"
          titleKey="plugins.github.ui.mutations.alreadySatisfied"
          description={text(
            'plugins.github.ui.mutations.alreadySatisfied.description',
            'No request was sent: GitHub already held this state.',
          )}
        />
      );
  }
  if (outcome.kind === 'pending') {
    return (
      <Banner
        tone="info"
        title="Accepted"
        titleKey="plugins.github.ui.mutations.pending"
        description={text(
          'plugins.github.ui.mutations.pending.description',
          'GitHub accepted this request, but the branch update has not appeared yet.',
        )}
      />
    );
  }
  if (outcome.kind === 'refused') {
    const copy = WRITE_REFUSAL_COPY[outcome.reason];
    return (
      <Banner
        tone="warning"
        title="Refused"
        titleKey="plugins.github.ui.mutations.refused"
        description={text(copy.key, copy.fallback)}
      />
    );
  }
  if (outcome.kind === 'uncertain') {
    // Never presented as a failure, and never beside a "try again": this request
    // may already have changed GitHub.
    const stated = text(
      'plugins.github.ui.mutations.uncertain.description',
      'The request was accepted and its effect could not be confirmed. Open this entry'
        + ' again to see what is true now rather than pressing again.',
    );
    return (
      <Banner
        tone="warning"
        title="Outcome unknown"
        titleKey="plugins.github.ui.mutations.uncertain"
        description={outcome.failure === null
          ? stated
          : `${failureDescription(outcome.failure, stated)} ${stated}`}
      />
    );
  }
  if (outcome.kind === 'failed') {
    return (
      <Banner
        tone="danger"
        title="Not carried out"
        titleKey="plugins.github.ui.mutations.notCarriedOut"
        description={failureDescription(
          outcome.failure,
          text(
            'plugins.github.ui.mutations.writeFailed',
            'GitHub could not complete this change.',
          ),
        )}
      />
    );
  }
  if (outcome.kind === 'rejected') {
    return (
      <Banner
        tone="danger"
        title="Not carried out"
        titleKey="plugins.github.ui.mutations.notCarriedOut"
        description={text(
          'plugins.github.ui.mutations.rejected.description',
          'Nothing was changed on GitHub ({code}).',
          { code: outcome.code },
        )}
      />
    );
  }
  return (
    <Banner
      tone="danger"
      title="This answer could not be read"
      titleKey="plugins.github.ui.mutations.unreadable"
      description={text(
        'plugins.github.ui.mutations.unreadable.description',
        'GitHub answered in a form this build does not understand, so nothing here says'
          + ' whether the change was made. Open this entry again to see its current state.',
      )}
    />
  );
}

/** A settled Action gives the shared gate the provider outcome; only that gate can signal Triage. */
type GithubObservedEntryHandlerV1 = (
  execution: PluginActionExecution<unknown>,
  outcome: GithubMutationOutcomeV1 | null,
  actionLocalId: string,
) => void;

type GithubWriteControllerV1 = Readonly<{
  /** `null` until one dispatch has settled; a press in flight settles nothing. */
  outcome: GithubMutationOutcomeV1 | null;
  pending: boolean;
  run: (payload: GithubWritePayloadV1) => void;
}>;

type GithubWritePayloadV1 =
  NonNullable<ReturnType<typeof buildGithubPullRequestTargetInputV1>>
  | NonNullable<ReturnType<typeof buildGithubPullRequestMergeInputV1>>
  | NonNullable<ReturnType<typeof buildGithubIssueCloseInputV1>>
  | NonNullable<ReturnType<typeof buildGithubIssueReopenInputV1>>
  | NonNullable<ReturnType<typeof buildGithubPullRequestMarkReadyInputV1>>
  | NonNullable<ReturnType<typeof buildGithubPullRequestReviewPublicationInputV1>>
  | NonNullable<ReturnType<typeof buildGithubPullRequestReviewCommentCreateInputV1>>
  | NonNullable<ReturnType<typeof buildGithubPullRequestThreadReplyInputV1>>
  | NonNullable<ReturnType<typeof buildGithubIssueCommentInputV1>>
  | NonNullable<ReturnType<typeof buildGithubPullRequestUpdateBranchInputV1>>
  | NonNullable<ReturnType<typeof buildGithubPullRequestReviewersInputV1>>
  | NonNullable<ReturnType<typeof buildGithubPullRequestThreadResolutionInputV1>>
  | NonNullable<ReturnType<typeof buildGithubIssueAssigneesInputV1>>
  | NonNullable<ReturnType<typeof buildGithubIssueLabelsInputV1>>;

/**
 * One write's dispatch and its settled answer, held together.
 *
 * The in-flight guard is the execution hook's, not a second one here: it owns the
 * action's identity, so a second press while one is in flight is the same mutation
 * running twice. The outcome is cleared at dispatch rather than kept, because a
 * stale "Done" sitting above a new press is the worst thing this panel could show.
 */
function useGithubWrite(
  localId: string,
  parseResult: (value: unknown) => GithubMutationResultV1 | null,
  onObserved: GithubObservedEntryHandlerV1,
): GithubWriteControllerV1 {
  const action = React.useMemo(
    () => ({ pluginId: GITHUB_PLUGIN_ID, localId }),
    [localId],
  );
  const { execution, execute } = useExecutePluginAction(action);
  const [outcome, setOutcome] = React.useState<GithubMutationOutcomeV1 | null>(null);

  const run = React.useCallback((payload: GithubWritePayloadV1) => {
    setOutcome(null);
    void (async () => {
      const settled = await execute(payload);
      const parsed = settled.status === 'success' ? parseResult(settled.result) : null;
      const outcome = projectGithubMutationOutcomeV1(settled, parsed);
      setOutcome(outcome);
      onObserved(settled, outcome, localId);
    })();
  }, [execute, localId, onObserved, parseResult]);

  return React.useMemo(
    () => ({ outcome, pending: execution.status === 'pending', run }),
    [execution.status, outcome, run],
  );
}

function parseMergeResult(value: unknown): GithubMutationResultV1 | null {
  const parsed = GithubPullRequestMergeResultV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseStateResult(value: unknown): GithubMutationResultV1 | null {
  const parsed = GithubPullRequestStateResultV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseMarkReadyResult(value: unknown): GithubMutationResultV1 | null {
  const parsed = GithubPullRequestMarkReadyResultV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseReviewPublicationResult(value: unknown): GithubMutationResultV1 | null {
  const parsed = GithubPullRequestReviewPublicationResultV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseUpdateBranchResult(value: unknown): GithubMutationResultV1 | null {
  const parsed = GithubPullRequestUpdateBranchResultV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseReviewersResult(value: unknown): GithubMutationResultV1 | null {
  const parsed = GithubPullRequestReviewersResultV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseIssueDeltaResult(value: unknown): GithubMutationResultV1 | null {
  const parsed = GithubIssueDeltaResultV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseThreadResolutionResult(value: unknown): GithubMutationResultV1 | null {
  const parsed = GithubPullRequestThreadResolutionResultV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

type GithubMergeSignatureStateV1 = Readonly<{
  terminal: boolean;
  /** Changes only after this mount's exact merge Action confirms a changed merge. */
  celebrationSequence: number;
}>;

const STATIC_OPEN_MERGE_SIGNATURE: GithubMergeSignatureStateV1 = Object.freeze({
  terminal: false,
  celebrationSequence: 0,
});

function isGithubMergedState(
  state: TriageDetailSurfaceInputV1['observation']['snapshot']['state'],
): boolean {
  return state.presentation === 'closed' && state.nativeLabel === 'Merged';
}

/**
 * Source-owned lifecycle glyph. Its animation is decorative: the canonical
 * Action banner and aggregate state remain the accessible semantic result.
 */
function GithubMergeSignature({ state }: Readonly<{
  state: GithubMergeSignatureStateV1;
}>): React.ReactElement {
  const { reducedMotion } = useSurfaceContext();
  const progress = React.useRef(new Animated.Value(1)).current;
  const previousSequence = React.useRef(state.celebrationSequence);

  React.useEffect(() => {
    if (state.celebrationSequence === previousSequence.current || reducedMotion) {
      previousSequence.current = state.celebrationSequence;
      progress.setValue(1);
      return undefined;
    }
    previousSequence.current = state.celebrationSequence;
    progress.setValue(0);
    const motion = Animated.timing(progress, {
      toValue: 1,
      duration: 480,
      useNativeDriver: true,
    });
    motion.start();
    return () => motion.stop();
  }, [progress, reducedMotion, state.celebrationSequence]);

  return (
    <Animated.View
      aria-hidden
      style={{
        alignSelf: 'flex-start',
        opacity: progress,
        transform: [{
          scale: progress.interpolate({
            inputRange: [0, 0.55, 1],
            outputRange: [0.82, 1.08, 1],
          }),
        }],
      }}
    >
      <Icon
        name={state.terminal ? 'change-complete' : 'change-open'}
        tone={state.terminal ? 'success' : 'secondary'}
        testID={state.terminal ? 'github-merge-signature-complete' : 'github-merge-signature-open'}
      />
    </Animated.View>
  );
}

/**
 * The merge control: choose how, then merge the head you are looking at.
 *
 * The method has no preselection, here or in the contract. Which of the three runs
 * decides whether the author's commits survive as themselves, and picking one on
 * the reader's behalf would make an accidental press a rewritten history. Until one
 * is chosen the button is inert, which is also what keeps a stray press harmless
 * before the host's own confirmation is ever reached.
 */
function MergeWrite({
  input,
  terminal,
  onObserved,
  capabilities,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  terminal: boolean;
  onObserved: GithubObservedEntryHandlerV1;
  capabilities: GithubRepositoryCapabilitiesV1;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const [mergeMethod, setMergeMethod] = React.useState<GithubMergeMethodV1 | null>(null);
  const write = useGithubWrite(
    GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMerge,
    parseMergeResult,
    onObserved,
  );
  // Built against the first method only to answer whether this observation can
  // address a merge at all; the dispatched payload always carries the chosen one.
  const addressable = React.useMemo(
    () => buildGithubPullRequestMergeInputV1(input, 'merge') !== null,
    [input],
  );
  const payload = React.useMemo(
    () => (mergeMethod === null
      ? null
      : buildGithubPullRequestMergeInputV1(input, mergeMethod)),
    [input, mergeMethod],
  );
  const head = input.observation.nativeRevision;
  const allowedMethods = GITHUB_MERGE_METHODS_V1.filter((method) =>
    capabilities.mergeMethods[method].kind === 'available');

  if (!addressable) {
    // A merge is pinned to the head the user saw. Without one there is nothing
    // honest to pin it to, so the control is absent rather than present and broken.
    return (
      <Text
        variant="caption"
        tone="neutral"
        valueKey="plugins.github.ui.mutations.mergeHeadUnknown"
        fallback={'This observation carries no head commit, so this pull request cannot be'
          + ' merged from here.'}
      />
    );
  }

  if (allowedMethods.length === 0) {
    const exposed = GITHUB_MERGE_METHODS_V1.map((method) => capabilities.mergeMethods[method]);
    const reason = exposed.some((value) => value.kind === 'denied' && value.code === 'repository_archived')
      ? text('plugins.github.ui.capabilities.archived', 'This repository is archived.')
      : exposed.every((value) => value.kind === 'unavailable' && value.code === 'repository_unsupported')
        ? text('plugins.github.ui.capabilities.unsupported', 'This repository does not support this change.')
        : text('plugins.github.ui.capabilities.unknown', 'GitHub did not expose enough permission information to enable this change.');
    return (
      <Stack gap="small">
        <Button
          title="Merge pull request"
          titleKey="plugins.github.ui.mutations.merge"
          variant="primary"
          disabled
          onPress={() => {}}
        />
        <Text variant="caption" tone="neutral" value={reason} />
      </Stack>
    );
  }

  return (
    <Stack gap="small">
      <Form.Select
        label={text('plugins.github.ui.mutations.mergeMethod', 'Merge method')}
        options={allowedMethods.map((method) => ({
          value: method,
          label: text(MERGE_METHOD_COPY[method].key, MERGE_METHOD_COPY[method].fallback),
        }))}
        {...(mergeMethod === null ? {} : { value: mergeMethod })}
        onChange={(value) => {
          // The chooser is the one place a method enters this control, and only
          // the declared vocabulary may. A value outside it selects nothing.
          const chosen = GITHUB_MERGE_METHODS_V1.find((method) => method === value);
          if (chosen !== undefined) setMergeMethod(chosen);
        }}
        disabled={write.pending || terminal}
      />
      {head === undefined
        ? null
        : (
          <Text
            variant="caption"
            tone="neutral"
            valueKey="plugins.github.ui.mutations.mergeHead"
            fallback="Merges {revision}, the head this observation carries. If GitHub has moved on, the merge is refused instead."
            values={{ revision: head.slice(0, 7) }}
          />
        )}
      <Button
        title="Merge pull request"
        titleKey="plugins.github.ui.mutations.merge"
        variant="primary"
        busy={write.pending}
        disabled={payload === null || write.pending || terminal}
        onPress={() => {
          if (payload !== null) write.run(payload);
        }}
      />
      {write.outcome === null ? null : <WriteOutcome outcome={write.outcome} />}
    </Stack>
  );
}

/**
 * Close and reopen: one control shape, because they are one contract shape. Both
 * are head-independent by declaration, so neither is pinned to a revision and
 * neither needs an input beyond the target the observation already names.
 */
function StateWrite({
  localId,
  payload,
  title,
  titleKey,
  onObserved,
}: Readonly<{
  localId: string;
  payload: GithubWritePayloadV1;
  title: string;
  titleKey: string;
  onObserved: GithubObservedEntryHandlerV1;
}>): React.ReactElement {
  const write = useGithubWrite(localId, parseStateResult, onObserved);
  return (
    <Stack gap="small">
      <Button
        title={title}
        titleKey={titleKey}
        variant="secondary"
        busy={write.pending}
        disabled={write.pending}
        onPress={() => write.run(payload)}
      />
      {write.outcome === null ? null : <WriteOutcome outcome={write.outcome} />}
    </Stack>
  );
}

function ExactWrite({
  localId,
  payload,
  title,
  titleKey,
  parseResult,
  onObserved,
}: Readonly<{
  localId: string;
  payload: GithubWritePayloadV1 | null;
  title: string;
  titleKey: string;
  parseResult: (value: unknown) => GithubMutationResultV1 | null;
  onObserved: GithubObservedEntryHandlerV1;
}>): React.ReactElement {
  const write = useGithubWrite(localId, parseResult, onObserved);
  return (
    <Stack gap="small">
      <Button
        title={title}
        titleKey={titleKey}
        variant="secondary"
        busy={write.pending}
        disabled={payload === null || write.pending}
        onPress={() => {
          if (payload !== null) write.run(payload);
        }}
      />
      {write.outcome === null ? null : <WriteOutcome outcome={write.outcome} />}
    </Stack>
  );
}

function PullRequestHeadWrites({
  input,
  onObserved,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  onObserved: GithubObservedEntryHandlerV1;
}>): React.ReactElement {
  const markReady = React.useMemo(() => buildGithubPullRequestMarkReadyInputV1(input), [input]);
  const updateBranch = React.useMemo(
    () => buildGithubPullRequestUpdateBranchInputV1(input),
    [input],
  );
  return (
    <Stack gap="medium">
      {input.observation.snapshot.state.nativeLabel === 'Draft'
        ? (
          <ExactWrite
            localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMarkReady}
            payload={markReady}
            title="Mark ready for review"
            titleKey="plugins.github.mutations.markReady.confirmation.confirmLabel"
            parseResult={parseMarkReadyResult}
            onObserved={onObserved}
          />
        )
        : null}
      <ExactWrite
        localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestUpdateBranch}
        payload={updateBranch}
        title="Update branch"
        titleKey="plugins.github.mutations.updateBranch.confirmation.confirmLabel"
        parseResult={parseUpdateBranchResult}
        onObserved={onObserved}
      />
    </Stack>
  );
}

function PullRequestReviewerWrites({
  input,
  onObserved,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  onObserved: GithubObservedEntryHandlerV1;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const [userValue, setUserValue] = React.useState('');
  const [teamValue, setTeamValue] = React.useState('');
  const users = React.useMemo(() => readGithubNamesV1(userValue), [userValue]);
  const teams = React.useMemo(() => readGithubNamesV1(teamValue), [teamValue]);
  const add = React.useMemo(
    () => buildGithubPullRequestReviewersInputV1(input, users, teams, 'add'),
    [input, teams, users],
  );
  const remove = React.useMemo(
    () => buildGithubPullRequestReviewersInputV1(input, users, teams, 'remove'),
    [input, teams, users],
  );
  return (
    <Stack gap="small">
      <Form.TextField
        label={text('plugins.github.ui.mutations.reviewers.users', 'Reviewer user logins')}
        placeholder={text('plugins.github.ui.mutations.separateWithCommas', 'Separate several with commas')}
        value={userValue}
        onChange={setUserValue}
      />
      <Form.TextField
        label={text('plugins.github.ui.mutations.reviewers.teams', 'Reviewer team slugs')}
        placeholder={text('plugins.github.ui.mutations.separateWithCommas', 'Separate several with commas')}
        value={teamValue}
        onChange={setTeamValue}
      />
      <Row gap="small">
        <ExactWrite
          localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestAddReviewers}
          payload={add}
          title="Request review"
          titleKey="plugins.github.mutations.addReviewers.confirmation.confirmLabel"
          parseResult={parseReviewersResult}
          onObserved={onObserved}
        />
        <ExactWrite
          localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestRemoveReviewers}
          payload={remove}
          title="Withdraw review requests"
          titleKey="plugins.github.mutations.removeReviewers.confirmation.confirmLabel"
          parseResult={parseReviewersResult}
          onObserved={onObserved}
        />
      </Row>
    </Stack>
  );
}

const GITHUB_REVIEW_VERDICTS_V1: readonly GithubPullRequestReviewVerdictV1[] = Object.freeze([
  'comment',
  'approve',
  'requestChanges',
]);

/**
 * Publishes exactly one already-canonical Review Comment. This is intentionally
 * fed by the one detail-mounted public proposal reader: issue and thread writes
 * never invent project/comment identity and never mount another cache lifecycle.
 */
function SingleProposalPublicationWrite({
  input,
  proposals,
  proposalRead,
  kind,
  threadId,
  onObserved,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  proposals: readonly ReviewCommentV1[];
  proposalRead: ReviewCommentProposalReadV1['status'];
  kind: 'issue-comment' | 'thread-reply';
  threadId?: string;
  onObserved: GithubObservedEntryHandlerV1;
}>): React.ReactElement {
  const text = usePluginTranslation();
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
        configuredAccountId: input.instance.binding.account.accountId,
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
      <ExactWrite
        localId={localId}
        payload={payload}
        title={title}
        titleKey={titleKey}
        parseResult={parseReviewPublicationResult}
        onObserved={onObserved}
      />
    </Stack>
  );
}

function PullRequestReviewPublicationWrite({
  input,
  onObserved,
  publicationProposals,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  onObserved: GithubObservedEntryHandlerV1;
  publicationProposals: ReviewCommentProposalReadV1;
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
    if (entries.length === 0 && body === '') return null;
    if (verdict !== 'comment' && body === '') return null;
    return parseReviewCommentPublicationPlanV1({
      target: Object.freeze({
        providerId: 'github',
        configuredAccountId: input.instance.binding.account.accountId,
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
      verdict: body === '' ? null : Object.freeze({ kind: verdict, body }),
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
        configuredAccountId: input.instance.binding.account.accountId,
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
      <Form.TextField
        label={text('plugins.github.ui.mutations.review.summary', 'Review summary')}
        value={verdictBody}
        onChange={setVerdictBody}
      />
      <ExactWrite
        localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestSubmitReview}
        payload={payload}
        title="Submit review"
        titleKey="plugins.github.ui.mutations.review.submit"
        parseResult={parseReviewPublicationResult}
        onObserved={onObserved}
      />
      <ExactWrite
        localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestReviewCommentCreate}
        payload={standaloneCommentPayload}
        title="Publish selected comment"
        titleKey="plugins.github.mutations.reviewCommentCreate.confirmation.confirmLabel"
        parseResult={parseReviewPublicationResult}
        onObserved={onObserved}
      />
    </Stack>
  );
}

function IssueMemberWrites({
  input,
  onObserved,
  publicationProposals,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  onObserved: GithubObservedEntryHandlerV1;
  publicationProposals: ReviewCommentProposalReadV1;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const [assigneeValue, setAssigneeValue] = React.useState('');
  const [labelValue, setLabelValue] = React.useState('');
  const usernames = React.useMemo(() => readGithubNamesV1(assigneeValue), [assigneeValue]);
  const labels = React.useMemo(() => readGithubLabelsV1(labelValue), [labelValue]);
  return (
    <Stack gap="medium">
      <Stack gap="small">
        <Form.TextField
          label={text('plugins.github.ui.mutations.assignees', 'Assignee usernames')}
          placeholder={text('plugins.github.ui.mutations.separateWithCommas', 'Separate several with commas')}
          value={assigneeValue}
          onChange={setAssigneeValue}
        />
        <Row gap="small">
          <ExactWrite
            localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueAssigneeAdd}
            payload={buildGithubIssueAssigneesInputV1(input, usernames, 'add')}
            title="Add assignees"
            titleKey="plugins.github.mutations.issueAssigneeAdd.confirmation.confirmLabel"
            parseResult={parseIssueDeltaResult}
            onObserved={onObserved}
          />
          <ExactWrite
            localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueAssigneeRemove}
            payload={buildGithubIssueAssigneesInputV1(input, usernames, 'remove')}
            title="Remove assignees"
            titleKey="plugins.github.mutations.issueAssigneeRemove.confirmation.confirmLabel"
            parseResult={parseIssueDeltaResult}
            onObserved={onObserved}
          />
        </Row>
      </Stack>
      <Stack gap="small">
        <Form.TextField
          label={text('plugins.github.ui.mutations.labels', 'Label names')}
          placeholder={text('plugins.github.ui.mutations.oneLabelPerLine', 'One label per line')}
          multiline
          value={labelValue}
          onChange={setLabelValue}
        />
        <Row gap="small">
          <ExactWrite
            localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueLabelAdd}
            payload={buildGithubIssueLabelsInputV1(input, labels, 'add')}
            title="Add labels"
            titleKey="plugins.github.mutations.issueLabelAdd.confirmation.confirmLabel"
            parseResult={parseIssueDeltaResult}
            onObserved={onObserved}
          />
          <ExactWrite
            localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueLabelRemove}
            payload={buildGithubIssueLabelsInputV1(input, labels, 'remove')}
            title="Remove label"
            titleKey="plugins.github.mutations.issueLabelRemove.confirmation.confirmLabel"
            parseResult={parseIssueDeltaResult}
            onObserved={onObserved}
          />
        </Row>
      </Stack>
      <SingleProposalPublicationWrite
        input={input}
        proposals={publicationProposals.proposals}
        proposalRead={publicationProposals.status}
        kind="issue-comment"
        onObserved={onObserved}
      />
    </Stack>
  );
}

/**
 * Closing an issue: choose what it means, then say it.
 *
 * The reason is not a formality and it has no default. `Completed` and
 * `Not planned` are two different public statements about the same issue, and
 * everyone watching it reads whichever one this control sends. Until one is
 * chosen the button is inert, exactly as the merge method's is, and for the same
 * reason: a stray press must not decide something on the reader's behalf.
 */
function IssueCloseWrite({
  input,
  onObserved,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  onObserved: GithubObservedEntryHandlerV1;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const [reason, setReason] = React.useState<GithubIssueCloseReasonV1 | null>(null);
  const write = useGithubWrite(
    GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueClose,
    parseStateResult,
    onObserved,
  );
  const payload = React.useMemo(
    () => (reason === null ? null : buildGithubIssueCloseInputV1(input, reason)),
    [input, reason],
  );

  return (
    <Stack gap="small">
      <Form.Select
        label={text('plugins.github.ui.mutations.closeReason', 'Close as')}
        options={GITHUB_ISSUE_CLOSE_REASONS_V1.map((value) => ({
          value,
          label: text(ISSUE_CLOSE_REASON_COPY[value].key, ISSUE_CLOSE_REASON_COPY[value].fallback),
        }))}
        {...(reason === null ? {} : { value: reason })}
        onChange={(value) => {
          // The chooser is the one place a reason enters this control, and only
          // the declared vocabulary may.
          const chosen = GITHUB_ISSUE_CLOSE_REASONS_V1.find((candidate) => candidate === value);
          if (chosen !== undefined) setReason(chosen);
        }}
        disabled={write.pending}
      />
      <Button
        title="Close issue"
        titleKey="plugins.github.ui.mutations.closeIssue"
        variant="secondary"
        busy={write.pending}
        disabled={payload === null || write.pending}
        onPress={() => {
          if (payload !== null) write.run(payload);
        }}
      />
      {write.outcome === null ? null : <WriteOutcome outcome={write.outcome} />}
    </Stack>
  );
}

/** The writes an ISSUE offers, which are its two state transitions and nothing else. */
function IssueWrites({
  input,
  offered,
  onObserved,
  publicationProposals,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  offered: readonly string[];
  onObserved: GithubObservedEntryHandlerV1;
  publicationProposals: ReviewCommentProposalReadV1;
}>): React.ReactElement {
  const reopen = React.useMemo(() => buildGithubIssueReopenInputV1(input), [input]);
  return (
    <Stack gap="medium">
      <Text
        variant="caption"
        tone="neutral"
        valueKey="plugins.github.ui.mutations.issueDescription"
        fallback="These change the issue on GitHub itself. Each one asks you to confirm before anything is written."
      />
      {offered.includes('close') ? <IssueCloseWrite input={input} onObserved={onObserved} /> : null}
      {offered.includes('reopen') && reopen !== null
        ? (
          <StateWrite
            localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueReopen}
            payload={reopen}
            title="Reopen issue"
            titleKey="plugins.github.ui.mutations.reopenIssue"
            onObserved={onObserved}
          />
        )
        : null}
      <IssueMemberWrites input={input} onObserved={onObserved} publicationProposals={publicationProposals} />
    </Stack>
  );
}

function githubOperationCapabilityReason(
  text: PluginTranslate,
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>,
  operation: keyof GithubRepositoryCapabilitiesV1['operations'],
): string | null {
  if (capabilities.kind === 'loading') {
    return text('plugins.github.ui.capabilities.checking', 'Checking repository permissions…');
  }
  if (capabilities.kind === 'unavailable') {
    return text('plugins.github.ui.capabilities.unavailable', 'GitHub repository permissions could not be read.');
  }
  const availability = capabilities.value.operations[operation];
  if (availability.kind === 'available') return null;
  if (availability.code === 'repository_archived') {
    return text('plugins.github.ui.capabilities.archived', 'This repository is archived.');
  }
  if (availability.code === 'repository_unsupported') {
    return text('plugins.github.ui.capabilities.unsupported', 'This repository does not support this change.');
  }
  if (availability.code === 'forbidden_by_forge') {
    return text('plugins.github.ui.capabilities.forbidden', 'Your GitHub repository role does not allow this change.');
  }
  return text('plugins.github.ui.capabilities.unknown', 'GitHub did not expose enough permission information to enable this change.');
}

function WritesSection({
  input,
  kindId,
  mergeSignature,
  onObserved,
  publicationProposals,
  capabilities,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  kindId: GithubTriageKindIdV1;
  mergeSignature: GithubMergeSignatureStateV1;
  onObserved: GithubObservedEntryHandlerV1;
  publicationProposals: ReviewCommentProposalReadV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  const offered = githubOfferedMutationsV1({
    kindId,
    state: input.observation.snapshot.state,
  });
  const target = React.useMemo(
    () => buildGithubPullRequestTargetInputV1(input),
    [input],
  );
  if (offered.length === 0 && kindId !== 'pull-request') return null;
  const representative = kindId === 'issue' ? 'issueComment' : 'pullRequestClose';
  const readyCapabilities = capabilities.kind === 'ready' ? capabilities.value : null;
  const reason = githubOperationCapabilityReason(text, capabilities, representative);

  return (
    <Stack gap="small">
      <Divider />
      {kindId === 'pull-request' ? <GithubMergeSignature state={mergeSignature} /> : null}
      {reason === null ? null : (
        <Stack gap="small">
          <Button
            title="Changes unavailable"
            titleKey="plugins.github.ui.capabilities.changesUnavailable"
            variant="secondary"
            disabled
            onPress={() => {}}
          />
          <Text variant="caption" tone="neutral" value={reason} />
        </Stack>
      )}
      {reason !== null ? null : (
      <>{offered.length === 0 ? null : (
        <>
      <Text
        variant="label"
        valueKey="plugins.github.ui.mutations"
        fallback="Change this on GitHub"
      />
      {target === null
        ? (
          <Banner
            tone="warning"
            title="This entry cannot be changed from here"
            titleKey="plugins.github.ui.mutations.noRoute"
            description="This observation carries no route to GitHub, so nothing here can be written."
            descriptionKey="plugins.github.ui.mutations.noRoute.description"
          />
        )
        : kindId === 'issue'
          ? <IssueWrites input={input} offered={offered} onObserved={onObserved} publicationProposals={publicationProposals} />
          : (
          <Stack gap="medium">
            <Text
              variant="caption"
              tone="neutral"
              valueKey="plugins.github.ui.mutations.description"
              fallback="These change the pull request on GitHub itself. Each one asks you to confirm before anything is written."
            />
            {offered.includes('merge')
              ? (
                <MergeWrite
                  input={input}
                  terminal={mergeSignature.terminal}
                  onObserved={onObserved}
                  capabilities={readyCapabilities as GithubRepositoryCapabilitiesV1}
                />
              )
              : null}
            {input.observation.snapshot.state.presentation === 'active'
              ? (
                <>
                  <PullRequestHeadWrites input={input} onObserved={onObserved} />
                  <PullRequestReviewerWrites input={input} onObserved={onObserved} />
                  <PullRequestReviewPublicationWrite input={input} onObserved={onObserved} publicationProposals={publicationProposals} />
                </>
              )
              : null}
            {offered.includes('close')
              ? (
                <StateWrite
                  localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestClose}
                  payload={target}
                  title="Close pull request"
                  titleKey="plugins.github.ui.mutations.close"
                  onObserved={onObserved}
                />
              )
              : null}
            {offered.includes('reopen')
              ? (
                <StateWrite
                  localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestReopen}
                  payload={target}
                  title="Reopen pull request"
                  titleKey="plugins.github.ui.mutations.reopen"
                  onObserved={onObserved}
                />
              )
              : null}
          </Stack>
        )}
        </>
      )}</>
      )}
    </Stack>
  );
}

/* --------------------------------------------------------------------- Overview */

function OverviewPanel({
  body,
  input,
  kindId,
  locale,
  nowMs,
  mergeSignature,
  onObserved,
  publicationProposals,
  capabilities,
}: Readonly<{
  body: GithubDetailBodyV1;
  input: TriageDetailSurfaceInputV1;
  kindId: GithubTriageKindIdV1;
  locale: string;
  nowMs: number;
  mergeSignature: GithubMergeSignatureStateV1;
  onObserved: GithubObservedEntryHandlerV1;
  publicationProposals: ReviewCommentProposalReadV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const statusFields = body.fields.filter(
    (field): field is Extract<GithubDetailFieldV1, { kind: 'status' }> => field.kind === 'status',
  );
  const pendingFields = body.fields.filter((field) => field.kind === 'pending');
  const entries: readonly MetadataEntry[] = body.fields.flatMap((field) => {
    if (field.kind === 'pending' || field.kind === 'status') return [];
    const value = fieldValueText(field, locale, nowMs);
    return value === null
      ? []
      // The label is this source's own word for one of its fact ids, so it is
      // resolved through the catalog with the declared English as its fallback.
      : [{ label: field.label, labelKey: githubDetailFieldLabelKey(field.id), value }];
  });

  return (
    <ScrollArea>
      <Stack gap="large">
        {statusFields.length === 0 ? null : (
          <Row gap="small">
            {statusFields.map((field) => (
              <Status
                key={field.id}
                tone={field.tone}
                label={text('plugins.github.ui.factStatus', '{label}: {value}', {
                  label: text(githubDetailFieldLabelKey(field.id), field.label),
                  value: field.value,
                })}
              />
            ))}
          </Row>
        )}
        {entries.length === 0
          ? (
            <EmptyState
              title="No projected facts"
              titleKey="plugins.github.ui.noFacts"
              description="This observation carried no displayable GitHub facts."
              descriptionKey="plugins.github.ui.noFacts.description"
            />
          )
          : <Metadata title="GitHub" titleKey="plugins.github.ui.facts" entries={entries} />}
        {pendingFields.length === 0 ? null : (
          <Stack gap="small">
            <Text
              variant="caption"
              tone="neutral"
              valueKey="plugins.github.ui.pendingPanels.description"
              fallback="Answered in the panels beside this one, not on the list row:"
            />
            <Row gap="small">
              {pendingFields.map((field) => (
                <Badge
                  key={field.id}
                  value={field.label}
                  valueKey={githubDetailFieldLabelKey(field.id)}
                />
              ))}
            </Row>
          </Stack>
        )}
        <WritesSection
          input={input}
          kindId={kindId}
          mergeSignature={mergeSignature}
          onObserved={onObserved}
          publicationProposals={publicationProposals}
          capabilities={capabilities}
        />
      </Stack>
    </ScrollArea>
  );
}

/* --------------------------------------------------------------------- Timeline */

/**
 * The reader-facing sentence for one timeline arm.
 *
 * `forcePushed` and `baseChanged` read differently from an ordinary push on
 * purpose: both silently invalidate work computed against the previous head or
 * base, and a reader scanning the timeline is exactly who needs to notice.
 */
function timelineHeadline(text: PluginTranslate, row: GithubProjectedTimelineRowV1): string {
  // An event this build does not model keeps GitHub's own word for it rather
  // than disappearing or being described as something it is not. GitHub's word
  // is not translated, because it is a provider fact and not this product's
  // sentence about one.
  const modelled = GITHUB_TIMELINE_HEADLINES_V1[row.kind];
  const headline = modelled === undefined
    ? row.rawKind
    : text(githubTimelineHeadlineKey(row.kind), modelled);
  return row.actor === undefined ? headline : `${headline} · ${row.actor}`;
}

function TimelinePanel({
  input,
  locale,
  nowMs,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const controller = useGithubTimeline(input);
  const { state } = controller;

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title="Reading this timeline from GitHub" titleKey="plugins.github.ui.readingTimeline" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The timeline is unavailable"
        titleKey="plugins.github.ui.timelineUnavailable"
        description={failureDescription(
          state.failure,
          text('plugins.github.ui.readFailed', 'GitHub could not complete this read.'),
        )}
      />
    );
  }

  const incomplete = incompleteDescription(text, state.incomplete, null);
  return (
    <List
      accessibilityLabel="Events GitHub recorded for this entry"
      accessibilityLabelKey="plugins.github.ui.timelineLabel"
      items={state.rows}
      keyForItem={(row) => row.id}
      header={<PageFailureBanner state={state} />}
      empty={(
        <EmptyState
          title="No recorded events"
          titleKey="plugins.github.ui.noEvents"
          description="GitHub has recorded no timeline events for this entry yet."
          descriptionKey="plugins.github.ui.noEvents.description"
        />
      )}
      footer={(
        <Stack gap="small">
          <Text
            variant="caption"
            tone="neutral"
            valueKey={state.omittedRowCount === 0
              ? 'plugins.github.ui.eventsRead'
              : 'plugins.github.ui.eventsReadWithUnreadable'}
            fallback={state.omittedRowCount === 0
              ? '{count} event(s) read.'
              : '{count} event(s) read. {unreadable} row(s) on the pages read could not be understood.'}
            values={{ count: state.rows.length, unreadable: state.omittedRowCount }}
          />
          {incomplete === null
            ? null
            : <Text variant="caption" tone="neutral">{incomplete}</Text>}
          {state.canLoadMore
            ? (
              <Button
                // GitHub pages this timeline oldest first, so the next page is
                // LATER events, not earlier ones. The control says what it does.
                title="Load more events"
                titleKey="plugins.github.ui.loadMoreEvents"
                variant="secondary"
                busy={state.pending}
                onPress={controller.loadMore}
              />
            )
            : null}
          <RefreshRow
            onRefresh={controller.refresh}
            pending={state.pending}
            accessibilityLabel="Re-read this timeline from GitHub"
            accessibilityLabelKey="plugins.github.ui.rereadTimeline"
          />
        </Stack>
      )}
      renderItem={(row) => (
        <Item
          title={timelineHeadline(text, row)}
          {...(row.summary === undefined ? {} : { subtitle: row.summary })}
          {...(row.atMs === undefined
            ? {}
            : { detail: formatTimestamp(locale, row.atMs, 'relative', nowMs) })}
          {...(row.webUrl === undefined
            ? {}
            : {
              accessory: (
                <Action.OpenExternal
                  url={row.webUrl}
                  variant="plain"
                  accessibilityLabel={text(
                    'plugins.github.ui.openOnGithub',
                    'Open {item} on GitHub',
                    { item: timelineHeadline(text, row) },
                  )}
                />
              ),
            })}
        />
      )}
    />
  );
}

/* ------------------------------------------------------------------------ Files */

const CHANGED_FILE_TONES: Readonly<Record<string, 'success' | 'danger' | 'info' | 'neutral'>> =
  Object.freeze({
    added: 'success',
    removed: 'danger',
    renamed: 'info',
    copied: 'info',
  });

function changedFileDetail(
  row: GithubProjectedChangedFileRowV1,
  locale: string,
): string {
  return `+${formatNumber(locale, row.additions, 'compact')} −${formatNumber(locale, row.deletions, 'compact')}`;
}

function changedFileSubtitle(text: PluginTranslate, row: GithubProjectedChangedFileRowV1): string {
  const declaredStatus = GITHUB_CHANGED_FILE_STATUS_LABELS_V1[row.status];
  const status = declaredStatus === undefined
    ? row.status
    : text(githubChangedFileStatusKey(row.status), declaredStatus);
  const renamed = row.previousPath === undefined
    ? null
    : text('plugins.github.ui.fileWasAt', 'was {path}', { path: row.previousPath });
  // A file GitHub omitted the patch for is a real provider fact, and it renders
  // as that fact rather than as an empty diff.
  const diff = row.diffAvailable
    ? null
    : text('plugins.github.ui.fileDiffUnavailable', 'diff unavailable for this file');
  return [status, renamed, diff].filter((part) => part !== null).join(' · ');
}

function checkStatusText(text: PluginTranslate, row: GithubProjectedCheckRowV1): string {
  if (row.conclusion !== undefined) {
    const declared = GITHUB_CHECK_CONCLUSION_LABELS_V1[row.conclusion];
    return declared === undefined
      ? row.conclusion
      : text(githubCheckConclusionKey(row.conclusion), declared);
  }
  const declared = GITHUB_CHECK_STATUS_LABELS_V1[row.status];
  return declared === undefined ? row.status : text(githubCheckStatusKey(row.status), declared);
}

function FilesPanel({
  input,
  locale,
}: Readonly<{ input: TriageDetailSurfaceInputV1; locale: string }>): React.ReactElement {
  const text = usePluginTranslation();
  const controller = useGithubChangedFiles(input);
  const { state } = controller;
  // The reading order is a source-owned fact computed over everything read so
  // far, so appending a page reorders within the same three bands rather than
  // stapling a second, differently ordered list onto the end.
  const sections = React.useMemo(
    () => groupGithubChangedFiles(orderGithubChangedFiles(state.rows))
      .map((section) => ({ key: section.band, title: section.title, data: section.rows })),
    [state.rows],
  );

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title="Reading the changed files from GitHub" titleKey="plugins.github.ui.readingFiles" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The changed files are unavailable"
        titleKey="plugins.github.ui.filesUnavailable"
        description={failureDescription(
          state.failure,
          text('plugins.github.ui.readFailed', 'GitHub could not complete this read.'),
        )}
      />
    );
  }

  const incomplete = incompleteDescription(
    text,
    state.incomplete,
    text(
      'plugins.github.ui.incompleteFiles.description',
      'GitHub returns at most {limit} files for one pull request, and this one reached that'
        + ' limit. Open it on GitHub to see the rest.',
      { limit: GITHUB_CHANGED_FILES_CEILING_V1 },
    ),
  );

  if (state.rows.length === 0) {
    return (
      <EmptyState
        title="No changed files"
        titleKey="plugins.github.ui.noFiles"
        description="GitHub reports that this pull request changes no files."
        descriptionKey="plugins.github.ui.noFiles.description"
      />
    );
  }

  return (
    <List
      accessibilityLabel="Files this pull request changes"
      accessibilityLabelKey="plugins.github.ui.filesLabel"
      sections={sections}
      keyForItem={(row) => row.path}
      header={(
        <Stack gap="small">
          <PageFailureBanner state={state} />
          {incomplete === null
            ? null
            : (
              // Known-incomplete is a rendered state, not a log line: a count
              // that stops at a round number with no explanation reads as a
              // defect in this product rather than a limit of GitHub's.
              <Banner tone="warning" title="This file list is incomplete" titleKey="plugins.github.ui.incompleteFiles" description={incomplete} />
            )}
        </Stack>
      )}
      footer={(
        <Stack gap="small">
          <Text
            variant="caption"
            tone="neutral"
            valueKey={state.omittedRowCount === 0
              ? 'plugins.github.ui.filesRead'
              : 'plugins.github.ui.filesReadWithUnreadable'}
            fallback={state.omittedRowCount === 0
              ? '{count} changed file(s) read.'
              : '{count} changed file(s) read. {unreadable} row(s) on the pages read could not be understood.'}
            values={{ count: state.rows.length, unreadable: state.omittedRowCount }}
          />
          {state.canLoadMore
            ? (
              <Button
                title="Load more files"
                titleKey="plugins.github.ui.loadMoreFiles"
                variant="secondary"
                busy={state.pending}
                onPress={controller.loadMore}
              />
            )
            : null}
          <RefreshRow
            onRefresh={controller.refresh}
            pending={state.pending}
            accessibilityLabel="Re-read the changed files from GitHub"
            accessibilityLabelKey="plugins.github.ui.rereadFiles"
          />
        </Stack>
      )}
      renderItem={(row) => (
        <Item
          title={row.path}
          subtitle={changedFileSubtitle(text, row)}
          detail={changedFileDetail(row, locale)}
          tone={CHANGED_FILE_TONES[row.status] ?? 'neutral'}
          accessoryOutsidePressable
          accessory={(
            <Row gap="small">
              <Action.Copy
                value={row.path}
                variant="plain"
                accessibilityLabel={text('plugins.github.ui.copyValue', 'Copy {item}', {
                  item: row.path,
                })}
              />
              {row.webUrl === undefined
                ? null
                : (
                  <Action.OpenExternal
                    url={row.webUrl}
                    variant="plain"
                    accessibilityLabel={text(
                      'plugins.github.ui.openOnGithub',
                      'Open {item} on GitHub',
                      { item: row.path },
                    )}
                  />
                )}
            </Row>
          )}
        />
      )}
    />
  );
}

/* ----------------------------------------------------------------------- Checks */

function checkTone(row: GithubProjectedCheckRowV1): 'success' | 'danger' | 'warning' | 'neutral' {
  if (row.status !== 'completed') return 'warning';
  if (row.conclusion === undefined) return 'neutral';
  return row.conclusion === 'success' ? 'success' : 'danger';
}

function checksRollup(view: GithubChecksViewV1): readonly MetadataEntry[] {
  // A count is shown only where the source could compute one over a suite it
  // fully read. Rendering `0 failing` for a suite nobody could read would be a
  // fabricated fact, so the entry is absent instead.
  return [
    ...(view.failingCount === undefined
      ? []
      : [{
        label: 'Failing',
        labelKey: 'plugins.github.ui.checksFailing',
        value: String(view.failingCount),
      }]),
    ...(view.runningCount === undefined
      ? []
      : [{
        label: 'Running',
        labelKey: 'plugins.github.ui.checksRunning',
        value: String(view.runningCount),
      }]),
    ...(view.passingCount === undefined
      ? []
      : [{
        label: 'Passing',
        labelKey: 'plugins.github.ui.checksPassing',
        value: String(view.passingCount),
      }]),
  ];
}

function ChecksBody({
  view,
  locale,
  nowMs,
  onRefresh,
}: Readonly<{
  view: GithubChecksViewV1;
  locale: string;
  nowMs: number;
  onRefresh: () => void;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const rollup = checksRollup(view);
  const failures = [
    ...(view.checkRunsFailure === undefined
      ? []
      : [{
        label: text('plugins.github.ui.checkRuns', 'Check runs'),
        failure: view.checkRunsFailure,
      }]),
    ...(view.commitStatusFailure === undefined
      ? []
      : [{
        label: text('plugins.github.ui.commitStatuses', 'Commit statuses'),
        failure: view.commitStatusFailure,
      }]),
  ];

  return (
    <List
      accessibilityLabel="Checks GitHub reports for this pull request"
      accessibilityLabelKey="plugins.github.ui.checksLabel"
      items={view.rows}
      keyForItem={(row) => row.key}
      header={(
        <Stack gap="small">
          {failures.length === 0
            ? null
            : (
              <Banner
                tone="warning"
                title="One check surface could not be read"
                titleKey="plugins.github.ui.checkSurfaceUnavailable"
                description={failures
                  .map((entry) => `${entry.label}: ${entry.failure.code}`)
                  .join(' · ')}
              />
            )}
          {view.state !== 'knownIncomplete'
            ? null
            : (
              <Banner
                tone="warning"
                title="This check suite is larger than GitHub will list"
                titleKey="plugins.github.ui.checkSuiteIncomplete"
                description="The rows below are real, but they are not the whole suite."
                descriptionKey="plugins.github.ui.checkSuiteIncomplete.description"
              />
            )}
          {rollup.length === 0 ? null : <Metadata title="At this head" titleKey="plugins.github.ui.atHead" entries={rollup} />}
          <Text
            variant="caption"
            tone="neutral"
            valueKey="plugins.github.ui.readAgainstRevision"
            fallback="Read against {revision}."
            values={{ revision: view.headRevision.slice(0, 7) }}
          />
        </Stack>
      )}
      empty={(
        // `none` and `unknown` are different answers and never render alike.
        view.state === 'unknown'
          ? (
            <ErrorState
              title="The checks could not be determined"
              titleKey="plugins.github.ui.checksUnknown"
              description="GitHub did not answer for this commit, so nothing here says the checks passed."
              descriptionKey="plugins.github.ui.checksUnknown.description"
            />
          )
          : (
            <EmptyState
              title="No checks configured"
              titleKey="plugins.github.ui.noChecks"
              description="No check run or commit status reports against this commit."
              descriptionKey="plugins.github.ui.noChecks.description"
            />
          )
      )}
      footer={(
        <Stack gap="small">
          {view.omittedRowCount === 0
            ? null
            : (
              <Text
                variant="caption"
                tone="neutral"
                valueKey="plugins.github.ui.checksNotListed"
                fallback="{count} further check(s) are not listed."
                values={{ count: view.omittedRowCount }}
              />
            )}
          <RefreshRow
            onRefresh={onRefresh}
            pending={false}
            accessibilityLabel="Re-read the checks from GitHub"
            accessibilityLabelKey="plugins.github.ui.rereadChecks"
          />
        </Stack>
      )}
      renderItem={(row) => (
        <Item
          title={row.name}
          subtitle={checkStatusText(text, row)}
          tone={checkTone(row)}
          {...(row.completedAtMs === undefined
            ? {}
            : { detail: formatTimestamp(locale, row.completedAtMs, 'relative', nowMs) })}
          accessoryOutsidePressable
          accessory={(
            <Row gap="small">
              <Action.Copy
                value={row.name}
                variant="plain"
                accessibilityLabel={text('plugins.github.ui.copyValue', 'Copy {item}', {
                  item: row.name,
                })}
              />
              {row.detailsUrl === undefined
                ? null
                : (
                  <Action.OpenExternal
                    url={row.detailsUrl}
                    variant="plain"
                  accessibilityLabel={text(
                    'plugins.github.ui.openResults',
                    'Open results for {item}',
                    { item: row.name },
                  )}
                  />
                )}
            </Row>
          )}
        />
      )}
    />
  );
}

function ChecksPanel({
  input,
  locale,
  nowMs,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const controller = useGithubChecks(input);
  const checks: GithubReadStateV1<GithubChecksViewV1> = controller.state;

  if (checks.kind === 'loading') {
    return <LoadingState title="Reading the checks from GitHub" titleKey="plugins.github.ui.readingChecks" />;
  }
  if (checks.kind === 'unavailable') {
    return (
      <ErrorState
        title="The checks are unavailable"
        titleKey="plugins.github.ui.checksUnavailable"
        description={failureDescription(
          checks.failure,
          text('plugins.github.ui.readFailed', 'GitHub could not complete this read.'),
        )}
      />
    );
  }
  return (
    <ChecksBody
      view={checks.value}
      locale={locale}
      nowMs={nowMs}
      onRefresh={controller.refresh}
    />
  );
}

/* --------------------------------------------------------------------- Comments */

/**
 * The one sentence this panel owes its reader, every time it is shown.
 *
 * GitHub serves pull-request-level comments, line comments and review bodies as
 * separate resources with separate cursors. This panel reads the first of them,
 * and saying so is what keeps a reader from believing the conversation is empty
 * when it is only elsewhere.
 */
function commentScopeDisclosure(text: PluginTranslate): string {
  return text(
    'plugins.github.ui.commentScope',
    'These are comments on the entry itself. Line-anchored review conversations are shown'
      + ' in Feedback.',
  );
}

/**
 * One remark, rendered the same way wherever it is read.
 *
 * The `Comments` panel and the `Feedback` plane show the same GitHub comment,
 * and two markups for one body is how a comment starts announcing its author
 * differently in one product. The two callers differ only in the shape their
 * read hands over, so this row takes the resolved facts rather than either
 * caller's row type.
 */
type GithubCommentRowFactsV1 = Readonly<{
  author: string | null;
  atMs: number | null;
  body: string;
  webUrl: string | null;
  edited: boolean;
}>;

function commentHeadline(text: PluginTranslate, row: GithubCommentRowFactsV1): string {
  const author = row.author ?? text('plugins.github.ui.someone', 'Someone');
  return row.edited
    ? text('plugins.github.ui.commentEdited', '{author} · edited', { author })
    : author;
}

function CommentRow({
  row,
  locale,
  nowMs,
}: Readonly<{
  row: GithubCommentRowFactsV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const headline = commentHeadline(text, row);
  return (
    <Stack gap="small">
      <Row gap="small">
        <Text variant="caption">{headline}</Text>
        {row.atMs === null
          ? null
          : (
            <Text variant="caption" tone="neutral">
              {formatTimestamp(locale, row.atMs, 'relative', nowMs)}
            </Text>
          )}
        {row.webUrl === null
          ? null
          : (
            <Action.OpenExternal
              url={row.webUrl}
              variant="plain"
              accessibilityLabel={text(
                'plugins.github.ui.openOnGithub',
                'Open {item} on GitHub',
                { item: headline },
              )}
            />
          )}
      </Row>
      {row.body === ''
        ? (
          <Text
            variant="caption"
            tone="neutral"
            valueKey="plugins.github.ui.commentNoText"
            fallback="This comment carries no text."
          />
        )
        : <Markdown value={row.body} />}
      <Divider />
    </Stack>
  );
}

function feedbackCommentRowFacts(
  row: import('../triage/feedback.js').GithubFeedbackCommentV1,
): GithubCommentRowFactsV1 {
  return {
    author: row.author,
    atMs: row.createdAtMs,
    body: row.body,
    webUrl: row.url,
    edited: false,
  };
}

function CommentsPanel({
  input,
  locale,
  nowMs,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const controller = useGithubFeedbackComments(input);
  const { state } = controller;
  const rows = React.useMemo(
    () => Object.freeze([...state.rows].sort((left, right) => {
      if (left.createdAtMs !== null && right.createdAtMs !== null
        && left.createdAtMs !== right.createdAtMs) {
        return left.createdAtMs - right.createdAtMs;
      }
      if (left.createdAtMs === null && right.createdAtMs !== null) return 1;
      if (left.createdAtMs !== null && right.createdAtMs === null) return -1;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    })),
    [state.rows],
  );

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <LoadingState title="Reading this conversation from GitHub" titleKey="plugins.github.ui.readingConversation" />;
  }
  if (state.kind === 'unavailable') {
    return (
      <ErrorState
        title="The conversation is unavailable"
        titleKey="plugins.github.ui.conversationUnavailable"
        description={failureDescription(
          state.failure,
          text('plugins.github.ui.readFailed', 'GitHub could not complete this read.'),
        )}
      />
    );
  }

  const incomplete = incompleteDescription(text, state.incomplete, null);
  return (
    <List
      accessibilityLabel="Comments on this GitHub entry"
      accessibilityLabelKey="plugins.github.ui.commentsLabel"
      preserveVisibleContentPositionOnPrepend
      items={rows}
      keyForItem={(row) => row.id}
      header={(
        <Stack gap="small">
          <Text variant="caption" tone="neutral">{commentScopeDisclosure(text)}</Text>
          <PageFailureBanner state={state} />
        </Stack>
      )}
      empty={(
        <EmptyState
          title="No comments yet"
          titleKey="plugins.github.ui.noComments"
          description={commentScopeDisclosure(text)}
        />
      )}
      footer={(
        <Stack gap="small">
          <Text
            variant="caption"
            tone="neutral"
            valueKey={state.omittedRowCount === 0
              ? 'plugins.github.ui.commentsRead'
              : 'plugins.github.ui.commentsReadWithUnreadable'}
            fallback={state.omittedRowCount === 0
              ? '{count} comment(s) read.'
              : '{count} comment(s) read. {unreadable} row(s) on the pages read could not be understood.'}
            values={{ count: rows.length, unreadable: state.omittedRowCount }}
          />
          {state.projectionTruncated
            ? (
              <Text
                variant="caption"
                tone="neutral"
                valueKey="plugins.github.ui.commentsShortened.description"
                fallback="Some comments were shortened. Open the entry on GitHub to read them in full."
              />
            )
            : null}
          {incomplete === null
            ? null
            : <Text variant="caption" tone="neutral">{incomplete}</Text>}
          {state.canLoadMore
            ? (
              <Button
                title="Show 40 earlier comments"
                titleKey="plugins.github.ui.showEarlierIssueComments"
                variant="secondary"
                busy={state.pending}
                onPress={controller.loadMore}
              />
            )
            : null}
          <RefreshRow
            onRefresh={controller.refresh}
            pending={state.pending}
            accessibilityLabel="Re-read this conversation from GitHub"
            accessibilityLabelKey="plugins.github.ui.rereadConversation"
          />
        </Stack>
      )}
      renderItem={(row) => (
        <CommentRow row={feedbackCommentRowFacts(row)} locale={locale} nowMs={nowMs} />
      )}
    />
  );
}

/* --------------------------------------------------------------------- Feedback */

/** GitHub's own review-state word, in the reader's language where there is one. */
function reviewStateText(text: PluginTranslate, state: string): string {
  const normalized = state.trim().toLowerCase();
  const copy = GITHUB_REVIEW_STATE_LABELS_V1[normalized];
  return copy === undefined ? state : text(githubReviewStateKey(normalized), copy);
}

/** The two review-people groups, rendered as two labelled groups and never unioned. */
function ReviewPeople({
  people,
  locale,
  nowMs,
}: Readonly<{
  people: GithubFeedbackReviewPeopleV1;
  locale: string;
  nowMs: number;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  if (people.reviewed.length === 0 && people.requested.length === 0) return null;

  const reviewed: readonly MetadataEntry[] = people.reviewed.map((reviewer) => ({
    label: reviewer.login,
    value: reviewer.submittedAtMs === undefined
      ? reviewStateText(text, reviewer.state)
      : `${reviewStateText(text, reviewer.state)} · ${formatTimestamp(locale, reviewer.submittedAtMs, 'relative', nowMs)}`,
  }));
  const requested: readonly MetadataEntry[] = people.requested.map((request) => ({
    label: request.subject,
    // `requested_reviewers` has no request instant. Rendering the observation
    // time here would turn the time we looked into a claim about when GitHub
    // asked, so requested reviewers state only that work is still awaited.
    value: text('plugins.github.ui.reviewAwaited', 'Waiting'),
  }));

  return (
    <Stack gap="small">
      {reviewed.length === 0
        ? null
        : (
          <Metadata
            title="Reviewed"
            titleKey="plugins.github.ui.reviewedBy"
            entries={reviewed}
          />
        )}
      {requested.length === 0
        ? null
        : (
          // Never merged with the group above: a person who reviewed is history,
          // and a request nobody has answered is work still outstanding.
          <Metadata
            title="Review requested from"
            titleKey="plugins.github.ui.reviewRequestedFrom"
            entries={requested}
          />
        )}
    </Stack>
  );
}

const FINDING_STATE_COPY: Readonly<Record<'check' | 'conflict', Readonly<{
  key: string;
  fallback: string;
}>>> = Object.freeze({
  check: Object.freeze({
    key: 'plugins.github.ui.findingCheck',
    fallback: 'Checks GitHub reports as failing',
  }),
  conflict: Object.freeze({
    key: 'plugins.github.ui.findingConflict',
    fallback: 'GitHub cannot merge this as it stands',
  }),
});

function FeedbackFindingRow({
  finding,
  input,
  locale,
  nowMs,
  onObserved,
  publicationProposals,
  capabilities,
}: Readonly<{
  finding: GithubFeedbackFindingV1;
  input: TriageDetailSurfaceInputV1;
  locale: string;
  nowMs: number;
  onObserved: GithubObservedEntryHandlerV1;
  publicationProposals: ReviewCommentProposalReadV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
}>): React.ReactElement {
  const text = usePluginTranslation();
  if (finding.resource === 'comment') {
    return (
      <CommentRow
        row={{
          author: finding.author,
          atMs: finding.atMs,
          body: finding.body,
          webUrl: finding.webUrl,
          // The finding arm carries no edit instant, and inventing one would
          // label an unedited comment as edited.
          edited: false,
        }}
        locale={locale}
        nowMs={nowMs}
      />
    );
  }
  if (finding.resource === 'review') {
    return (
      <Stack gap="small">
        <Item
          title={reviewStateText(text, finding.state)}
          subtitle={finding.author ?? text('plugins.github.ui.unknownAuthor', 'Unknown author')}
        />
        {finding.body === ''
          ? null
          : (
            <CommentRow
              row={{
                author: finding.author,
                atMs: finding.atMs,
                body: finding.body,
                webUrl: finding.webUrl,
                edited: false,
              }}
              locale={locale}
              nowMs={nowMs}
            />
          )}
      </Stack>
    );
  }
  if (finding.resource === 'thread') {
    return finding.previousRepliesCursor === null
      ? (
        <ThreadFeedbackFinding
          input={input}
          finding={finding}
          locale={locale}
          nowMs={nowMs}
          onObserved={onObserved}
          publicationProposals={publicationProposals}
          capabilities={capabilities}
        />
      )
      : (
        <PagedThreadFeedbackFinding
          input={input}
          finding={finding}
          firstCursor={finding.previousRepliesCursor}
          locale={locale}
          nowMs={nowMs}
          onObserved={onObserved}
          publicationProposals={publicationProposals}
          capabilities={capabilities}
        />
      );
  }
  const copy = FINDING_STATE_COPY[finding.kind];
  return (
    <Item
      // GitHub's own words for the state, kept as the provider fact they are.
      title={finding.label}
      subtitle={text(copy.key, copy.fallback)}
      tone={finding.tone}
      {...(finding.atMs === null
        ? {}
        : { detail: formatTimestamp(locale, finding.atMs, 'relative', nowMs) })}
    />
  );
}

type GithubThreadFindingV1 = Extract<GithubFeedbackFindingV1, { resource: 'thread' }>;

function ThreadFeedbackFinding({
  input,
  finding,
  earlierReplies = [],
  loadMore,
  pending = false,
  locale,
  nowMs,
  onObserved,
  publicationProposals,
  capabilities,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  finding: GithubThreadFindingV1;
  earlierReplies?: GithubThreadFindingV1['replies'];
  loadMore?: () => void;
  pending?: boolean;
  locale: string;
  nowMs: number;
  onObserved: GithubObservedEntryHandlerV1;
  publicationProposals: ReviewCommentProposalReadV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const location = finding.path === null
    ? text('plugins.github.ui.reviewThread', 'Review conversation')
    : finding.line === null ? finding.path : `${finding.path}:${finding.line}`;
  const nextResolved = !finding.isResolved;
  const payload = buildGithubPullRequestThreadResolutionInputV1(
    input,
    finding.id,
    nextResolved,
  );
  const action = nextResolved
    ? text('plugins.github.ui.mutations.thread.resolve', 'Resolve conversation')
    : text('plugins.github.ui.mutations.thread.reopen', 'Reopen conversation');
  const resolutionReason = githubOperationCapabilityReason(
    text,
    capabilities,
    'pullRequestThreadResolution',
  );
  const replyReason = githubOperationCapabilityReason(text, capabilities, 'pullRequestThreadReply');
  const capabilityReason = resolutionReason ?? replyReason;
  return (
      <Stack gap="small">
        <Item
          title={location}
          subtitle={finding.isResolved
            ? text('plugins.github.ui.threadResolved', 'Resolved')
            : text('plugins.github.ui.threadUnresolved', 'Unresolved')}
          tone={finding.isResolved ? 'neutral' : 'warning'}
        />
        {[...earlierReplies, ...finding.replies].map((reply) => (
          <CommentRow
            key={reply.id}
            row={{
              author: reply.author,
              atMs: reply.createdAtMs,
              body: reply.body,
              webUrl: reply.url,
              edited: false,
            }}
            locale={locale}
            nowMs={nowMs}
          />
        ))}
        {loadMore === undefined
          ? null
          : <Button title="Load earlier replies" titleKey="plugins.github.ui.loadEarlierReplies" variant="secondary" busy={pending} onPress={loadMore} />}
        {capabilityReason === null ? <><ExactWrite
          localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestThreadResolution}
          payload={payload}
          title={`${action} at ${location}`}
          titleKey={nextResolved
            ? 'plugins.github.ui.mutations.thread.resolve'
            : 'plugins.github.ui.mutations.thread.reopen'}
          parseResult={parseThreadResolutionResult}
          onObserved={onObserved}
        />
        <SingleProposalPublicationWrite
          input={input}
          proposals={publicationProposals.proposals}
          proposalRead={publicationProposals.status}
          kind="thread-reply"
          threadId={finding.id}
          onObserved={onObserved}
        /></> : (
          <Stack gap="small">
            <Button
              title="Changes unavailable"
              titleKey="plugins.github.ui.capabilities.changesUnavailable"
              variant="secondary"
              disabled
              onPress={() => {}}
            />
            <Text
              variant="caption"
              tone="neutral"
              value={capabilityReason}
            />
          </Stack>
        )}
      </Stack>
  );
}

function PagedThreadFeedbackFinding({
  input,
  finding,
  firstCursor,
  locale,
  nowMs,
  onObserved,
  publicationProposals,
  capabilities,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  finding: GithubThreadFindingV1;
  firstCursor: string;
  locale: string;
  nowMs: number;
  onObserved: GithubObservedEntryHandlerV1;
  publicationProposals: ReviewCommentProposalReadV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
}>): React.ReactElement {
  const replies = useGithubFeedbackThreadReplies(input, finding.id, firstCursor);
  return (
    <ThreadFeedbackFinding
      input={input}
      finding={finding}
      earlierReplies={replies.state.rows}
      {...(replies.state.canLoadMore ? { loadMore: replies.loadMore } : {})}
      pending={replies.state.pending}
      locale={locale}
      nowMs={nowMs}
      onObserved={onObserved}
      publicationProposals={publicationProposals}
      capabilities={capabilities}
    />
  );
}

/**
 * The `Feedback` plane: what is being said about this pull request, who has
 * signed off, who is still being waited on, and what GitHub reports as wrong.
 *
 * It composes the conversation walk with the canonical reviews and checks
 * reads. They settle independently: one failing leaves the other answers on
 * screen beside a banner naming exactly what could not be read.
 */
function FeedbackPanel({
  input,
  locale,
  nowMs,
  onObserved,
  publicationProposals,
  capabilities,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  locale: string;
  nowMs: number;
  onObserved: GithubObservedEntryHandlerV1;
  publicationProposals: ReviewCommentProposalReadV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const conversation = useGithubFeedbackComments(input);
  const threads = useGithubFeedbackThreads(input);
  const reviews = useGithubFeedbackReviews(input);
  const requests = useGithubFeedbackRequests(input);
  const checks = useGithubChecks(input);
  const { observation } = input;
  const currentChecks = checks.state.kind === 'ready'
    ? checks.state.value.rowState ?? null
    : null;
  const view: GithubFeedbackViewV1 = React.useMemo(
    () => projectGithubFeedback({
      facts: observation.snapshot.facts,
      observedAtMs: observation.observedAtMs,
      comments: conversation.state.rows,
      historicalReviews: reviews.state.rows,
      threads: threads.state.rows,
      reviewDecision: reviews.reviewDecision,
      requests: requests.state.rows,
      checks: currentChecks,
    }),
    [checks.state, conversation.state.rows, observation, requests.state.rows,
      reviews.reviewDecision, reviews.state.rows, threads.state.rows],
  );

  const conversationSettling = conversation.state.kind === 'idle'
    || conversation.state.kind === 'loading';
  const reviewsSettling = reviews.state.kind === 'loading';
  const threadsSettling = threads.state.kind === 'loading';
  const requestsSettling = requests.state.kind === 'loading';
  const checksSettling = checks.state.kind === 'loading';
  if (conversationSettling && threadsSettling && reviewsSettling
    && requestsSettling && checksSettling) {
    return (
      <LoadingState
        title="Reading the feedback on this pull request from GitHub"
        titleKey="plugins.github.ui.readingFeedback"
      />
    );
  }

  const readFailed = text(
    'plugins.github.ui.readFailed',
    'GitHub could not complete this read.',
  );
  if (
    conversation.state.kind === 'unavailable'
    && threads.state.kind === 'unavailable'
    && reviews.state.kind === 'unavailable'
    && requests.state.kind === 'unavailable'
    && checks.state.kind === 'unavailable'
  ) {
    // Cold: no read answered, so there is no content to keep and nothing
    // honest to say beyond that we could not look.
    return (
      <ErrorState
        title="The feedback is unavailable"
        titleKey="plugins.github.ui.feedbackUnavailable"
        description={failureDescription(conversation.state.failure, readFailed)}
      />
    );
  }

  // Each connection names ITSELF. "Something failed" over a partial plane leaves
  // the reader unable to tell which half of the picture they are missing.
  const reviewsFailure = reviews.state.failure;
  const threadsFailure = threads.state.failure;
  const requestsFailure = requests.state.failure;
  const checksFailure = checks.state.kind === 'unavailable'
    ? checks.state.failure
    : checks.state.kind === 'ready'
      ? checks.state.value.checkRunsFailure ?? checks.state.value.commitStatusFailure ?? null
      : null;
  const failedConnections = [
    ...(conversation.state.kind === 'unavailable' || conversation.state.failure !== null
      ? [text('plugins.github.ui.feedbackConversationFailed', 'the conversation')]
      : []),
    ...(reviewsFailure === null
      ? []
      : [text('plugins.github.ui.feedbackReviewsFailed', 'the review history')]),
    ...(requestsFailure === null
      ? []
      : [text('plugins.github.ui.feedbackRequestsFailed', 'the outstanding review requests')]),
    ...(threadsFailure === null
      ? []
      : [text('plugins.github.ui.feedbackThreadsFailed', 'the line review conversations')]),
    ...(checksFailure === null
      ? []
      : [text('plugins.github.ui.feedbackChecksFailed', 'the checks')]),
  ];
  const connectionFailure = conversation.state.failure ?? threadsFailure ?? reviewsFailure
    ?? requestsFailure ?? checksFailure;
  const commentsIncomplete = incompleteDescription(text, conversation.state.incomplete, null);

  return (
    <List
      accessibilityLabel="Feedback on this pull request"
      accessibilityLabelKey="plugins.github.ui.feedbackLabel"
      preserveVisibleContentPositionOnPrepend
      items={view.findings}
      keyForItem={(finding) => `${finding.resource}:${finding.id}`}
      header={(
        <Stack gap="medium">
          {view.review.kind === 'decided'
            ? (
              <Row gap="small">
                <Status
                  tone={view.review.tone}
                  label={text('plugins.github.ui.reviewDecision', 'Review: {value}', {
                    value: view.review.label,
                  })}
                />
              </Row>
            )
            : (
              <Text
                variant="caption"
                tone="neutral"
                valueKey="plugins.github.ui.reviewUnresolved"
                fallback={'GitHub\'s current reviews read did not report a review decision, so'
                  + ' nothing here says whether it is approved.'}
              />
            )}
          <ReviewPeople people={view.people} locale={locale} nowMs={nowMs} />
          <Text
            variant="caption"
            tone="neutral"
            valueKey="plugins.github.ui.feedbackScope"
            fallback={'This keeps issue comments, review bodies, outstanding requests, line'
              + ' conversations, check state, and timeline history as distinct GitHub facts.'}
          />
          {failedConnections.length === 0 || connectionFailure === null
            ? null
            : (
              <Banner
                tone="warning"
                title="Part of this feedback could not be read"
                titleKey="plugins.github.ui.feedbackPartial"
                description={failureDescription(
                  connectionFailure,
                  text(
                    'plugins.github.ui.feedbackPartial.description',
                    'GitHub could not complete {connections}, so it is missing from what is'
                      + ' shown here.',
                    { connections: failedConnections.join(', ') },
                  ),
                )}
              />
            )}
        </Stack>
      )}
      empty={(
        <EmptyState
          title="Nothing has been said yet"
          titleKey="plugins.github.ui.noFeedback"
          description={text(
            'plugins.github.ui.noFeedback.description',
            'No comment has been left on this pull request, and GitHub reports nothing wrong'
              + ' with it.',
          )}
        />
      )}
      footer={(
        <Stack gap="small">
          <Text
            variant="caption"
            tone="neutral"
            valueKey={conversation.state.omittedRowCount === 0
              ? 'plugins.github.ui.feedbackRead'
              : 'plugins.github.ui.commentsReadWithUnreadable'}
            fallback={conversation.state.omittedRowCount === 0
              ? '{comments} comment(s) read.'
              : '{count} comment(s) read. {unreadable} row(s) on the pages read could not be understood.'}
            values={{
              comments: conversation.state.rows.length,
              count: conversation.state.rows.length,
              unreadable: conversation.state.omittedRowCount,
            }}
          />
          {conversation.state.projectionTruncated
            ? (
              <Text
                variant="caption"
                tone="neutral"
                valueKey="plugins.github.ui.commentsShortened.description"
                fallback="Some comments were shortened. Open the entry on GitHub to read them in full."
              />
            )
            : null}
          {commentsIncomplete === null
            ? null
            : <Text variant="caption" tone="neutral">{commentsIncomplete}</Text>}
          {conversation.state.canLoadMore
            ? (
              <Button
                title="Load more comments"
                titleKey="plugins.github.ui.loadMoreComments"
                variant="secondary"
                busy={conversation.state.pending}
                onPress={conversation.loadMore}
              />
            )
            : null}
          {threads.state.canLoadMore
            ? <Button title="Load earlier review conversations" titleKey="plugins.github.ui.loadEarlierReviewThreads" variant="secondary" busy={threads.state.pending} onPress={threads.loadMore} />
            : null}
          {reviews.state.canLoadMore
            ? <Button title="Load earlier reviews" titleKey="plugins.github.ui.loadEarlierReviews" variant="secondary" busy={reviews.state.pending} onPress={reviews.loadMore} />
            : null}
          {requests.state.canLoadMore
            ? <Button title="Load more review requests" titleKey="plugins.github.ui.loadMoreReviewRequests" variant="secondary" busy={requests.state.pending} onPress={requests.loadMore} />
            : null}
          <RefreshRow
            onRefresh={() => {
              conversation.refresh();
              threads.refresh();
              reviews.refresh();
              requests.refresh();
              checks.refresh();
            }}
            pending={conversation.state.pending || threads.state.pending || reviews.state.pending
              || requests.state.pending || checksSettling}
            accessibilityLabel="Re-read this feedback from GitHub"
            accessibilityLabelKey="plugins.github.ui.rereadFeedback"
          />
        </Stack>
      )}
      renderItem={(finding) => (
        <FeedbackFindingRow
          finding={finding}
          input={input}
          locale={locale}
          nowMs={nowMs}
          onObserved={onObserved}
          publicationProposals={publicationProposals}
          capabilities={capabilities}
        />
      )}
    />
  );
}

/* ---------------------------------------------------------------- Work Sessions */

/**
 * The issue composition's `Work Sessions` panel: the exact bounded projection the input
 * carried, with an exact host-owned open action. It performs no Session-store read and owns no
 * Session resolution; only its transient press/error presentation is local.
 */
function WorkSessionsPanel({
  sessions,
}: Readonly<{ sessions: readonly TriageLinkedSessionProjectionV1[] }>): React.ReactElement {
  const text = usePluginTranslation();
  const { execute } = useExecutePluginAction('session.open');
  const [pendingSessionId, setPendingSessionId] = React.useState<string | null>(null);
  const [failedSessionId, setFailedSessionId] = React.useState<string | null>(null);
  if (sessions.length === 0) {
    return (
      <EmptyState
        title="No linked sessions"
        titleKey="plugins.github.ui.noSessions"
        description="Sessions started from this issue will be listed here."
        descriptionKey="plugins.github.ui.noSessions.description"
      />
    );
  }
  return (
    <List accessibilityLabel="Sessions linked to this GitHub issue" accessibilityLabelKey="plugins.github.ui.sessionsLabel">
      <ItemGroup>
        {sessions.map((session) => {
          const title = session.displayTitle
            ?? text('plugins.github.ui.linkedSession', 'Session');
          const pending = pendingSessionId === session.sessionId;
          return (
            <Item
              key={session.sessionId}
              title={title}
              // A retained link whose Session summary is unavailable keeps its id and loses
              // only its display text. It is never presented as "never linked".
              subtitle={session.displayTitle === undefined
                ? text(
                  'plugins.github.ui.sessionUnavailable',
                  'Session details are unavailable',
                )
                : failedSessionId === session.sessionId
                  ? text('plugins.github.ui.sessionOpenFailed', 'This Session could not be opened.')
                  : undefined}
              accessoryOutsidePressable
              accessory={(
                <Button
                  title={text('plugins.github.ui.openSession', 'Open {session}', { session: title })}
                  variant="plain"
                  busy={pending}
                  disabled={pendingSessionId !== null}
                  onPress={() => {
                    setPendingSessionId(session.sessionId);
                    setFailedSessionId(null);
                    void execute({ sessionId: session.sessionId }).then((settled) => {
                      setPendingSessionId(null);
                      if (settled.status !== 'success') setFailedSessionId(session.sessionId);
                    });
                  }}
                />
              )}
            />
          );
        })}
      </ItemGroup>
    </List>
  );
}

/* ------------------------------------------------------------------ detail body */

function GithubDetailBody({
  input: launched,
  kindId,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  kindId: GithubTriageKindIdV1;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const { locale } = useSurfaceContext();
  const [selected, setSelected] = React.useState<GithubDetailTabIdV1>(
    GITHUB_DEFAULT_DETAIL_TAB_V1,
  );
  // One render-time read, passed down as data, so no child owns a hidden clock.
  const nowMs = Date.now();
  const completePostMutation = useTriagePostMutationCompletion();
  const launchedMerged = isGithubMergedState(launched.observation.snapshot.state);
  const [mergeSignature, setMergeSignature] = React.useState<GithubMergeSignatureStateV1>(() => (
    launchedMerged
      ? Object.freeze({ terminal: true, celebrationSequence: 0 })
      : STATIC_OPEN_MERGE_SIGNATURE
  ));
  React.useEffect(() => {
    // A background/provider refresh changes truth immediately but is not this
    // reader's successful merge, so it never starts the signature motion.
    setMergeSignature((current) => {
      if (launchedMerged) {
        return current.terminal
          ? current
          : Object.freeze({ terminal: true, celebrationSequence: current.celebrationSequence });
      }
      return current.terminal ? STATIC_OPEN_MERGE_SIGNATURE : current;
    });
  }, [launchedMerged]);
  const onObserved = React.useCallback((
    execution: PluginActionExecution<unknown>,
    outcome: GithubMutationOutcomeV1 | null,
    actionLocalId: string,
  ) => {
    if (actionLocalId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMerge
      && outcome?.kind === 'applied'
      && outcome.confirmedState !== null
      && outcome.confirmedEntryRef?.kindId === launched.observation.entryRef.kindId
      && outcome.confirmedEntryRef.collisionScope === launched.observation.entryRef.collisionScope
      && outcome.confirmedEntryRef.entryId === launched.observation.entryRef.entryId
      && isGithubMergedState(outcome.confirmedState)) {
      setMergeSignature((current) => Object.freeze({
        terminal: true,
        celebrationSequence: outcome.effect === 'changed'
          ? current.celebrationSequence + 1
          : current.celebrationSequence,
      }));
    }
    void completeTriagePostMutationIfNeeded(
      completePostMutation,
      execution,
      () => githubMutationMayHaveChangedProviderStateV1(outcome),
    );
  }, [
    completePostMutation,
    launched.observation.entryRef.collisionScope,
    launched.observation.entryRef.entryId,
    launched.observation.entryRef.kindId,
  ]);
  const input = launched;
  const capabilities = useGithubCapabilities(input);
  const body = React.useMemo(() => projectGithubDetailBody(input), [input]);
  const publicationProposals = useReviewCommentProposalsForEntry({
    linkedSessionIds: input.linkedSessions.map((linked) => linked.sessionId),
    entry: kindId === 'issue'
      ? {
        kind: 'issue',
        id: createReviewCommentLinkedIssueIdV1(input.observation.entryRef),
      }
      : { kind: 'pullRequest', url: input.observation.locator.webUrl },
  });

  const visible = githubVisibleDetailTabs(kindId);
  const tab = githubResolveSelectedTab(selected, visible);

  const panels: Readonly<Record<GithubDetailTabIdV1, React.ReactNode>> = {
    overview: (
      <OverviewPanel
        body={body}
        input={input}
        kindId={kindId}
        locale={locale}
        nowMs={nowMs}
        mergeSignature={mergeSignature}
        onObserved={onObserved}
        publicationProposals={publicationProposals}
        capabilities={capabilities}
      />
    ),
    timeline: <TimelinePanel input={input} locale={locale} nowMs={nowMs} />,
    files: <FilesPanel input={input} locale={locale} />,
    checks: <ChecksPanel input={input} locale={locale} nowMs={nowMs} />,
    feedback: (
      <FeedbackPanel
        input={input}
        locale={locale}
        nowMs={nowMs}
        onObserved={onObserved}
        publicationProposals={publicationProposals}
        capabilities={capabilities}
      />
    ),
    comments: <CommentsPanel input={input} locale={locale} nowMs={nowMs} />,
    'work-sessions': <WorkSessionsPanel sessions={body.linkedSessions} />,
  };

  return (
    <Screen safeArea>
      <Tabs
        value={tab}
        onValueChange={(next) => {
          // The visible declarations are the only tab identities this body renders, so a value
          // that is not one of them selects nothing rather than becoming a tab id by assertion.
          const declared = visible.find((candidate) => candidate.id === next);
          if (declared !== undefined) setSelected(declared.id);
        }}
        ariaLabel={text('plugins.github.ui.detailTabs', 'GitHub entry detail')}
      >
        {visible.map((declaration) => (
          <Tabs.Item
            key={declaration.id}
            value={declaration.id}
            // `Tabs.Item` takes a plain string, so the declaration carries both
            // halves and the title is resolved here rather than read.
            title={text(declaration.titleKey, declaration.title)}
            // Stated, never inherited: the shared primitive would otherwise discard a panel
            // this source means to keep, or keep one it means to discard.
            retention={declaration.retention}
            {...(declaration.id === 'work-sessions' && body.linkedSessions.length > 0
              ? { badge: String(body.linkedSessions.length) }
              : {})}
          >
            {panels[declaration.id]}
          </Tabs.Item>
        ))}
      </Tabs>
    </Screen>
  );
}

function GithubDetailSurface(context: RenderContext): React.ReactElement {
  const admitted = React.useMemo(() => {
    const parsed = TriageDetailSurfaceInputV1Schema.safeParse(context.launchInput);
    if (!parsed.success) return { ok: false as const };
    const kindId = readGithubTriageKindId(parsed.data.observation.entryRef.kindId);
    // A kind this source never declared cannot select a composition, and guessing
    // one would render a pull request's panels over an entry that is not one.
    return kindId === null
      ? { ok: false as const }
      : { ok: true as const, input: parsed.data, kindId };
  }, [context.launchInput]);

  if (!admitted.ok) {
    return (
      <Screen safeArea>
        <ErrorState
          title="This entry cannot be shown"
          titleKey="plugins.github.ui.invalidInput"
          description="Triage supplied a detail input this GitHub build does not accept."
          descriptionKey="plugins.github.ui.invalidInput.description"
        />
      </Screen>
    );
  }

  return <GithubDetailBody input={admitted.input} kindId={admitted.kindId} />;
}

/**
 * The exact export name the build target's Module Federation identity names. Renaming it breaks
 * the native artifact contract, not just this file.
 */
export const renderSurface = defineUiSurface(GithubDetailSurface);
