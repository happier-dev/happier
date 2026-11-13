import { expect, it } from 'vitest';
import { SessionReadBatchResponseV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';

import { createSessionFixture, createLockedEncryptedSessionByIdResponseFixture } from '../fixtures/sessionFixtures';
import type { SessionDisplayProjectionV1 } from '@happier-dev/protocol/sessions/metadata/sessionDisplaySchemasV1';
import { createSessionMetadataHttpBoundary } from './sessionMetadataHttpBoundary';
import { createCompactSessionListFetchBoundary, createSessionReadBatchFetchBoundary } from './sessionReadBatchHttpBoundary';
import { createPlainV2SessionRecordFixture } from '../fixtures/sessionFixtures';
import { V2SessionListResponseSchema, V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';

it('serves one canonical Session snapshot and its declared turn projection through the batch wire', async () => {
    const session = createSessionFixture({ id: 'voice-carrier', sessionTurns: {
        v: 1, sessionId: 'voice-carrier', updatedAt: 7, turns: [],
    } });
    const metadata = createSessionMetadataHttpBoundary(() => ({ [session.id]: session }));
    const request = createSessionReadBatchFetchBoundary(async (url, init) => metadata.handle(url, init));
    const response = await request('https://voice.test/v2/sessions/read-batch', {
        method: 'POST', body: JSON.stringify({ sessionIds: [session.id], includeSnapshot: true, includeMessages: false }),
    });
    if (!response) throw new Error('Missing batch response');
    const body = SessionReadBatchResponseV1Schema.parse(await response.json());
    expect(body.results).toMatchObject([{
        sessionId: session.id, detail: { status: 200, body: { session: { id: session.id } } },
        turns: { status: 200, body: session.sessionTurns },
    }]);
});

it('serves compact lists and retains their full source documents only at the detail transport boundary', async () => {
    const session = createPlainV2SessionRecordFixture({ id: 'compact-source' });
    const request = createCompactSessionListFetchBoundary(async path => path === '/v2/sessions'
        ? Response.json({ sessions: [session], nextCursor: null, hasNext: false }) : undefined);
    const page = await request('/v2/sessions', {});
    const body = V2SessionListResponseSchema.parse(await page!.json());
    expect(body.sessions[0]).toMatchObject({ id: session.id, documents: 'omitted', metadataAudience: 'owner', agentStateDocument: 'omitted' });
    expect(body.sessions[0]).not.toHaveProperty('metadata');
    expect(body.sessions[0]).not.toHaveProperty('ownerMetadata');
    expect(body.sessions[0]).not.toHaveProperty('agentState');
    expect(body.sessions[0]?.displayProjectionV1).toMatchObject({ v: 1,
        sourceMetadataVersion: session.metadataVersion, metadataLayoutVersion: 1,
        shared: { t: 'plain', v: { display: { v: 1 } } },
        owner: { t: 'plain', v: { display: { v: 1, path: '/Users/tester/project', machineId: 'machine-1' } } },
    });
    const batch = await request('/v2/sessions/read-batch', { method: 'POST', body: JSON.stringify({
        sessionIds: [session.id], includeSnapshot: true, includeTurns: false, includeMessages: false,
    }) });
    const result = SessionReadBatchResponseV1Schema.parse(await batch!.json()).results[0]!;
    expect(V2SessionByIdResponseSchema.parse(result.detail!.body).session).toEqual(session);
});

it('retains an explicit display sidecar and never fabricates plaintext display for an encrypted source', async () => {
    const session = createPlainV2SessionRecordFixture({ id: 'explicit-display' });
    const displayProjectionV1 = { v: 1, sourceMetadataVersion: session.metadataVersion, metadataLayoutVersion: 1,
        shared: { t: 'plain', v: { v: 1, audience: 'shared', purpose: 'session_shared_display', display: { v: 1 } } },
        owner: { t: 'plain', v: { v: 1, audience: 'owner', purpose: 'session_owner_display', display: { v: 1, name: 'Explicit sidecar' } } },
    } satisfies SessionDisplayProjectionV1;
    const encrypted = await createLockedEncryptedSessionByIdResponseFixture(createSessionFixture({ id: 'encrypted-source',
        encryptionMode: 'e2ee', encryptedContentAvailability: 'encrypted_access_pending' }));
    const request = createCompactSessionListFetchBoundary(async () => Response.json({
        sessions: [{ ...session, displayProjectionV1 }, encrypted.session], nextCursor: null, hasNext: false,
    }));
    const page = V2SessionListResponseSchema.parse(await (await request('/v2/sessions', {}))!.json());
    expect(page.sessions[0]?.displayProjectionV1).toEqual(displayProjectionV1);
    expect(page.sessions[1]).not.toHaveProperty('displayProjectionV1');
});

it('preserves explicit batch failures and malformed list rows rather than repairing the tested contract', async () => {
    const invalidDescriptor = { ...createPlainV2SessionRecordFixture(), documents: 'partial' };
    const request = createCompactSessionListFetchBoundary(async path => path === '/v2/sessions/read-batch'
        ? Response.json({ error: 'unavailable' }, { status: 503 })
        : Response.json({ sessions: [{ id: 'malformed', metadata: 42 }, invalidDescriptor] }));
    const page = await request('/v2/sessions', {});
    expect(await page!.json()).toEqual({ sessions: [{ id: 'malformed', metadata: 42 }, invalidDescriptor] });
    const batch = await request('/v2/sessions/read-batch', { method: 'POST', body: '{}' });
    expect(batch!.status).toBe(503);
});

it('lets a configured exact-route refusal override a previously captured list document', async () => {
    const session = createPlainV2SessionRecordFixture({ id: 'revoked' });
    const request = createCompactSessionListFetchBoundary(async path => {
        if (path === '/v2/sessions') return Response.json({ sessions: [session] });
        if (path === '/v2/sessions/revoked') return Response.json({ error: 'forbidden' }, { status: 403 });
        return undefined;
    }, { preferExactSnapshot: true });
    await request('/v2/sessions', {});
    const batch = await request('/v2/sessions/read-batch', { method: 'POST', body: JSON.stringify({
        sessionIds: [session.id], includeSnapshot: true, includeTurns: false, includeMessages: false,
    }) });
    const body = SessionReadBatchResponseV1Schema.parse(await batch.json());
    expect(body.results[0]?.detail).toEqual({ status: 403, body: { error: 'forbidden' } });
});

it('preserves Request inputs and null fallthrough for composed external HTTP fixtures', async () => {
    const calls: Array<{ method?: string; authorization: string | null; body: BodyInit | null | undefined }> = [];
    const request = createCompactSessionListFetchBoundary(async (path, init) => {
        if (path !== 'https://fixture.test/v2/sessions/query') return null;
        calls.push({ method: init.method, authorization: new Headers(init.headers).get('authorization'), body: init.body });
        return Response.json({ sessions: [createPlainV2SessionRecordFixture()] });
    });
    const response = await request(new Request('https://fixture.test/v2/sessions/query', {
        method: 'POST', headers: { Authorization: 'Bearer fixture-account' }, body: '{"v":1}',
    }));
    expect(V2SessionListResponseSchema.parse(await response!.json()).sessions[0]?.documents).toBe('omitted');
    expect(calls).toEqual([{ method: 'POST', authorization: 'Bearer fixture-account', body: '{"v":1}' }]);
    expect(await request('https://fixture.test/transcript')).toBeNull();
});
