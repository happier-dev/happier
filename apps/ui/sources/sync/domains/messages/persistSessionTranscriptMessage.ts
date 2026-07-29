import { z } from 'zod';

import { SessionMessageRoleSchema, type SessionMessageRole } from '@happier-dev/protocol';

import { normalizeRawMessage, RawRecordSchema, type NormalizedMessage, type RawRecord } from '@/sync/typesRaw';

const PersistSessionTranscriptMessageResponseSchema = z.object({
    didWrite: z.boolean(),
    didUpdate: z.boolean().optional(),
    message: z.object({
        id: z.string(),
        seq: z.number().int().min(0),
        localId: z.string().nullable(),
        createdAt: z.number().int().min(0),
    }),
}).passthrough();

export type PersistSessionTranscriptMessageInput = Readonly<{
    sessionId: string;
    localId: string;
    createdAt: number;
    rawRecord: RawRecord;
    messageRole: SessionMessageRole;
}>;

export type PersistSessionTranscriptMessageDeps = Readonly<{
    request: (path: string, init?: RequestInit) => Promise<Response>;
    sessionEncryptionMode: 'e2ee' | 'plain';
    encryptRawRecord?: (rawRecord: RawRecord) => Promise<string>;
}>;

export type PersistedSessionTranscriptMessage = Readonly<{
    didWrite: boolean;
    didUpdate: boolean;
    message: NormalizedMessage;
}>;

export async function persistSessionTranscriptMessage(
    deps: PersistSessionTranscriptMessageDeps,
    input: PersistSessionTranscriptMessageInput,
): Promise<PersistedSessionTranscriptMessage> {
    const sessionId = input.sessionId.trim();
    const localId = input.localId.trim();
    const parsedRawRecord = RawRecordSchema.safeParse(input.rawRecord);
    const parsedMessageRole = SessionMessageRoleSchema.safeParse(input.messageRole);
    if (!sessionId || !localId || !parsedRawRecord.success || !parsedMessageRole.success) {
        throw new Error('Invalid session transcript message');
    }

    const storedContent = deps.sessionEncryptionMode === 'plain'
        ? { content: { t: 'plain' as const, v: parsedRawRecord.data } }
        : await (async () => {
            if (!deps.encryptRawRecord) {
                throw new Error(`Session ${sessionId} encryption not found`);
            }
            return { ciphertext: await deps.encryptRawRecord(parsedRawRecord.data) };
        })();
    const response = await deps.request(
        `/v2/sessions/${encodeURIComponent(sessionId)}/messages`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': localId,
            },
            body: JSON.stringify({
                ...storedContent,
                localId,
                messageRole: parsedMessageRole.data,
            }),
        },
    );
    if (!response.ok) {
        throw new Error(`Session transcript message write failed (${response.status})`);
    }

    const parsedResponse = PersistSessionTranscriptMessageResponseSchema.safeParse(await response.json());
    if (!parsedResponse.success) {
        throw new Error('Invalid session transcript message response');
    }
    const ack = parsedResponse.data.message;
    const normalized = normalizeRawMessage(
        ack.id,
        ack.localId ?? localId,
        ack.createdAt,
        parsedRawRecord.data,
        {
            seq: ack.seq,
            messageRole: parsedMessageRole.data,
        },
    );
    if (!normalized) {
        throw new Error('Session transcript message could not be normalized');
    }

    return {
        didWrite: parsedResponse.data.didWrite,
        didUpdate: parsedResponse.data.didUpdate === true,
        message: normalized,
    };
}
