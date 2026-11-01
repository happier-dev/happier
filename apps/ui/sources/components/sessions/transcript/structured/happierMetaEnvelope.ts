import { HappierMetaEnvelopeSchema, type HappierMetaEnvelope } from '@happier-dev/protocol';

export type { HappierMetaEnvelope };

export function parseHappierMetaEnvelope(meta: unknown, key = 'happier'): HappierMetaEnvelope | null {
    if (!meta || typeof meta !== 'object') return null;
    const record = meta as Record<string, unknown>;
    const envelope = record[key];
    if (envelope !== undefined && envelope !== null) {
        const parsed = HappierMetaEnvelopeSchema.safeParse(envelope);
        if (parsed.success) return parsed.data;
    }
    if (Object.prototype.hasOwnProperty.call(record, key)) return null;

    // Session-input metadata is the canonical machine contract for generated user messages.
    // Project its recognized event into the existing transcript renderer registry instead of
    // duplicating card-selection logic or storing a second `meta.happier` envelope.
    if (key !== 'happier') return null;
    const structuredInput = record.happierStructuredInputV1;
    if (!structuredInput || typeof structuredInput !== 'object' || Array.isArray(structuredInput)) return null;
    const completion = (structuredInput as Record<string, unknown>).executionRunCompletion;
    if (completion === undefined) return null;
    return { kind: 'execution_run_completion.v1', payload: completion };
}
