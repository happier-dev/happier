import {
  ExecutionRunScmDiffSummaryInputV1Schema,
  SCM_DIFF_SUMMARY_CACHE_SCHEMA_VERSION,
  ScmDiffSummaryGenerateOutputSchema,
  type ScmDiffSummaryGenerateOutput,
} from '@happier-dev/protocol';
import type { ExecutionRunIntentProfile } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';

import { buildDiffSummaryPrompt } from './buildDiffSummaryPrompt';
import { loadScmDiffSummaryContext } from './loadScmDiffSummaryContext';
import { parseDiffSummaryModelOutput } from './parseDiffSummaryModelOutput';
import { stripTrailingJsonObjectFromText } from '@/agent/executionRuns/profiles/shared/stripTrailingJsonObjectFromText';
import {
  scmDiffSummaryCacheStore,
  type ScmDiffSummaryCachedValue,
} from '@/agent/executionRuns/tasks/scmDiffSummary/cache/cacheStore';
import type { ScmDiffSummaryCacheKeyInput } from '@/agent/executionRuns/tasks/scmDiffSummary/cache/cacheKey';

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readPositiveVersion(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : SCM_DIFF_SUMMARY_CACHE_SCHEMA_VERSION;
}

function resolveSelectorCatalogId(params: Readonly<{
  intentInput: Readonly<Record<string, unknown>>;
  backendTarget: unknown;
}>): string {
  const explicit = readRecord(params.intentInput.resolvedSelector);
  const explicitCatalogId = readNonEmptyString(explicit.catalogId);
  if (explicitCatalogId) return explicitCatalogId;

  const backendTarget = readRecord(params.backendTarget);
  const kind = readNonEmptyString(backendTarget.kind) ?? 'backend';
  const backendId = readNonEmptyString(backendTarget.backendId);
  if (backendId) return `${kind}:${backendId}`;
  const agentId = readNonEmptyString(backendTarget.agentId);
  if (agentId) return `${kind}:${agentId}`;
  return `${kind}:default`;
}

function buildCacheKeyInput(params: Readonly<{
  intentInput: Readonly<Record<string, unknown>>;
  backendTarget: unknown;
}>): ScmDiffSummaryCacheKeyInput | null {
  const source = readRecord(params.intentInput.source);
  if (source.kind !== 'turnCheckpoint') return null;
  const checkpointReceiptId = readNonEmptyString(params.intentInput.checkpointReceiptId);
  if (!checkpointReceiptId) return null;
  const checkpointRef = readCheckpointRef({
    intentInput: params.intentInput,
    checkpointReceiptId,
  });
  if (!checkpointRef) return null;
  const turnEvidenceMode = readNonEmptyString(params.intentInput.turnEvidenceMode);

  return {
    source: {
      kind: 'turnCheckpoint',
      checkpointReceiptId,
      checkpointRef,
      ...(turnEvidenceMode ? { turnEvidenceMode } : {}),
    },
    summarySchemaVersion: readPositiveVersion(params.intentInput.summarySchemaVersion),
    resolvedSelector: {
      catalogId: resolveSelectorCatalogId(params),
    },
  };
}

function readCheckpointRef(params: Readonly<{
  intentInput: Readonly<Record<string, unknown>>;
  checkpointReceiptId: string | undefined;
}>): string | undefined {
  const explicit = readNonEmptyString(params.intentInput.checkpointRef);
  if (explicit) return explicit;
  if (!params.checkpointReceiptId) return undefined;

  const turnChangeSet = readRecord(params.intentInput.turnChangeSet);
  const repositoryCheckpoint = readRecord(turnChangeSet.repositoryCheckpoint);
  const receipts = Array.isArray(repositoryCheckpoint.receipts) ? repositoryCheckpoint.receipts : [];
  for (const receipt of receipts) {
    const record = readRecord(receipt);
    if (record.id !== params.checkpointReceiptId) continue;
    const ref = readNonEmptyString(record.ref);
    if (ref) return ref;
  }
  return undefined;
}

function isScmDiffSummaryGenerateOutput(value: ScmDiffSummaryCachedValue | null): value is ScmDiffSummaryGenerateOutput {
  return Boolean(value && typeof value === 'object' && 'success' in value);
}

function shouldBypassCache(intentInput: Readonly<Record<string, unknown>>): boolean {
  const cachePolicy = readRecord(intentInput.cachePolicy);
  return cachePolicy.mode === 'bypass';
}

export const ScmDiffSummaryProfile: ExecutionRunIntentProfile = {
  intent: 'scm_diff_summary',
  transcriptMaterialization: 'full',
  computeSidechainStreamText: ({ fullText }) => {
    const rawText = String(fullText ?? '');
    const stripped = stripTrailingJsonObjectFromText(rawText).trimEnd();
    if (stripped !== rawText.trimEnd()) return stripped;

    const jsonStartIndex = rawText.trimStart().startsWith('{') ? rawText.indexOf('{') : rawText.lastIndexOf('\n{');
    if (jsonStartIndex >= 0) {
      const jsonTail = rawText.slice(jsonStartIndex, Math.min(rawText.length, jsonStartIndex + 800));
      if (jsonTail.includes('"summaryMarkdown"') || jsonTail.includes('"risks"') || jsonTail.includes('"testImpact"')) {
        return rawText.slice(0, jsonStartIndex).trimEnd();
      }
    }

    return rawText;
  },
  prepareStartParams: async ({ request, cwd }) => {
    const input = ExecutionRunScmDiffSummaryInputV1Schema.parse(request.intentInput ?? {});
    const inputRecord = input as Readonly<Record<string, unknown>>;
    const cacheKeyInput = buildCacheKeyInput({ intentInput: inputRecord, backendTarget: request.backendTarget });
    const cachedOutput = cacheKeyInput && !shouldBypassCache(inputRecord)
      ? scmDiffSummaryCacheStore.get(cacheKeyInput)
      : null;
    if (cacheKeyInput && isScmDiffSummaryGenerateOutput(cachedOutput)) {
      return {
        instructions: 'SCM diff summary cache hit; no generation required.',
        intentInput: {
          ...input,
          summarySchemaVersion: cacheKeyInput.summarySchemaVersion,
          resolvedSelector: cacheKeyInput.resolvedSelector,
          cachedOutput,
        },
      };
    }

    const context = await loadScmDiffSummaryContext({
      input,
      workingDirectory: input.cwd || cwd,
    });
    const summarySchemaVersion = cacheKeyInput?.summarySchemaVersion ?? SCM_DIFF_SUMMARY_CACHE_SCHEMA_VERSION;
    const resolvedSelector = cacheKeyInput?.resolvedSelector
      ?? { catalogId: resolveSelectorCatalogId({ intentInput: inputRecord, backendTarget: request.backendTarget }) };
    const checkpointRef = readCheckpointRef({
      intentInput: inputRecord,
      checkpointReceiptId: context.metadata.checkpointReceiptId,
    });

    return {
      instructions: buildDiffSummaryPrompt({
        metadata: context.metadata,
        files: context.files,
        truncation: context.truncation,
        instructions: typeof request.instructions === 'string' ? request.instructions : undefined,
      }),
      intentInput: {
        ...input,
        sourceKey: context.metadata.sourceKey,
        metadata: context.metadata,
        summarySchemaVersion,
        resolvedSelector,
        ...(checkpointRef ? { checkpointRef } : {}),
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

    const cacheKeyInput = buildCacheKeyInput({ intentInput, backendTarget: start.backendTarget });
    if (cacheKeyInput) {
      scmDiffSummaryCacheStore.set({
        keyInput: cacheKeyInput,
        checkpointRef: readCheckpointRef({ intentInput, checkpointReceiptId }),
        value: result,
      });
    }

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
