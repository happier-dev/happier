import {
  ExecutionRunScmDiffSummaryInputV1Schema,
  ScmDiffSummaryGenerateOutputSchema,
} from '@happier-dev/protocol';
import type { ExecutionRunIntentProfile } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';

import { buildDiffSummaryPrompt } from './buildDiffSummaryPrompt';
import { loadScmDiffSummaryContext } from './loadScmDiffSummaryContext';
import { parseDiffSummaryModelOutput } from './parseDiffSummaryModelOutput';

export const ScmDiffSummaryProfile: ExecutionRunIntentProfile = {
  intent: 'scm_diff_summary',
  transcriptMaterialization: 'none',
  prepareStartParams: async ({ request, cwd }) => {
    const input = ExecutionRunScmDiffSummaryInputV1Schema.parse(request.intentInput ?? {});
    const context = await loadScmDiffSummaryContext({
      input,
      workingDirectory: input.cwd || cwd,
    });

    return {
      instructions: buildDiffSummaryPrompt({
        metadata: context.metadata,
        files: context.files,
        truncation: context.truncation,
        instructions: request.instructions,
      }),
      intentInput: {
        ...input,
        sourceKey: context.metadata.sourceKey,
        metadata: context.metadata,
        ...(context.truncation ? { truncation: context.truncation } : {}),
      },
    };
  },
  buildPrompt: (params) => params.instructions,
  onBoundedComplete: ({ start, rawText }) => {
    const parsed = parseDiffSummaryModelOutput(rawText);
    const intentInput = start.intentInput && typeof start.intentInput === 'object'
      ? start.intentInput as Record<string, unknown>
      : {};
    const sourceKey = typeof intentInput.sourceKey === 'string' && intentInput.sourceKey.trim().length > 0
      ? intentInput.sourceKey.trim()
      : 'unknown';
    const checkpointReceiptId =
      typeof intentInput.checkpointReceiptId === 'string' && intentInput.checkpointReceiptId.trim().length > 0
        ? intentInput.checkpointReceiptId.trim()
        : undefined;
    const metadata = intentInput.metadata;
    const truncation = intentInput.truncation;

    if (!parsed || !metadata) {
      const failure = ScmDiffSummaryGenerateOutputSchema.parse({
        success: false,
        error: 'Invalid diff summary output',
        errorCode: parsed ? 'SUMMARY_FAILED' : 'SUMMARY_FAILED',
        sourceKey,
        ...(checkpointReceiptId ? { checkpointReceiptId } : {}),
        ...(metadata ? { metadata } : {}),
      });

      return {
        status: 'failed',
        summary: 'Diff summary generation failed.',
        toolResultOutput: failure,
        structuredMeta: {
          kind: 'scm_diff_summary.v1',
          payload: failure,
        },
      };
    }

    const result = ScmDiffSummaryGenerateOutputSchema.parse({
      success: true,
      summaryMarkdown: parsed.summaryMarkdown,
      sourceKey,
      ...(checkpointReceiptId ? { checkpointReceiptId } : {}),
      metadata,
      ...(truncation ? { truncation } : {}),
      ...(parsed.risks && parsed.risks.length > 0 ? { risks: parsed.risks } : {}),
      ...(parsed.testImpact ? { testImpact: parsed.testImpact } : {}),
      ...(parsed.suggestedPrBody ? { suggestedPrBody: parsed.suggestedPrBody } : {}),
    });

    return {
      status: 'succeeded',
      summary: 'Diff summary generated.',
      toolResultOutput: result,
      structuredMeta: {
        kind: 'scm_diff_summary.v1',
        payload: result,
      },
    };
  },
  buildInvalidOutputRepairPrompt: () => [
    'Your previous response did not include the required JSON object.',
    'Do not run tools. Return ONLY valid JSON.',
    'Do not wrap it in markdown fences. Do not include extra text.',
    '{',
    '  "summaryMarkdown": "## Summary\\n\\nOne concise paragraph.",',
    '  "risks": [],',
    '  "testImpact": "Not assessed.",',
    '  "suggestedPrBody": "Optional PR body."',
    '}',
  ].join('\n'),
};
