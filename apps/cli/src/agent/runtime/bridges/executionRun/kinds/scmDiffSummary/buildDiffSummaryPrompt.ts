import type { ScmComparison, ScmDiffSummaryMetadata, ScmDiffSummaryOutputKind } from '@happier-dev/protocol';
import { presentScmDiffSummaryModelContext } from './presentScmDiffSummaryModelContext';

export type ScmDiffSummaryPromptFile = Readonly<{
  path: string;
  changeKind: string;
  source?: string;
  confidence?: string;
  description?: string | null;
  unifiedDiff?: string | null;
  binary?: boolean;
}>;

export function buildDiffSummaryPrompt(params: Readonly<{
  metadata: ScmDiffSummaryMetadata;
  files: readonly ScmDiffSummaryPromptFile[];
  instructions?: string;
  comparison?: ScmComparison;
  outputs?: readonly ScmDiffSummaryOutputKind[];
  reviewExplanation?: boolean;
}>): string {
  const fileList = params.files
    .map((file) => {
      const source = file.source ? ` source=${file.source}` : '';
      const confidence = file.confidence ? ` confidence=${file.confidence}` : '';
      const binary = file.binary ? ' binary=true' : '';
      return `- ${file.path} (${file.changeKind}${source}${confidence}${binary})`;
    })
    .join('\n');

  const diffBlocks = params.files
    .map((file) => {
      const diff = typeof file.unifiedDiff === 'string' && file.unifiedDiff.trim().length > 0
        ? file.unifiedDiff
        : (file.description?.trim() || '(no textual diff available)');
      return `### ${file.path}\n${diff}`;
    })
    .join('\n\n');

  const extra = typeof params.instructions === 'string' && params.instructions.trim().length > 0
    ? `\n\nUser instructions:\n${params.instructions.trim()}`
    : '';

  const outputs = params.outputs ?? ['summary'];
  const shape = params.reviewExplanation ? ['  "reviewExplanations": [{ "stopId": string, "markdown": string }]'] : [
    ...(outputs.includes('summary') ? ['  "summaryMarkdown": string,', '  "risks"?: string[],', '  "testImpact"?: string,', '  "suggestedPrBody"?: string,'] : []),
    ...(outputs.includes('walkthrough') ? ['  "walkthrough": { "title": string, "intro": string, "stops": [{ "id": string, "title": string, "explanationMarkdown": string, "changeRefs": string[], "importance"?: "low"|"medium"|"high", "findingRefs"?: string[] }], "readingHint"?: string, "otherChangeRefs": string[] },'] : []),
    ...(outputs.includes('commitPlan') ? ['  "commitPlan": { "groups": [{ "id": string, "message": string, "rationale": string, "changeRefs": string[] }], "leftOutChangeRefs": string[] },'] : []),
  ];
  const aliases = params.comparison ? presentScmDiffSummaryModelContext(params.comparison.inventory.files.map((file) => ({
    path: file.path, binary: file.binary, generated: file.generated, lockfile: file.lockfile,
    evidence: file.evidence.state === 'unavailable' ? file.evidence : { state: 'available' },
    occurrences: file.occurrences,
  })), params.comparison) : undefined;
  return [
    'SCM diff summary generator.',
    '',
    'You MUST return ONLY valid JSON in this shape:',
    '{',
    ...shape,
    '}',
    '',
    'Rules:',
    '- summaryMarkdown must be concise markdown.',
    '- mention unavailable evidence or shared/unknown attribution when relevant.',
    '- do not include markdown fences.',
    '- do not invent files or tests not shown in the evidence.',
    '- return only the requested output keys. Do not include executable patches, commands or acceptance.',
    params.reviewExplanation ? '- return one explanation per requested stop ID; do not return walkthrough, summary, commitPlan or provenance.'
      : '- assign each comparison change alias exactly once to a walkthrough stop or otherChangeRefs; for commitPlan assign each once to a group or leftOutChangeRefs.',
    '- unavailable, binary and generated evidence stays reachable. Do not infer human review from analysis.',
    '',
    `Source key: ${params.metadata.sourceKey}`,
    `Source kind: ${params.metadata.source.kind}`,
    params.metadata.turnId ? `Turn id: ${params.metadata.turnId}` : '',
    params.metadata.checkpointReceiptId ? `Checkpoint receipt id: ${params.metadata.checkpointReceiptId}` : '',
    params.metadata.contentConfidence ? `Content confidence: ${params.metadata.contentConfidence}` : '',
    params.metadata.attributionScope ? `Attribution scope: ${params.metadata.attributionScope}` : '',
    ...(params.comparison ? [
      `Comparison: ${params.comparison.id}`,
      `Source inventory: ${params.comparison.inventory.state}`,
      `Inventory reasons: ${JSON.stringify(params.comparison.inventory.reasons)}`,
      `Change aliases: ${JSON.stringify(aliases)}`,
    ] : []),
    '',
    'Changed files:',
    fileList || '(none)',
    '',
    'Diff evidence:',
    diffBlocks || '(no diff evidence)',
    extra,
  ].filter((line) => line !== '').join('\n');
}
