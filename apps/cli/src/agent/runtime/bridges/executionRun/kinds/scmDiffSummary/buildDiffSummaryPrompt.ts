import type { ScmDiffSummaryMetadata, ScmDiffSummaryTruncation } from '@happier-dev/protocol';

export type ScmDiffSummaryPromptFile = Readonly<{
  path: string;
  changeKind: string;
  source?: string;
  confidence?: string;
  description?: string | null;
  unifiedDiff?: string | null;
  binary?: boolean;
}>;

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function buildDiffSummaryPrompt(params: Readonly<{
  metadata: ScmDiffSummaryMetadata;
  files: readonly ScmDiffSummaryPromptFile[];
  truncation?: ScmDiffSummaryTruncation;
  instructions?: string;
}>): string {
  const fileList = params.files
    .slice(0, 100)
    .map((file) => {
      const source = file.source ? ` source=${file.source}` : '';
      const confidence = file.confidence ? ` confidence=${file.confidence}` : '';
      const binary = file.binary ? ' binary=true' : '';
      return `- ${file.path} (${file.changeKind}${source}${confidence}${binary})`;
    })
    .join('\n');

  const diffBlocks = params.files
    .slice(0, 30)
    .map((file) => {
      const diff = typeof file.unifiedDiff === 'string' && file.unifiedDiff.trim().length > 0
        ? truncate(file.unifiedDiff.trim(), 16_000)
        : (file.description?.trim() || '(no textual diff available)');
      return `### ${file.path}\n${diff}`;
    })
    .join('\n\n');

  const truncationBlock = params.truncation
    ? [
      'Truncation:',
      `- reason: ${params.truncation.reason}`,
      typeof params.truncation.droppedFiles === 'number' ? `- droppedFiles: ${params.truncation.droppedFiles}` : '',
    ].filter(Boolean).join('\n')
    : 'Truncation: none';

  const extra = typeof params.instructions === 'string' && params.instructions.trim().length > 0
    ? `\n\nUser instructions:\n${params.instructions.trim()}`
    : '';

  return [
    'SCM diff summary generator.',
    '',
    'You MUST return ONLY valid JSON in this shape:',
    '{',
    '  "summaryMarkdown": string,',
    '  "risks"?: string[],',
    '  "testImpact"?: string,',
    '  "suggestedPrBody"?: string',
    '}',
    '',
    'Rules:',
    '- summaryMarkdown must be concise markdown.',
    '- mention truncation or shared/unknown attribution when relevant.',
    '- do not include markdown fences.',
    '- do not invent files or tests not shown in the evidence.',
    '',
    `Source key: ${params.metadata.sourceKey}`,
    `Source kind: ${params.metadata.source.kind}`,
    params.metadata.turnId ? `Turn id: ${params.metadata.turnId}` : '',
    params.metadata.checkpointReceiptId ? `Checkpoint receipt id: ${params.metadata.checkpointReceiptId}` : '',
    params.metadata.contentConfidence ? `Content confidence: ${params.metadata.contentConfidence}` : '',
    params.metadata.attributionScope ? `Attribution scope: ${params.metadata.attributionScope}` : '',
    truncationBlock,
    '',
    'Changed files:',
    fileList || '(none)',
    '',
    'Diff evidence:',
    diffBlocks || '(no diff evidence)',
    extra,
  ].filter((line) => line !== '').join('\n');
}
