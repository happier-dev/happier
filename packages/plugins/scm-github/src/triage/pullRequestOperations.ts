import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import type { TriageEntryStateV1, TriagePullRequestStatusV1, TriagePullRequestOperationsV1,
  TriagePullRequestOperationOfferV1 } from '@happier-dev/triage-protocol/v1';

import type { GithubRepositoryCapabilitiesV1 } from './capabilities.js';
import { GithubPullRequestMergeInputV1Schema, GithubPullRequestMarkReadyInputV1Schema,
  GITHUB_MERGE_METHODS_V1,
  GithubPullRequestEnqueueInputV1Schema, GithubPullRequestDequeueInputV1Schema, GithubPullRequestAutoMergeSetInputV1Schema,
  type GithubPullRequestMergeInputV1, type GithubMergeMethodV1, type GithubSkippedRequirementV1 } from './mutations/contracts.js';
import { classifyGithubPullRequestMergeRequirementsV1 } from './mutations/mergeRequirements.js';
import { GITHUB_PLUGIN_ID } from '../observations/githubProviderContracts.js';
import { GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1 } from './contribution.js';

export type GithubPrimaryWriteReasonV1 = 'reading' | 'unavailable' | 'headChanged' | 'headUnknown'
  | 'conflicts' | 'blocked' | 'checksFailed' | 'checksPending' | 'reviewRequired' | 'changesRequested'
  | 'mergeabilityUnknown' | 'methodsUnknown' | 'archived' | 'unsupported';

export type GithubPrimaryWriteProjectionV1 = Readonly<{
  kind: 'merge' | 'markReady' | 'enqueue' | 'dequeue';
  reason: GithubPrimaryWriteReasonV1 | null;
  methods: readonly GithubMergeMethodV1[];
  readiness: 'ready' | 'blocked' | 'unknown';
  unmetRequirements: readonly GithubSkippedRequirementV1[];
  bypassAllowed: boolean;
  autoMergeEnabled: boolean | null;
}>;

export { GITHUB_MERGE_METHODS_V1 } from './mutations/contracts.js';

/** The incumbent source decision, shared by mounted and portable Action offers. */
export function projectGithubPrimaryWriteFactsV1(input: Readonly<{
  kindId: string;
  state: TriageEntryStateV1;
  headRevision: string | undefined;
  overview: Readonly<{ kindId: string; pullRequestStatus?: TriagePullRequestStatusV1;
    draft?: boolean; headRevision?: string; merged?: boolean; state?: string; mergeable?: boolean | null }> | null;
  capabilities: GithubRepositoryCapabilitiesV1 | null;
  failed: boolean;
}>, previous: GithubPrimaryWriteProjectionV1 | null = null): GithubPrimaryWriteProjectionV1 | null {
  const { overview, capabilities } = input;
  if (input.kindId !== 'pull-request' || input.state.presentation !== 'active') return null;
  const exact = overview?.kindId === 'pull-request' ? overview : null;
  const status = exact?.pullRequestStatus;
  const decision = status === undefined ? null : classifyGithubPullRequestMergeRequirementsV1(status);
  const kind = status?.merge?.draft === true || status?.merge?.nativeState === 'DRAFT' || exact?.draft === true ? 'markReady'
    : status?.merge?.queue != null ? 'dequeue' : status?.merge?.queueRequired === true ? 'enqueue' : 'merge';
  let methods: readonly GithubMergeMethodV1[] = capabilities === null ? []
    : GITHUB_MERGE_METHODS_V1.filter(method => capabilities.mergeSettings?.[method] === true
      && capabilities.mergeMethods[method].kind === 'available');
  if (previous && methods.length === previous.methods.length && methods.every((method, index) => method === previous.methods[index])) methods = previous.methods;
  const unmetRequirements = decision?.unmetRequirements ?? [];
  const requirements = previous && previous.unmetRequirements.length === unmetRequirements.length
    && unmetRequirements.every((requirement, index) => requirement.kind === previous.unmetRequirements[index]?.kind
      && requirement.id === previous.unmetRequirements[index]?.id && requirement.label === previous.unmetRequirements[index]?.label)
    ? previous.unmetRequirements : unmetRequirements;
  const structural = decision?.structuralRefusal !== undefined;
  // GitHub's current native verdict decides readiness even when the check projection is partial.
  // A superseded status clears draft to null and cannot supply a current native verdict.
  const nativeReady = status?.merge?.draft === false && (status.merge.nativeState === 'CLEAN'
    || status.merge.nativeState === 'HAS_HOOKS' || status.merge.nativeState === 'UNSTABLE');
  const readiness = input.failed ? 'unknown' : structural || unmetRequirements.length > 0 ? 'blocked'
    : decision?.complete === true || nativeReady ? 'ready' : 'unknown';
  const bypassAllowed = !input.failed && !structural && unmetRequirements.length > 0
    && decision?.complete === true && status?.merge?.canMergeWithoutWaiting === true;
  const autoMergeEnabled = status?.merge?.autoMerge?.enabled ?? null;
  const answer = (reason: GithubPrimaryWriteReasonV1 | null): GithubPrimaryWriteProjectionV1 => {
    const canBypass = bypassAllowed && methods.length > 0 && (reason === null || reason === 'blocked'
      || reason === 'checksFailed' || reason === 'checksPending' || reason === 'reviewRequired' || reason === 'changesRequested');
    const next: GithubPrimaryWriteProjectionV1 = { kind, reason, methods, readiness, unmetRequirements: requirements,
      bypassAllowed: canBypass, autoMergeEnabled };
    return previous && previous.kind === kind && previous.reason === reason && previous.methods === methods
      && previous.readiness === readiness && previous.unmetRequirements === requirements
      && previous.bypassAllowed === canBypass && previous.autoMergeEnabled === autoMergeEnabled ? previous : next;
  };
  if (input.failed) return answer('unavailable');
  if (exact === null || capabilities === null) return answer('reading');
  const availability = capabilities.operations[kind === 'markReady' ? 'pullRequestMarkReady'
    : kind === 'enqueue' ? 'pullRequestEnqueue' : kind === 'dequeue' ? 'pullRequestDequeue' : 'pullRequestMerge'];
  if (availability !== undefined && availability.kind !== 'available') return answer(availability.code === 'repository_archived' ? 'archived' : 'unsupported');
  const currentHead = status?.branch?.headRevision ?? exact.headRevision;
  if (input.headRevision === undefined || currentHead === undefined) return answer('headUnknown');
  if (input.headRevision !== currentHead) return answer('headChanged');
  if (exact.merged === true || (exact.state !== undefined && exact.state !== 'open')) return null;
  if (kind === 'markReady') return answer(null);
  if (structural || exact.mergeable === false) return answer('conflicts');
  if (kind === 'enqueue' || kind === 'dequeue') return answer(status?.merge?.viewerCanUpdate === true ? null : 'unsupported');
  if (unmetRequirements.length > 0) {
    if (status?.checks?.rows.some(row => row.required === true && row.state === 'failed')) return answer('checksFailed');
    if (status?.checks?.rows.some(row => row.required === true && row.state === 'pending')) return answer('checksPending');
    if (status?.review?.decision === 'changesRequested') return answer('changesRequested');
    if (status?.review?.decision === 'reviewRequired') return answer('reviewRequired');
    return answer('blocked');
  }
  return answer(methods.length === 0 ? 'methodsUnknown' : null);
}

/** The one copy of each reason; the mounted detail translates these same words rather than keeping its own. */
export const GITHUB_PRIMARY_WRITE_REASON_COPY_V1: Readonly<Record<GithubPrimaryWriteReasonV1, string>> = {
  reading: 'Reading the current pull request…', unavailable: 'Needs a fresh read of this pull request.',
  headUnknown: 'The head commit is not known yet.', headChanged: 'New commits arrived. Re-read this pull request before changing it.',
  conflicts: 'This pull request has merge conflicts.', blocked: 'GitHub is blocking this merge.',
  checksFailed: 'Required checks are failing.', checksPending: 'Required checks are still running.',
  reviewRequired: 'A required review is missing.', changesRequested: 'Changes have been requested.',
  mergeabilityUnknown: 'GitHub has not confirmed that this pull request is ready to merge.',
  methodsUnknown: 'No enabled merge method has been reported by GitHub.', archived: 'This repository is archived.',
  unsupported: 'This repository does not support this change.',
};
const METHOD_TITLES: Readonly<Record<GithubMergeMethodV1, string>> = {
  merge: 'Create a merge commit', squash: 'Squash and merge', rebase: 'Rebase and merge',
};

/** Project only already-admitted target facts and the actual envelope-fitted status. */
export function buildGithubPullRequestOperationsV1(input: Readonly<{
  target: Pick<GithubPullRequestMergeInputV1, 'instance' | 'localRef' | 'routingToken'>;
  state: TriageEntryStateV1;
  headRevision: string | undefined;
  overview: NonNullable<Parameters<typeof projectGithubPrimaryWriteFactsV1>[0]['overview']>;
  capabilities: GithubRepositoryCapabilitiesV1 | null;
  status: TriagePullRequestStatusV1;
}>): TriagePullRequestOperationsV1 | undefined {
  const projection = projectGithubPrimaryWriteFactsV1({ kindId: input.target.localRef.kindId,
    state: input.state, headRevision: input.headRevision, capabilities: input.capabilities, failed: false,
    overview: { ...input.overview, pullRequestStatus: input.status },
  });
  if (projection === null) return undefined;
  const target = { v: 1 as const, ...input.target };
  const headRevision = input.status.branch?.headRevision ?? input.headRevision;
  type Variant = TriagePullRequestOperationOfferV1['variants'][number];
  const variant = (id: string, value: unknown, method?: GithubMergeMethodV1): Variant => ({
    id, input: projectNativeJsonValueForTransport(value),
    ...(method === undefined ? {} : { method: { title: METHOD_TITLES[method], titleKey: `plugins.github.ui.mutations.mergeMethod.${method}` } }),
  });
  const methods = (build: (method: GithubMergeMethodV1) => unknown): Variant[] => headRevision === undefined ? []
    : projection.methods.map(method => variant(method, build(method), method));
  const offer = (id: string, title: string, actionId: string, reason: GithubPrimaryWriteReasonV1 | null,
    variants: readonly Variant[]): TriagePullRequestOperationOfferV1 => ({
    id, title, titleKey: `plugins.github.ui.primaryWrite.${id}`,
    disabledReason: reason === null ? null : GITHUB_PRIMARY_WRITE_REASON_COPY_V1[reason],
    ...(reason === null ? {} : { disabledReasonKey: `plugins.github.ui.primaryWrite.${reason}` }),
    actionRef: { pluginId: GITHUB_PLUGIN_ID, localId: actionId }, variants,
  });
  const primary = projection.kind === 'merge'
    ? offer('merge', 'Merge', GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMerge, projection.reason,
      methods(mergeMethod => GithubPullRequestMergeInputV1Schema.parse({ ...target, headRevision, mergeMethod })))
    : projection.kind === 'markReady'
      ? offer('markReady', 'Mark ready', GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMarkReady, projection.reason,
        headRevision === undefined ? [] : [variant('markReady', GithubPullRequestMarkReadyInputV1Schema.parse({ ...target, headRevision }))])
      : projection.kind === 'enqueue'
        ? offer('enqueue', 'Add to merge queue', GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestEnqueue, projection.reason,
          headRevision === undefined ? [] : [variant('enqueue', GithubPullRequestEnqueueInputV1Schema.parse({ ...target, expectedHeadSha: headRevision }))])
        : offer('dequeue', 'Remove from queue', GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestDequeue, projection.reason,
          headRevision === undefined ? [] : [variant('dequeue', GithubPullRequestDequeueInputV1Schema.parse(target))]);
  const alternatives: TriagePullRequestOperationOfferV1[] = [];
  if (projection.bypassAllowed) {
    alternatives.push(offer('withoutWaiting', 'Merge without waiting for requirements', GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMerge,
      null, methods(mergeMethod => GithubPullRequestMergeInputV1Schema.parse({ ...target, headRevision, mergeMethod,
        intent: 'withoutWaiting', skippedRequirements: projection.unmetRequirements }))));
  }
  if (projection.kind !== 'markReady' && projection.autoMergeEnabled !== null) {
    const enabled = projection.autoMergeEnabled !== true;
    const native = input.status.merge;
    const targetReady = !['reading', 'unavailable', 'headUnknown', 'headChanged', 'conflicts', 'archived', 'unsupported'].includes(projection.reason ?? '');
    const allowed = targetReady && (enabled ? native?.viewerCanEnableAutoMerge === true : native?.viewerCanDisableAutoMerge === true);
    const id = enabled ? 'enableAutoMerge' : 'cancelAutoMerge';
    alternatives.push(offer(id, enabled ? 'Merge when ready' : 'Cancel auto-merge', GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestAutoMergeSet,
      allowed ? enabled && projection.methods.length === 0 ? 'methodsUnknown' : null : 'unsupported',
      enabled ? methods(mergeMethod => GithubPullRequestAutoMergeSetInputV1Schema.parse({ ...target, expectedHeadSha: headRevision, enabled, mergeMethod }))
        : headRevision === undefined ? [] : [variant(id, GithubPullRequestAutoMergeSetInputV1Schema.parse({ ...target, expectedHeadSha: headRevision, enabled }))]));
  }
  return { readiness: projection.readiness, unmetRequirements: projection.unmetRequirements, primary, alternatives };
}
