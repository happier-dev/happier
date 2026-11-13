import type {
  ExecutionRunIntentProfile,
  ExecutionRunProfileBoundedCompleteResult,
  ExecutionRunProfileStartParams,
} from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import { buildReviewGuidanceBlock } from '@/agent/reviews/prompt/buildStandardReviewPrompt';

/** The one repair prompt per structured intent, asking for the profile's final JSON contract. */
export function buildBoundedCompletionRepairPrompt(intent: ExecutionRunProfileStartParams['intent'], rawText: string): string {
  if (intent === 'review') {
    return [
      'Your previous response did not include the required final JSON object.',
      'If you have already completed the review, convert your conclusions into the required JSON now.',
      'If you have not yet inspected the workspace or gathered enough evidence, continue the review first using the available read-only tools, then return ONLY valid JSON (parsable by JSON.parse).',
      'Do not wrap it in markdown code fences. Do not include any extra text before or after the JSON.',
      buildReviewGuidanceBlock(),
      '',
      'Content to convert:',
      rawText,
    ].join('\n');
  }

  if (intent === 'plan') {
    return [
      'Your previous response did not include the required final JSON object.',
      'Do not run any tools. Return ONLY valid JSON (parsable by JSON.parse).',
      'Do not wrap it in markdown code fences. Do not include any extra text before or after the JSON.',
      'Return a single JSON object with this shape:',
      '{',
      '  "summary": "Ok",',
      '  "sections": [{ "title": "Steps", "items": ["Step 1"] }],',
      '  "risks": [],',
      '  "milestones": [],',
      '  "recommendedBackendId": "claude"',
      '}',
      '',
      'Content to convert:',
      rawText,
    ].join('\n');
  }

  // delegate
  return [
    'Your previous response did not include the required final JSON object.',
    'Do not run any tools. Return ONLY valid JSON (parsable by JSON.parse).',
    'Do not wrap it in markdown code fences. Do not include any extra text before or after the JSON.',
    'Return a single JSON object with this shape:',
    '{',
    '  "summary": "Ok",',
    '  "deliverables": [{ "id": "d1", "title": "Deliverable", "details": "Optional details" }]',
    '}',
    '',
    'Content to convert:',
    rawText,
  ].join('\n');
}

function isRepairableIntent(intent: ExecutionRunProfileStartParams['intent']): boolean {
  return intent === 'review' || intent === 'plan' || intent === 'delegate';
}

/**
 * The one task-completion decision for bounded runs, shared by the hidden backend controller and
 * the visible `session` controller: evaluate the final output through the profile and, when a
 * structured intent's output misses its contract, run exactly one repair turn.
 */
export async function runBoundedCompletionWithRepair(params: Readonly<{
  profile: Pick<ExecutionRunIntentProfile, 'onBoundedComplete'>;
  start: ExecutionRunProfileStartParams;
  rawText: string;
  finishedAtMs: number;
  /** Sends the repair prompt as one more turn and resolves with that turn's final text. */
  runRepairTurn: (prompt: string) => Promise<string>;
}>): Promise<Readonly<{ completion: ExecutionRunProfileBoundedCompleteResult; repaired: boolean }>> {
  const completion = params.profile.onBoundedComplete({
    start: params.start,
    rawText: params.rawText,
    finishedAtMs: params.finishedAtMs,
  });
  const errorCode = (completion.toolResultOutput as { error?: { code?: unknown } } | null | undefined)?.error?.code;
  const shouldRepair = completion.status === 'failed' && errorCode === 'invalid_output' && isRepairableIntent(params.start.intent);
  if (!shouldRepair) return { completion, repaired: false };

  const repairedRawText = await params.runRepairTurn(buildBoundedCompletionRepairPrompt(params.start.intent, params.rawText));
  return {
    completion: params.profile.onBoundedComplete({
      start: params.start,
      rawText: repairedRawText,
      finishedAtMs: params.finishedAtMs,
    }),
    repaired: true,
  };
}
