import fastify from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { SessionOwnerMetadataEnvelopeV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { V2SessionByIdResponseSchema, SessionLookupByTagsResponseV2Schema } from '@happier-dev/protocol/sessions/control/contract';
import { SessionReadBatchResponseV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';

import { enableSchemaValidation } from '../../utils/enableSchemaValidation';
import { projectSessionMetadataForRecipient } from '@/app/session/metadata/sessionMetadataRecipientProjection';
import { parseProjectedSessionByIdResponse, parseProjectedSessionBatchResponse, parseProjectedSessionLookupResponse } from './sessionRecordResponse';

const ciphertext = 'oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==';

describe('admitted Session record response', () => {
    it.each(['detail', 'batch', 'lookup'] as const)('admits an external owner envelope once through real Fastify %s while retaining mode and outer-record refusals', async kind => {
        const app = fastify().withTypeProvider<ZodTypeProvider>();
        enableSchemaValidation(app);
        let accountMode: 'e2ee' | 'plain' = 'e2ee';
        let seq = 0;
        const responseSchema = kind === 'detail' ? V2SessionByIdResponseSchema
            : kind === 'batch' ? SessionReadBatchResponseV1Schema : SessionLookupByTagsResponseV2Schema;
        app.post('/', { schema: { body: SessionOwnerMetadataEnvelopeV1Schema,
            response: { 200: responseSchema } } }, async (request, reply) => {
            const projection = projectSessionMetadataForRecipient({ session: { accountId: 'owner',
                encryptionMode: 'e2ee', metadata: 'shared', metadataVersion: 1, metadataLayoutVersion: 1,
                ownerMetadata: request.body, agentState: null, agentStateVersion: 0 },
                recipient: { type: 'owner', accountId: 'owner', accountMode } });
            const detail = parseProjectedSessionByIdResponse({ session: { ...projection,
                id: 'session', seq, active: false, activeAt: 1, createdAt: 1, updatedAt: 1,
                encryptionMode: 'e2ee', share: null, dataEncryptionKey: null } });
            const body = kind === 'detail' ? detail : kind === 'batch'
                ? parseProjectedSessionBatchResponse({ results: [{ sessionId: 'session', detail: { status: 200, body: detail } }] })
                : parseProjectedSessionLookupResponse({ sessions: [detail.session] });
            return reply.serializer(JSON.stringify).send(body);
        });
        await app.ready();
        try {
            const accepted = await app.inject({ method: 'POST', url: '/', payload: { t: 'encrypted', c: ciphertext } });
            expect(accepted.statusCode).toBe(200);
            const body = accepted.json();
            const session = kind === 'detail' ? body.session : kind === 'batch' ? body.results[0].detail.body.session : body.sessions[0];
            expect(session.ownerMetadata).toEqual({ t: 'encrypted', c: ciphertext });
            accountMode = 'plain';
            const changedMode = await app.inject({ method: 'POST', url: '/', payload: { t: 'encrypted', c: ciphertext } });
            expect(changedMode.statusCode).toBe(500);
            expect(changedMode.payload).not.toContain(ciphertext);
            accountMode = 'e2ee';
            const extra = await app.inject({ method: 'POST', url: '/', payload: { t: 'encrypted', c: ciphertext, forgedAuthority: true } });
            expect(extra.statusCode).toBe(400);
            expect(extra.payload).not.toContain(ciphertext);
            seq = -1;
            const badOuter = await app.inject({ method: 'POST', url: '/', payload: { t: 'encrypted', c: ciphertext } });
            expect(badOuter.statusCode).toBe(500);
            expect(badOuter.payload).not.toContain(ciphertext);
        } finally { await app.close(); }
    });
});
