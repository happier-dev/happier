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
import { formatUsageDurationCompact } from '@happier-dev/plugin-ui/components';
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
  MarkdownEditor,
  Icon,
  IconButton,
  List,
  LoadingState,
  Markdown,
  Metadata,
  MotionFeedback,
  Row,
  Screen,
  ScrollArea,
  Stack,
  Status,
  Step,
  Tabs,
  Text,
  defineUiSurface,
  formatHappierDiffStat,
  usePluginHostApi,
  usePluginTheme,
  usePluginTranslation,
  useExecutePluginAction,
  projectPluginActionControlExecutionV1,
  isPluginActionConfirmationDeclined,
  useReviewCommentProposalsForEntry,
  useSurfaceContext,
  useTabPanelActivity,
  type ReviewCommentProposalReadV1,
  type MetadataEntry,
  type PluginActionExecution,
  type PluginTranslate,
} from '@happier-dev/plugin-ui';
import {
  TriageDetailSurfaceInputV1Schema,
  TriageReadConfiguredSourceInstancesResultV1Schema,
  TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
  triageSourceBindingComponentsV1,
  type TriageDetailSurfaceInputV1,
  type TriageLinkedSessionProjectionV1,
  type TriageSourceFailureV1,
  type SessionPullRequestNativeStatusV1,
} from '@happier-dev/triage-protocol/v1';
import { GithubChecksRunDrilldown } from './detail/checksRunDrilldown.js';
import { GithubReadFailure, GithubReadFailureDetails } from './detail/readFailure.js';
import { useGithubWrite, type GithubObservedEntryHandlerV1, type GithubWriteControllerV1 } from './detail/useGithubWrite.js';
import { GithubEntryPropertyPicker } from './detail/entryPropertyPicker.js';
import { GithubIssueNotifications } from './detail/notifications.js';
import { GithubSubIssueOrder } from './detail/subIssueOrder.js';
import { GithubPullRequestPreviewStep } from './pullRequestPreview.js';
import type { GithubReadFailureV1 } from './detail/readBoundary.js';
import { useGithubFileViewedSource } from './detail/filesViewed.js';
import type { GithubCheckActionsTargetV1 } from '../triage/checks.js';
import {
  completeTriagePostMutationIfNeeded,
  TriageDetailInstance,
  TriageDetailPanel,
  TriageDetailStory,
  TriageDetailChangeSummary,
  TriageChangedFilesLoading,
  TriageChangedFilesProgress,
  useTriageViewedFileCount,
  TriageChecksRollupLine,
  TriageDetailChecks,
  type TriageDetailChecksRollupV1,
  useTriageDetailPanelOpener,
  TriageStatusRow,
  TriageActivityTimeline,
  TriageSourceCommentComposer,
  type TriageSourceWriteSettlementV1,
  useTriagePostMutationCompletion,
  useTriageEvidenceDisclosure,
  useTriageSourcePanelIntentV1,
  useTriageSourcePanelPagingV1,
  type TriageSourcePanelCommandV1,
  useTriageDetailRequest,
  useTriagePageRefresh,
  useTriagePullRequestPrimaryWriteV1,
  type TriageDetailPrimaryWriteV1,
  type TriageActivityContinuationV1,
  type TriageActivityLeadV1,
  type TriageActivityEventV1,
  type TriageActivityKindV1,
} from '@happier-dev/triage-sources/ui';
// The presentation rules used below are projections of the Triage contract's own
// closed fact and failure vocabularies, so they are consumed from the one published
// owner rather than re-spelled here: six copies is how one declared `compact` number
// could start meaning two things in one list. They are aliased to this file's local
// vocabulary so the call sites read as the panel language they already are.
import {
  resolveTriageRowFactStatusToneV1,
  describeTriageSourceFailureV1 as failureDescription,
  formatTriageTimestampV1 as formatTimestamp,
  projectTriageDetailFieldTextV1 as fieldValueText,
  type TriagePullRequestOperationOfferV1,
} from '@happier-dev/triage-protocol/v1';

import { GithubFilesList } from './detail/filesList.js';
import type {
  GithubProjectedCheckRowV1,
  GithubProjectedTimelineRowV1,
} from '../triage/detail/projection.js';
import { GITHUB_CHANGED_FILES_CEILING_V1 } from '../triage/detail/routes.js';
import { githubMarkdownDisplayText } from '../triage/detail/markdown/projectGithubMarkdownForDisplay.js';
import { GithubOverviewMarkdown } from './detail/markdown.js';
import { GithubIssueOpeningDetailV1Schema, type GithubOverviewResultV1 } from '../triage/detail/contracts.js';
import {
  GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1,
  GITHUB_TRIAGE_DETAIL_RENDERER_ID_V1,
  readGithubTriageKindId,
} from '../triage/contribution.js';
import { GITHUB_PLUGIN_ID } from '../observations/githubProviderContracts.js';
import { decodeGithubTriageConfiguration } from '../triage/configuration.js';
import { readGithubResourceIntent } from '../triage/locator.js';
import type { GithubFeedbackCommentV1 } from '../triage/feedback.js';
import { GITHUB_WRITE_REFUSAL_COPY_V1 as WRITE_REFUSAL_COPY } from '../triage/mutations/outcome.js';
import { GITHUB_PRIMARY_WRITE_REASON_COPY_V1 as PRIMARY_WRITE_REASON } from '../triage/pullRequestOperations.js';
import { GithubSecurityAlertBody, type GithubSecurityAlertRenderersV1 } from './securityAlerts/detail.js';
import {
  githubReviewPublicationCredential,
  GithubEntryAdministrationResultV1Schema,
  type GithubEntryAdministrationResultV1,
  GithubIssueDeltaResultV1Schema,
  GithubPullRequestMarkReadyActionResultV1Schema,
  GithubPullRequestReviewPublicationResultV1Schema,
  GithubPullRequestReviewersResultV1Schema,
  GithubPullRequestStateResultV1Schema,
  GithubPullRequestThreadResolutionResultV1Schema,
  GithubPullRequestUpdateBranchResultV1Schema,
  GithubCommentEditResultV1Schema,
  GithubCommentCreateResultV1Schema,
  GithubPullRequestHeadBranchDeleteResultV1Schema,
  GithubPullRequestHeadBranchRestoreResultV1Schema,
  GithubPullRequestReviewMutationResultV1Schema,
  type GithubCommentEditTargetKindV1,
  type GithubPullRequestReviewVerdictV1,
  GITHUB_REVIEW_VERDICTS_V1,
} from '../triage/mutations/contracts.js';
import { GithubRelationshipMutationResultV1Schema } from '../triage/mutations/relationshipContracts.js';
import { ScmSuggestionApplyResponseSchema, type ScmSuggestionV1 } from '@happier-dev/protocol/scm';
import type { GithubTriageKindIdV1 } from '../triage/types.js';
import type { GithubRepositoryCapabilitiesV1 } from '../triage/capabilities.js';

import {
  orderGithubFeedbackReplies,
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
  GithubDetailChecksFromOverview,
  GithubDetailResourcesProvider,
  useGithubChecksDemanded,
  useGithubChangedFiles,
  useGithubChecks,
  useGithubFeedbackComments,
  useGithubFeedbackRequests,
  useGithubFeedbackReviews,
  useGithubFeedbackThreads,
  useGithubTimeline,
} from './detail/resourceOwners.js';
import {
  useGithubCapabilities,
  useGithubFeedbackThreadReplies,
  useGithubOverview,
  type GithubChecksViewV1,
  type GithubOverviewControllerV1,
  type GithubPagedControllerV1,
} from './detail/panelReaders.js';
import { githubCheckStatusKindV1, githubOverviewStatusToneV1 } from './detail/story.js';
import { useGithubChecksRerunV1 } from './detail/checksRerun.js';
import { readGithubCheckOutcomeV1 } from '../triage/checkOutcome.js';
import type { GithubPagedStateV1, GithubReadStateV1 } from './detail/panelState.js';
import {
  buildGithubCommentCreateInputV1,
  buildGithubCommentEditInputV1,
  buildGithubIssueCommentInputV1,
  buildGithubIssueAssigneesInputV1,
  buildGithubIssueLabelsInputV1,
  buildGithubIssueReopenInputV1,
  buildGithubPullRequestReviewCommentCreateInputV1,
  buildGithubPullRequestReviewPublicationInputV1,
  buildGithubPullRequestReviewersInputV1,
  buildGithubPullRequestTargetInputV1,
  buildGithubPullRequestThreadResolutionInputV1,
  buildGithubPullRequestThreadReplyInputV1,
  buildGithubPullRequestUpdateBranchInputV1,
  buildGithubEntryLockInputV1,
  buildGithubEntryMilestoneSetInputV1,
  buildGithubEntryUnlockInputV1,
  buildGithubIssueTypeSetInputV1,
  buildGithubPullRequestChangeBaseInputV1,
  buildGithubPullRequestConvertToDraftInputV1,
  buildGithubPullRequestEditInputV1,
  buildGithubPullRequestHeadBranchInputV1,
  buildGithubIssueTransferInputV1,
  buildGithubPullRequestRevertInputV1,
  buildGithubRelatedEntryInputV1,
  buildGithubSubIssueAddInputV1,
  buildGithubSubIssueReprioritizeInputV1,
  readGithubSameRepositoryNumberV1,
  buildGithubPendingReviewCreateInputV1,
  buildGithubPendingReviewDeleteInputV1,
  buildGithubPendingReviewSubmitInputV1,
  buildGithubReviewDismissInputV1,
  GITHUB_LOCK_REASONS_V1,
  type GithubLockReasonV1,
  githubMutationMayHaveChangedProviderStateV1,
  githubOfferedMutationsV1,
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
  GITHUB_CHECK_CONCLUSION_LABELS_V1,
  GITHUB_CHECK_STATUS_LABELS_V1,
  GITHUB_REVIEW_STATE_LABELS_V1,
  GITHUB_TIMELINE_HEADLINES_V1,
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
    <Stack gap="small">
    <Banner
      tone="warning"
      title="Showing what was read so far"
      titleKey="plugins.github.ui.partial"
      description={failureDescription(
        state.failure,
        text('plugins.github.ui.readFailed', 'GitHub could not complete this read.'), text,
      )}
    />
    <GithubReadFailureDetails failures={[state.failure]} />
    </Stack>
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
  onRefresh: () => unknown;
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

/** The settled answer one write owes the reader who pressed it. */
function WriteOutcome({
  outcome,
}: Readonly<{ outcome: GithubMutationOutcomeV1 }>): React.ReactElement {
  const text = usePluginTranslation();
  if ('presentation' in outcome) {
    const presentation = outcome.presentation;
    const description = presentation.descriptionKey === undefined
      ? presentation.description : text(presentation.descriptionKey, presentation.description);
    return <Banner tone={presentation.tone}
      title={presentation.titleKey === undefined ? presentation.title : text(presentation.titleKey, presentation.title)}
      description={[description, ...(outcome.kind === 'refused' ? outcome.unmetRequirements?.map((requirement) => requirement.label) ?? [] : [])].join(' · ')} />;
  }
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
        tone={fullyPublished ? 'secondary' : 'warning'}
        title={fullyPublished
          ? text('plugins.github.ui.mutations.review.outcome.published', 'Review published')
          : hasUncertainty
            ? text('plugins.github.ui.mutations.uncertain', 'Outcome unknown')
            : text('plugins.github.ui.mutations.review.outcome.partial', 'Review partially published')}
        description={outcome.failure === null
          ? exact
          : `${exact} ${failureDescription(outcome.failure, '', text)}`.trim()}
      />
    );
  }
  if (outcome.kind === 'applied') {
    return outcome.effect === 'changed'
      ? (
        <Banner
          tone="secondary"
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
          tone="secondary"
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
        tone="neutral"
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
        description={[text(copy.key, copy.fallback), ...(outcome.unmetRequirements?.map((requirement) => requirement.label) ?? [])].join(' · ')}
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
          : `${failureDescription(outcome.failure, stated, text)} ${stated}`}
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
          ), text,
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

type GithubWritePayloadV1 =
  TriagePullRequestOperationOfferV1['variants'][number]['input']
  | NonNullable<ReturnType<typeof buildGithubPullRequestTargetInputV1>>
  | NonNullable<ReturnType<typeof buildGithubIssueReopenInputV1>>
  | NonNullable<ReturnType<typeof buildGithubPullRequestReviewPublicationInputV1>>
  | NonNullable<ReturnType<typeof buildGithubPullRequestReviewCommentCreateInputV1>>
  | NonNullable<ReturnType<typeof buildGithubPullRequestThreadReplyInputV1>>
  | NonNullable<ReturnType<typeof buildGithubIssueCommentInputV1>>
  | NonNullable<ReturnType<typeof buildGithubPullRequestUpdateBranchInputV1>>
  | NonNullable<ReturnType<typeof buildGithubPullRequestReviewersInputV1>>
  | NonNullable<ReturnType<typeof buildGithubPullRequestThreadResolutionInputV1>>
  | NonNullable<ReturnType<typeof buildGithubIssueAssigneesInputV1>>
  | NonNullable<ReturnType<typeof buildGithubIssueLabelsInputV1>>
  | NonNullable<ReturnType<typeof buildGithubCommentEditInputV1>>
  | NonNullable<ReturnType<typeof buildGithubCommentCreateInputV1>>
  | NonNullable<ReturnType<typeof buildGithubPullRequestEditInputV1>>
  | NonNullable<ReturnType<typeof buildGithubPullRequestChangeBaseInputV1>>
  | NonNullable<ReturnType<typeof buildGithubPullRequestConvertToDraftInputV1>>
  | NonNullable<ReturnType<typeof buildGithubEntryMilestoneSetInputV1>>
  | NonNullable<ReturnType<typeof buildGithubIssueTypeSetInputV1>>
  | NonNullable<ReturnType<typeof buildGithubEntryLockInputV1>>
  | NonNullable<ReturnType<typeof buildGithubEntryUnlockInputV1>>
  | NonNullable<ReturnType<typeof buildGithubPullRequestHeadBranchInputV1>>
  | NonNullable<ReturnType<typeof buildGithubRelatedEntryInputV1>>
  | NonNullable<ReturnType<typeof buildGithubSubIssueAddInputV1>>
  | NonNullable<ReturnType<typeof buildGithubSubIssueReprioritizeInputV1>>
  | NonNullable<ReturnType<typeof buildGithubPendingReviewSubmitInputV1>>
  | NonNullable<ReturnType<typeof buildGithubPendingReviewDeleteInputV1>>
  | NonNullable<ReturnType<typeof buildGithubReviewDismissInputV1>>;

function parseStateResult(value: unknown): GithubMutationResultV1 | null {
  const parsed = GithubPullRequestStateResultV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseAdministrationResult(value: unknown): GithubEntryAdministrationResultV1 | null {
  const parsed = GithubEntryAdministrationResultV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseMarkReadyResult(value: unknown): GithubMutationResultV1 | null {
  const parsed = GithubPullRequestMarkReadyActionResultV1Schema.safeParse(value);
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

function parseCommentEditResult(value: unknown): GithubMutationResultV1 | null {
  const parsed = GithubCommentEditResultV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseThreadResolutionResult(value: unknown): GithubMutationResultV1 | null {
  const parsed = GithubPullRequestThreadResolutionResultV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Source scope/admission effects around the public portable-operation controller. */
function useGithubPrimaryWrite(input: TriageDetailSurfaceInputV1,
  overview: GithubOverviewControllerV1,
  onObserved: GithubObservedEntryHandlerV1,
  activity: ReturnType<typeof useTabPanelActivity>,
): Readonly<{ value: TriageDetailPrimaryWriteV1 | null; refresh: () => Promise<void> }> {
  const text = usePluginTranslation();
  const host = usePluginHostApi();
  const { active, activeSignal } = activity;
  const request = useTriageDetailRequest(input);
  const routingToken = input.observation.locator.routingToken;
  const head = input.observation.snapshot.reviewRevision?.headSha;
  const presentation = input.observation.snapshot.state.presentation;
  const observedStatus = overview.value?.kindId === 'pull-request' ? overview.value.pullRequestStatus : undefined;
  const operations = observedStatus?.operations;
  const nativeStatus = React.useMemo<SessionPullRequestNativeStatusV1 | null>(() => {
    if (observedStatus !== undefined && overview.checkedAtMs !== null) {
      return overview.failure === null
        ? { kind: 'current', value: observedStatus, checkedAtMs: overview.checkedAtMs }
        : { kind: 'stale', value: observedStatus, checkedAtMs: overview.checkedAtMs, failure: overview.failure };
    }
    return overview.failure === null ? null : { kind: 'unavailable', failure: overview.failure };
  }, [observedStatus, overview.checkedAtMs, overview.failure]);
  // Choice identity retires old callbacks. Feedback instead belongs to the
  // entry/head/activity lifetime, including a failed explicit re-read.
  const offerScope = React.useMemo(() => ({ request, routingToken, head, presentation, operations, observedStatus,
    failure: overview.failure, active }),
    [request, routingToken, head, presentation, operations, observedStatus, overview.failure, active]);
  const currentOffer = React.useRef(offerScope);
  currentOffer.current = offerScope;
  const offeredRequest = React.useMemo(() => new AbortController(), [request, routingToken, head, presentation, activeSignal]);
  React.useEffect(() => {
    const retire = () => offeredRequest.abort();
    if (activeSignal.aborted) retire();
    else activeSignal.addEventListener('abort', retire, { once: true });
    return () => { activeSignal.removeEventListener('abort', retire); retire(); };
  }, [activeSignal, offeredRequest]);
  const readReason = overview.failure === null && overview.value === null
    ? text('plugins.github.ui.primaryWrite.reading', PRIMARY_WRITE_REASON.reading)
    : text('plugins.github.ui.primaryWrite.unavailable', PRIMARY_WRITE_REASON.unavailable);
  const unavailableReason = !active ? text('plugins.github.ui.primaryWrite.inactive', 'Open the source detail to make this change.')
    : overview.failure !== null || operations === undefined ? readReason
      : head !== undefined && observedStatus?.branch?.headRevision !== undefined && observedStatus.branch.headRevision !== head
        ? text('plugins.github.ui.primaryWrite.headChanged', PRIMARY_WRITE_REASON.headChanged) : undefined;
  const execute = React.useCallback(async (operationId: string, variantId?: string): Promise<unknown> => {
    if (offeredRequest.signal.aborted || currentOffer.current !== offerScope || unavailableReason !== undefined || !operations) {
      return { kind: 'unavailable', reason: 'operationUnavailable' };
    }
    const offers = [operations.primary, ...operations.alternatives].filter(offer => offer.id === operationId);
    const offer = offers[0];
    if (offers.length !== 1 || !offer || offer.disabledReason !== null) return { kind: 'unavailable', reason: 'operationUnavailable' };
    const choices = offer.variants.filter(variant => variantId === undefined
      ? offer.variants.length === 1 && variant.method === undefined : variant.id === variantId);
    if (choices.length !== 1 || !choices[0]) return { kind: 'unavailable', reason: 'operationUnavailable' };
    return host.executeAction(offer.actionRef, choices[0].input, { signal: offeredRequest.signal });
  }, [host, offeredRequest, offerScope, unavailableReason, operations]);
  const onSettled = React.useCallback((execution: PluginActionExecution<unknown>,
    outcome: Parameters<GithubObservedEntryHandlerV1>[1], offer: TriagePullRequestOperationOfferV1) => {
    onObserved(execution, outcome, offer.actionRef.localId);
  }, [onObserved]);
  const controller = useTriagePullRequestPrimaryWriteV1({ operations,
    ...(nativeStatus === null ? {} : { nativeStatus }),
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
    execute, signal: offeredRequest.signal, refresh: overview.refresh, readRequirements: overview.readRequirements, onSettled });
  const value = React.useMemo<TriageDetailPrimaryWriteV1 | null>(() => {
    if (input.observation.entryRef.kindId !== 'pull-request' || presentation !== 'active') return null;
    // Keep an unknown read explainable, but respect the producer's closed-state absence.
    // While the first read is out Merge keeps its place, quietly: the reason is said only once the read has an answer.
    const reading = overview.failure === null && overview.value === null;
    // A failed read is answered by reading again: the header offers this detail's own refresh beside the reason.
    const retry = overview.failure === null ? {} : { retry: overview.refresh };
    if (controller.primaryWrite !== null) return reading ? { ...controller.primaryWrite, reading: true }
      : controller.primaryWrite.disabledReason === null ? controller.primaryWrite : { ...controller.primaryWrite, ...retry };
    if (overview.value?.state === 'closed') return null;
    return { title: text('plugins.github.ui.primaryWrite.merge', 'Merge'),
      disabledReason: readReason, pending: false, execute: async () => {}, ...(reading ? { reading: true } : {}),
      ...(nativeStatus === null ? {} : { nativeStatus }), readRequirements: controller.refresh, ...retry };
  }, [controller.primaryWrite, controller.refresh, input.observation.entryRef.kindId, presentation, overview.failure, overview.value, overview.refresh, nativeStatus, readReason, text]);
  return React.useMemo(() => ({ value, refresh: controller.refresh }), [value, controller.refresh]);
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
  // A merged pull request projects `resolved` (`CONTRACT.md` §4, r0.42).
  return state.presentation === 'resolved';
}

/**
 * Source-owned lifecycle glyph. Its animation is decorative: the canonical
 * Action banner and aggregate state remain the accessible semantic result.
 */
function GithubMergeSignature({ state }: Readonly<{
  state: GithubMergeSignatureStateV1;
}>): React.ReactElement {
  return (
    <MotionFeedback trigger={state.celebrationSequence} decorative style={{ alignSelf: 'flex-start' }}>
      <Icon
        name={state.terminal ? 'change-complete' : 'change-open'}
        tone={state.terminal ? 'neutral' : 'secondary'}
        testID={state.terminal ? 'github-merge-signature-complete' : 'github-merge-signature-open'}
      />
    </MotionFeedback>
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
  primaryWrite,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  terminal: boolean;
  primaryWrite: TriageDetailPrimaryWriteV1;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const [mergeMethod, setMergeMethod] = React.useState<string | null>(null);
  const head = input.observation.snapshot.reviewRevision?.headSha;
  if (primaryWrite.disabledReason !== null) {
    return (
      <Stack gap="small">
      <UnavailableOperationWrite
        title={primaryWrite.id === undefined || primaryWrite.id === 'merge' ? 'Merge pull request' : primaryWrite.title}
        {...(primaryWrite.id === undefined || primaryWrite.id === 'merge' ? { titleKey: 'plugins.github.ui.mutations.merge' } : {})}
        reason={primaryWrite.disabledReason}
        variant="primary"
      />
      {primaryWrite.feedback}
      </Stack>
    );
  }
  const methods = primaryWrite.methods;
  const chosen = methods?.find(method => method.id === mergeMethod);
  const payload = primaryWrite.inputFor?.(chosen?.id);
  return (
    <Stack gap="small">
      {methods === undefined ? null : <Form.Select
        label={text('plugins.github.ui.mutations.mergeMethod', 'Merge method')}
        options={methods.map((method) => ({
          value: method.id,
          label: method.title,
        }))}
        {...(chosen === undefined ? {} : { value: chosen.id })}
        onChange={(value) => {
          if (typeof value === 'string' && methods.some(method => method.id === value)) setMergeMethod(value);
        }}
        disabled={primaryWrite.pending || terminal}
      />}
      {head === undefined || methods === undefined
        ? null
        : (
          <Text
            variant="micro"
            tone="neutral"
            valueKey="plugins.github.ui.mutations.mergeHead"
            fallback="Merges {revision}, the head this observation carries. If GitHub has moved on, the merge is refused instead."
            values={{ revision: head.slice(0, 7) }}
          />
        )}
      <Action.Control
        action={primaryWrite.actionRef!}
        controller={primaryWrite.controllerFor!(chosen?.id)}
        signal={primaryWrite.signal}
        title={primaryWrite.id === 'merge' ? 'Merge pull request' : primaryWrite.title}
        {...(primaryWrite.id === 'merge' ? { titleKey: 'plugins.github.ui.mutations.merge' } : {})}
        variant="primary"
        disabled={payload == null || primaryWrite.pending || terminal}
      />
      {primaryWrite.feedback}
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
  capabilities,
  operation,
}: Readonly<{
  localId: string;
  payload: GithubWritePayloadV1;
  title: string;
  titleKey: string;
  onObserved: GithubObservedEntryHandlerV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
  operation: keyof GithubRepositoryCapabilitiesV1['operations'];
}>): React.ReactElement {
  const text = usePluginTranslation();
  const capabilityReason = githubOperationCapabilityReason(text, capabilities, operation);
  const write = useGithubWrite(localId, parseStateResult, onObserved);
  if (capabilityReason !== null) {
    return <UnavailableOperationWrite title={title} titleKey={titleKey} reason={capabilityReason} />;
  }
  return (
    <Stack gap="small">
      <Action.Control action={write.action} controller={write.controllerFor(payload)}
        title={title} titleKey={titleKey} variant="secondary" disabled={write.pending} />
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
  capabilities,
  operation,
  primaryWrite,
}: Readonly<{
  localId: string;
  title: string;
  titleKey: string;
  parseResult: (value: unknown) => GithubMutationResultV1 | null;
  onObserved: GithubObservedEntryHandlerV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
  operation: keyof GithubRepositoryCapabilitiesV1['operations'];
} & (
  | { primaryWrite: TriageDetailPrimaryWriteV1; payload: unknown }
  | { primaryWrite?: undefined; payload: GithubWritePayloadV1 | null }
)>): React.ReactElement {
  const text = usePluginTranslation();
  const capabilityReason = primaryWrite === undefined ? githubOperationCapabilityReason(text, capabilities, operation) : primaryWrite.disabledReason;
  const write = useGithubWrite(localId, parseResult, onObserved);
  if (capabilityReason !== null) {
    return <UnavailableOperationWrite title={title} titleKey={titleKey} reason={capabilityReason} />;
  }
  return (
    <Stack gap="small">
      {primaryWrite === undefined ? <Action.Control action={write.action} controller={write.controllerFor(payload)}
        title={title} titleKey={titleKey} variant="secondary" disabled={payload === null || write.pending} />
        : <Action.Control action={primaryWrite.actionRef!} controller={primaryWrite.controllerFor!()}
          signal={primaryWrite.signal} title={title} titleKey={titleKey} variant="secondary"
          disabled={payload === null || primaryWrite.pending} />}
      {primaryWrite === undefined ? write.outcome === null ? null : <WriteOutcome outcome={write.outcome} /> : primaryWrite.feedback}
    </Stack>
  );
}

function PullRequestHeadWrites({
  input,
  onObserved,
  capabilities,
  branchUpdateEligible,
  primaryWrite,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  onObserved: GithubObservedEntryHandlerV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
  branchUpdateEligible: boolean;
  primaryWrite: TriageDetailPrimaryWriteV1 | null;
}>): React.ReactElement {
  const markReady = primaryWrite?.id === 'markReady' ? primaryWrite.inputFor?.() ?? null : null;
  const updateBranch = React.useMemo(
    () => buildGithubPullRequestUpdateBranchInputV1(input),
    [input],
  );
  return (
    <Stack gap="medium">
      {primaryWrite?.id === 'markReady'
        ? (
          <ExactWrite
            localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMarkReady}
            payload={markReady}
            title="Mark ready for review"
            titleKey="plugins.github.mutations.markReady.confirmation.confirmLabel"
            parseResult={parseMarkReadyResult}
            onObserved={onObserved}
            capabilities={capabilities}
            operation="pullRequestMarkReady"
            primaryWrite={primaryWrite}
          />
        )
        : null}
      {branchUpdateEligible
        ? (
          <ExactWrite
            localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestUpdateBranch}
            payload={updateBranch}
            title="Update branch"
            titleKey="plugins.github.mutations.updateBranch.confirmation.confirmLabel"
            parseResult={parseUpdateBranchResult}
            onObserved={onObserved}
            capabilities={capabilities}
            operation="pullRequestUpdateBranch"
          />
        )
        : null}
    </Stack>
  );
}

function PullRequestReviewerWrites({
  input,
  onObserved,
  capabilities,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  onObserved: GithubObservedEntryHandlerV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
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
          capabilities={capabilities}
          operation="pullRequestAddReviewers"
        />
        <ExactWrite
          localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestRemoveReviewers}
          payload={remove}
          title="Withdraw review requests"
          titleKey="plugins.github.mutations.removeReviewers.confirmation.confirmLabel"
          parseResult={parseReviewersResult}
          onObserved={onObserved}
          capabilities={capabilities}
          operation="pullRequestRemoveReviewers"
        />
      </Row>
    </Stack>
  );
}

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
  capabilities,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  proposals: readonly ReviewCommentV1[];
  proposalRead: ReviewCommentProposalReadV1['status'];
  kind: 'issue-comment' | 'thread-reply';
  threadId?: string;
  onObserved: GithubObservedEntryHandlerV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
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
      <ExactWrite
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

function PullRequestReviewPublicationWrite({
  input,
  onObserved,
  publicationProposals,
  capabilities,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
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
      <Form.TextField
        label={text('plugins.github.ui.mutations.review.summary', 'Review summary')}
        value={verdictBody}
        required
        onChange={setVerdictBody}
      />
      <ExactWrite
        localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestSubmitReview}
        payload={payload}
        title="Submit review"
        titleKey="plugins.github.ui.mutations.review.submit"
        parseResult={parseReviewPublicationResult}
        onObserved={onObserved}
        capabilities={capabilities}
        operation="pullRequestSubmitReview"
      />
      <ExactWrite
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

/**
 * The writes an ISSUE offers, where github.com keeps them: its sidebar properties and relationships, the selected
 * proposal to publish, and administration last. Closing belongs to the task Status menu.
 */
function IssueWrites({
  input,
  offered,
  overview,
  onObserved,
  publicationProposals,
  capabilities,
  refreshOverview,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  offered: readonly string[];
  overview: GithubOverviewValueV1 | null;
  onObserved: GithubObservedEntryHandlerV1;
  publicationProposals: ReviewCommentProposalReadV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
  refreshOverview: () => unknown;
}>): React.ReactElement {
  const reopen = React.useMemo(() => buildGithubIssueReopenInputV1(input), [input]);
  return (
    <Stack gap="medium">
      <Text
        variant="micro"
        tone="neutral"
        valueKey="plugins.github.ui.mutations.issueDescription"
        fallback="These change the issue on GitHub itself. Each one asks you to confirm before anything is written."
      />
      {/* Subscribing is this panel's quickest change, so it leads rather than sitting under the longer cards. */}
      <GithubIssueNotifications input={input} renderControls={(facts, update) => <Stack gap="small">
        <GithubNotificationToggle input={input} checked={facts.viewerSubscription === 'SUBSCRIBED'}
          operation={facts.viewerSubscription === 'SUBSCRIBED' ? 'entryUnsubscribe' : 'entrySubscribe'}
          onObserved={onObserved} capabilities={capabilities}
          onConfirmed={entry => { if (entry.subscription !== undefined) update({ viewerSubscription: entry.subscription }); }} />
        <GithubNotificationToggle input={input} checked={facts.isPinned}
          operation={facts.isPinned ? 'issueUnpin' : 'issuePin'} onObserved={onObserved} capabilities={capabilities}
          onConfirmed={entry => { if (entry.pinned !== undefined) update({ isPinned: entry.pinned }); }} />
      </Stack>} />
      <GithubEntryProperties input={input} kindId="issue" overview={overview} onObserved={onObserved} capabilities={capabilities} refreshOverview={refreshOverview} />
      <GithubEntryRelationships input={input} kindId="issue" onObserved={onObserved} capabilities={capabilities} />
      <SingleProposalPublicationWrite
        input={input}
        proposals={publicationProposals.proposals}
        proposalRead={publicationProposals.status}
        kind="issue-comment"
        onObserved={onObserved}
        capabilities={capabilities}
      />
      {offered.includes('reopen') && reopen !== null
        ? (
          <StateWrite
            localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueReopen}
            payload={reopen}
            title="Reopen issue"
            titleKey="plugins.github.ui.mutations.reopenIssue"
            onObserved={onObserved}
            capabilities={capabilities}
            operation="issueReopen"
          />
        )
        : null}
      <Divider />
      <GithubIssueTransferWrite input={input} onObserved={onObserved} capabilities={capabilities} />
      <GithubIssueDeleteWrite input={input} onObserved={onObserved} capabilities={capabilities} />
    </Stack>
  );
}

/* ----------------------------------------------------------- write parity rows */

function parseRelationshipResult(value: unknown): GithubMutationResultV1 | null {
  const parsed = GithubRelationshipMutationResultV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseHeadBranchDeleteResult(value: unknown): GithubMutationResultV1 | null {
  const parsed = GithubPullRequestHeadBranchDeleteResultV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseHeadBranchRestoreResult(value: unknown): GithubMutationResultV1 | null {
  const parsed = GithubPullRequestHeadBranchRestoreResultV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * One github.com sidebar property: the row says what it is and its current value, and opens in place onto its own
 * control. Calm by default: nothing editable is on screen until the reader asks for that one property.
 */
function GithubPropertyRow({ title, value, tone, children }: Readonly<{
  title: string;
  value?: string;
  tone?: React.ComponentProps<typeof Item>['tone'];
  children: React.ReactNode;
}>): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  return (
    <Item
      title={title}
      {...(value === undefined ? {} : { subtitle: value })}
      {...(tone === undefined ? {} : { tone })}
      // The row is named by what it is, then its current value, as one phrase rather than run together.
      accessibilityLabel={value === undefined ? title : `${title}, ${value}`}
      expanded={open}
      {...(open ? { expandedContent: <Stack gap="small">{children}</Stack> } : {})}
      onPress={() => setOpen((current) => !current)}
    />
  );
}

/** Title and description, edited from GitHub's own text; only what the reader changed is sent. */
function GithubPullRequestContentEditor({ input, overview, onObserved, capabilities }: Readonly<{
  input: TriageDetailSurfaceInputV1;
  overview: GithubOverviewValueV1 | null;
  onObserved: GithubObservedEntryHandlerV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const currentTitle = overview?.title ?? input.observation.snapshot.title;
  const currentBody = overview?.body ?? '';
  const [title, setTitle] = React.useState(currentTitle);
  const [body, setBody] = React.useState(currentBody);
  const payload = React.useMemo(() => {
    const edited = {
      ...(title !== currentTitle ? { title } : {}),
      ...(body !== currentBody ? { body } : {}),
    };
    return Object.keys(edited).length === 0 ? null : buildGithubPullRequestEditInputV1(input, edited);
  }, [body, currentBody, currentTitle, input, title]);
  return (
    <>
      <Form.TextField label={text('plugins.github.ui.parity.title', 'Title')} value={title} onChange={setTitle} />
      <Form.Field label={text('plugins.github.ui.parity.description', 'Description')}>
        <MarkdownEditor accessibilityLabel={text('plugins.github.ui.parity.description', 'Description')} value={body} onChange={setBody} />
      </Form.Field>
      <ExactWrite
        localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestEdit}
        payload={payload}
        title="Save changes"
        titleKey="plugins.github.ui.parity.saveChanges"
        parseResult={parseStateResult}
        onObserved={onObserved}
        capabilities={capabilities}
        operation="pullRequestEdit"
      />
    </>
  );
}

function GithubEntryMemberProperty({ input, property, overview, onObserved, capabilities, refresh }: Readonly<{
  input: TriageDetailSurfaceInputV1;
  property: 'assignees' | 'labels';
  overview: GithubOverviewValueV1;
  onObserved: GithubObservedEntryHandlerV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
  refresh: () => unknown;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const addOperation = property === 'assignees' ? 'issueAssigneeAdd' : 'issueLabelAdd';
  const removeOperation = property === 'assignees' ? 'issueAssigneeRemove' : 'issueLabelRemove';
  const add = useGithubWrite(GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1[addOperation], parseIssueDeltaResult, onObserved);
  const remove = useGithubWrite(GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1[removeOperation], parseIssueDeltaResult, onObserved);
  const [lastMode, setLastMode] = React.useState<'add' | 'remove'>('add');
  const outcome = (lastMode === 'add' ? add : remove).outcome;
  const disabledReason = githubOperationCapabilityReason(text, capabilities, addOperation)
    ?? githubOperationCapabilityReason(text, capabilities, removeOperation);
  return <GithubEntryPropertyPicker property={property} overview={overview} refresh={refresh}
    pending={add.pending || remove.pending} disabledReason={disabledReason}
    feedback={outcome === null ? null : <WriteOutcome outcome={outcome} />}
    onChange={async (member, mode) => {
      const payload = property === 'assignees'
        ? buildGithubIssueAssigneesInputV1(input, [member], mode)
        : buildGithubIssueLabelsInputV1(input, [member], mode);
      if (payload !== null) {
        setLastMode(mode);
        await (mode === 'add' ? add : remove).run(payload);
      }
    }} />;
}

/** The sidebar of one issue or pull request (github.com's right column): people, labels, milestone, type, base. */
function GithubEntryProperties({ input, kindId, overview, onObserved, capabilities, refreshOverview }: Readonly<{
  input: TriageDetailSurfaceInputV1;
  kindId: GithubTriageKindIdV1;
  overview: GithubOverviewValueV1 | null;
  onObserved: GithubObservedEntryHandlerV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
  refreshOverview: () => unknown;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const [milestoneValue, setMilestoneValue] = React.useState('');
  const [typeValue, setTypeValue] = React.useState('');
  const [baseValue, setBaseValue] = React.useState('');
  const [lockReason, setLockReason] = React.useState<GithubLockReasonV1 | null>(null);
  const milestoneNumber = readGithubSameRepositoryNumberV1(milestoneValue);
  const pullRequest = overview?.kindId === 'pull-request' ? overview : null;
  const active = input.observation.snapshot.state.presentation === 'active';
  const reviewers = pullRequest?.requestedReviewers?.map((reviewer) => reviewer.subject);
  const none = text('plugins.github.ui.parity.none', 'None');
  return (
    <ItemGroup title={text('plugins.github.ui.parity.details', 'Details')}>
      {kindId === 'pull-request' ? (
        <GithubPropertyRow title={text('plugins.github.ui.parity.titleAndDescription', 'Title and description')}
          value={overview?.title ?? input.observation.snapshot.title}>
          <GithubPullRequestContentEditor input={input} overview={overview} onObserved={onObserved} capabilities={capabilities} />
        </GithubPropertyRow>
      ) : null}
      {kindId === 'pull-request' && overview !== null ? <GithubEntryMemberProperty
        input={input} property="assignees" overview={overview} onObserved={onObserved}
        capabilities={capabilities} refresh={refreshOverview} /> : null}
      {kindId === 'pull-request' && active ? (
        <GithubPropertyRow title={text('plugins.github.ui.parity.reviewers', 'Reviewers')}
          {...(reviewers === undefined ? {} : { value: reviewers.length === 0 ? none : reviewers.join(', ') })}>
          <PullRequestReviewerWrites input={input} onObserved={onObserved} capabilities={capabilities} />
        </GithubPropertyRow>
      ) : null}
      {kindId === 'pull-request' && overview !== null ? <GithubEntryMemberProperty
        input={input} property="labels" overview={overview} onObserved={onObserved}
        capabilities={capabilities} refresh={refreshOverview} /> : null}
      {kindId === 'issue' ? (
        <GithubPropertyRow title={text('plugins.github.ui.parity.type', 'Type')}
          {...(overview === null || overview.issueType === undefined ? {} : { value: overview.issueType ?? none })}>
          <Form.TextField label={text('plugins.github.ui.parity.typeName', 'Type name')} value={typeValue} onChange={setTypeValue} />
          <Row gap="small" wrap>
            <ExactWrite localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueTypeSet}
              payload={typeValue.trim() === '' ? null : buildGithubIssueTypeSetInputV1(input, typeValue)} title="Set type"
              titleKey="plugins.github.ui.parity.setType" parseResult={parseIssueDeltaResult}
              onObserved={onObserved} capabilities={capabilities} operation="issueTypeSet" />
            {overview?.issueType === null ? null : (
              <ExactWrite localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueTypeSet}
                payload={buildGithubIssueTypeSetInputV1(input, null)} title="Clear type"
                titleKey="plugins.github.ui.parity.clearType" parseResult={parseIssueDeltaResult}
                onObserved={onObserved} capabilities={capabilities} operation="issueTypeSet" />
            )}
          </Row>
        </GithubPropertyRow>
      ) : null}
      <GithubPropertyRow title={text('plugins.github.ui.parity.milestone', 'Milestone')}
        {...(overview === null || overview.milestone === undefined ? {} : { value: overview.milestone ?? none })}>
        <Form.TextField label={text('plugins.github.ui.parity.milestoneNumber', 'Milestone number')}
          value={milestoneValue} onChange={setMilestoneValue} />
        <Row gap="small" wrap>
          <ExactWrite localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.entryMilestoneSet}
            payload={milestoneNumber === null ? null : buildGithubEntryMilestoneSetInputV1(input, Number(milestoneNumber))}
            title="Set milestone" titleKey="plugins.github.ui.parity.setMilestone" parseResult={parseIssueDeltaResult}
            onObserved={onObserved} capabilities={capabilities} operation="entryMilestoneSet" />
          {overview?.milestone === null ? null : (
            <ExactWrite localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.entryMilestoneSet}
              payload={buildGithubEntryMilestoneSetInputV1(input, null)} title="Clear milestone"
              titleKey="plugins.github.ui.parity.clearMilestone" parseResult={parseIssueDeltaResult}
              onObserved={onObserved} capabilities={capabilities} operation="entryMilestoneSet" />
          )}
        </Row>
      </GithubPropertyRow>
      {kindId === 'pull-request' && active ? (
        <GithubPropertyRow title={text('plugins.github.ui.parity.baseBranch', 'Base branch')}
          {...(pullRequest?.baseBranch === undefined ? {} : {
            value: pullRequest.headBranch === undefined ? pullRequest.baseBranch
              : text('plugins.github.ui.parity.branchInto', '{head} into {base}', { head: pullRequest.headBranch, base: pullRequest.baseBranch }),
          })}>
          <Form.TextField label={text('plugins.github.ui.parity.newBase', 'New base branch')} value={baseValue} onChange={setBaseValue} />
          <ExactWrite localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestChangeBase}
            payload={baseValue.trim() === '' || baseValue.trim() === pullRequest?.baseBranch ? null
              : buildGithubPullRequestChangeBaseInputV1(input, baseValue)}
            title="Change base" titleKey="plugins.github.ui.parity.changeBase" parseResult={parseStateResult}
            onObserved={onObserved} capabilities={capabilities} operation="pullRequestChangeBase" />
        </GithubPropertyRow>
      ) : null}
      <GithubPropertyRow title={text('plugins.github.ui.parity.conversation', 'Conversation')}
        {...(overview?.locked === undefined ? {} : {
          value: overview.locked
            ? overview.lockReason ? text('plugins.github.ui.parity.lockedBecause', 'Locked as {reason}', { reason: overview.lockReason })
              : text('plugins.github.ui.parity.locked', 'Locked')
            : text('plugins.github.ui.parity.unlocked', 'Open to comments'),
        })}>
        {overview?.locked === true ? (
          <ExactWrite localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.entryUnlock}
            payload={buildGithubEntryUnlockInputV1(input)} title="Unlock conversation"
            titleKey="plugins.github.ui.parity.unlock" parseResult={parseIssueDeltaResult}
            onObserved={onObserved} capabilities={capabilities} operation="entryUnlock" />
        ) : (
          <>
            <Form.Select
              label={text('plugins.github.ui.parity.lockReason', 'Reason (optional)')}
              options={GITHUB_LOCK_REASONS_V1.map((value) => ({
                value, label: text(`plugins.github.ui.parity.lockReason.${value.replace(' ', '-')}`, GITHUB_LOCK_REASON_COPY[value]),
              }))}
              {...(lockReason === null ? {} : { value: lockReason })}
              onChange={(value) => {
                const chosen = GITHUB_LOCK_REASONS_V1.find((candidate) => candidate === value);
                if (chosen !== undefined) setLockReason(chosen);
              }}
            />
            <ExactWrite localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.entryLock}
              payload={buildGithubEntryLockInputV1(input, lockReason)} title="Lock conversation"
              titleKey="plugins.github.ui.parity.lock" parseResult={parseIssueDeltaResult}
              onObserved={onObserved} capabilities={capabilities} operation="entryLock" />
          </>
        )}
      </GithubPropertyRow>
    </ItemGroup>
  );
}

const GITHUB_LOCK_REASON_COPY: Readonly<Record<GithubLockReasonV1, string>> = Object.freeze({
  'off-topic': 'Off-topic', 'too heated': 'Too heated', resolved: 'Resolved', spam: 'Spam',
});

/** One relationship edited by the related entry's number in this repository: Add and Remove, each its own Action. */
function GithubRelationshipRow({ input, title, value, relatedKindId, add, remove, onObserved, children }: Readonly<{
  input: TriageDetailSurfaceInputV1;
  title: string;
  value?: string;
  relatedKindId: 'issue' | 'pull-request';
  add: Readonly<{ localId: string; title: string; titleKey: string }>;
  remove: Readonly<{ localId: string; title: string; titleKey: string }>;
  onObserved: GithubObservedEntryHandlerV1;
  children?: React.ReactNode;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const [numberValue, setNumberValue] = React.useState('');
  const number = readGithubSameRepositoryNumberV1(numberValue);
  const addWrite = useGithubWrite(add.localId, parseRelationshipResult, onObserved);
  const removeWrite = useGithubWrite(remove.localId, parseRelationshipResult, onObserved);
  const payload = add.localId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.subIssueAdd
    ? buildGithubSubIssueAddInputV1(input, number)
    : buildGithubRelatedEntryInputV1(input, relatedKindId, number);
  const removal = buildGithubRelatedEntryInputV1(input, relatedKindId, number);
  const pending = addWrite.pending || removeWrite.pending;
  const outcome = removeWrite.outcome ?? addWrite.outcome;
  return (
    <GithubPropertyRow title={title} {...(value === undefined ? {} : { value })}>
      {children}
      <Form.TextField
        label={relatedKindId === 'issue'
          ? text('plugins.github.ui.parity.issueNumber', 'Issue number')
          : text('plugins.github.ui.parity.pullRequestNumber', 'Pull request number')}
        value={numberValue}
        onChange={setNumberValue}
      />
      <Row gap="small" wrap>
        <Action.Control action={addWrite.action} controller={addWrite.controllerFor(payload)}
          title={add.title} titleKey={add.titleKey} variant="secondary" disabled={payload === null || pending} />
        <Action.Control action={removeWrite.action} controller={removeWrite.controllerFor(removal)}
          title={remove.title} titleKey={remove.titleKey} variant="plain" disabled={removal === null || pending} />
      </Row>
      {outcome === null ? null : <WriteOutcome outcome={outcome} />}
    </GithubPropertyRow>
  );
}

function GithubSubIssueRelationshipRow({ disabledReason, ...props }: React.ComponentProps<typeof GithubRelationshipRow> & Readonly<{
  disabledReason: string | null;
}>): React.ReactElement {
  const write = useGithubWrite(GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.subIssueReprioritize, parseRelationshipResult, props.onObserved);
  const reorder = React.useCallback(async (payload: NonNullable<ReturnType<typeof buildGithubSubIssueReprioritizeInputV1>>) => {
    const result = await write.run(payload);
    return result?.kind === 'applied';
  }, [write.run]);
  return <GithubRelationshipRow {...props}>
    <GithubSubIssueOrder input={props.input} reorder={reorder} {...(disabledReason === null ? {} : { disabledReason })} />
    {write.outcome === null ? null : <WriteOutcome outcome={write.outcome} />}
  </GithubRelationshipRow>;
}

/** Same-repository references the observation already read, as "#12, #14"; another repository's are counted. */
function githubRelatedNumbersText(
  text: PluginTranslate,
  input: TriageDetailSurfaceInputV1,
  refs: readonly Readonly<{ collisionScope: string; entryId: string }>[] | undefined,
): string | undefined {
  if (refs === undefined) return undefined;
  if (refs.length === 0) return text('plugins.github.ui.parity.none', 'None');
  return refs.map((ref) => ref.collisionScope === input.observation.entryRef.collisionScope ? `#${ref.entryId}` : '…').join(', ');
}

/** github.com's Development and Relationships: closing references, sub-issues and dependencies. */
function GithubEntryRelationships({ input, kindId, onObserved, capabilities }: Readonly<{
  input: TriageDetailSurfaceInputV1;
  kindId: GithubTriageKindIdV1;
  onObserved: GithubObservedEntryHandlerV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const relations = input.observation.snapshot.relations;
  const ids = GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1;
  if (kindId === 'pull-request') {
    return (
      <ItemGroup title={text('plugins.github.ui.parity.relationships', 'Relationships')}>
        <GithubRelationshipRow input={input} onObserved={onObserved} relatedKindId="issue"
          title={text('plugins.github.ui.parity.closesIssues', 'Closes issues')}
          add={{ localId: ids.closingReferenceAdd, title: 'Link issue', titleKey: 'plugins.github.ui.parity.linkIssue' }}
          remove={{ localId: ids.closingReferenceRemove, title: 'Unlink issue', titleKey: 'plugins.github.ui.parity.unlinkIssue' }} />
      </ItemGroup>
    );
  }
  const children = relations?.children;
  const blockedBy = githubRelatedNumbersText(text, input, relations?.blockedBy);
  return (
    <ItemGroup title={text('plugins.github.ui.parity.relationships', 'Relationships')}>
      <GithubSubIssueRelationshipRow input={input} onObserved={onObserved} relatedKindId="issue"
        disabledReason={githubOperationCapabilityReason(text, capabilities, 'subIssueReprioritize')}
        title={text('plugins.github.ui.parity.subIssues', 'Sub-issues')}
        {...(children === undefined ? {} : {
          value: children.total === 0 ? text('plugins.github.ui.parity.none', 'None')
            : text('plugins.github.ui.parity.subIssuesDone', '{completed} of {total} done', {
              completed: String(children.completed ?? 0), total: String(children.total) }),
        })}
        add={{ localId: ids.subIssueAdd, title: 'Add sub-issue', titleKey: 'plugins.github.ui.parity.addSubIssue' }}
        remove={{ localId: ids.subIssueRemove, title: 'Remove sub-issue', titleKey: 'plugins.github.ui.parity.removeSubIssue' }} />
      <GithubRelationshipRow input={input} onObserved={onObserved} relatedKindId="issue"
        title={text('plugins.github.ui.parity.blockedBy', 'Blocked by')}
        {...(blockedBy === undefined ? {} : { value: blockedBy })}
        add={{ localId: ids.blockedByAdd, title: 'Add blocker', titleKey: 'plugins.github.ui.parity.addBlocker' }}
        remove={{ localId: ids.blockedByRemove, title: 'Remove blocker', titleKey: 'plugins.github.ui.parity.removeBlocker' }} />
      <GithubRelationshipRow input={input} onObserved={onObserved} relatedKindId="issue"
        title={text('plugins.github.ui.parity.blocking', 'Blocking')}
        add={{ localId: ids.blockingAdd, title: 'Add blocked issue', titleKey: 'plugins.github.ui.parity.addBlocking' }}
        remove={{ localId: ids.blockingRemove, title: 'Remove blocked issue', titleKey: 'plugins.github.ui.parity.removeBlocking' }} />
      <GithubRelationshipRow input={input} onObserved={onObserved} relatedKindId="pull-request"
        title={text('plugins.github.ui.parity.linkedPullRequests', 'Linked pull requests')}
        add={{ localId: ids.closingReferenceAdd, title: 'Link pull request', titleKey: 'plugins.github.ui.parity.linkPullRequest' }}
        remove={{ localId: ids.closingReferenceRemove, title: 'Unlink pull request', titleKey: 'plugins.github.ui.parity.unlinkPullRequest' }} />
    </ItemGroup>
  );
}

/** A remote write's new entry is opened through the host's existing resource destination. */
function GithubAdministrationReceipt({ label, url }: Readonly<{ label: string; url?: string }>): React.ReactElement {
  const text = usePluginTranslation();
  const host = usePluginHostApi();
  const resource = url === undefined ? undefined : readGithubResourceIntent(url);
  return <Row gap="small" wrap>
    <Text variant="body" value={label} />
    {resource === undefined ? null : <Button title={text('plugins.github.ui.administration.open', 'Open')}
      variant="plain" size="small" onPress={() => host.openResource(resource)} />}
  </Row>;
}

/** Mounted only while the transfer editor is open: closed administration performs no source read. */
function GithubTransferEditor({ input, write, onApplied }: Readonly<{
  input: TriageDetailSurfaceInputV1;
  write: GithubWriteControllerV1<GithubEntryAdministrationResultV1>;
  onApplied(result: Extract<GithubEntryAdministrationResultV1, { kind: 'applied' }>): void;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const sources = useExecutePluginAction(TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1);
  const [destination, setDestination] = React.useState<string | null>(null);
  const [createLabels, setCreateLabels] = React.useState(false);
  const { execute } = sources;
  React.useEffect(() => {
    const controller = new AbortController();
    void execute({ v: 1 }, { signal: controller.signal });
    return () => controller.abort();
  }, [execute]);
  const read = React.useMemo(() => sources.execution.status === 'success'
    ? TriageReadConfiguredSourceInstancesResultV1Schema.safeParse(sources.execution.result) : null, [sources.execution]);
  const options = React.useMemo(() => {
    if (!read?.success || read.data.kind !== 'read') return [];
    const binding = JSON.stringify(triageSourceBindingComponentsV1(input.instance.binding));
    const repositories = new Set<string>();
    for (const row of read.data.instances) {
      if (row.lifecycle !== 'active'
        || JSON.stringify(triageSourceBindingComponentsV1(row.configured.binding)) !== binding) continue;
      const decoded = decodeGithubTriageConfiguration(row.configured.configuration.token);
      if (!decoded.ok || decoded.configuration.selection.kind !== 'selected') continue;
      for (const repository of decoded.configuration.selection.unitIds) {
        if (repository !== input.observation.locator.routingToken) repositories.add(repository);
      }
    }
    return [...repositories].map(repository => ({ value: repository, label: repository }));
  }, [input.instance.binding, input.observation.locator.routingToken, read]);
  if (sources.execution.status === 'idle' || sources.execution.status === 'pending') {
    return <Text variant="meta" tone="secondary" value={text('plugins.github.ui.administration.sourcesReading', 'Reading configured repositories…')} />;
  }
  if (!read?.success || read.data.kind !== 'read') {
    return <Status tone="warning" label={sources.execution.status === 'error' ? sources.execution.message
      : text('plugins.github.ui.administration.sourcesFailed', 'Configured repositories could not be read.')}
      action={<Button title={text('plugins.github.ui.administration.retry', 'Retry')} variant="plain"
        onPress={() => execute({ v: 1 })} />} />;
  }
  if (options.length === 0) return <Text variant="meta" tone="secondary" value={text('plugins.github.ui.administration.sourcesEmpty',
    'Configure another repository on this connection to transfer this issue.')} />;
  const payload = destination === null ? null : buildGithubIssueTransferInputV1(input, destination, createLabels);
  return <Stack gap="small">
    {read.data.status === 'truncated' ? <Text variant="meta" tone="secondary" value={text('plugins.github.ui.administration.sourcesPartial',
      'Showing the configured repositories returned by this read.')} /> : null}
    <Form.Select label={text('plugins.github.ui.administration.destination', 'Destination repository')}
      presentation="field" options={options} {...(destination === null ? {} : { value: destination })}
      disabled={write.pending} onChange={value => { if (typeof value === 'string') setDestination(value); }} />
    <Form.Toggle label={text('plugins.github.ui.administration.createLabels', 'Create missing labels')}
      value={createLabels} disabled={write.pending} onChange={setCreateLabels} />
    <Action.Control action={write.action}
      controller={write.controllerFor(payload, result => { if (result.kind === 'applied') onApplied(result); })}
      title={text('plugins.github.ui.administration.transferSubmit', 'Transfer')} variant="secondary"
      disabled={payload === null || write.pending} />
    {write.outcome === null ? null : <WriteOutcome outcome={write.outcome} />}
  </Stack>;
}

function GithubIssueTransferWrite({ input, onObserved, capabilities }: Readonly<{
  input: TriageDetailSurfaceInputV1;
  onObserved: GithubObservedEntryHandlerV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const write = useGithubWrite(GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueTransfer, parseAdministrationResult, onObserved);
  const [applied, setApplied] = React.useState<Extract<GithubEntryAdministrationResultV1, { kind: 'applied' }> | null>(null);
  const title = text('plugins.github.ui.administration.transfer', 'Transfer to another repository…');
  const reason = githubOperationCapabilityReason(text, capabilities, 'issueTransfer');
  if (applied !== null && applied.observation?.kind === 'merged' && applied.entry.routingToken !== undefined) {
    return <GithubAdministrationReceipt label={text('plugins.github.ui.administration.moved', 'Moved to {repository} #{number}', {
      repository: applied.entry.routingToken, number: applied.observation.successor.entryId,
    })} {...(applied.entry.url === undefined ? {} : { url: applied.entry.url })} />;
  }
  if (reason !== null) return <UnavailableOperationWrite title={title} reason={reason} />;
  return <GithubPropertyRow title={title}>
    <GithubTransferEditor input={input} write={write} onApplied={setApplied} />
  </GithubPropertyRow>;
}

function GithubIssueDeleteWrite({ input, onObserved, capabilities }: Readonly<{
  input: TriageDetailSurfaceInputV1;
  onObserved: GithubObservedEntryHandlerV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const write = useGithubWrite(GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueDelete, parseAdministrationResult, onObserved);
  const title = text('plugins.github.ui.administration.delete', 'Delete issue…');
  const reason = githubOperationCapabilityReason(text, capabilities, 'issueDelete');
  if (write.outcome?.kind === 'applied') return <Text variant="body" value={text('plugins.github.ui.administration.deleted', 'Deleted on GitHub')} />;
  if (reason !== null) return <UnavailableOperationWrite title={title} reason={reason} />;
  const payload = buildGithubPullRequestTargetInputV1(input);
  return <GithubPropertyRow title={title} tone="danger">
    <Text variant="label" value={text('plugins.github.ui.administration.deleteIdentity', 'Delete #{number} · {title}', {
      number: input.observation.entryRef.entryId, title: input.observation.snapshot.title,
    })} />
    <Text variant="body" value={text('plugins.github.ui.administration.deleteWarning',
      'This permanently deletes the issue and its comments on GitHub. It cannot be undone.')} />
    <Action.Control action={write.action} controller={write.controllerFor(payload)}
      title={text('plugins.github.ui.administration.deleteSubmit', 'Delete issue')} variant="destructive"
      disabled={payload === null || write.pending} />
    {write.outcome === null ? null : <WriteOutcome outcome={write.outcome} />}
  </GithubPropertyRow>;
}

function GithubPullRequestRevertWrite({ input, onObserved, capabilities }: Readonly<{
  input: TriageDetailSurfaceInputV1;
  onObserved: GithubObservedEntryHandlerV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const write = useGithubWrite(GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestRevert, parseAdministrationResult, onObserved);
  const [title, setTitle] = React.useState(text('plugins.github.ui.administration.revertDefaultTitle', 'Revert "#{number} {title}"', {
    number: input.observation.entryRef.entryId, title: input.observation.snapshot.title,
  }));
  const [body, setBody] = React.useState('');
  const [draft, setDraft] = React.useState(false);
  const [applied, setApplied] = React.useState<Extract<GithubEntryAdministrationResultV1, { kind: 'applied' }> | null>(null);
  if (applied !== null && applied.entry.localRef !== undefined) return <GithubAdministrationReceipt
    label={text('plugins.github.ui.administration.opened', 'Opened #{number}', { number: applied.entry.localRef.entryId })}
    {...(applied.entry.url === undefined ? {} : { url: applied.entry.url })} />;
  const label = text('plugins.github.ui.administration.revert', 'Revert…');
  const reason = githubOperationCapabilityReason(text, capabilities, 'pullRequestRevert');
  if (reason !== null) return <UnavailableOperationWrite title={label} reason={reason} />;
  const payload = buildGithubPullRequestRevertInputV1(input, { title: title.trim(), ...(body === '' ? {} : { body }), draft });
  return <GithubPropertyRow title={label}>
    <Form.TextField label={text('plugins.github.ui.parity.title', 'Title')} value={title} onChange={setTitle} disabled={write.pending} />
    <Form.Field label={text('plugins.github.ui.administration.revertBody', 'Body (optional)')}>
      <MarkdownEditor accessibilityLabel={text('plugins.github.ui.administration.revertBody', 'Body (optional)')}
        value={body} onChange={setBody} disabled={write.pending} />
    </Form.Field>
    <Form.Toggle label={text('plugins.github.ui.administration.draft', 'Open as draft')} value={draft} onChange={setDraft} disabled={write.pending} />
    <Action.Control action={write.action}
      controller={write.controllerFor(payload, result => { if (result.kind === 'applied') setApplied(result); })}
      title={text('plugins.github.ui.administration.revertSubmit', 'Open revert PR')} variant="secondary"
      disabled={payload === null || write.pending} />
    {write.outcome === null ? null : <WriteOutcome outcome={write.outcome} />}
  </GithubPropertyRow>;
}

/**
 * The source branch after a pull request closes (github.com's "Delete branch" / "Restore branch"). Both name the head
 * the reader saw; GitHub's answer decides which one shows next, never a guess.
 */
function PullRequestHeadBranchWrite({ input, overview, onObserved, capabilities }: Readonly<{
  input: TriageDetailSurfaceInputV1;
  overview: GithubOverviewValueV1 | null;
  onObserved: GithubObservedEntryHandlerV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
}>): React.ReactElement {
  const head = (overview?.kindId === 'pull-request' ? overview.headRevision : undefined)
    ?? input.observation.snapshot.reviewRevision?.headSha;
  const payload = buildGithubPullRequestHeadBranchInputV1(input, head);
  const [deleted, setDeleted] = React.useState(false);
  const observe = React.useCallback<GithubObservedEntryHandlerV1>((execution, outcome, actionLocalId) => {
    if (outcome?.kind === 'applied') setDeleted(actionLocalId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestHeadBranchDelete);
    onObserved(execution, outcome, actionLocalId);
  }, [onObserved]);
  return deleted ? (
    <ExactWrite localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestHeadBranchRestore} payload={payload}
      title="Restore branch" titleKey="plugins.github.ui.parity.restoreBranch" parseResult={parseHeadBranchRestoreResult}
      onObserved={observe} capabilities={capabilities} operation="pullRequestHeadBranchRestore" />
  ) : (
    <ExactWrite localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestHeadBranchDelete} payload={payload}
      title="Delete branch" titleKey="plugins.github.ui.parity.deleteBranch" parseResult={parseHeadBranchDeleteResult}
      onObserved={observe} capabilities={capabilities} operation="pullRequestHeadBranchDelete" />
  );
}

function GithubNotificationToggle({ input, checked, operation, onObserved, capabilities, onConfirmed }: Readonly<{
  input: TriageDetailSurfaceInputV1;
  checked: boolean;
  operation: 'entrySubscribe' | 'entryUnsubscribe' | 'issuePin' | 'issueUnpin';
  onObserved: GithubObservedEntryHandlerV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
  onConfirmed: (entry: Extract<GithubEntryAdministrationResultV1, { kind: 'applied' }>['entry']) => void;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const pin = operation === 'issuePin' || operation === 'issueUnpin';
  const write = useGithubWrite(GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1[operation], parseAdministrationResult, onObserved);
  const payload = React.useMemo(() => input.observation.entryRef.kindId === 'issue'
    ? buildGithubIssueReopenInputV1(input) : buildGithubPullRequestTargetInputV1(input), [input]);
  const reason = githubOperationCapabilityReason(text, capabilities, operation);
  const label = pin ? text('plugins.github.ui.notifications.pinned', 'Pinned to the repository')
    : text('plugins.github.ui.notifications.subscribed', 'Subscribed');
  return <Stack gap="small">
    <Item title={label} subtitle={reason ?? (pin
      ? text('plugins.github.ui.notifications.pinDescription', "Shown at the top of the repository’s issues.")
      : text('plugins.github.ui.notifications.description', "You’ll get GitHub notifications for activity here."))}
      accessory={<Form.Toggle label={label} value={checked}
        disabled={write.pending || payload === null || reason !== null}
        onChange={async () => {
          if (payload === null) return;
          const result = await write.run(payload);
          if (result?.kind === 'applied') onConfirmed(result.entry);
        }} />}
    />
    {write.outcome !== null && write.outcome.kind !== 'applied' ? <WriteOutcome outcome={write.outcome} /> : null}
  </Stack>;
}

function GithubNotifications({ input, overview, onObserved, capabilities }: Readonly<{
  input: TriageDetailSurfaceInputV1;
  overview: GithubOverviewValueV1 | null;
  onObserved: GithubObservedEntryHandlerV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  const [confirmed, setConfirmed] = React.useState<Readonly<{
    source: GithubOverviewValueV1;
    subscribed: boolean;
  }> | null>(null);
  const observed = overview?.kindId === 'pull-request' ? overview.viewerSubscription : undefined;
  const subscribed = confirmed?.source === overview
    ? confirmed.subscribed
    : observed === 'SUBSCRIBED';
  if (overview === null || observed === undefined) return null;
  return (
    <ItemGroup title={text('plugins.github.ui.notifications.title', 'Notifications')}>
      <GithubNotificationToggle input={input} checked={subscribed}
        operation={subscribed ? 'entryUnsubscribe' : 'entrySubscribe'} onObserved={onObserved} capabilities={capabilities}
        onConfirmed={entry => {
          if (entry.subscription !== undefined) setConfirmed({ source: overview, subscribed: entry.subscription === 'SUBSCRIBED' });
        }} />
    </ItemGroup>
  );
}

function githubOperationCapabilityReason(
  text: PluginTranslate,
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>,
  operation: keyof GithubRepositoryCapabilitiesV1['operations'],
): string | null {
  // A missing preflight is not a prohibition. The confirmed Action remains the
  // authority and already returns GitHub's typed permission failure. Only a
  // decisive provider fact disables an operation before dispatch.
  if (capabilities.kind !== 'ready') return null;
  const availability = capabilities.value.operations[operation];
  if (availability === undefined || availability.kind === 'available') return null;
  if (availability.code === 'repository_archived') {
    return text('plugins.github.ui.capabilities.archived', 'This repository is archived.');
  }
  if (availability.code === 'repository_unsupported') {
    return text('plugins.github.ui.capabilities.unsupported', 'This repository does not support this change.');
  }
  return null;
}

function UnavailableOperationWrite({
  title,
  titleKey,
  reason,
  variant = 'secondary',
}: Readonly<{
  title: string;
  titleKey?: string;
  reason: string;
  variant?: 'primary' | 'secondary';
}>): React.ReactElement {
  return (
    <Stack gap="small">
      <Button
        title={title}
        titleKey={titleKey}
        variant={variant}
        disabled
        onPress={() => {}}
      />
      <Text variant="micro" tone="neutral" value={reason} />
    </Stack>
  );
}

/**
 * The write controls as their own panel (r0.42): the Triage detail places them
 * in its header, beside its entry actions, rather than inside Overview. The
 * current overview read they depend on is this panel's own.
 */
function GithubActionsPanel(props: Readonly<{
  input: TriageDetailSurfaceInputV1;
  kindId: GithubTriageKindIdV1;
  mergeSignature: GithubMergeSignatureStateV1;
  onObserved: GithubObservedEntryHandlerV1;
  publicationProposals: ReviewCommentProposalReadV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
  overview: GithubOverviewControllerV1;
  primaryWrite: TriageDetailPrimaryWriteV1 | null;
}>): React.ReactElement | null {
  const primaryHost = useTriageEvidenceDisclosure().primaryWrite;
  return (
    <WritesSection
      input={props.input}
      kindId={props.kindId}
      mergeSignature={props.mergeSignature}
      onObserved={props.onObserved}
      publicationProposals={props.publicationProposals}
      capabilities={props.capabilities}
      overview={props.overview.value}
      refreshOverview={props.overview.refresh}
      primaryWrite={primaryHost === undefined ? props.primaryWrite : null}
    />
  );
}

function WritesSection({
  input,
  kindId,
  mergeSignature,
  onObserved,
  publicationProposals,
  capabilities,
  overview,
  primaryWrite,
  refreshOverview,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  kindId: GithubTriageKindIdV1;
  mergeSignature: GithubMergeSignatureStateV1;
  onObserved: GithubObservedEntryHandlerV1;
  publicationProposals: ReviewCommentProposalReadV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
  overview: Extract<GithubOverviewResultV1, { kind: 'overview' }> | null;
  primaryWrite: TriageDetailPrimaryWriteV1 | null;
  refreshOverview: () => unknown;
}>): React.ReactElement | null {
  const offered = githubOfferedMutationsV1({
    kindId,
    state: input.observation.snapshot.state,
  });
  const target = React.useMemo(
    () => buildGithubPullRequestTargetInputV1(input),
    [input],
  );
  if (offered.length === 0 && kindId !== 'pull-request') return null;

  return (
    <Stack gap="small">
      <Divider />
      {kindId === 'pull-request' ? <GithubMergeSignature state={mergeSignature} /> : null}
      <>{offered.length === 0 && kindId !== 'pull-request' ? null : (
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
          ? (
            <IssueWrites
              input={input}
              offered={offered}
              overview={overview}
              onObserved={onObserved}
              publicationProposals={publicationProposals}
              capabilities={capabilities}
              refreshOverview={refreshOverview}
            />
          )
          : (
          <Stack gap="medium">
            <Text
              variant="micro"
              tone="neutral"
              valueKey="plugins.github.ui.mutations.description"
              fallback="These change the pull request on GitHub itself. Each one asks you to confirm before anything is written."
            />
            {offered.includes('merge') && primaryWrite !== null && primaryWrite.id !== 'markReady'
              ? (
                <MergeWrite
                  input={input}
                  terminal={mergeSignature.terminal}
                  primaryWrite={primaryWrite}
                />
              )
              : null}
            {primaryWrite?.alternatives?.map(alternative => (
              <MergeWrite key={alternative.id} input={input} terminal={mergeSignature.terminal} primaryWrite={alternative} />
            ))}
            {input.observation.snapshot.state.presentation === 'active'
              ? (
                <>
                  <PullRequestHeadWrites
                    input={input}
                    onObserved={onObserved}
                    capabilities={capabilities}
                    primaryWrite={primaryWrite}
                    branchUpdateEligible={overview?.kindId === 'pull-request'
                      && overview.branchUpdateEligibility === 'behind'}
                  />
                  {overview?.kindId === 'pull-request' && overview.draft === false ? (
                    <ExactWrite
                      localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestConvertToDraft}
                      payload={buildGithubPullRequestConvertToDraftInputV1(input)}
                      title="Convert to draft"
                      titleKey="plugins.github.ui.parity.convertToDraft"
                      parseResult={parseStateResult}
                      onObserved={onObserved}
                      capabilities={capabilities}
                      operation="pullRequestConvertToDraft"
                    />
                  ) : null}
                </>
              )
              : null}
            {/* Subscribing is this panel's quickest change; it leads the longer property and relationship cards. */}
            <GithubNotifications input={input} overview={overview} onObserved={onObserved} capabilities={capabilities} />
            <GithubEntryProperties input={input} kindId="pull-request" overview={overview} onObserved={onObserved} capabilities={capabilities} refreshOverview={refreshOverview} />
            <GithubEntryRelationships input={input} kindId="pull-request" onObserved={onObserved} capabilities={capabilities} />
            {input.observation.snapshot.state.presentation === 'active'
              ? (
                <>
                  <PullRequestReviewPublicationWrite
                    input={input}
                    onObserved={onObserved}
                    publicationProposals={publicationProposals}
                    capabilities={capabilities}
                  />
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
                  capabilities={capabilities}
                  operation="pullRequestClose"
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
                  capabilities={capabilities}
                  operation="pullRequestReopen"
                />
              )
              : null}
            {input.observation.snapshot.state.presentation === 'active' ? null : (
              <PullRequestHeadBranchWrite input={input} overview={overview} onObserved={onObserved} capabilities={capabilities} />
            )}
            {isGithubMergedState(input.observation.snapshot.state)
              ? <GithubPullRequestRevertWrite input={input} onObserved={onObserved} capabilities={capabilities} /> : null}
          </Stack>
        )}
        </>
      )}</>
    </Stack>
  );
}

/* --------------------------------------------------------------------- Overview */

type GithubOverviewValueV1 = Extract<GithubOverviewResultV1, { kind: 'overview' }>;

function githubOverviewStatusLabel(
  input: TriageDetailSurfaceInputV1,
  overview: GithubOverviewValueV1 | null,
): string {
  if (overview === null) return input.observation.snapshot.state.nativeLabel ?? 'Unavailable';
  if (overview.kindId === 'pull-request') {
    if (overview.merged === true) return 'Merged';
    if (overview.draft === true) return 'Draft';
  }
  if (overview.state === 'open') return 'Open';
  if (overview.state === 'closed') return 'Closed';
  return overview.state ?? 'Unavailable';
}

function githubOverviewCollection(
  values: readonly string[] | undefined,
  empty: string,
): string {
  if (values === undefined) return 'Unavailable';
  return values.length === 0 ? empty : values.join(', ');
}

function githubOverviewEntries(
  input: TriageDetailSurfaceInputV1,
  overview: GithubOverviewValueV1 | null,
  locale: string,
  nowMs: number,
): readonly MetadataEntry[] {
  const observedAtMs = overview?.observedAtMs ?? input.observation.observedAtMs;
  const headRevision = overview?.kindId === 'pull-request'
    ? overview.headRevision
    : overview === null
      ? input.observation.snapshot.reviewRevision?.headSha
      : undefined;
  const entries: MetadataEntry[] = [
    {
      label: 'Author',
      value: overview === null ? 'Refresh to read' : overview.author ?? 'Unavailable',
    },
    {
      label: 'Created',
      value: overview === null
        ? input.observation.snapshot.createdAtMs === undefined
          ? 'Unavailable'
          : formatTimestamp(locale, input.observation.snapshot.createdAtMs, 'absolute', nowMs)
        : overview.createdAtMs === undefined
          ? 'Unavailable'
          : formatTimestamp(locale, overview.createdAtMs, 'absolute', nowMs),
    },
    {
      label: 'Updated',
      value: overview?.updatedAtMs === undefined
        ? overview === null ? 'Refresh to read' : 'Unavailable'
        : formatTimestamp(locale, overview.updatedAtMs, 'absolute', nowMs),
    },
  ];
  if (input.observation.entryRef.kindId === 'pull-request') {
    const pullRequest = overview?.kindId === 'pull-request' ? overview : null;
    entries.push(
      {
        label: 'Branches',
        value: pullRequest === null
          ? 'Refresh to read'
          : `${pullRequest.headBranch ?? 'Unavailable'} → ${pullRequest.baseBranch ?? 'Unavailable'}`,
      },
      {
        label: 'Requested reviewers',
        value: pullRequest === null
          ? 'Refresh to read'
          : pullRequest.requestedReviewers === undefined
            ? 'Unavailable'
            : pullRequest.requestedReviewers.length === 0
              ? 'None'
              : pullRequest.requestedReviewers
                .map((reviewer) => reviewer.kind === 'team'
                  ? `${reviewer.subject} (team)`
                  : reviewer.subject)
                .join(', '),
      },
      {
        label: 'Observed head',
        value: headRevision === undefined
          ? 'Unavailable'
          : `${headRevision.slice(0, 12)} · ${formatTimestamp(locale, observedAtMs, 'absolute', nowMs)}`,
      },
      {
        label: 'Changes',
        value: pullRequest === null
          ? 'Refresh to read'
          : pullRequest.additions === undefined || pullRequest.deletions === undefined
            ? 'Unavailable'
            : githubDiffStatText(pullRequest.additions, pullRequest.deletions, locale),
      },
    );
  }
  entries.push(
    {
      label: 'Labels',
      value: overview === null ? 'Refresh to read' : githubOverviewCollection(overview.labels, 'None'),
    },
    {
      label: 'Assignees',
      value: overview === null ? 'Refresh to read' : githubOverviewCollection(overview.assignees, 'None'),
    },
    {
      label: 'Milestone',
      value: overview === null
        ? 'Refresh to read'
        : overview.milestone === undefined
          ? 'Unavailable'
          : overview.milestone ?? 'None',
    },
  );
  return Object.freeze(entries);
}

function GithubOverviewReadFailure({
  controller,
}: Readonly<{ controller: GithubOverviewControllerV1 }>): React.ReactElement | null {
  const text = usePluginTranslation();
  if (controller.failure === null) return null;
  const description = failureDescription(
    controller.failure,
    text('plugins.github.ui.readFailed', 'GitHub could not complete this read.'), text,
  );
  return controller.value === null
    ? (
      <GithubReadFailure
        title={text(
          'plugins.github.ui.overview.unavailable',
          'The current overview is unavailable',
        )}
        failures={[controller.failure]}
        refresh={controller.refresh}
      />
    )
    : (
      <Stack gap="small"><Banner
        tone="warning"
        title={text(
          'plugins.github.ui.overview.retained',
          'Showing the last overview read',
        )}
        description={description}
      /><GithubReadFailureDetails failures={[controller.failure]} /></Stack>
    );
}

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
  // Preserve the standalone view's existing manual, tab-owned read interval.
  const activity = useTabPanelActivity();
  const overview = useGithubOverview(input, { activity, includePropertyChoices: kindId === 'pull-request' });
  const primaryController = useGithubPrimaryWrite(input, overview, onObserved, activity);
  const primaryWrite = primaryController.value;
  const exact = overview.value;
  const statusLabel = githubOverviewStatusLabel(input, exact);
  const currentEntries = React.useMemo(
    () => githubOverviewEntries(input, exact, locale, nowMs),
    [exact, input, locale, nowMs],
  );
  const webUrl = exact?.webUrl ?? input.observation.locator.webUrl;
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
        <RefreshRow
          onRefresh={primaryController.refresh}
          pending={overview.refreshing}
          accessibilityLabel={text(
            'plugins.github.ui.overview.reread',
            'Re-read this overview from GitHub',
          )}
        />
        <GithubOverviewReadFailure controller={overview} />
        {capabilities.kind === 'unavailable' ? <GithubReadFailureDetails failures={[capabilities.failure]} /> : null}
        <Text
          variant="heading"
          value={exact === null ? input.observation.snapshot.title : exact.title ?? 'Unavailable'}
        />
        <Status tone={githubOverviewStatusToneV1(statusLabel)} label={statusLabel} />
        <Metadata
          title={text('plugins.github.ui.overview.details', 'Current GitHub details')}
          entries={currentEntries}
        />
        <Stack gap="small">
          <Text variant="label" value="Description" />
          {exact === null && overview.failure === null
            ? <Text variant="micro" tone="neutral" value="Refresh to read the current description." />
            : <GithubOverviewMarkdown body={exact?.body} />}
        </Stack>
        {webUrl === undefined ? null : (
          <Row gap="small" wrap>
            <Action.OpenExternal
              url={webUrl}
              title={text('plugins.github.ui.overview.openOnGithub', 'Open on GitHub')}
            />
            <Action.Copy
              value={webUrl}
              title={text('plugins.github.ui.overview.copyGithubUrl', 'Copy GitHub URL')}
            />
          </Row>
        )}
        {statusFields.length === 0 ? null : (
          <Row gap="small">
            {statusFields.map((field) => (
              <Status
                key={field.id}
                tone={resolveTriageRowFactStatusToneV1(field.tone)}
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
              variant="micro"
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
        {kindId === 'pull-request' ? <GithubPullRequestPreviewStep input={input} closed={exact?.state === 'closed'} /> : null}
        <WritesSection
          input={input}
          kindId={kindId}
          mergeSignature={mergeSignature}
          onObserved={onObserved}
          publicationProposals={publicationProposals}
          capabilities={capabilities}
          overview={exact}
          primaryWrite={primaryWrite}
          refreshOverview={overview.refresh}
        />
      </Stack>
    </ScrollArea>
  );
}

/* --------------------------------------------------------------------- Timeline */

/**
 * The reader-facing words for one timeline arm; the shared Activity owner puts
 * the actor in front of them.
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
  return modelled === undefined
    ? row.rawKind
    : text(githubTimelineHeadlineKey(row.kind), modelled);
}

/** Which Activity marker each timeline arm takes; an unmodelled arm is just an event. */
const GITHUB_TIMELINE_ACTIVITY_KINDS: Readonly<Record<string, TriageActivityKindV1 | undefined>> =
  Object.freeze({
    commented: 'comment',
    committed: 'change',
    forcePushed: 'change',
    baseChanged: 'change',
    reviewed: 'review',
    reviewRequested: 'assignment',
    reviewRequestRemoved: 'assignment',
    merged: 'state',
    closed: 'state',
    reopened: 'state',
    renamed: 'state',
    labeled: 'label',
    unlabeled: 'label',
    milestoned: 'label',
    demilestoned: 'label',
    assigned: 'assignment',
    unassigned: 'assignment',
  });

/**
 * One GitHub read projected for the shared Activity stream.
 *
 * Each read keeps its own lifecycle, cursor and failure; the view below only
 * decides how the reads that answered are shown together.
 */
type GithubActivityStreamV1 = Readonly<{
  /** The read has not answered yet. */
  settling: boolean;
  /** The read answered with nothing usable at all: a cold failure. */
  unavailable: Readonly<{ title: string; titleKey: string; failure: GithubReadFailureV1 | null }> | null;
  failedReads: readonly Readonly<{ failure: GithubReadFailureV1 | null; refresh: () => unknown }>[];
  header: React.ReactNode;
  /** The stream's own summary (who reviewed), as Activity's first entry rather than pinned above it. */
  lead?: TriageActivityLeadV1 | undefined;
  events: readonly TriageActivityEventV1[];
  /**
   * GitHub records a remark twice — as the comment or review itself and as a
   * `commented`/`reviewed` timeline event with the same permalink. A stream
   * that mirrors remarks drops its copy when the remark itself is on screen.
   */
  mirrorsRemarks?: true;
  continuations: readonly TriageActivityContinuationV1[];
  /** The conversation's comment box, after the last event. */
  composer?: React.ReactNode;
  summary: React.ReactNode;
  refresh: () => void;
  pending: boolean;
  empty: React.ReactNode;
}>;

function useGithubTimelineStream(): GithubActivityStreamV1 {
  const text = usePluginTranslation();
  const controller = useGithubTimeline();
  const { state } = controller;
  const incomplete = incompleteDescription(text, state.incomplete, null);
  return {
    settling: state.kind === 'idle' || state.kind === 'loading',
    unavailable: state.kind === 'unavailable'
      ? { title: 'The timeline is unavailable', titleKey: 'plugins.github.ui.timelineUnavailable', failure: state.failure }
      : null,
    failedReads: [{ failure: state.failure, refresh: controller.refresh }],
    header: <PageFailureBanner state={state} />,
    events: state.rows.map((row) => {
      const headline = timelineHeadline(text, row);
      return {
        id: row.id,
        atMs: row.atMs ?? null,
        kind: GITHUB_TIMELINE_ACTIVITY_KINDS[row.kind] ?? 'other',
        actor: row.actor ?? null,
        summary: headline,
        detail: row.summary ?? null,
        href: row.webUrl ?? null,
        hrefLabel: text('plugins.github.ui.openOnGithub', 'Open {item} on GitHub', { item: headline }),
      };
    }),
    mirrorsRemarks: true,
    continuations: state.canLoadMore
      ? [{
        key: 'timeline',
        // GitHub pages this timeline oldest first, so the next page is LATER
        // events, not earlier ones. The control says what it does.
        title: 'Load more events',
        titleKey: 'plugins.github.ui.loadMoreEvents',
        pending: state.pending,
        onLoadMore: controller.loadMore,
      }]
      : [],
    summary: (
      <Stack gap="small">
        {/* A complete read says nothing; only rows that could not be understood are worth a line. */}
        {state.omittedRowCount === 0 ? null : <Text
          variant="micro"
          tone="neutral"
          valueKey="plugins.github.ui.eventsReadWithUnreadable"
          fallback="{count} event(s) read. {unreadable} row(s) on the pages read could not be understood."
          values={{ count: state.rows.length, unreadable: state.omittedRowCount }}
        />}
        {incomplete === null ? null : <Text variant="micro" tone="neutral">{incomplete}</Text>}
      </Stack>
    ),
    refresh: controller.refresh,
    pending: state.pending,
    empty: (
      <EmptyState
        title="No recorded events"
        titleKey="plugins.github.ui.noEvents"
        description="GitHub has recorded no timeline events for this entry yet."
        descriptionKey="plugins.github.ui.noEvents.description"
      />
    ),
  };
}

/**
 * Every Activity-shaped GitHub plane — the timeline, an issue's comments, a pull
 * request's feedback, and Triage's Activity panel that merges them — rendered
 * through the one shared Activity owner.
 *
 * It is a loading state while any initial read is still settling, and a failure
 * only when every read failed; otherwise it shows what answered, beside a banner
 * naming each read that did not.
 */
function GithubActivityView({
  streams,
  locale,
  nowMs,
  accessibilityLabel,
  accessibilityLabelKey,
  loadingTitle,
  loadingTitleKey,
  refreshLabel,
  refreshLabelKey,
}: Readonly<{
  streams: readonly GithubActivityStreamV1[];
  locale: string;
  nowMs: number;
  accessibilityLabel: string;
  accessibilityLabelKey: string;
  loadingTitle: string;
  loadingTitleKey: string;
  refreshLabel: string;
  refreshLabelKey: string;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const readFailed = text('plugins.github.ui.readFailed', 'GitHub could not complete this read.');
  if (streams.some((stream) => stream.settling)) {
    return <LoadingState title={loadingTitle} titleKey={loadingTitleKey} />;
  }
  const cold = streams.every((stream) => stream.unavailable !== null) ? streams[0]?.unavailable ?? null : null;
  if (cold !== null) {
    return (
      <GithubReadFailure
        title={cold.title}
        titleKey={cold.titleKey}
        failures={streams.flatMap(stream => stream.failedReads.map(read => read.failure))}
        refresh={() => { for (const read of streams.flatMap(stream => stream.failedReads)) {
          if (read.failure?.retryable === true) read.refresh();
        } }}
      />
    );
  }

  const answered = streams.filter((stream) => !stream.settling && stream.unavailable === null);
  const remarkHrefs = new Set(answered
    .filter((stream) => stream.mirrorsRemarks === undefined)
    .flatMap((stream) => stream.events)
    .filter((event) => event.kind === 'comment' || event.kind === 'review')
    .flatMap((event) => (event.href === undefined || event.href === null ? [] : [event.href])));
  const events = answered.flatMap((stream) => (stream.mirrorsRemarks === undefined
    ? stream.events
    : stream.events.filter((event) => !((event.kind === 'comment' || event.kind === 'review')
      && event.href !== undefined && event.href !== null && remarkHrefs.has(event.href)))));

  const lead = answered.find((stream) => stream.lead !== undefined)?.lead;

  return (
    <TriageActivityTimeline
      events={events}
      lead={lead}
      locale={locale}
      nowMs={nowMs}
      accessibilityLabel={accessibilityLabel}
      accessibilityLabelKey={accessibilityLabelKey}
      header={(
        <Stack gap="medium">
          {streams.map((stream, index) => (
            <React.Fragment key={index}>
              {stream.unavailable === null
                ? stream.header
                : (
                  <Stack gap="small"><Banner
                    tone="warning"
                    title={stream.unavailable.title}
                    titleKey={stream.unavailable.titleKey}
                    description={failureDescription(stream.unavailable.failure, readFailed, text)}
                  /><GithubReadFailureDetails failures={stream.failedReads.map(read => read.failure)} /></Stack>
                )}
            </React.Fragment>
          ))}
        </Stack>
      )}
      empty={answered.length === streams.length ? answered[0]?.empty ?? null : null}
      continuations={answered.flatMap((stream) => stream.continuations)}
      refresh={{
        label: refreshLabel,
        labelKey: refreshLabelKey,
        pending: streams.some((stream) => stream.pending),
        onRefresh: () => { for (const stream of streams) stream.refresh(); },
      }}
      footer={(
        <Stack gap="small">
          {streams.map((stream, index) => <React.Fragment key={index}>{stream.composer ?? null}</React.Fragment>)}
          {answered.map((stream, index) => <React.Fragment key={index}>{stream.summary}</React.Fragment>)}
        </Stack>
      )}
    />
  );
}

function TimelinePanel({
  locale,
  nowMs,
}: Readonly<{
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  const timeline = useGithubTimelineStream();
  return (
    <GithubActivityView
      streams={[timeline]}
      locale={locale}
      nowMs={nowMs}
      accessibilityLabel="Events GitHub recorded for this entry"
      accessibilityLabelKey="plugins.github.ui.timelineLabel"
      loadingTitle="Reading this timeline from GitHub"
      loadingTitleKey="plugins.github.ui.readingTimeline"
      refreshLabel="Re-read this timeline from GitHub"
      refreshLabelKey="plugins.github.ui.rereadTimeline"
    />
  );
}

/* ------------------------------------------------------------------------ Files */

/** A text-only slot's "+53 −5", by the shared diff-stat owner: a side with nothing to say is left out. */
function githubDiffStatText(additions: number, deletions: number, locale: string): string {
  const counts = formatHappierDiffStat(additions, deletions, { locale });
  return [counts.added, counts.removed].filter((count) => count !== null).join(' ') || 'None';
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

/**
 * A row's Copy and Open as the list's own quiet overflow: one trailing control per row instead of
 * two plain buttons beside every file and check.
 */
function quietRowActions(
  hostApi: ReturnType<typeof usePluginHostApi>,
  text: PluginTranslate,
  input: Readonly<{ copyValue: string; openUrl?: string }>,
) {
  return {
    secondaryActions: [
      { id: 'copy', label: text('happier.plugin-ui.action.copy', 'Copy') },
      ...(input.openUrl === undefined
        ? []
        : [{ id: 'open', label: text('happier.plugin-ui.action.open', 'Open') }]),
    ],
    onSecondaryAction: (id: string) => {
      if (id === 'copy') void hostApi.writeClipboard(input.copyValue);
      else if (id === 'open' && input.openUrl !== undefined) void hostApi.openExternalLink(input.openUrl);
    },
  };
}

/** The source List, with one disclosed file and the existing paging lifecycle. */
function FilesPanel({
  input,
  overview,
  focusPath,
  onFocusPath,
  totalFiles,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  overview: GithubOverviewControllerV1['value'];
  /** GitHub's count of every file the pull request changes, from the Overview read when it has answered. */
  totalFiles: number | undefined;
  /** The detail's one "which file Files opens" fact: the reader's pick in Overview or an agent's open intent. */
  focusPath: string | null;
  onFocusPath: (path: string | null) => void;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const { locale } = useSurfaceContext();
  const controller = useGithubChangedFiles();
  const { state } = controller;
  const { active } = useTabPanelActivity();
  // GitHub's Viewed marks for this PR and head, from the host's one Viewed owner.
  const viewed = useGithubFileViewedSource(input, overview);
  const viewedCount = useTriageViewedFileCount(viewed);
  // The page's one refresh re-reads the files and their Viewed marks; this panel draws no refresh of its own.
  useTriagePageRefresh(() => { controller.refresh(); void viewed?.refresh(); });
  // One disclosed file for reader and agent intents; leaving Files releases its body.
  const wasActive = React.useRef(active);
  React.useEffect(() => {
    if (wasActive.current && !active) onFocusPath(null);
    wasActive.current = active;
  }, [active, onFocusPath]);
  const openCommands = React.useMemo<readonly TriageSourcePanelCommandV1[]>(() => state.rows
    .filter(row => row.diffAvailable).map(row => ({ title: row.path,
      operation: { kind: 'setSourceItemExpanded', list: 'files', itemId: row.path, expanded: true } })), [state.rows]);
  useTriageSourcePanelIntentV1({ kind: 'setSourceItemExpanded', list: 'files' }, async (operation) => {
    if (operation.kind !== 'setSourceItemExpanded'
      || !state.rows.some(row => row.path === operation.itemId && row.diffAvailable)) return { status: 'unavailable' };
    onFocusPath(operation.expanded ? operation.itemId : null);
    return { status: 'applied' };
  }, openCommands);
  const loadMore = useTriageSourcePanelPagingV1('files', text('plugins.github.ui.showMoreFiles', 'Show more files'),
    state.canLoadMore, state.pending, controller.loadMore);

  if (state.kind === 'idle' || state.kind === 'loading') {
    // The rows' own shape and the progress line's place, so the files replace placeholders of their size.
    return <TriageChangedFilesLoading title="Reading the changed files from GitHub" titleKey="plugins.github.ui.readingFiles"
      progress={viewed !== null} />;
  }
  if (state.kind === 'unavailable') {
    return (
      <GithubReadFailure
        title="The changed files are unavailable"
        titleKey="plugins.github.ui.filesUnavailable"
        failures={[state.failure]}
        refresh={controller.refresh}
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

  // GitHub's own total when the Overview has it; else the rows read, but only once the walk has no page left.
  const total = totalFiles ?? (state.canLoadMore ? undefined : state.rows.length);
  // The tab already counts the files; above them the panel says only what the tab cannot: the reader's progress.
  const notices = (
    <>
      {/* Held empty until the Viewed marks answer, so the rows do not move when the count lands. */}
      {viewed === null ? null : <TriageChangedFilesProgress value={viewedCount === null ? null : total === undefined
        ? text('plugins.github.ui.filesViewedCount', '{viewed} viewed', { viewed: new Intl.NumberFormat(locale).format(viewedCount) })
        : text('plugins.github.ui.filesViewedOf', '{viewed} of {total} viewed', {
          viewed: new Intl.NumberFormat(locale).format(viewedCount), total: new Intl.NumberFormat(locale).format(total) })} />}
      <PageFailureBanner state={state} />
      {incomplete === null
        ? null
        // Known-incomplete is a rendered state, not a log line: a count that stops at a round
        // number with no explanation reads as a defect in this product rather than a limit of GitHub's.
        : <Banner tone="warning" title="This file list is incomplete" titleKey="plugins.github.ui.incompleteFiles" description={incomplete} />}
    </>
  );
  const more = state.canLoadMore || state.omittedRowCount > 0
    ? (
      <Stack gap="small">
        {state.omittedRowCount === 0
          ? null
          : (
            <Text
              variant="micro"
              tone="neutral"
              valueKey="plugins.github.ui.filesReadWithUnreadable"
              fallback="{count} changed file(s) read. {unreadable} row(s) on the pages read could not be understood."
              values={{ count: state.rows.length, unreadable: state.omittedRowCount }}
            />
          )}
        {state.canLoadMore
          ? (
            <Button
              title="Show more files"
              titleKey="plugins.github.ui.showMoreFiles"
              variant="secondary"
              busy={state.pending}
              onPress={loadMore}
            />
          )
          : null}
      </Stack>
    )
    : undefined;

  return (
    <GithubFilesList input={input} rows={state.rows} focusPath={focusPath} onFocusPath={onFocusPath}
      viewed={viewed} active={active} header={notices} endContent={more} />
  );
}

/* ----------------------------------------------------------------------- Checks */

/** What needs the reader leads: failed checks, then the ones still running, then the rest in GitHub's order. */
const CHECK_OUTCOME_RANK_V1: Readonly<Record<string, number>> = Object.freeze({ failed: 0, pending: 1 });
function orderGithubCheckRowsV1(rows: readonly GithubProjectedCheckRowV1[]): readonly GithubProjectedCheckRowV1[] {
  return rows
    .map((row, index) => ({ row, index, rank: CHECK_OUTCOME_RANK_V1[readGithubCheckOutcomeV1(row)] ?? 2 }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ row }) => row);
}

function ChecksBody({
  view,
  locale,
  nowMs,
  pending,
  onRefresh,
  onOpenRun,
  signal,
}: Readonly<{
  view: GithubChecksViewV1;
  locale: string;
  nowMs: number;
  pending: boolean;
  onRefresh: () => void;
  /** A check GitHub Actions ran opens its run in place (lab a8); others open in place as before. */
  onOpenRun: (target: GithubCheckActionsTargetV1) => void;
  signal: AbortSignal;
}>): React.ReactElement {
  // The page's one refresh re-reads the checks; this panel draws no refresh of its own.
  useTriagePageRefresh(pending ? undefined : onRefresh);
  const text = usePluginTranslation();
  const hostApi = usePluginHostApi();
  const { spacing } = usePluginTheme();
  const rows = React.useMemo(() => orderGithubCheckRowsV1(view.rows), [view.rows]);
  const rerun = useGithubChecksRerunV1(rows, onRefresh, signal);
  // Which checks are open in place. Failing checks lead the list; any row opens to what GitHub said about it.
  const [openKeys, setOpenKeys] = React.useState<ReadonlySet<string>>(() => new Set());
  const toggle = React.useCallback((key: string) => {
    setOpenKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);
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
      items={rows}
      keyForItem={(row) => row.key}
      header={(
        <Stack gap="small">
          {rerun.notice}
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
          {/* On the rows' text edge: the plugin row's own horizontal inset (`spacing.medium`). A text-only
              header has no control edge, so it keeps a row's breath before the first check. */}
          <Stack gap="xsmall" style={{ paddingHorizontal: spacing.medium, paddingBottom: spacing.small }}>
            <TriageChecksRollupLine latestCommit rollup={githubChecksRollupV1(view)} />
            <Text
              variant="micro"
              tone="secondary"
              valueKey="plugins.github.ui.readAgainstRevision"
              fallback="Read against {revision}."
              values={{ revision: view.headRevision.slice(0, 7) }}
            />
          </Stack>
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
                variant="micro"
                tone="neutral"
                valueKey="plugins.github.ui.checksNotListed"
                fallback="{count} further check(s) are not listed."
                values={{ count: view.omittedRowCount }}
              />
            )}
        </Stack>
      )}
      renderItem={(row) => {
        // The mark says the status; how long it ran is the row's meta, and when it finished sits under its name:
        // the two facts that tell a slow check from a stuck one.
        const ran = row.startedAtMs !== undefined && row.completedAtMs !== undefined && row.completedAtMs >= row.startedAtMs
          ? formatUsageDurationCompact(row.completedAtMs - row.startedAtMs, locale)
          : null;
        const when = row.completedAtMs === undefined ? null : formatTimestamp(locale, row.completedAtMs, 'relative', nowMs);
        const offer = rerun.offer(row);
        const quiet = quietRowActions(hostApi, text, {
          copyValue: row.name,
          ...(row.detailsUrl === undefined ? {} : { openUrl: row.detailsUrl }),
        });
        // A failed check's re-run is its next action, so it stands at the row's end; any other finished check
        // keeps its re-run in the row's quiet overflow.
        const rerunWorkflow = offer === 'all'
          ? [{ id: 'rerun', label: text('plugins.github.ui.checkRerunWorkflow', 'Re-run workflow') }]
          : [];
        return (
          <TriageStatusRow
            presentation="list"
            name={row.name}
            status={checkStatusText(text, row)}
            glyph={githubCheckStatusKindV1(row)}
            {...(ran === null ? {} : { detail: ran })}
            {...(when === null ? {} : { subtitle: when })}
            {...(offer === 'failed'
              ? {
                accessory: (
                  <IconButton
                    icon={<Icon name="refresh" size="small" />}
                    accessibilityLabel={text('plugins.github.ui.checkRerunFailed', 'Re-run failed jobs')}
                    busy={rerun.pendingKey === row.key}
                    onPress={() => rerun.rerun(row)}
                  />
                ),
              }
              : {})}
            {...(row.actions === undefined
              ? {
                expanded: openKeys.has(row.key),
                onPress: () => toggle(row.key),
                expandedContent: <GithubCheckDetails row={row} />,
              }
              : { onPress: () => onOpenRun(row.actions!) })}
            secondaryActions={[...rerunWorkflow, ...quiet.secondaryActions]}
            onSecondaryAction={(id) => { if (id === 'rerun') rerun.rerun(row); else quiet.onSecondaryAction(id); }}
          />
        );
      }}
    />
  );
}

/** What GitHub said about one check: its output summary (failing step, assertion), and where to read the whole log. */
function GithubCheckDetails({ row }: Readonly<{ row: GithubProjectedCheckRowV1 }>): React.ReactElement {
  const hostApi = usePluginHostApi();
  return (
    <Stack gap="small">
      {row.logExcerpt === undefined
        ? (
          <Text
            variant="micro"
            tone="secondary"
            valueKey="plugins.github.ui.checkNoSummary"
            fallback="GitHub has no summary for this check. Its full log is on GitHub."
          />
        )
        : <Markdown value={githubMarkdownDisplayText(row.logExcerpt)} />}
      {row.truncated === true
        ? (
          <Text
            variant="micro"
            tone="secondary"
            valueKey="plugins.github.ui.checkSummaryTruncated"
            fallback="This summary is shortened. The rest is on GitHub."
          />
        )
        : null}
      {row.detailsUrl === undefined
        ? null
        : (
          <Row>
            <Button
              title="Open on GitHub"
              titleKey="plugins.github.ui.openCheckOnGithub"
              variant="secondary"
              size="small"
              onPress={() => { void hostApi.openExternalLink(row.detailsUrl!); }}
            />
          </Row>
        )}
    </Stack>
  );
}

function ChecksPanel({
  locale,
  nowMs,
  signal,
}: Readonly<{
  locale: string;
  nowMs: number;
  signal: AbortSignal;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const controller = useGithubChecks();
  const checks: GithubReadStateV1<GithubChecksViewV1> = controller.state;
  // The run a check opened (lab a8); Back returns to the checks, which re-render from the retained read.
  const [drill, setDrill] = React.useState<GithubCheckActionsTargetV1 | null>(null);
  if (drill !== null) {
    return (
      <GithubChecksRunDrilldown
        target={drill}
        checksLabel={text('plugins.github.ci.backToChecks', 'Checks')}
        onBack={() => setDrill(null)}
        signal={signal}
      />
    );
  }

  if (checks.kind === 'loading') {
    return <LoadingState title="Reading the checks from GitHub" titleKey="plugins.github.ui.readingChecks" />;
  }
  if (checks.kind === 'unavailable') {
    return (
      <GithubReadFailure
        title="The checks are unavailable"
        titleKey="plugins.github.ui.checksUnavailable"
        failures={[checks.failure]}
        refresh={controller.refresh}
      />
    );
  }
  return (
    <ChecksBody
      view={checks.value}
      locale={locale}
      nowMs={nowMs}
      pending={controller.pending}
      onRefresh={controller.refresh}
      onOpenRun={setDrill}
      signal={signal}
    />
  );
}

/* --------------------------------------------------------------------- Comments */


/* --------------------------------------------------------------- remark editing */

/**
 * A person's own writes into one mounted conversation stream: which remark is open for editing,
 * what GitHub answered each saved edit with, and the comments they posted here.
 *
 * Each answer is shown only until the stream's own read carries it: a saved edit while the stream
 * still holds the text it replaced, a posted comment while no read row has its id. No re-read
 * follows a write and no second row store exists; the readers keep their rows.
 */
type GithubRemarkEditsV1 = Readonly<{
  editingId: string | null;
  begin: (id: string) => void;
  end: () => void;
  shown: (id: string, readBody: string) => string;
  saved: (id: string, replaced: string, body: string) => void;
  posted: (comment: GithubFeedbackCommentV1) => void;
  /** The read rows followed by this person's posted comments the read does not hold yet. */
  withPosted: (rows: readonly GithubFeedbackCommentV1[]) => readonly GithubFeedbackCommentV1[];
  /** The one review whose dismiss or submit form is open in place of its words. */
  reviewForm: Readonly<{ id: string; form: 'dismiss' | 'submit' }> | null;
  openReview: (id: string, form: 'dismiss' | 'submit') => void;
  closeReview: () => void;
}>;

function useGithubRemarkEdits(): GithubRemarkEditsV1 {
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [savedEdits, setSavedEdits] = React.useState<
    ReadonlyMap<string, Readonly<{ replaced: string; body: string }>>
  >(() => new Map());
  const [postedComments, setPostedComments] = React.useState<readonly GithubFeedbackCommentV1[]>([]);
  const [reviewForm, setReviewForm] = React.useState<GithubRemarkEditsV1['reviewForm']>(null);
  return React.useMemo(() => ({
    reviewForm,
    openReview: (id: string, form: 'dismiss' | 'submit') => setReviewForm({ id, form }),
    closeReview: () => setReviewForm(null),
    editingId,
    begin: setEditingId,
    end: () => setEditingId(null),
    shown: (id, readBody) => {
      const edit = savedEdits.get(id);
      return edit !== undefined && edit.replaced === readBody ? edit.body : readBody;
    },
    saved: (id, replaced, body) => setSavedEdits((current) => new Map(current).set(id, { replaced, body })),
    posted: (comment) => setPostedComments((current) => [...current, comment]),
    withPosted: (rows) => {
      if (postedComments.length === 0) return rows;
      const read = new Set(rows.map((row) => row.id));
      const unread = postedComments.filter((comment) => !read.has(comment.id));
      return unread.length === 0 ? rows : [...rows, ...unread];
    },
  }), [editingId, postedComments, reviewForm, savedEdits]);
}

/** What an editable remark needs from its stream: the edit owner and the write's entry. */
type GithubRemarkEditContextV1 = Readonly<{
  edits: GithubRemarkEditsV1;
  input: TriageDetailSurfaceInputV1;
  onObserved: GithubObservedEntryHandlerV1;
}>;

/** The inline editor that replaces a remark's text while it is open. Save is the confirmed write. */
function GithubRemarkEditor({
  context,
  target,
  body,
}: Readonly<{
  context: GithubRemarkEditContextV1;
  target: Readonly<{ kind: GithubCommentEditTargetKindV1; id: string }>;
  body: string;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const { edits, input, onObserved } = context;
  const [draft, setDraft] = React.useState(body);
  const label = target.kind === 'review'
    ? text('plugins.github.ui.commentEdit.reviewLabel', 'Review summary')
    : text('plugins.github.ui.commentEdit.label', 'Comment');
  const write = useGithubWrite(GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.commentEdit, parseCommentEditResult, onObserved);
  const payload = draft === body ? null : buildGithubCommentEditInputV1(input, target, draft);
  const onApplied = (result: GithubMutationResultV1): void => {
    if (result.kind === 'applied' && 'comment' in result) {
      edits.saved(target.id, body, result.comment.body);
      edits.end();
    }
  };
  return (
    <Stack gap="small">
      <Form.Field label={label}>
        <MarkdownEditor accessibilityLabel={label} value={draft} onChange={setDraft} disabled={write.pending} />
      </Form.Field>
      <Row gap="small">
        <Action.Control
          action={write.action}
          controller={write.controllerFor(payload, onApplied)}
          title="Save"
          titleKey="plugins.github.ui.commentEdit.save"
          variant="secondary"
          disabled={payload === null || write.pending}
        />
        <Button
          title="Cancel"
          titleKey="plugins.github.ui.commentEdit.cancel"
          variant="plain"
          disabled={write.pending}
          onPress={edits.end}
        />
      </Row>
      {write.outcome === null || write.outcome.kind === 'applied' ? null : <WriteOutcome outcome={write.outcome} />}
    </Stack>
  );
}

/** The quiet Edit control beside a remark GitHub lets this viewer change. */
function GithubRemarkEditButton({ edits, id, item }: Readonly<{
  edits: GithubRemarkEditsV1;
  id: string;
  item: string;
}>): React.ReactElement {
  const text = usePluginTranslation();
  return (
    <IconButton
      icon={<Icon name="edit" tone="secondary" size="small" />}
      accessibilityLabel={text('plugins.github.ui.commentEdit.editItem', 'Edit {item}', { item })}
      onPress={() => edits.begin(id)}
    />
  );
}

const GITHUB_COMMENT_CREATE_ACTION = Object.freeze({
  pluginId: GITHUB_PLUGIN_ID,
  localId: GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.commentCreate,
});

/** GitHub's comment-create result in the shared write vocabulary; the posted comment rides on `applied`. */
function readGithubCommentCreateSettlementV1(value: unknown): TriageSourceWriteSettlementV1 {
  const parsed = GithubCommentCreateResultV1Schema.safeParse(value);
  if (!parsed.success) return { kind: 'uncertain' };
  switch (parsed.data.kind) {
    case 'applied': return { kind: 'applied', result: parsed.data };
    case 'uncertain': return { kind: 'uncertain' };
    case 'failed': return { kind: 'failed', failure: parsed.data.failure };
  }
}

/**
 * The comment box at the end of a conversation, as GitHub places it: the shared source comment composer, bound to
 * GitHub's comment Action, its capability answer and its posted-comment handoff.
 */
function GithubCommentComposer({
  context,
  capabilities,
}: Readonly<{
  context: GithubRemarkEditContextV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const { edits, input } = context;
  const buildInput = React.useCallback((body: string) => buildGithubCommentCreateInputV1(input, body), [input]);
  const onPublished = React.useCallback((result: unknown) => {
    const parsed = GithubCommentCreateResultV1Schema.safeParse(result);
    if (!parsed.success || parsed.data.kind !== 'applied') return;
    const comment = parsed.data.comment;
    edits.posted(Object.freeze({
      id: comment.id,
      body: comment.body,
      author: comment.author ?? null,
      createdAtMs: comment.createdAtMs ?? null,
      url: comment.url ?? null,
      editable: true as const,
    }));
  }, [edits]);
  const webUrl = input.observation.locator.webUrl;
  return (
    <TriageSourceCommentComposer
      action={GITHUB_COMMENT_CREATE_ACTION}
      buildInput={buildInput}
      sourceName="GitHub"
      {...(webUrl === undefined ? {} : { sourceUrl: webUrl })}
      readResult={readGithubCommentCreateSettlementV1}
      unavailableReason={githubOperationCapabilityReason(text, capabilities, 'commentCreate')}
      onPublished={onPublished}
    />
  );
}

function parseReviewMutationResult(value: unknown): GithubMutationResultV1 | null {
  const parsed = GithubPullRequestReviewMutationResultV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A summary stays in this open form until the confirmed Action creates GitHub's pending review. */
function GithubPendingReviewCreateWrite({ context }: Readonly<{
  context: GithubFeedbackWriteContextV1;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const [summary, setSummary] = React.useState('');
  const write = useGithubWrite(GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pendingReviewCreate,
    parseReviewMutationResult, context.onObserved);
  const title = text('plugins.github.ui.review.start', 'Start a review');
  const reason = githubOperationCapabilityReason(text, context.capabilities, 'pendingReviewCreate');
  if (reason !== null) return <UnavailableOperationWrite title={title} reason={reason} />;
  if (write.outcome?.kind === 'applied') return <WriteOutcome outcome={write.outcome} />;
  const payload = buildGithubPendingReviewCreateInputV1(context.input, summary);
  return <GithubPropertyRow title={title}>
    <Form.Field label={text('plugins.github.ui.review.summaryOptional', 'Summary (optional)')}>
      <MarkdownEditor accessibilityLabel={text('plugins.github.ui.review.summaryOptional', 'Summary (optional)')}
        value={summary} onChange={setSummary} disabled={write.pending} />
    </Form.Field>
    <Action.Control action={write.action} controller={write.controllerFor(payload)}
      title={text('plugins.github.ui.review.startReview', 'Start review')} variant="secondary"
      disabled={payload === null || write.pending} />
    {write.outcome === null ? null : <WriteOutcome outcome={write.outcome} />}
  </GithubPropertyRow>;
}

/**
 * A review's own lifecycle, beside its words as github.com keeps it: a submitted approval or change request can be
 * dismissed (with a reason); the viewer's pending review can be submitted or deleted. A comment review has neither.
 */
function GithubReviewLifecycleActions({ context, reviewId, state, item }: Readonly<{
  context: GithubRemarkEditContextV1;
  reviewId: string;
  state: string;
  item: string;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  const normalized = state.trim().toUpperCase();
  const remove = useGithubWrite(GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pendingReviewDelete, parseReviewMutationResult, context.onObserved);
  if (normalized === 'APPROVED' || normalized === 'CHANGES_REQUESTED') {
    return (
      <Button title="Dismiss" titleKey="plugins.github.ui.review.dismiss" variant="plain"
        accessibilityLabel={text('plugins.github.ui.review.dismissItem', 'Dismiss {item}', { item })}
        onPress={() => context.edits.openReview(reviewId, 'dismiss')} />
    );
  }
  if (normalized !== 'PENDING') return null;
  const payload = buildGithubPendingReviewDeleteInputV1(context.input, reviewId);
  return (
    <Row gap="small">
      <Button title="Submit" titleKey="plugins.github.ui.review.submit" variant="plain"
        accessibilityLabel={text('plugins.github.ui.review.submitItem', 'Submit {item}', { item })}
        onPress={() => context.edits.openReview(reviewId, 'submit')} />
      <Action.Control action={remove.action} controller={remove.controllerFor(payload)}
        title="Delete draft review" titleKey="plugins.github.ui.review.deleteDraft" variant="plain"
        disabled={payload === null || remove.pending} />
      {remove.outcome === null || remove.outcome.kind === 'applied' ? null : <WriteOutcome outcome={remove.outcome} />}
    </Row>
  );
}

/** The dismiss reason or the pending review's verdict, open in place of the review's words until it settles. */
function GithubReviewLifecycleForm({ context, reviewId, form }: Readonly<{
  context: GithubRemarkEditContextV1;
  reviewId: string;
  form: 'dismiss' | 'submit';
}>): React.ReactElement {
  const text = usePluginTranslation();
  const [message, setMessage] = React.useState('');
  const messageLabel = form === 'dismiss'
    ? text('plugins.github.ui.review.dismissReason', 'Reason for dismissing')
    : text('plugins.github.ui.review.summaryOptional', 'Summary (optional)');
  const [verdict, setVerdict] = React.useState<GithubPullRequestReviewVerdictV1 | null>(null);
  const write = useGithubWrite(form === 'dismiss'
    ? GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.reviewDismiss
    : GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pendingReviewSubmit, parseReviewMutationResult, context.onObserved);
  const payload = form === 'dismiss'
    ? buildGithubReviewDismissInputV1(context.input, reviewId, message)
    : verdict === null ? null : buildGithubPendingReviewSubmitInputV1(context.input, reviewId, verdict, message);
  const onApplied = (): void => context.edits.closeReview();
  return (
    <Stack gap="small">
      {form === 'submit' ? (
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
          {...(verdict === null ? {} : { value: verdict })}
          onChange={(value) => {
            const next = GITHUB_REVIEW_VERDICTS_V1.find((candidate) => candidate === value);
            if (next !== undefined) setVerdict(next);
          }}
          disabled={write.pending}
        />
      ) : null}
      <Form.Field label={messageLabel}>
        <MarkdownEditor accessibilityLabel={messageLabel} value={message} onChange={setMessage} disabled={write.pending} />
      </Form.Field>
      <Row gap="small">
        <Action.Control action={write.action} controller={write.controllerFor(payload, onApplied)}
          title={form === 'dismiss' ? 'Dismiss review' : 'Submit review'}
          titleKey={form === 'dismiss' ? 'plugins.github.ui.review.dismissReview' : 'plugins.github.ui.review.submitReview'}
          variant="secondary" disabled={payload === null || write.pending} />
        <Button title="Cancel" titleKey="plugins.github.ui.commentEdit.cancel" variant="plain"
          disabled={write.pending} onPress={context.edits.closeReview} />
      </Row>
      {write.outcome === null || write.outcome.kind === 'applied' ? null : <WriteOutcome outcome={write.outcome} />}
    </Stack>
  );
}

/** A remark as one Activity event: its author's mark, the verb, and its own words quoted. */
function remarkEvent(text: PluginTranslate, remark: Readonly<{
  id: string;
  atMs: number | null;
  author: string | null;
  body: string;
  webUrl: string | null;
  kind: 'comment' | 'review';
  summary: string;
  /** Present when GitHub lets this viewer edit the remark and its whole body was read. */
  edit?: Readonly<{ context: GithubRemarkEditContextV1; target: GithubCommentEditTargetKindV1 }>;
  /** A review's own lifecycle: dismissing a submitted verdict, or submitting or deleting a pending one. */
  review?: Readonly<{ context: GithubRemarkEditContextV1; state: string }>;
}>): TriageActivityEventV1 {
  const actor = remark.author ?? text('plugins.github.ui.someone', 'Someone');
  const item = `${actor} · ${remark.summary}`;
  const edit = remark.edit;
  const body = edit === undefined ? remark.body : edit.context.edits.shown(remark.id, remark.body);
  const editing = edit !== undefined && edit.context.edits.editingId === remark.id;
  const review = remark.review;
  const reviewForm = review !== undefined && review.context.edits.reviewForm?.id === remark.id
    ? review.context.edits.reviewForm.form : null;
  const reviewActions = review === undefined || reviewForm !== null || editing ? null
    : <GithubReviewLifecycleActions context={review.context} reviewId={remark.id} state={review.state} item={item} />;
  const editAction = edit === undefined || editing || reviewForm !== null ? null
    : <GithubRemarkEditButton edits={edit.context.edits} id={remark.id} item={item} />;
  return {
    id: remark.id,
    atMs: remark.atMs,
    kind: remark.kind,
    actor,
    summary: remark.summary,
    ...(editing
      ? {
        inset: (
          <GithubRemarkEditor
            context={edit.context}
            target={{ kind: edit.target, id: remark.id }}
            body={body}
          />
        ),
      }
      : review !== undefined && reviewForm !== null
        ? { inset: <GithubReviewLifecycleForm context={review.context} reviewId={remark.id} form={reviewForm} /> }
      : body === ''
        ? remark.kind === 'comment'
          ? { detail: text('plugins.github.ui.commentNoText', 'This comment carries no text.') }
          : {}
        : { quote: <GithubOverviewMarkdown body={body} /> }),
    ...(editAction === null && reviewActions === null
      ? {}
      : { actions: reviewActions === null ? editAction! : <Row gap="small">{editAction}{reviewActions}</Row> }),
    href: remark.webUrl,
    hrefLabel: text('plugins.github.ui.openOnGithub', 'Open {item} on GitHub', { item }),
  };
}

/** One reply inside a line review conversation, under that conversation's Activity event. */
function ThreadReplyRow({
  reply,
  locale,
  nowMs,
  editContext,
}: Readonly<{
  reply: import('../triage/feedback.js').GithubFeedbackCommentV1;
  locale: string;
  nowMs: number;
  editContext?: GithubRemarkEditContextV1;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const author = reply.author ?? text('plugins.github.ui.someone', 'Someone');
  const edit = reply.editable === true && reply.truncated !== true ? editContext : undefined;
  const body = edit === undefined ? reply.body : edit.edits.shown(reply.id, reply.body);
  const editing = edit !== undefined && edit.edits.editingId === reply.id;
  return (
    <Stack gap="small">
      <Row gap="small">
        <Text variant="micro">{author}</Text>
        {reply.createdAtMs === null
          ? null
          : (
            <Text variant="micro" tone="neutral">
              {formatTimestamp(locale, reply.createdAtMs, 'relative', nowMs)}
            </Text>
          )}
        {reply.url === null
          ? null
          : (
            <Action.OpenExternal
              url={reply.url}
              variant="plain"
              accessibilityLabel={text(
                'plugins.github.ui.openOnGithub',
                'Open {item} on GitHub',
                { item: author },
              )}
            />
          )}
        {edit === undefined || editing
          ? null
          : <GithubRemarkEditButton edits={edit.edits} id={reply.id} item={author} />}
      </Row>
      {editing
        ? <GithubRemarkEditor context={edit} target={{ kind: 'review-comment', id: reply.id }} body={body} />
        : body === ''
        ? (
          <Text
            variant="micro"
            tone="neutral"
            valueKey="plugins.github.ui.commentNoText"
            fallback="This comment carries no text."
          />
        )
        : <GithubOverviewMarkdown body={body} />}
    </Stack>
  );
}

function useGithubCommentsStream(
  input: TriageDetailSurfaceInputV1,
  onObserved: GithubObservedEntryHandlerV1,
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>,
): GithubActivityStreamV1 {
  const text = usePluginTranslation();
  const controller = useGithubFeedbackComments();
  const edits = useGithubRemarkEdits();
  const editContext = React.useMemo(() => ({ edits, input, onObserved }), [edits, input, onObserved]);
  const { state } = controller;
  const incomplete = incompleteDescription(text, state.incomplete, null);
  const commented = text(githubTimelineHeadlineKey('commented'), GITHUB_TIMELINE_HEADLINES_V1['commented'] ?? 'Commented');
  return {
    settling: state.kind === 'idle' || state.kind === 'loading',
    unavailable: state.kind === 'unavailable'
      ? { title: 'The conversation is unavailable', titleKey: 'plugins.github.ui.conversationUnavailable', failure: state.failure }
      : null,
    failedReads: [{ failure: state.failure, refresh: controller.refresh }],
    header: <PageFailureBanner state={state} />,
    events: edits.withPosted(state.rows).map((row) => remarkEvent(text, {
      id: row.id,
      atMs: row.createdAtMs,
      author: row.author,
      body: row.body,
      webUrl: row.url,
      kind: 'comment',
      summary: commented,
      ...(row.editable === true && row.truncated !== true
        ? { edit: { context: editContext, target: 'issue-comment' as const } }
        : {}),
    })),
    continuations: state.canLoadMore
      ? [{
        key: 'comments',
        title: 'Show 40 earlier comments',
        titleKey: 'plugins.github.ui.showEarlierIssueComments',
        pending: state.pending,
        onLoadMore: controller.loadMore,
        reads: 'earlier',
      }]
      : [],
    composer: <GithubCommentComposer context={editContext} capabilities={capabilities} />,
    summary: (
      <Stack gap="small">
        {state.omittedRowCount === 0 ? null : <Text
          variant="micro"
          tone="neutral"
          valueKey="plugins.github.ui.commentsReadWithUnreadable"
          fallback="{count} comment(s) read. {unreadable} row(s) on the pages read could not be understood."
          values={{ count: state.rows.length, unreadable: state.omittedRowCount }}
        />}
        {state.projectionTruncated
          ? (
            <Text
              variant="micro"
              tone="neutral"
              valueKey="plugins.github.ui.commentsShortened.description"
              fallback="Some comments were shortened. Open the entry on GitHub to read them in full."
            />
          )
          : null}
        {incomplete === null ? null : <Text variant="micro" tone="neutral">{incomplete}</Text>}
      </Stack>
    ),
    refresh: controller.refresh,
    pending: state.pending,
    empty: (
      <EmptyState
        title="No comments yet"
        titleKey="plugins.github.ui.noComments"
      />
    ),
  };
}

function CommentsPanel({
  input,
  locale,
  nowMs,
  onObserved,
  capabilities,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  locale: string;
  nowMs: number;
  onObserved: GithubObservedEntryHandlerV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
}>): React.ReactElement {
  const comments = useGithubCommentsStream(input, onObserved, capabilities);
  return (
    <GithubActivityView
      streams={[comments]}
      locale={locale}
      nowMs={nowMs}
      accessibilityLabel="Comments on this GitHub entry"
      accessibilityLabelKey="plugins.github.ui.commentsLabel"
      loadingTitle="Reading this conversation from GitHub"
      loadingTitleKey="plugins.github.ui.readingConversation"
      refreshLabel="Re-read this conversation from GitHub"
      refreshLabelKey="plugins.github.ui.rereadConversation"
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

/**
 * Who reviewed, with GitHub's state and when, as Activity's first entry: it scrolls away with the stream. Who is
 * still awaited is said once: by the Overview's facts and the rail's own request event (lab c7).
 */
function githubReviewPeopleLead(
  text: PluginTranslate,
  people: GithubFeedbackReviewPeopleV1,
  locale: string,
  nowMs: number,
): TriageActivityLeadV1 | undefined {
  if (people.reviewed.length === 0) return undefined;
  const reviewed: readonly MetadataEntry[] = people.reviewed.map((reviewer) => ({
    label: reviewer.login,
    value: reviewer.submittedAtMs === undefined
      ? reviewStateText(text, reviewer.state)
      : `${reviewStateText(text, reviewer.state)} · ${formatTimestamp(locale, reviewer.submittedAtMs, 'relative', nowMs)}`,
  }));
  return {
    icon: 'review',
    heading: <Text variant="label" valueKey="plugins.github.ui.reviewedBy" fallback="Reviewed" />,
    body: <Metadata entries={reviewed} />,
  };
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

type GithubFeedbackWriteContextV1 = Readonly<{
  input: TriageDetailSurfaceInputV1;
  locale: string;
  nowMs: number;
  onObserved: GithubObservedEntryHandlerV1;
  publicationProposals: ReviewCommentProposalReadV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
}>;

/** The write context plus the stream's one remark-edit owner, which thread replies share. */
type GithubFeedbackEventContextV1 = GithubFeedbackWriteContextV1 & Readonly<{
  editContext: GithubRemarkEditContextV1;
}>;

/** One feedback finding as one Activity event; a line conversation keeps its replies and controls under it. */
function feedbackFindingEvent(
  text: PluginTranslate,
  finding: GithubFeedbackFindingV1,
  context: GithubFeedbackEventContextV1,
): TriageActivityEventV1 {
  if (finding.resource === 'comment') {
    return remarkEvent(text, {
      id: finding.id,
      atMs: finding.atMs,
      author: finding.author,
      body: finding.body,
      webUrl: finding.webUrl,
      kind: 'comment',
      summary: text(githubTimelineHeadlineKey('commented'), GITHUB_TIMELINE_HEADLINES_V1['commented'] ?? 'Commented'),
      ...(finding.editable ? { edit: { context: context.editContext, target: 'issue-comment' as const } } : {}),
    });
  }
  if (finding.resource === 'review') {
    return remarkEvent(text, {
      id: finding.id,
      atMs: finding.atMs,
      author: finding.author ?? text('plugins.github.ui.unknownAuthor', 'Unknown author'),
      body: finding.body,
      webUrl: finding.webUrl,
      kind: 'review',
      summary: reviewStateText(text, finding.state),
      ...(finding.editable ? { edit: { context: context.editContext, target: 'review' as const } } : {}),
      review: { context: context.editContext, state: finding.state },
    });
  }
  if (finding.resource === 'thread') {
    const location = threadLocation(text, finding);
    return {
      id: finding.id,
      atMs: finding.atMs,
      kind: 'review',
      actor: finding.firstReply?.author ?? null,
      summary: location,
      detail: finding.isResolved
        ? text('plugins.github.ui.threadResolved', 'Resolved')
        : text('plugins.github.ui.threadUnresolved', 'Unresolved'),
      tone: finding.isResolved ? 'neutral' : 'warning',
      inset: <ThreadFindingInset finding={finding} context={context} />,
    };
  }
  const copy = FINDING_STATE_COPY[finding.kind];
  return {
    id: `${finding.resource}:${finding.id}`,
    atMs: finding.atMs,
    kind: 'check',
    // GitHub's own words for the state, kept as the provider fact they are.
    summary: finding.label,
    detail: text(copy.key, copy.fallback),
    tone: finding.tone,
  };
}

type GithubThreadFindingV1 = Extract<GithubFeedbackFindingV1, { resource: 'thread' }>;

function threadLocation(text: PluginTranslate, finding: GithubThreadFindingV1): string {
  return finding.path === null
    ? text('plugins.github.ui.reviewThread', 'Review conversation')
    : finding.line === null ? finding.path : `${finding.path}:${finding.line}`;
}

/** A line conversation's own content under its event: replies, earlier replies, and its two writes. */
function ThreadFindingInset({
  finding,
  context,
}: Readonly<{ finding: GithubThreadFindingV1; context: GithubFeedbackEventContextV1 }>): React.ReactElement {
  const { platform } = useSurfaceContext();
  const mobile = platform === 'ios' || platform === 'android';
  return finding.previousRepliesCursor === null || mobile
    ? <ThreadFeedbackFinding finding={finding} mobile={mobile} {...context} />
    : <PagedThreadFeedbackFinding finding={finding} firstCursor={finding.previousRepliesCursor} {...context} />;
}

function ThreadFeedbackFinding({
  input,
  finding,
  earlierReplies = [],
  mobile = false,
  loadMore,
  pending = false,
  locale,
  nowMs,
  onObserved,
  publicationProposals,
  capabilities,
  editContext,
}: GithubFeedbackEventContextV1 & Readonly<{
  finding: GithubThreadFindingV1;
  earlierReplies?: GithubThreadFindingV1['replies'];
  mobile?: boolean;
  loadMore?: () => void;
  pending?: boolean;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const location = threadLocation(text, finding);
  const nextResolved = !finding.isResolved;
  const payload = buildGithubPullRequestThreadResolutionInputV1(
    input,
    finding.id,
    nextResolved,
  );
  const action = nextResolved
    ? text('plugins.github.ui.mutations.thread.resolve', 'Resolve conversation')
    : text('plugins.github.ui.mutations.thread.reopen', 'Reopen conversation');
  const visibleReplies = mobile
    ? finding.firstReply === null ? [] : [finding.firstReply]
    : orderGithubFeedbackReplies([...earlierReplies, ...finding.replies]);
  return (
      <Stack gap="small">
        {visibleReplies.map((reply) => (
          <ThreadReplyRow key={reply.id} reply={reply} locale={locale} nowMs={nowMs} editContext={editContext} />
        ))}
        {mobile
          ? (
            <Text
              variant="micro"
              tone="neutral"
              valueKey="plugins.github.ui.threadReplyCount"
              fallback="{count} replies"
              values={{ count: finding.replyCount }}
            />
          )
          : loadMore === undefined
            ? null
            : <Button title="Load earlier replies" titleKey="plugins.github.ui.loadEarlierReplies" variant="secondary" busy={pending} onPress={loadMore} />}
        <ExactWrite
          localId={GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestThreadResolution}
          payload={payload}
          title={`${action} at ${location}`}
          titleKey={nextResolved
            ? 'plugins.github.ui.mutations.thread.resolve'
            : 'plugins.github.ui.mutations.thread.reopen'}
          parseResult={parseThreadResolutionResult}
          onObserved={onObserved}
          capabilities={capabilities}
          operation="pullRequestThreadResolution"
        />
        <GithubSuggestionApply input={input}
          suggestions={visibleReplies.flatMap((reply) => reply.suggestions ?? [])} />
        <SingleProposalPublicationWrite
          input={input}
          proposals={publicationProposals.proposals}
          proposalRead={publicationProposals.status}
          kind="thread-reply"
          threadId={finding.id}
          onObserved={onObserved}
          capabilities={capabilities}
        />
      </Stack>
  );
}

const GITHUB_SUGGESTION_REFUSAL_COPY: Readonly<Record<string, Readonly<{ key: string; fallback: string }>>> = Object.freeze({
  suggestion_conflict: { key: 'plugins.github.ui.suggestion.conflict', fallback: 'the Session\'s copy no longer matches this suggestion' },
  suggestion_outdated: { key: 'plugins.github.ui.suggestion.outdated', fallback: 'the file changed since this suggestion' },
  invalid_path: { key: 'plugins.github.ui.suggestion.invalidPath', fallback: 'the file is outside this Session\'s checkout' },
  file_replace_failed: { key: 'plugins.github.ui.suggestion.writeFailed', fallback: 'the file could not be written' },
});

/**
 * GitHub's "Apply suggestion", done where the code is: the conversation's suggestions applied to a Session linked to
 * this pull request, without committing. Each file reports its own answer (applied, conflict, outdated). With no
 * linked Session there is nowhere to apply them here; Open on GitHub stays on each comment.
 */
function GithubSuggestionApply({ input, suggestions }: Readonly<{
  input: TriageDetailSurfaceInputV1;
  suggestions: readonly ScmSuggestionV1[];
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  const sessions = input.linkedSessions;
  const [chosen, setChosen] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [answer, setAnswer] = React.useState<Readonly<{ tone: 'success' | 'warning' | 'danger'; label: string }> | null>(null);
  if (suggestions.length === 0) return null;
  if (sessions.length === 0) {
    return <Text variant="micro" tone="neutral" value={text('plugins.github.ui.suggestion.noSession',
      'Link a Session to this pull request to apply these suggestions in it.')} />;
  }
  const session = sessions.length === 1 ? sessions[0] : sessions.find((candidate) => candidate.sessionId === chosen);
  const sessionTitle = (candidate: TriageLinkedSessionProjectionV1) => candidate.displayTitle
    ?? text('plugins.github.ui.linkedSession', 'Session');
  const settle: import('@happier-dev/plugin-sdk/ui').PluginUiActionControlController['onSettled'] = (execution) => {
    try {
      const projected = projectPluginActionControlExecutionV1(execution, text);
      if (isPluginActionConfirmationDeclined(projected) || projected.status === 'pending') return;
      const parsed = ScmSuggestionApplyResponseSchema.safeParse(
        execution.ok ? execution.result : null,
      );
      if (!parsed.success) {
        setAnswer({ tone: 'warning', label: text('plugins.github.ui.suggestion.unknown', 'Check the Session\'s changes to see what was applied.') });
        return;
      }
      const applied = parsed.data.files.filter((file) => file.status === 'applied').length;
      const refused = parsed.data.files.flatMap((file) => file.status === 'refused' ? [`${file.path}: ${text(
        GITHUB_SUGGESTION_REFUSAL_COPY[file.errorCode]?.key ?? 'plugins.github.ui.suggestion.writeFailed',
        GITHUB_SUGGESTION_REFUSAL_COPY[file.errorCode]?.fallback ?? 'the file could not be written')}.`] : []);
      setAnswer({
        tone: refused.length === 0 ? 'success' : applied === 0 ? 'danger' : 'warning',
        label: [text('plugins.github.ui.suggestion.applied', 'Applied {applied} of {total} files.', {
          applied: String(applied), total: String(parsed.data.files.length) }), ...refused].join(' '),
      });
    } catch {
      setAnswer({ tone: 'warning', label: text('plugins.github.ui.suggestion.unknown', 'Check the Session\'s changes to see what was applied.') });
    } finally {
      setPending(false);
    }
  };
  return (
    <Stack gap="small">
      {sessions.length > 1 ? (
        <Form.Select
          label={text('plugins.github.ui.suggestion.session', 'Apply in')}
          options={sessions.map((candidate) => ({ value: candidate.sessionId, label: sessionTitle(candidate) }))}
          {...(chosen === null ? {} : { value: chosen })}
          onChange={(value) => setChosen(sessions.find((candidate) => candidate.sessionId === value)?.sessionId ?? null)}
          disabled={pending}
        />
      ) : null}
      <Row gap="small">
        <Action.Control action="scm.suggestion.apply"
          title={text('plugins.github.ui.suggestion.apply', 'Apply {count} suggestions in {session}', {
            count: String(suggestions.length),
            session: session === undefined ? text('plugins.github.ui.linkedSession', 'Session') : sessionTitle(session),
          })}
          variant="secondary" disabled={session === undefined || pending}
          controller={{ prepare() {
            if (session === undefined || pending) return null;
            setPending(true); setAnswer(null);
            return { input: { sessionId: session.sessionId, suggestions: [...suggestions] } };
          }, onSettled: settle }} />
      </Row>
      {answer === null ? null : <Status tone={answer.tone} label={answer.label} />}
    </Stack>
  );
}

function PagedThreadFeedbackFinding({
  finding,
  firstCursor,
  ...context
}: GithubFeedbackEventContextV1 & Readonly<{
  finding: GithubThreadFindingV1;
  firstCursor: string;
}>): React.ReactElement {
  const replies = useGithubFeedbackThreadReplies(context.input, finding.id, firstCursor);
  const text = usePluginTranslation();
  const loadMore = useTriageSourcePanelPagingV1(`thread-replies:${finding.id}`, text('plugins.github.ui.loadEarlierReplies', 'Load earlier replies'),
    replies.state.canLoadMore, replies.state.pending, replies.loadMore);
  return (
    <Stack gap="small">
      <ThreadFeedbackFinding
        finding={finding}
        earlierReplies={replies.state.rows}
        {...(replies.state.canLoadMore ? { loadMore } : {})}
        pending={replies.state.pending}
        {...context}
      />
      <PageFailureBanner state={replies.state} />
    </Stack>
  );
}

/**
 * The `Feedback` read: what is being said about this pull request, who has
 * signed off, who is still being waited on, and what GitHub reports as wrong.
 *
 * It composes the conversation walk with the canonical reviews and checks
 * reads. They settle independently: one failing leaves the other answers on
 * screen beside a banner naming exactly what could not be read.
 */
function useGithubFeedbackStream(context: GithubFeedbackWriteContextV1): GithubActivityStreamV1 {
  const { input, locale, nowMs } = context;
  const text = usePluginTranslation();
  const conversation = useGithubFeedbackComments();
  const threads = useGithubFeedbackThreads();
  const reviews = useGithubFeedbackReviews();
  const requests = useGithubFeedbackRequests();
  const checks = useGithubChecks();
  const edits = useGithubRemarkEdits();
  const { onObserved } = context;
  const eventContext: GithubFeedbackEventContextV1 = { ...context, editContext: { edits, input, onObserved } };
  const { observation } = input;
  const currentChecks = checks.state.kind === 'ready'
    ? checks.state.value.rowState ?? null
    : null;
  /**
   * The checks read SUCCEEDED and still did not list the whole suite.
   *
   * It is neither a failed connection nor a settled verdict, and the canonical
   * checks projection already withholds the rollup for exactly this reason. This
   * plane owes the reader the same fact: the unread part of the suite is where a
   * failure it never saw would be.
   */
  const checksKnownIncomplete = checks.state.kind === 'ready'
    && checks.state.value.state === 'knownIncomplete';
  const view: GithubFeedbackViewV1 = React.useMemo(
    () => projectGithubFeedback({
      facts: observation.snapshot.facts,
      observedAtMs: observation.observedAtMs,
      comments: edits.withPosted(conversation.state.rows),
      historicalReviews: reviews.state.rows,
      threads: threads.state.rows,
      reviewDecision: reviews.reviewDecision,
      requests: requests.state.rows,
      checks: currentChecks,
    }),
    [checks.state, conversation.state.rows, edits, observation, requests.state.rows,
      reviews.reviewDecision, reviews.state.rows, threads.state.rows],
  );

  // Publish the first combined rail after all its initial reads answer. Warm
  // refreshes retain ready rows in their readers and do not enter this state.
  const settling = conversation.state.kind === 'idle' || conversation.state.kind === 'loading'
    || reviews.state.kind === 'idle' || reviews.state.kind === 'loading'
    || threads.state.kind === 'idle' || threads.state.kind === 'loading'
    || requests.state.kind === 'idle' || requests.state.kind === 'loading'
    || checks.state.kind === 'loading';
  // Cold: no read answered, so there is no content to keep and nothing
  // honest to say beyond that we could not look.
  const cold = conversation.state.kind === 'unavailable'
    && threads.state.kind === 'unavailable'
    && reviews.state.kind === 'unavailable'
    && requests.state.kind === 'unavailable'
    && checks.state.kind === 'unavailable';

  const readFailed = text(
    'plugins.github.ui.readFailed',
    'GitHub could not complete this read.',
  );
  // Each connection names ITSELF. "Something failed" over a partial plane leaves
  // the reader unable to tell which half of the picture they are missing.
  const reviewsFailure = reviews.state.failure;
  const threadsFailure = threads.state.failure;
  const requestsFailure = requests.state.failure;
  const checksFailure = checks.failure ?? (checks.state.kind === 'unavailable'
    ? checks.state.failure
    : checks.state.kind === 'ready'
      ? checks.state.value.checkRunsFailure ?? checks.state.value.commitStatusFailure ?? null
      : null);
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
  const failedReads = [
    { failure: conversation.state.failure, refresh: conversation.refresh },
    { failure: threadsFailure, refresh: threads.refresh },
    { failure: reviewsFailure, refresh: reviews.refresh },
    { failure: requestsFailure, refresh: requests.refresh },
    { failure: checksFailure, refresh: checks.refresh },
  ];
  const allConnectionsAnswered = conversation.state.kind === 'ready'
    && threads.state.kind === 'ready' && reviews.state.kind === 'ready'
    && requests.state.kind === 'ready' && checks.state.kind === 'ready';
  const commentsIncomplete = incompleteDescription(text, conversation.state.incomplete, null);
  const checksIncompleteDescription = text(
    'plugins.github.ui.feedbackChecksIncomplete',
    'GitHub did not list this pull request\'s whole check suite, so nothing here says its checks'
      + ' are clean.',
  );

  return {
    settling,
    failedReads,
    unavailable: cold
      ? { title: 'The feedback is unavailable', titleKey: 'plugins.github.ui.feedbackUnavailable', failure: conversation.state.failure }
      : null,
    lead: githubReviewPeopleLead(text, view.people, locale, nowMs),
    header: (
      <Stack gap="medium">
        {reviews.state.kind === 'ready'
          && !reviews.state.canLoadMore && reviews.state.incomplete === null && reviews.state.omittedRowCount === 0
          && !reviews.state.rows.some(review => review.state.trim().toUpperCase() === 'PENDING')
          ? <GithubPendingReviewCreateWrite context={context} /> : null}
        {view.review.kind === 'decided'
          ? (
            <Row gap="small">
              <Status
                tone={resolveTriageRowFactStatusToneV1(view.review.tone)}
                label={text('plugins.github.ui.reviewDecision', 'Review: {value}', {
                  value: view.review.label,
                })}
              />
            </Row>
          )
          : null}
        {checksKnownIncomplete
          ? (
            // The same fact the Checks plane states, in the plane that would
            // otherwise imply a clean suite. It is deliberately separate from
            // the failure banner below: an incomplete read is not a failed one.
            <Banner
              tone="warning"
              title="This check suite is larger than GitHub will list"
              titleKey="plugins.github.ui.checkSuiteIncomplete"
              description={checksIncompleteDescription}
              descriptionKey="plugins.github.ui.feedbackChecksIncomplete"
            />
          )
          : null}
        {failedConnections.length === 0 || connectionFailure === null
          ? null
          : (
            <Stack gap="small"><Banner
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
                ), text,
              )}
            /><GithubReadFailureDetails failures={failedReads.map(read => read.failure)} /></Stack>
          )}
      </Stack>
    ),
    events: view.findings.map((finding) => feedbackFindingEvent(text, finding, eventContext)),
    continuations: [
      ...(conversation.state.canLoadMore
        ? [{ key: 'comments', title: 'Load more comments', titleKey: 'plugins.github.ui.loadMoreComments', pending: conversation.state.pending, onLoadMore: conversation.loadMore, reads: 'earlier' as const }]
        : []),
      ...(threads.state.canLoadMore
        ? [{ key: 'threads', title: 'Load earlier review conversations', titleKey: 'plugins.github.ui.loadEarlierReviewThreads', pending: threads.state.pending, onLoadMore: threads.loadMore, reads: 'earlier' as const }]
        : []),
      ...(reviews.state.canLoadMore
        ? [{ key: 'reviews', title: 'Load earlier reviews', titleKey: 'plugins.github.ui.loadEarlierReviews', pending: reviews.state.pending, onLoadMore: reviews.loadMore, reads: 'earlier' as const }]
        : []),
      ...(requests.state.canLoadMore
        ? [{ key: 'requests', title: 'Load more review requests', titleKey: 'plugins.github.ui.loadMoreReviewRequests', pending: requests.state.pending, onLoadMore: requests.loadMore }]
        : []),
    ],
    composer: <GithubCommentComposer context={eventContext.editContext} capabilities={context.capabilities} />,
    summary: conversation.state.kind !== 'ready' ? null : (
      <Stack gap="small">
        {conversation.state.omittedRowCount === 0 ? null : <Text
          variant="micro"
          tone="neutral"
          valueKey="plugins.github.ui.commentsReadWithUnreadable"
          fallback="{count} comment(s) read. {unreadable} row(s) on the pages read could not be understood."
          values={{ count: conversation.state.rows.length, unreadable: conversation.state.omittedRowCount }}
        />}
        {conversation.state.projectionTruncated
          ? (
            <Text
              variant="micro"
              tone="neutral"
              valueKey="plugins.github.ui.commentsShortened.description"
              fallback="Some comments were shortened. Open the entry on GitHub to read them in full."
            />
          )
          : null}
        {commentsIncomplete === null
          ? null
          : <Text variant="micro" tone="neutral">{commentsIncomplete}</Text>}
      </Stack>
    ),
    refresh: () => {
      conversation.refresh();
      threads.refresh();
      reviews.refresh();
      requests.refresh();
      checks.refresh();
    },
    pending: conversation.state.pending || threads.state.pending || reviews.state.pending
      || requests.state.pending || checks.pending,
    empty: !allConnectionsAnswered || failedConnections.length > 0 ? null : (
      <EmptyState
        title="Nothing has been said yet"
        titleKey="plugins.github.ui.noFeedback"
        description={checksKnownIncomplete
          // "GitHub reports nothing wrong with it" is a claim about the whole
          // suite. Over a suite GitHub would not list, it is a claim nobody
          // could compute, and it is the reassuring half of this plane.
          ? text(
            'plugins.github.ui.noFeedback.checksIncomplete',
            'No comment has been left on this pull request, and GitHub did not list its whole'
              + ' check suite.',
          )
          : text(
            'plugins.github.ui.noFeedback.description',
            'No comment has been left on this pull request, and GitHub reports nothing wrong'
              + ' with it.',
          )}
      />
    ),
  };
}

function FeedbackPanel(props: GithubFeedbackWriteContextV1): React.ReactElement {
  const feedback = useGithubFeedbackStream(props);
  return (
    <GithubActivityView
      streams={[feedback]}
      locale={props.locale}
      nowMs={props.nowMs}
      accessibilityLabel="Feedback on this pull request"
      accessibilityLabelKey="plugins.github.ui.feedbackLabel"
      loadingTitle="Reading the feedback on this pull request from GitHub"
      loadingTitleKey="plugins.github.ui.readingFeedback"
      refreshLabel="Re-read this feedback from GitHub"
      refreshLabelKey="plugins.github.ui.rereadFeedback"
    />
  );
}

/**
 * Activity (r0.42): the entry's whole story as one stream — a pull request's
 * feedback or an issue's comments interleaved by time with GitHub's timeline.
 */
function PullRequestActivityPanel(props: GithubFeedbackWriteContextV1): React.ReactElement {
  const feedback = useGithubFeedbackStream(props);
  const timeline = useGithubTimelineStream();
  return <GithubActivityPanelView streams={[feedback, timeline]} locale={props.locale} nowMs={props.nowMs} />;
}

function IssueActivityPanel(props: Readonly<{
  input: TriageDetailSurfaceInputV1;
  locale: string;
  nowMs: number;
  onObserved: GithubObservedEntryHandlerV1;
  capabilities: GithubReadStateV1<GithubRepositoryCapabilitiesV1>;
}>): React.ReactElement {
  const comments = useGithubCommentsStream(props.input, props.onObserved, props.capabilities);
  const timeline = useGithubTimelineStream();
  return <GithubActivityPanelView streams={[comments, timeline]} locale={props.locale} nowMs={props.nowMs} />;
}

function GithubActivityPanelView(props: Readonly<{
  streams: readonly GithubActivityStreamV1[];
  locale: string;
  nowMs: number;
}>): React.ReactElement {
  return (
    <GithubActivityView
      {...props}
      accessibilityLabel="Events GitHub recorded for this entry"
      accessibilityLabelKey="plugins.github.ui.timelineLabel"
      loadingTitle="Reading this timeline from GitHub"
      loadingTitleKey="plugins.github.ui.readingTimeline"
      refreshLabel="Re-read this timeline from GitHub"
      refreshLabelKey="plugins.github.ui.rereadTimeline"
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

/* ------------------------------------------------------------ Story rail (r0.42) */

/**
 * ② What changed: the shared summary over the changed-file pages the Files panel's
 * reader reads, with GitHub's own whole-change totals once the overview states them.
 */
function GithubChangeStep({ overview, onOpenFile }: Readonly<{
  overview: GithubOverviewValueV1 | null;
  /** Opens Files on one path; absent where no frame offers a Files panel. */
  onOpenFile?: ((path: string) => void) | undefined;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const files = useGithubChangedFiles();
  // The frame's own panel selection: the step's title opens Files, a file opens Files on that file.
  const openFiles = useTriageDetailPanelOpener('files');
  const rows = React.useMemo(() => files.state.rows.map((row) => ({
    path: row.path, lines: { additions: row.additions, deletions: row.deletions },
  })), [files.state.rows]);
  const pullRequest = overview?.kindId === 'pull-request' ? overview : null;
  const totals = pullRequest?.changedFiles === undefined ? undefined : {
    files: pullRequest.changedFiles,
    ...(pullRequest.additions === undefined ? {} : { additions: pullRequest.additions }),
    ...(pullRequest.deletions === undefined ? {} : { deletions: pullRequest.deletions }),
  };
  return (
    <TriageDetailChangeSummary titleKey="plugins.github.ui.story.changed" rows={rows} totals={totals}
      more={files.state.canLoadMore || files.state.incomplete !== null}
      onOpenChanges={openFiles}
      onOpenFile={openFiles === undefined ? undefined : onOpenFile}
      loadMore={files.state.canLoadMore
        ? { title: text('plugins.github.ui.showMoreFiles', 'Show more files'), pending: files.state.pending, onLoadMore: files.loadMore }
        : undefined}>
      {pullRequest?.headBranch === undefined || pullRequest.baseBranch === undefined ? null
        : <Text variant="code" tone="secondary" value={`${pullRequest.headBranch} → ${pullRequest.baseBranch}`} />}
      {files.state.kind === 'loading' || files.state.kind === 'idle'
        ? <Text variant="micro" tone="secondary" valueKey="plugins.github.ui.readingFiles" fallback="Reading the changed files from GitHub" />
        : null}
      {files.state.failure === null ? null : (
        <Text
          variant="micro"
          tone="warning"
          value={failureDescription(files.state.failure, text('plugins.github.ui.readFailed', 'GitHub could not complete this read.'), text)}
        />
      )}
    </TriageDetailChangeSummary>
  );
}

/**
 * What the checks say as counts, for the story's Checks step and the Checks tab alike. When GitHub
 * had more check pages than were read (`knownIncomplete`) it states no counts, so the rollup carries
 * what was read so far, marked incomplete.
 */
function githubChecksRollupV1(view: GithubChecksViewV1): TriageDetailChecksRollupV1 {
  if (view.state !== 'knownIncomplete') return view;
  return {
    incomplete: true,
    failingCount: view.rowState?.kind === 'failing'
      ? view.rowState.failingCount
      : view.rows.filter((row) => readGithubCheckOutcomeV1(row) === 'failed').length,
    runningCount: view.rows.filter((row) => readGithubCheckOutcomeV1(row) === 'pending').length,
  };
}

/** The first line of a check's output that says something, without its Markdown heading or list marks. */
function firstGithubOutputLine(output: string): string | undefined {
  for (const line of output.split('\n')) {
    const said = line.replace(/^[\s#>*\-]+/, '').trim();
    if (said !== '') return said;
  }
  return undefined;
}

/**
 * The checks step: GitHub's rollup of the head commit's checks, and the ones that failed.
 * When GitHub had more check pages than were read (`knownIncomplete`) it states no counts,
 * so the step carries what was read so far: the failing count `checks.ts` observed and the
 * in-flight checks among the rows, marked incomplete.
 */
function GithubChecksStep(): React.ReactElement | null {
  const text = usePluginTranslation();
  const checks = useGithubChecks();
  const openChecks = useTriageDetailPanelOpener('checks');
  if (checks.state.kind !== 'ready') return (
    <Step title="Checks" titleKey="plugins.github.ui.story.checks"
      marker={{ kind: 'state', state: 'open', label: 'Checks' }}>
      {checks.state.kind === 'unavailable' && checks.overviewFailure === true
        // The story's own read failed; its failure and Re-read are already shown above.
        ? <Status tone="muted" label={text('plugins.github.ui.checksUnavailable', 'The checks are unavailable')} />
        : checks.state.kind === 'unavailable'
        ? <GithubReadFailure title="The checks are unavailable" titleKey="plugins.github.ui.checksUnavailable"
          failures={[checks.state.failure]} refresh={checks.refresh} />
        : <Status tone="muted" pulsing label={text('plugins.github.ui.readingChecks', 'Reading the checks from GitHub')} />}
    </Step>
  );
  const view = checks.state.value;
  const failed = view.rows.filter((row) => readGithubCheckOutcomeV1(row) === 'failed');
  const rollup = githubChecksRollupV1(view);
  return (
    <TriageDetailChecks title="Checks" titleKey="plugins.github.ui.story.checks" latestCommit rollup={rollup}
      onOpenChecks={openChecks}
      failing={failed.map((row) => {
        // What GitHub said about the failure, in one line under its name: the output's first line.
        const said = row.logExcerpt === undefined ? undefined : firstGithubOutputLine(row.logExcerpt);
        return { id: row.key, name: row.name, ...(said === undefined ? {} : { detail: said }) };
      })} />
  );
}

/**
 * The GitHub facts the key/value block used to hold, said once each in the story: who
 * asked, its labels, and who it is assigned to and waiting on. A fact GitHub did not
 * state is left out rather than drawn as "Unavailable".
 */
function GithubStoryFacts({ overview }: Readonly<{ overview: GithubOverviewValueV1 }>): React.ReactElement | null {
  const text = usePluginTranslation();
  // An issue is a task in Triage: its Assignees and Labels are the task's own property rows above the story, so the
  // story does not say them a second time.
  const issue = overview.kindId === 'issue';
  const labels = issue ? [] : overview.labels ?? [];
  const reviewers = overview.kindId === 'pull-request' ? overview.requestedReviewers ?? [] : [];
  const parts = [
    ...(issue || overview.assignees === undefined || overview.assignees.length === 0 ? []
      : [text('plugins.github.ui.story.assignees', 'Assigned to {names}', { names: overview.assignees.join(', ') })]),
    ...(reviewers.length === 0 ? [] : [`${text('plugins.github.ui.reviewRequestedFrom', 'Review requested from')} ${reviewers
      .map((reviewer) => reviewer.kind === 'team' ? `${reviewer.subject} (team)` : reviewer.subject).join(', ')}`]),
    ...(overview.milestone === undefined || overview.milestone === null ? []
      : [text('plugins.github.ui.story.milestone', 'Milestone: {name}', { name: overview.milestone })]),
  ];
  if (labels.length === 0 && parts.length === 0) return null;
  return (
    <Stack gap="small">
      {labels.length === 0 ? null : <Row gap="small" wrap>{labels.map((label) => <Badge key={label} value={label} />)}</Row>}
      {parts.length === 0 ? null : <Text variant="micro" tone="secondary" value={parts.join(' · ')} />}
    </Stack>
  );
}

/**
 * The Overview panel as the story rail's source half (r0.42): ① the ask (a
 * pull request) or the report (an issue) with who opened it, then ② what
 * changed and the checks state for a pull request. Triage draws ③. The exact
 * overview is read when the story opens; a Re-read control appears only beside
 * a read that failed.
 */
function GithubStoryOverview({
  input,
  kindId,
  locale,
  nowMs,
  overview,
  refresh,
  capabilitiesFailure,
  onOpenFile,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  kindId: GithubTriageKindIdV1;
  locale: string;
  nowMs: number;
  overview: GithubOverviewControllerV1;
  refresh: () => Promise<void>;
  capabilitiesFailure: TriageSourceFailureV1 | null;
  onOpenFile: (path: string) => void;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const exact = overview.value;
  // The observation's own summary is the ask until the reader re-reads the
  // current description; neither is invented when both are absent.
  const ask = exact?.body ?? input.observation.snapshot.summary;
  const opened = exact?.createdAtMs === undefined ? null : formatTimestamp(locale, exact.createdAtMs, 'relative', nowMs);
  const byline = [exact?.author, opened].filter((part): part is string => typeof part === 'string' && part.length > 0);
  return (
    <TriageDetailStory kind={kindId === 'issue' ? 'report' : 'ask'}
        // Nothing to show yet (no last read, no list summary) while the first read settles: hold ①'s place.
        loading={exact === null && overview.failure === null && (ask === undefined || ask === null || ask.length === 0)}
        changes={kindId === 'pull-request' ? <GithubChangeStep overview={exact} onOpenFile={onOpenFile} /> : null}
        // Preview follows Checks in the story (DEPLOY-COMPOSE-1107 P15); the slot keeps their order.
        checks={kindId === 'pull-request' ? <><GithubChecksStep /><GithubPullRequestPreviewStep input={input} closed={exact?.state === 'closed'} /></> : null}
        trailing={byline.length === 0 ? undefined : <Text variant="micro" tone="secondary" value={byline.join(' · ')} />}
        notice={overview.failure === null ? undefined : (
          // One line above the ask, beside its Re-read: the description it previews (the last read, or the
          // list's own summary) stays readable instead of sitting under a whole-panel error.
          <Stack gap="small">
            <Status
              tone="warning"
              label={exact === null
                ? text('plugins.github.ui.overview.unavailable', 'The current overview is unavailable')
                : text('plugins.github.ui.overview.retained', 'Showing the last overview read')}
              value={failureDescription(overview.failure, text('plugins.github.ui.readFailed', 'GitHub could not complete this read.'), text)}
              action={(
                <RefreshRow
                  onRefresh={refresh}
                  pending={overview.refreshing}
                  accessibilityLabel={text('plugins.github.ui.overview.reread', 'Re-read this overview from GitHub')}
                />
              )}
            />
            <GithubReadFailureDetails failures={[overview.failure]} />
          </Stack>
        )}
      >
        {ask === undefined || ask === null || ask.length === 0
          ? exact === null ? null : <Text variant="micro" tone="secondary" valueKey="plugins.github.ui.story.noDescription" fallback="No description." />
          : <GithubOverviewMarkdown body={ask} />}
        {exact === null ? null : <GithubStoryFacts overview={exact} />}
        <GithubReadFailureDetails failures={[capabilitiesFailure]} />
    </TriageDetailStory>
  );
}

function GithubDetailBody({
  input: launched,
  kindId,
  detailActivity,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  kindId: GithubTriageKindIdV1;
  detailActivity: ReturnType<typeof useTabPanelActivity>;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const { locale } = useSurfaceContext();
  const [selected, setSelected] = React.useState<GithubDetailTabIdV1>(
    GITHUB_DEFAULT_DETAIL_TAB_V1,
  );
  // One render-time read, passed down as data, so no child owns a hidden clock.
  const nowMs = Date.now();
  // Which file Files opens: one fact for the detail, set by the reader from Overview or by an agent in Files.
  const [focusPath, setFocusPath] = React.useState<string | null>(null);
  const openFiles = useTriageDetailPanelOpener('files');
  const openFile = React.useCallback((path: string) => {
    setFocusPath(path);
    openFiles?.();
  }, [openFiles]);
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
  const openingDetail = React.useMemo(() => {
    if (kindId !== 'issue' || input.detailData === undefined) return undefined;
    const parsed = GithubIssueOpeningDetailV1Schema.safeParse(input.detailData);
    return parsed.success ? parsed.data : undefined;
  }, [input.detailData, kindId]);
  const primaryHost = useTriageEvidenceDisclosure().primaryWrite;
  const tabActivity = useTabPanelActivity();
  const publishesPrimaryWrite = primaryHost !== undefined && input.panel !== undefined && input.panel !== 'actions';
  // The header is outside the body tabs. Its facts and confirmed writer belong
  // to this mounted detail, even while a sibling tab hides the source body.
  const activity = publishesPrimaryWrite ? detailActivity : tabActivity;
  const readWhenActive = input.panel === 'overview' || publishesPrimaryWrite
    || (kindId === 'pull-request' && (input.panel === 'files' || (input.panel === undefined && selected === 'files')));
  // A shown checks consumer reads the checks this Overview read states.
  const checksDemanded = useGithubChecksDemanded();
  const propertiesDemanded = kindId === 'pull-request' && input.panel === 'actions';
  const overview = useGithubOverview(input, { readWhenActive: readWhenActive || checksDemanded || propertiesDemanded,
    includePropertyChoices: propertiesDemanded, activity, initialOverview: openingDetail?.overview });
  const capabilities = useGithubCapabilities(input, activity, kindId === 'pull-request' && readWhenActive ? overview : undefined,
    openingDetail?.capabilities);
  const primaryController = useGithubPrimaryWrite(input, overview, onObserved, activity);
  const primaryWrite = primaryController.value;
  const publishPrimaryWrite = primaryHost?.offer;
  React.useLayoutEffect(() => {
    if (publishPrimaryWrite === undefined || !publishesPrimaryWrite) return undefined;
    publishPrimaryWrite(primaryWrite);
    return () => { publishPrimaryWrite(null); };
  }, [publishesPrimaryWrite, primaryWrite, publishPrimaryWrite]);
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
    locations: null,
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
    timeline: <TimelinePanel locale={locale} nowMs={nowMs} />,
    files: <FilesPanel input={input} overview={overview.value} focusPath={focusPath} onFocusPath={setFocusPath}
      totalFiles={overview.value?.kindId === 'pull-request' ? overview.value.changedFiles : undefined} />,
    checks: <ChecksPanel locale={locale} nowMs={nowMs} signal={detailActivity.activeSignal} />,
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
    comments: <CommentsPanel input={input} locale={locale} nowMs={nowMs} onObserved={onObserved} capabilities={capabilities} />,
    'work-sessions': <WorkSessionsPanel sessions={body.linkedSessions} />,
  };

  // The Triage detail asked for exactly one panel (r0.42): its frame draws the
  // tab strip, and this body renders that panel inside its own active interval.
  // Every checks consumer in this body reads the Overview's own rollup answer.
  const withChecks = (node: React.ReactElement) => (
    <GithubDetailChecksFromOverview overview={overview}>{node}</GithubDetailChecksFromOverview>
  );
  if (input.panel !== undefined) {
    return withChecks(
      <Screen safeArea>
        <TriageDetailPanel
          scrollOwner={input.panelScrollOwner}
          panel={input.panel}
          ariaLabel={text('plugins.github.ui.detailTabs', 'GitHub entry detail')}
          retention={Object.fromEntries(visible
            .filter((declaration) => ['overview', 'timeline', 'files', 'checks'].includes(declaration.id))
            .map((declaration) => [declaration.id === 'timeline' ? 'activity' : declaration.id, declaration.retention]))}
          panels={{
            overview: <GithubStoryOverview input={input} kindId={kindId} locale={locale} nowMs={nowMs} overview={overview} refresh={primaryController.refresh}
              capabilitiesFailure={capabilities.kind === 'unavailable' ? capabilities.failure : null} onOpenFile={openFile} />,
            activity: kindId === 'pull-request'
              ? (
                <PullRequestActivityPanel
                  input={input}
                  locale={locale}
                  nowMs={nowMs}
                  onObserved={onObserved}
                  publicationProposals={publicationProposals}
                  capabilities={capabilities}
                />
              )
              : <IssueActivityPanel input={input} locale={locale} nowMs={nowMs} onObserved={onObserved} capabilities={capabilities} />,
            ...(kindId === 'pull-request' ? { files: panels.files, checks: panels.checks } : {}),
            actions: (
              <GithubActionsPanel
                input={input}
                kindId={kindId}
                mergeSignature={mergeSignature}
                onObserved={onObserved}
                publicationProposals={publicationProposals}
                capabilities={capabilities}
                overview={overview}
                primaryWrite={primaryWrite}
              />
            ),
          }}
        />
      </Screen>,
    );
  }

  return withChecks(
    <Screen safeArea>
      <Tabs
        presentation="page"
        pageKind={{ pluginId: GITHUB_PLUGIN_ID, localId: `${GITHUB_TRIAGE_DETAIL_RENDERER_ID_V1}/${kindId}` }}
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
            glyph={declaration.glyph}
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
    </Screen>,
  );
}

/** The source's own Markdown projection and settled-write presenter, lent to the alert composition. */
const GITHUB_SECURITY_ALERT_RENDERERS: GithubSecurityAlertRenderersV1 = Object.freeze({
  renderMarkdown: (body: string) => <GithubOverviewMarkdown body={body} />,
  renderOutcome: (outcome: GithubMutationOutcomeV1) => <WriteOutcome outcome={outcome} />,
});

function GithubDetailSurface(context: RenderContext): React.ReactElement | null {
  const detailActivity = React.useMemo(() => ({
    active: context.activity?.active !== false,
    activeSignal: context.signal,
  }), [context.activity?.active, context.signal]);
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

  // An alert never enters the issue/PR readers: its own composition reads it through the selected-alert controller.
  if (admitted.kindId !== 'pull-request' && admitted.kindId !== 'issue') {
    return <TriageDetailInstance scrollOwner={admitted.input.panelScrollOwner}><GithubSecurityAlertBody input={admitted.input} renderers={GITHUB_SECURITY_ALERT_RENDERERS} detailActivity={detailActivity} /></TriageDetailInstance>;
  }
  return (
    <TriageDetailInstance scrollOwner={admitted.input.panelScrollOwner}>
      <GithubDetailResourcesProvider input={admitted.input} activity={detailActivity}>
        <GithubDetailBody input={admitted.input} kindId={admitted.kindId} detailActivity={detailActivity} />
      </GithubDetailResourcesProvider>
    </TriageDetailInstance>
  );
}

/**
 * The manifest names this exact universal CommonJS export.
 */
export const renderSurface = defineUiSurface(GithubDetailSurface);
