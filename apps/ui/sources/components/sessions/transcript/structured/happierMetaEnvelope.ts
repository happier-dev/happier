import { HappierMetaEnvelopeSchema, type HappierMetaEnvelope } from '@happier-dev/protocol/messages/structured/HappierMetaEnvelope';

export type { HappierMetaEnvelope };

export function parseHappierMetaEnvelope(meta: unknown, key = 'happier'): HappierMetaEnvelope | null {
    if (!meta || typeof meta !== 'object') return null;
    const record = meta as Record<string, unknown>;
    const parsed = HappierMetaEnvelopeSchema.safeParse(record[key]);
    if (parsed.success) return parsed.data;
    if (Object.prototype.hasOwnProperty.call(record, key)) return null;

    // Generated Session user input keeps its typed machine contract in the canonical structured
    // input envelope. Adapt recognized built-in events into the one transcript renderer registry
    // instead of storing or selecting from a second `meta.happier` representation.
    if (key !== 'happier') return null;
    const structuredInput = record.happierStructuredInputV1;
    if (!structuredInput || typeof structuredInput !== 'object' || Array.isArray(structuredInput)) return null;
    const completion = (structuredInput as Record<string, unknown>).executionRunCompletion;
    if (completion === undefined) return null;
    return { kind: 'execution_run_completion.v1', payload: completion };
}
