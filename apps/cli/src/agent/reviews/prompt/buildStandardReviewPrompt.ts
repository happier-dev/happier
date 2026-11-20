import { REVIEW_SCM_SCOPE_INPUT_KEY, ReviewStartInputSchema } from '@happier-dev/protocol/reviews/reviewStart';
import { ReviewScmScopeV1Schema } from '@happier-dev/protocol/reviews/scope';

import { ReviewFollowUpIntentInputSchema } from '../followUp/reviewFollowUpIntentInput';
import { buildNativeReviewOutputSchema } from '../normalize/nativeReviewOutputSchema';

export const REVIEW_CURRENT_FINDINGS_GUIDANCE = '- Return the complete current findings set, including unresolved findings reported in previous rounds that still apply. Do not omit a current finding merely because it was reported before.';

export function buildReviewGuidanceBlock(): string {
  return [
    'While working, you may emit brief progress updates as plain text.',
    'Inspect the accessible workspace before you finalize the review.',
    'Do not stop at a plan or restate the request as your final answer.',
    'Use the available read-only tools to inspect relevant files, tests, and supporting context before deciding whether there are findings.',
    'If shell inspection is unavailable, use the available read-only workspace and SCM tools to gather evidence within the requested scope.',
    'When finished, output ONE final JSON object matching this JSON Schema as the LAST thing in your message:',
    JSON.stringify(buildNativeReviewOutputSchema(undefined)),
    '',
    'Rules for the final JSON:',
    '- It MUST be valid JSON (parsable by JSON.parse).',
    '- Do NOT wrap it in markdown code fences.',
    '- Do NOT include any extra text after the JSON.',
    '- Put the reviewer narrative in overviewMarkdown.',
    '- For a complete review, include quality with an integer score from 1 (serious issues) to 5 (ready to ship) and a one-line rationale grounded in the review. Omit the score when the available evidence does not support one.',
    '- Only emit findings you can support with evidence.',
    REVIEW_CURRENT_FINDINGS_GUIDANCE,
    '- Set reviewOutcome to complete only after inspecting the requested scope; an empty findings array does not prove a clean review.',
    '- If inspection is unavailable, set reviewOutcome to failed and explain the missing evidence in overviewMarkdown. If only part of the scope could be inspected, use partial and preserve supported findings.',
    '- If you need missing context from the user, add a question instead of guessing.',
  ].join('\n');
}

function buildReviewFollowUpGuidanceBlock(intentInput: unknown): string {
  return [
    'You are continuing an existing code review conversation.',
    'Answer the latest user message directly and succinctly in markdown.',
    'Only update findings when your conclusion changed or needs clarification.',
    'If you still need missing context from the user, add a question instead of guessing.',
    'When finished, output ONE final JSON object matching this JSON Schema as the LAST thing in your message:',
    JSON.stringify(buildNativeReviewOutputSchema(intentInput)),
    '',
    'Rules for the final JSON:',
    '- It MUST be valid JSON (parsable by JSON.parse).',
    '- Do NOT wrap it in markdown code fences.',
    '- Do NOT include any extra text after the JSON.',
  ].join('\n');
}

function buildReviewScopeGuidanceBlock(intentInput: unknown): string | null {
  const input = typeof intentInput === 'object' && intentInput !== null && !Array.isArray(intentInput)
    ? intentInput as Record<string, unknown> : undefined;
  const resolved = ReviewScmScopeV1Schema.safeParse(input?.[REVIEW_SCM_SCOPE_INPUT_KEY]);
  if (resolved.success && resolved.data.status === 'supported'
    && (resolved.data.comparison || resolved.data.revisionRange)) {
    const scope = resolved.data;
    const before = scope.comparison?.endpoints.before ?? scope.revisionRange?.baseOid;
    const after = scope.comparison?.endpoints.after ?? scope.revisionRange?.headOid;
    return [
      'Review scope:',
      scope.comparison ? `- Captured comparison: ${scope.comparison.id} (${scope.comparison.source.kind})`
        : '- Selected pull request revision range:',
      `- Before revision: ${before ?? 'unavailable in captured evidence'}`,
      `- After revision: ${after ?? 'unavailable in captured evidence'}`,
      `- Selected paths: ${scope.selectedPaths.length > 0 ? JSON.stringify(scope.selectedPaths) : 'all paths in the selected comparison or revision range'}`,
      '- Review this captured comparison or exact revision range. Do not infer a different base or include unrelated checkout changes.',
      '- Inspect supporting context only as needed to validate scoped findings; preserve unavailable evidence as incomplete review scope.',
    ].join('\n');
  }
  const parsed = ReviewStartInputSchema.safeParse(intentInput);
  const supportedScope = resolved.success && resolved.data.status === 'supported' ? resolved.data : null;
  if (supportedScope ? supportedScope.scope === 'repository' : parsed.success && parsed.data.scope === 'repository') {
    return [
      'Review scope:',
      '- Inspect the entire repository, including unchanged and tracked files outside the current diff.',
      '- Use the requested focus to guide inspection; do not restrict findings to changed files.',
    ].join('\n');
  }
  if (supportedScope) {
    return [
      'Review scope:',
      `- Selected paths: ${JSON.stringify(supportedScope.selectedPaths)}`,
      ...(parsed.success ? [`- Change type: ${parsed.data.changeType}`] : []),
      `- Comparison base: ${supportedScope.baseRef.ref ?? 'unavailable in admitted scope'}`,
      '- Review only the admitted changes in these paths. An empty selection contains no changed files to review.',
      '- Inspect supporting context only as needed to validate scoped findings; do not include unrelated checkout changes.',
    ].join('\n');
  }
  if (!parsed.success) return null;

  const payload = parsed.data;
  const baseLine = payload.base.kind === 'branch'
    ? `Base branch: ${payload.base.baseBranch}`
    : payload.base.kind === 'commit'
      ? `Base commit: ${payload.base.baseCommit}`
      : 'Base: infer the repository\'s normal comparison base from the current branch context.';
  const scopeInstruction = payload.changeType === 'uncommitted'
    ? 'Focus on the current uncommitted worktree changes, including untracked files when they are relevant to the review.'
    : payload.changeType === 'all'
      ? 'Review both the committed diff for the selected base and the current uncommitted worktree changes.'
      : 'Focus on the committed changes for the selected review base.';

  return [
    'Review scope:',
    `- Change type: ${payload.changeType}`,
    `- ${baseLine}`,
    `- ${scopeInstruction}`,
    '- Do not broaden the review to unrelated repository areas unless they are directly needed to validate a scoped finding.',
  ].join('\n');
}

export function buildStandardReviewPrompt(params: Readonly<{ instructions: string; intentInput?: unknown }>): string {
  const followUp = ReviewFollowUpIntentInputSchema.safeParse(params.intentInput);
  if (followUp.success) {
    const payload = followUp.data;
    return [
      params.instructions,
      '',
      'Current review summary:',
      payload.summary,
      '',
      'Current review overview:',
      payload.overviewMarkdown,
      '',
      'Current effective findings:',
      JSON.stringify(payload.findings, null, 2),
      '',
      'Current open questions:',
      JSON.stringify(payload.questions, null, 2),
      '',
      'Current assumptions:',
      JSON.stringify(payload.assumptions, null, 2),
      '',
      `Target thread: ${payload.threadId}`,
      payload.replyToQuestionId ? `Replying to question: ${payload.replyToQuestionId}` : '',
      payload.findingIds.length > 0 ? `Target findings: ${payload.findingIds.join(', ')}` : 'Target findings: general review follow-up',
      '',
      'Latest user message:',
      payload.messageMarkdown,
      '',
      buildReviewFollowUpGuidanceBlock(params.intentInput),
    ].filter((line) => line.length > 0).join('\n');
  }
  const scopeBlock = buildReviewScopeGuidanceBlock(params.intentInput);
  const input = params.intentInput && typeof params.intentInput === 'object' ? params.intentInput : {};
  const previousRound = 'previousRoundContext' in input && input.previousRoundContext !== null
    && input.previousRoundContext !== undefined
    ? `Previous review round and findings (historical context; inspect the current scope again):\n${JSON.stringify(input.previousRoundContext)}`
    : null;
  return [
    params.instructions,
    scopeBlock,
    previousRound,
    buildReviewGuidanceBlock(),
  ].filter((line) => typeof line === 'string' && line.length > 0).join('\n\n');
}
