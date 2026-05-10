export type ScmDiffSummaryCacheSource =
  | Readonly<{
      kind: 'turnCheckpoint';
      checkpointReceiptId: string;
      checkpointRef: string;
      turnEvidenceMode?: string;
    }>
  | Readonly<{
      kind: 'workingTree';
      volatileSourceVersion: string;
    }>;

export type ScmDiffSummaryResolvedSelectorInput = Readonly<{
  catalogId?: string;
  label?: string;
}>;

export type ScmDiffSummaryCacheKeyInput = Readonly<{
  source: ScmDiffSummaryCacheSource;
  summarySchemaVersion: number;
  resolvedSelector: ScmDiffSummaryResolvedSelectorInput;
  volatileDiffDigest?: string;
}>;

function requireNonEmpty(value: string | undefined, fieldName: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }
  return normalized;
}

function requirePositiveVersion(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('summarySchemaVersion must be a positive integer');
  }
  return value;
}

function resolveSelectorCatalogId(selector: ScmDiffSummaryResolvedSelectorInput): string {
  const catalogId = typeof selector.catalogId === 'string' ? selector.catalogId.trim() : '';
  if (!catalogId) {
    throw new Error('resolved catalog id is required for SCM diff-summary cache keys');
  }
  return catalogId;
}

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value);
}

export function buildScmDiffSummaryCacheKey(input: ScmDiffSummaryCacheKeyInput): string {
  const version = requirePositiveVersion(input.summarySchemaVersion);
  const selector = encodeKeyPart(resolveSelectorCatalogId(input.resolvedSelector));

  if (input.source.kind === 'turnCheckpoint') {
    const receiptId = encodeKeyPart(requireNonEmpty(input.source.checkpointReceiptId, 'checkpointReceiptId'));
    const checkpointRef = encodeKeyPart(requireNonEmpty(input.source.checkpointRef, 'checkpointRef'));
    const evidenceMode = encodeKeyPart(requireNonEmpty(input.source.turnEvidenceMode ?? 'reconciled', 'turnEvidenceMode'));
    return `checkpoint:${checkpointRef}:receipt:${receiptId}:evidence:${evidenceMode}:schema:${version}:selector:${selector}`;
  }

  const sourceVersion = encodeKeyPart(requireNonEmpty(input.source.volatileSourceVersion, 'volatileSourceVersion'));
  return `volatile-working-tree:${sourceVersion}:schema:${version}:selector:${selector}`;
}

export function isDurableScmDiffSummaryCacheKey(key: string): boolean {
  return key.startsWith('checkpoint:');
}
