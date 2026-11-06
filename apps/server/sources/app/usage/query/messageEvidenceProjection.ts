import { z } from 'zod';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { TranscriptRawAgentEventV1Schema } from '@happier-dev/protocol/sessions/messages/transcriptRawRecordV1';
import { SessionMessageAcceptedDeliveryFactsV1StoredSchema } from '@happier-dev/protocol/sessions/messages/sessionMessageDeliveryResolutionV1';
import { projectUsageCollaborationToolPayload, type UsageSessionMessageProjection } from '@happier-dev/protocol/usage/usageWorkEvidence';

const eventSchema = createStoredReadSchema(TranscriptRawAgentEventV1Schema);
const toolSchema = z.object({ kind: z.enum(['call', 'result']), id: z.string(), name: z.string(),
    input: z.unknown().optional(), result: z.unknown().optional() });
const rowSchema = z.object({ id: z.string(), localId: z.string().nullable(), createdAt: z.number().int().nonnegative().safe(),
    sidechainIds: z.array(z.string()), role: z.string().nullable(), recordType: z.string().nullable(),
    nativeAgentId: z.string().nullable(), eventId: z.string().nullable(),
    event: z.unknown().optional(), tools: z.array(toolSchema), acceptedDelivery: z.unknown().optional() });

function readJson(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

/** Admit stored SQL witnesses, not a reconstructed or truncated native transcript record. */
export function readUsageSessionMessageProjection(value: unknown): UsageSessionMessageProjection | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const source = value as Record<string, unknown>;
    const parsed = rowSchema.safeParse({ ...source, tools: readJson(source.tools), sidechainIds: readJson(source.sidechainIds) });
    if (!parsed.success) return null;
    const row = parsed.data;
    const event = row.event == null ? null : eventSchema.safeParse(readJson(row.event));
    const accepted = row.acceptedDelivery == null ? null
        : SessionMessageAcceptedDeliveryFactsV1StoredSchema.safeParse(readJson(row.acceptedDelivery));
    if (event && !event.success || accepted && !accepted.success) return null;
    if (row.role !== 'agent' && (row.tools.length > 0 || event !== null || row.nativeAgentId !== null || row.sidechainIds.length > 0)) return null;
    return { id: row.id, localId: row.localId, createdAt: row.createdAt,
        nativeAgentId: row.nativeAgentId, sidechainIds: row.sidechainIds,
        tools: row.tools.map(tool => ({ kind: tool.kind, id: tool.id, name: tool.name,
            ...(tool.input === undefined ? {} : { input: projectUsageCollaborationToolPayload(tool.input) }),
            ...(tool.result === undefined ? {} : { result: projectUsageCollaborationToolPayload(tool.result) }) })),
        ...(event?.success ? { event: event.data } : {}), ...(row.eventId === null ? {} : { eventId: row.eventId }),
        ...(accepted?.success ? { acceptedDelivery: accepted.data } : {}) };
}
