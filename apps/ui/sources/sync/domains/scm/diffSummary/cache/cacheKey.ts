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

export type ScmDiffSummaryCacheKeyInput = Readonly<{
    source: ScmDiffSummaryCacheSource;
    summarySchemaVersion: number;
    resolvedSelector: Readonly<{ catalogId: string }>;
}>;

function requirePart(value: string, fieldName: string): string {
    const normalized = value.trim();
    if (!normalized) {
        throw new Error(`${fieldName} is required`);
    }
    return encodeURIComponent(normalized);
}

function requireVersion(version: number): number {
    if (!Number.isInteger(version) || version <= 0) {
        throw new Error('summarySchemaVersion must be a positive integer');
    }
    return version;
}

export function buildScmDiffSummaryCacheKey(input: ScmDiffSummaryCacheKeyInput): string {
    const version = requireVersion(input.summarySchemaVersion);
    const selector = requirePart(input.resolvedSelector.catalogId, 'resolved selector catalog id');

    if (input.source.kind === 'turnCheckpoint') {
        return [
            'checkpoint',
            requirePart(input.source.checkpointRef, 'checkpointRef'),
            'receipt',
            requirePart(input.source.checkpointReceiptId, 'checkpointReceiptId'),
            `evidence:${requirePart(input.source.turnEvidenceMode ?? 'reconciled', 'turnEvidenceMode')}`,
            `schema:${version}`,
            `selector:${selector}`,
        ].join(':');
    }

    return `volatile-working-tree:${requirePart(input.source.volatileSourceVersion, 'volatileSourceVersion')}:schema:${version}:selector:${selector}`;
}
