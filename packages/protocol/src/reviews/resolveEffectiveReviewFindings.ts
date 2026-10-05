import type { ExecutionRunStructuredRunRef } from '../messages/structured/executionRunStructuredRunRef.js';
import type { ReviewFollowUpV1 } from '../messages/structured/reviewFollowUpV1.js';
import type { ReviewFinding } from './ReviewFinding.js';

export type ReviewFindingThreadEntry = Readonly<{
  threadId: string;
  requestMarkdown: string;
  answerMarkdown: string;
  generatedAtMs: number;
  updatedFinding: ReviewFinding | null;
  previousFinding: ReviewFinding | null;
}>;

export type EffectiveReviewFindings = Readonly<{
  findings: readonly ReviewFinding[];
  threadRefsByFindingId: Readonly<Record<string, readonly string[]>>;
  threadsByFindingId: Readonly<Record<string, readonly ReviewFindingThreadEntry[]>>;
  originalByFindingId: Readonly<Record<string, ReviewFinding>>;
}>;

/** Apply validated answers in canonical transcript order, scoped to the complete review Run. */
export function resolveEffectiveReviewFindingFollowUps(params: Readonly<{
  runRef: ExecutionRunStructuredRunRef;
  initialFindings: readonly ReviewFinding[];
  followUps: readonly ReviewFollowUpV1[];
}>): EffectiveReviewFindings {
  const findingById = new Map<string, ReviewFinding>();
  const threadRefsByFindingId = new Map<string, string[]>();
  const threadsByFindingId = new Map<string, ReviewFindingThreadEntry[]>();
  const originalByFindingId = new Map<string, ReviewFinding>();
  for (const finding of params.initialFindings) {
    findingById.set(finding.id, finding);
  }
  for (const followUp of params.followUps) {
    const parent = followUp.parentRunRef;
    if (parent.runId !== params.runRef.runId || parent.callId !== params.runRef.callId || parent.backendId !== params.runRef.backendId) continue;
    const updatedById = new Map((followUp.updatedFindings ?? []).map((finding) => [finding.id, finding]));
    const askedIds = new Set([...(followUp.findingIds ?? []), ...updatedById.keys()]);
    for (const findingId of askedIds) {
      const previous = findingById.get(findingId) ?? null;
      const proposed = updatedById.get(findingId) ?? null;
      // Wording updates do not erase the host's persisted finding/comment identity.
      const updated = proposed && !proposed.comment && previous?.comment
        ? { ...proposed, comment: previous.comment } : proposed;
      if (updated) {
        if (previous && !originalByFindingId.has(findingId)) originalByFindingId.set(findingId, previous);
        findingById.set(findingId, updated);
      }
      if (!findingById.has(findingId)) continue;
      const refs = threadRefsByFindingId.get(findingId) ?? [];
      if (!refs.includes(followUp.threadId)) refs.push(followUp.threadId);
      threadRefsByFindingId.set(findingId, refs);
      const entries = threadsByFindingId.get(findingId) ?? [];
      entries.push({
        threadId: followUp.threadId, requestMarkdown: followUp.requestMarkdown,
        answerMarkdown: followUp.answerMarkdown, generatedAtMs: followUp.generatedAtMs,
        updatedFinding: updated, previousFinding: updated ? previous : null,
      });
      threadsByFindingId.set(findingId, entries);
    }
  }
  return {
    findings: [...findingById.values()],
    threadRefsByFindingId: Object.fromEntries(threadRefsByFindingId),
    threadsByFindingId: Object.fromEntries(threadsByFindingId),
    originalByFindingId: Object.fromEntries(originalByFindingId),
  };
}
