import { ReviewStartInputSchema } from '@happier-dev/protocol';

import { ReviewFollowUpIntentInputSchema } from '@/agent/reviews/followUp/reviewFollowUpIntentInput';

export function buildReviewGuidanceBlock(): string {
  return [
    'While working, you may emit brief progress updates as plain text.',
    'Inspect the accessible workspace before you finalize the review.',
    'Do not stop at a plan or restate the request as your final answer.',
    'Use the available read-only tools to inspect relevant files, tests, and supporting context before deciding whether there are findings.',
    'When finished, output ONE final JSON object with this shape as the LAST thing in your message:',
    '{',
    '  "summary": string,',
    '  "overviewMarkdown": string,',
    '  "findings": Array<{',
    '    "id": string,',
    '    "title": string,',
    '    "severity": "blocker"|"high"|"medium"|"low"|"nit",',
    '    "category": "correctness"|"security"|"performance"|"maintainability"|"testing"|"style"|"docs",',
    '    "summary": string,',
    '    "whyItMatters"?: string,',
    '    "evidence"?: string,',
    '    "confidence"?: number,',
    '    "filePath"?: string,',
    '    "startLine"?: number,',
    '    "endLine"?: number,',
    '    "suggestion"?: string,',
    '    "patch"?: string',
    '  }>,',
    '  "questions": Array<{ "id": string, "text": string, "findingIds"?: string[], "status": "open"|"answered"|"superseded" }>,',
    '  "assumptions": Array<{ "id": string, "text": string, "findingIds"?: string[] }>',
    '}',
    '',
    'Rules for the final JSON:',
    '- It MUST be valid JSON (parsable by JSON.parse).',
    '- Do NOT wrap it in markdown code fences.',
    '- Do NOT include any extra text after the JSON.',
    '- Put the reviewer narrative in overviewMarkdown.',
    '- Only emit findings you can support with evidence.',
    '- If you need missing context from the user, add a question instead of guessing.',
  ].join('\n');
}

function buildReviewFollowUpGuidanceBlock(): string {
  return [
    'You are continuing an existing code review conversation.',
    'Answer the latest user message directly and succinctly in markdown.',
    'Only update findings when your conclusion changed or needs clarification.',
    'If you still need missing context from the user, add a question instead of guessing.',
    'When finished, output ONE final JSON object with this shape as the LAST thing in your message:',
    '{',
    '  "answerMarkdown": string,',
    '  "updatedFindings"?: Array<{',
    '    "id": string,',
    '    "title": string,',
    '    "severity": "blocker"|"high"|"medium"|"low"|"nit",',
    '    "category": "correctness"|"security"|"performance"|"maintainability"|"testing"|"style"|"docs",',
    '    "summary": string,',
    '    "whyItMatters"?: string,',
    '    "evidence"?: string,',
    '    "confidence"?: number,',
    '    "filePath"?: string,',
    '    "startLine"?: number,',
    '    "endLine"?: number,',
    '    "suggestion"?: string,',
    '    "patch"?: string',
    '  }>,',
    '  "questions"?: Array<{ "id": string, "text": string, "findingIds"?: string[], "status": "open"|"answered"|"superseded" }>,',
    '  "assumptions"?: Array<{ "id": string, "text": string, "findingIds"?: string[] }>',
    '}',
    '',
    'Rules for the final JSON:',
    '- It MUST be valid JSON (parsable by JSON.parse).',
    '- Do NOT wrap it in markdown code fences.',
    '- Do NOT include any extra text after the JSON.',
  ].join('\n');
}

function buildReviewScopeGuidanceBlock(intentInput: unknown): string | null {
  const parsed = ReviewStartInputSchema.safeParse(intentInput);
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
      buildReviewFollowUpGuidanceBlock(),
    ].filter((line) => line.length > 0).join('\n');
  }

  const scopeBlock = buildReviewScopeGuidanceBlock(params.intentInput);
  return [
    params.instructions,
    scopeBlock,
    buildReviewGuidanceBlock(),
  ].filter((line) => typeof line === 'string' && line.length > 0).join('\n\n');
}
