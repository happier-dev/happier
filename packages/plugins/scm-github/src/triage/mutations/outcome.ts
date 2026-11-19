import type { PluginUiActionFailureV1 } from '@happier-dev/plugin-sdk/ui';
import type { TriageDetailSurfaceInputV1, TriageSourceFailureV1, TriageSourceOperationOutcomeV1 } from '@happier-dev/triage-protocol/v1';
import { describeTriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import type {
  GithubSkippedRequirementV1, GithubPullRequestMergeResultV1, GithubPullRequestNativeMergeResultV1,
  GithubPullRequestReviewPublicationResultV1, GithubPullRequestStateResultV1, GithubPullRequestMarkReadyResultV1,
  GithubPullRequestUpdateBranchResultV1, GithubPullRequestReviewersResultV1, GithubIssueDeltaResultV1,
  GithubPullRequestThreadResolutionResultV1, GithubCommentEditResultV1, GithubCommentCreateResultV1,
  GithubPullRequestMergeActionResultV1, GithubPullRequestNativeMergeActionResultV1, GithubPullRequestMarkReadyActionResultV1,
  GithubPullRequestReviewMutationResultV1,
  GithubEntryAdministrationResultV1,
  GithubPullRequestHeadBranchRestoreResultV1,
  GithubPullRequestHeadBranchDeleteResultV1,
} from './contracts.js';
import type { GithubSecurityAlertMutationResultV1 } from '../securityAlerts/actionContracts.js';
import type { GithubRelationshipMutationResultV1 } from './relationshipContracts.js';

type ObservedState = TriageDetailSurfaceInputV1['observation']['snapshot']['state'];
export const GITHUB_WRITE_REFUSAL_COPY_V1: Readonly<Record<
  GithubMutationRefusalReasonV1,
  Readonly<{ key: string; fallback: string }>
>> = Object.freeze({
  head_advanced: Object.freeze({
    key: 'plugins.github.ui.mutations.refused.head_advanced',
    fallback: 'The pull request head changed since you selected it. Refresh before trying again.',
  }),
  branch_moved: { key: 'plugins.github.ui.mutations.refused.branch_moved',
    fallback: 'The source branch moved since the head shown here. Refresh before deleting it.' },
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
  requirements_unmet: { key: 'plugins.github.ui.mutations.refused.requirements_unmet', fallback: 'Merge requirements are unmet.' },
  requirements_changed: { key: 'plugins.github.ui.mutations.refused.requirements_changed', fallback: 'Requirements changed. Refresh and confirm the current requirements.' },
  requirements_unknown: { key: 'plugins.github.ui.mutations.refused.requirements_unknown', fallback: 'GitHub has not established all requirements that would be skipped.' },
  bypass_not_allowed: { key: 'plugins.github.ui.mutations.refused.bypass_not_allowed', fallback: 'This GitHub viewer cannot merge without waiting for requirements.' },
  operation_not_allowed: { key: 'plugins.github.ui.mutations.refused.operation_not_allowed', fallback: 'GitHub does not allow this operation for the current viewer.' },
});

type ObservedEntryLocalRef = Pick<TriageDetailSurfaceInputV1['observation']['entryRef'], 'kindId' | 'collisionScope' | 'entryId'>;
export type GithubLegacyMutationOutcomeV1 =
  | Readonly<{
    kind: 'applied';
    effect: 'changed' | 'alreadySatisfied';
    /** Exact state from the Action's confirming observation, when that result carries one. */
    confirmedState: ObservedState | null;
    /** Identity paired with `confirmedState`; prevents another entry's answer driving this UI. */
    confirmedEntryRef: ObservedEntryLocalRef | null;
  }>
  | Readonly<{
    kind: 'publication';
    publishedCount: number;
    uncertainCount: number;
    failedCount: number;
    totalCount: number;
    verdict: 'published' | 'uncertain' | 'failed' | 'notRequested';
    failure: TriageSourceFailureV1 | null;
  }>
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'approval' }>
  | Readonly<{ kind: 'refused'; reason: GithubMutationRefusalReasonV1; unmetRequirements?: readonly GithubSkippedRequirementV1[] }>
  | Readonly<{ kind: 'uncertain'; failure: TriageSourceFailureV1 | null }>
  | Readonly<{ kind: 'failed'; failure: TriageSourceFailureV1 }>
  | Readonly<{ kind: 'rejected'; failure: PluginUiActionFailureV1 }>
  | Readonly<{ kind: 'unreadable' }>;

export type GithubMutationResultV1 =
  | GithubPullRequestHeadBranchDeleteResultV1
  | GithubPullRequestHeadBranchRestoreResultV1
  | GithubEntryAdministrationResultV1
  | GithubPullRequestReviewMutationResultV1
  | GithubRelationshipMutationResultV1
  | GithubPullRequestMergeActionResultV1
  | GithubPullRequestNativeMergeActionResultV1
  | GithubPullRequestMarkReadyActionResultV1
  | GithubPullRequestMergeResultV1
  | GithubPullRequestNativeMergeResultV1
  | GithubPullRequestReviewPublicationResultV1
  | GithubPullRequestStateResultV1
  | GithubPullRequestMarkReadyResultV1
  | GithubPullRequestUpdateBranchResultV1
  | GithubPullRequestReviewersResultV1
  | GithubIssueDeltaResultV1
  | GithubPullRequestThreadResolutionResultV1
  | GithubCommentEditResultV1
  | GithubCommentCreateResultV1;

export type GithubMutationRefusalReasonV1 =
  Extract<GithubMutationResultV1, { kind: 'refused' }>['reason'];

/** Native alert refusal codes stay source-owned without widening the legacy UI's copy table. */
export type GithubSecurityAlertMutationOutcomeV1 =
  | Exclude<GithubLegacyMutationOutcomeV1, { kind: 'refused' }>
  | Readonly<{ kind: 'refused'; reason: string }>;


export type GithubMutationOutcomeV1 = GithubLegacyMutationOutcomeV1 | TriageSourceOperationOutcomeV1;

type GithubOperationResultV1 = GithubPullRequestMergeResultV1
  | GithubPullRequestNativeMergeResultV1 | GithubPullRequestMarkReadyResultV1;
type GithubOperationNativeOutcomeV1 = Extract<GithubLegacyMutationOutcomeV1,
  { kind: 'applied' | 'refused' | 'uncertain' | 'failed' }>;

/** Original operation Actions add presentation, never reinterpret transport approval. */
export function withGithubOperationOutcomeV1(
  result: GithubOperationResultV1,
): GithubPullRequestMergeActionResultV1 | GithubPullRequestNativeMergeActionResultV1 | GithubPullRequestMarkReadyActionResultV1 {
  const native = projectGithubMutationOutcomeV1(result);
  let outcome: TriageSourceOperationOutcomeV1;
  switch (native.kind) {
    case 'applied':
      outcome = { ...native, presentation: native.effect === 'changed'
        ? { title: 'Done', titleKey: 'plugins.github.ui.mutations.applied',
          description: 'GitHub now reports the state you asked for.', descriptionKey: 'plugins.github.ui.mutations.applied.description', tone: 'secondary' }
        : { title: 'Nothing to do', titleKey: 'plugins.github.ui.mutations.alreadySatisfied',
          description: 'No request was sent: GitHub already held this state.', descriptionKey: 'plugins.github.ui.mutations.alreadySatisfied.description', tone: 'secondary' } };
      break;
    case 'refused': {
      const copy = GITHUB_WRITE_REFUSAL_COPY_V1[native.reason];
      outcome = { ...native, presentation: {
        title: 'Refused', titleKey: 'plugins.github.ui.mutations.refused',
        description: copy.fallback, descriptionKey: copy.key, tone: 'warning',
      } };
      break;
    }
    case 'uncertain': {
      const advice = 'The request was accepted and its effect could not be confirmed. Open this entry again to see what is true now rather than pressing again.';
      const described = describeTriageSourceFailureV1(native.failure, advice, undefined, 'en');
      outcome = { ...native, presentation: {
        title: 'Outcome unknown', titleKey: 'plugins.github.ui.mutations.uncertain',
        description: described === advice ? advice : `${described} ${advice}`, tone: 'warning',
      } };
      break;
    }
    case 'failed':
      outcome = { ...native, presentation: { title: 'Not carried out', titleKey: 'plugins.github.ui.mutations.notCarriedOut',
        description: describeTriageSourceFailureV1(native.failure, 'GitHub could not complete this change.', undefined, 'en'), tone: 'danger' } };
      break;
  }
  // The native writer retains its exact refs. The public result presents that
  // same sequence once: duplicating it can overflow the outer Action envelope.
  if ('unmetRequirements' in result) {
    const { unmetRequirements: _requirements, ...native } = result;
    return Object.freeze({ ...native, outcome: Object.freeze(outcome) });
  }
  return Object.freeze({ ...result, outcome: Object.freeze(outcome) });
}

/** Native semantics projected once, inside the source Action or a legacy consumer. */
export function projectGithubMutationOutcomeV1(parsed: GithubOperationResultV1): GithubOperationNativeOutcomeV1;
export function projectGithubMutationOutcomeV1(parsed: GithubMutationResultV1): GithubLegacyMutationOutcomeV1;
export function projectGithubMutationOutcomeV1(parsed: GithubSecurityAlertMutationResultV1): GithubSecurityAlertMutationOutcomeV1;
export function projectGithubMutationOutcomeV1(parsed: GithubMutationResultV1 | GithubSecurityAlertMutationResultV1): GithubLegacyMutationOutcomeV1 | GithubSecurityAlertMutationOutcomeV1;
export function projectGithubMutationOutcomeV1(
  parsed: GithubMutationResultV1 | GithubSecurityAlertMutationResultV1,
): GithubLegacyMutationOutcomeV1 | GithubSecurityAlertMutationOutcomeV1 {
  if (parsed.kind === 'settled') {
    const entryOutcomes = parsed.publication.entries.map((entry) => entry.outcome);
    const publicationVerdict = parsed.publication.verdict;
    const verdict = 'kind' in publicationVerdict
      ? 'notRequested' as const
      : publicationVerdict.outcome.kind === 'published'
        ? 'published' as const
        : publicationVerdict.outcome.kind === 'uncertain'
          ? 'uncertain' as const
          : 'failed' as const;
    return Object.freeze({
      kind: 'publication' as const,
      publishedCount: entryOutcomes.filter((effect) => effect.kind === 'published').length,
      uncertainCount: entryOutcomes.filter((effect) => effect.kind === 'uncertain').length,
      failedCount: entryOutcomes.filter((effect) => (
        effect.kind === 'failed' || effect.kind === 'skippedPriorFailure'
      )).length,
      totalCount: entryOutcomes.length,
      verdict,
      failure: parsed.failure ?? null,
    });
  }
  if (parsed.kind === 'applied') {
    const confirmedObservation = 'observation' in parsed && parsed.observation?.kind === 'present'
      ? parsed.observation
      : null;
    return Object.freeze({
      kind: 'applied' as const,
      effect: 'effect' in parsed ? parsed.effect : 'changed',
      confirmedState: confirmedObservation?.snapshot.state ?? null,
      confirmedEntryRef: confirmedObservation === null
        ? null
        : Object.freeze({
          kindId: confirmedObservation.localRef.kindId,
          collisionScope: confirmedObservation.localRef.collisionScope,
          entryId: confirmedObservation.localRef.entryId,
        }),
    });
  }
  if (parsed.kind === 'pending') return Object.freeze({ kind: 'pending' as const });
  if (parsed.kind === 'refused') {
    return Object.freeze({ kind: 'refused' as const, reason: parsed.reason,
      ...('unmetRequirements' in parsed ? { unmetRequirements: parsed.unmetRequirements } : {}) });
  }
  if (parsed.kind === 'uncertain') {
    return Object.freeze({
      kind: 'uncertain' as const,
      failure: parsed.failure ?? null,
    });
  }
  if (parsed.kind === 'rejected') {
    return Object.freeze({
      kind: 'rejected' as const,
      failure: { ok: false as const, errorCode: parsed.reason },
    });
  }
  return Object.freeze({ kind: 'failed' as const, failure: parsed.failure });
}

/** Whether GitHub's own settled write vocabulary leaves provider state uncertain. */
export function githubMutationMayHaveChangedProviderStateV1(
  outcome: GithubMutationOutcomeV1 | GithubSecurityAlertMutationOutcomeV1 | null,
): boolean {
  if (outcome === null) return false;
  switch (outcome.kind) {
    case 'applied':
      // `alreadySatisfied` sends no outward write, but its exact confirming read
      // can still be newer than the mounted observation and must reconcile it.
      return true;
    case 'publication':
      return outcome.publishedCount > 0
        || outcome.uncertainCount > 0
        || outcome.verdict === 'published'
        || outcome.verdict === 'uncertain';
    case 'pending':
    case 'uncertain':
    case 'unreadable':
      return true;
    default:
      return false;
  }
}

