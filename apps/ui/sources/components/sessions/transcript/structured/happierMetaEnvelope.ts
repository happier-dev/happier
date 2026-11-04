import { parseSessionMediaMessageMeta, type ParsedSessionMediaMessageMeta } from '@/sync/domains/session/media/sessionMediaMessageMeta';
import { HappierMetaEnvelopeSchema, type HappierMetaEnvelope } from '@happier-dev/protocol/messages/structured/HappierMetaEnvelope';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { AttachmentsMessageMetaV1Schema, type AttachmentsMessageMetaV1 } from '@/sync/domains/attachments/attachmentsMessageMeta';

export type { HappierMetaEnvelope };

export function readTranscriptAttachmentsMeta(meta: unknown): AttachmentsMessageMetaV1 | null {
    const primary = parseHappierMetaEnvelope(meta);
    const envelope = primary?.kind === 'attachments.v1' ? primary : parseHappierMetaEnvelope(meta, 'happierAttachments');
    if (envelope?.kind !== 'attachments.v1') return null;
    const parsed = AttachmentsMessageMetaV1Schema.safeParse(envelope.payload);
    return parsed.success && parsed.data.attachments.length > 0 ? parsed.data : null;
}

export function readTranscriptSessionMediaMeta(meta: unknown): ParsedSessionMediaMessageMeta | null {
    const primary = parseHappierMetaEnvelope(meta);
    const envelope = primary?.kind === 'session_media.v1' ? primary : parseHappierMetaEnvelope(meta, 'happierMedia');
    return parseSessionMediaMessageMeta(envelope);
}

export function parseHappierMetaEnvelope(meta: unknown, key = 'happier'): HappierMetaEnvelope | null {
    if (!meta || typeof meta !== 'object') return null;
    const record = meta as Record<string, unknown>;
    const envelope = record[key];
    if (envelope !== undefined && envelope !== null) {
        const parsed = createStoredReadSchema(HappierMetaEnvelopeSchema).safeParse(envelope);
        if (parsed.success) return parsed.data;
    }
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
