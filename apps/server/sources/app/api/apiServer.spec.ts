import { describe, expect, it } from 'vitest';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/mini';
import { SessionIdSchema, SessionIndexedIdentifierMaxLengthV1 } from '@happier-dev/protocol/sessions/idsV1';
import { PendingLocalIdSchema } from '@happier-dev/protocol/sessions/pending/pendingLocalId';
import { ACTION_OPERATION_REQUEST_ID_MAX_LENGTH_V1, ActionOperationIdentifierV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { createApiServer } from './apiServer';
import { enableSchemaValidation } from './utils/enableSchemaValidation';

describe('Home router parameter admission', () => {
    it('serves the largest route identifier at its maximum encoded length', async () => {
        const app = createApiServer().withTypeProvider<ZodTypeProvider>();
        enableSchemaValidation(app);
        // Zod's operation-id bound measures UTF-16 units: a BMP code point uses
        // three UTF-8 bytes, or nine URI characters, for each admitted unit.
        const environmentId = '\uFFFF'.repeat(ACTION_OPERATION_REQUEST_ID_MAX_LENGTH_V1);
        expect(ActionOperationIdentifierV1Schema.parse(environmentId)).toBe(environmentId);
        app.get('/v1/deployments/environments/:environmentId', {
            schema: { params: z.object({ environmentId: ActionOperationIdentifierV1Schema }) },
        }, async request => request.params);
        try {
            const response = await app.inject({
                method: 'GET', url: `/v1/deployments/environments/${encodeURIComponent(environmentId)}`,
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ environmentId });
        } finally {
            await app.close();
        }
    });

    it('serves maximum-length Protocol ids with worst-case URI encoding', async () => {
        const app = createApiServer().withTypeProvider<ZodTypeProvider>();
        enableSchemaValidation(app);
        // Four UTF-8 bytes per code point, each encoded as three URI characters.
        const id = '😀'.repeat(SessionIndexedIdentifierMaxLengthV1);
        expect(SessionIdSchema.parse(id)).toBe(id);
        expect(PendingLocalIdSchema.parse(id)).toBe(id);
        app.get('/v2/sessions/:sessionId/messages/by-local-id/:localId', {
            schema: { params: z.object({
                sessionId: z.custom<string>(value => SessionIdSchema.safeParse(value).success),
                localId: PendingLocalIdSchema,
            }) },
        }, async request => request.params);
        try {
            const response = await app.inject({
                method: 'GET',
                url: `/v2/sessions/${encodeURIComponent(id)}/messages/by-local-id/${encodeURIComponent(id)}`,
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ sessionId: id, localId: id });
        } finally {
            await app.close();
        }
    });
});
