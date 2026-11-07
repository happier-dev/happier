import type { ConversationPullRequestFixResolutionV1 } from '@happier-dev/channels-protocol/v1';

import { readGithubCheckOutcomeV1 } from './checkOutcome.js';
import type { GithubChecksSurfaceV1, GithubNativePullRequestFactsV1 } from './checks.js';
import { mapGithubMergeability } from './mapping/state.js';

/** D-I14 native snapshot projection, shared by status and the incumbent PR poll.
 * It consumes acquired evidence only; pending checks, approvals and queues are
 * not fix subjects. Unreadable or superseded evidence cannot end a sequence. */
export function projectGithubPullRequestFixResolution(input: Readonly<{
  headRevision: string;
  draft: boolean;
  mergeable: boolean | null;
  mergeableState: string | null;
  surface: GithubChecksSurfaceV1 | null | undefined;
}>): Readonly<{
  fixResolution: ConversationPullRequestFixResolutionV1;
  conflicts: boolean | null;
  threads: Readonly<{ rows: GithubNativePullRequestFactsV1['threads']; incomplete: boolean }>;
}> {
  const surface = input.surface;
  const observed = surface?.observation;
  const superseded = observed?.state === 'superseded';
  const native = superseded ? undefined : surface?.nativePullRequest;
  const nativeConflicts = mapGithubMergeability({ draft: input.draft, mergeable: input.mergeable,
    mergeable_state: input.mergeableState }) === 'conflicts' || native?.mergeStateStatus === 'DIRTY';
  const conflicts = superseded ? null : nativeConflicts ? true : input.mergeable === true ? false : null;
  const threads = { rows: native?.threads ?? [],
    incomplete: native?.threadsIncomplete !== false || surface?.checkRunsFailure != null };
  const currentHead = observed?.currentHeadSha === input.headRevision && observed.headSha === input.headRevision && !superseded;
  const incomplete = !currentHead || (surface?.state !== 'resolved' && surface?.state !== 'none')
    || surface?.checkRunsFailure != null || surface?.commitStatusFailure != null
    || threads.incomplete || surface?.reviewDecision == null || conflicts === null;
  const hasFixSubject = conflicts === true || surface?.reviewDecision === 'changes-requested'
    || threads.rows.some(thread => !thread.isResolved)
    || surface?.observations.some(check => check.required === true && readGithubCheckOutcomeV1(check) === 'failed') === true;
  return { conflicts, threads, fixResolution: {
    headRevision: observed?.currentHeadSha || input.headRevision,
    resolved: !incomplete && !hasFixSubject,
    incomplete,
  } };
}
