/** A persisted Collection usage/contract fact is semantically inconsistent. */
export class PluginCollectionQuotaCensusInconsistencyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PluginCollectionQuotaCensusInconsistencyError';
    }
}

const textEncoder = new TextEncoder();

/** The quota metric includes identity, complete envelope and stored projections. */
export function measurePluginCollectionStoredRowEncodedBytes(input: Readonly<{
    rowId: string;
    contentEnvelope: unknown;
    projections: readonly Readonly<{ fieldId: string; typedEncodedValue: string }>[];
}>): number {
    const payload = JSON.stringify({
        rowId: input.rowId,
        contentEnvelope: input.contentEnvelope,
        projections: [...input.projections]
            .sort((left, right) => left.fieldId.localeCompare(right.fieldId))
            .map((projection) => ({
                fieldId: projection.fieldId,
                typedEncodedValue: projection.typedEncodedValue,
            })),
    });
    if (payload === undefined) {
        throw new PluginCollectionQuotaCensusInconsistencyError('Collection stored row is not JSON serializable.');
    }
    return textEncoder.encode(payload).byteLength;
}
