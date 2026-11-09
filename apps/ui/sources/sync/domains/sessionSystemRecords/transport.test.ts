import { describe, expect, it } from 'vitest';
import { buildWorkflowRunSystemRecordLocalId } from '@happier-dev/protocol/sessions/system/records/activity/activitySystemRecordKinds';
import { createSessionSystemRecordTransport, projectSessionSystemRecordHydrationFailure } from './transport';
import {
    readLegacyWorkflowSystemRecord,
    selectWorkflowSystemRecordQuery,
} from './compatibility/legacyHostTransport';
import { makeSessionWorkflowRunSnapshot } from '@/dev/testkit';
import { openWorkflowRunSystemRecord } from '@/sync/domains/sessionActivity/sessionWorkflowActivityRecords';
import { RetryableServerResponseError, NonRetryableServerResponseError } from '@/sync/runtime/connectivity/transientConnectivityErrors';

const session = { serverId: 'home-a', sessionId: 'same-session' };
const address = {
    owner: 'host',
    namespace: 'activity',
    kind: 'workflow_run.v1',
    localId: buildWorkflowRunSystemRecordLocalId({ runId: 'run-one' }),
} as const;
const scope = { serverId: 'home-a', accountId: 'alice' };

describe('strict host System Record transport', () => {
    it('distinguishes superseded and decrypting Session material from actual malformed responses and denial', () => {
        const sessionId = session.sessionId;
        expect(projectSessionSystemRecordHydrationFailure({ kind: 'awaiting_push', sessionId, errorCode: 'stale_response' }))
            .toEqual({ status: 'server_error', retryable: true });
        expect(projectSessionSystemRecordHydrationFailure({ kind: 'retryable_failure', sessionId, cause: 'decrypting' }))
            .toEqual({ status: 'encryption_material_unavailable' });
        expect(projectSessionSystemRecordHydrationFailure({ kind: 'retryable_failure', sessionId, cause: 'unknown', errorCode: 'invalid_response' }))
            .toEqual({ status: 'invalid_response' });
        expect(projectSessionSystemRecordHydrationFailure({ kind: 'retryable_failure', sessionId, cause: 'server_unavailable', errorCode: 'network_error' }))
            .toEqual({ status: 'offline' });
        expect(projectSessionSystemRecordHydrationFailure({ kind: 'missing', sessionId, cause: 'forbidden' }))
            .toEqual({ status: 'forbidden' });
        expect(projectSessionSystemRecordHydrationFailure({ kind: 'missing', sessionId, cause: 'not_found' }))
            .toEqual({ status: 'not_found' });
    });

    it('keeps typed body-stream failures and treats only actual schema failures as invalid responses', async () => {
        const transport = createSessionSystemRecordTransport({ scope, request: async () => new Response(new ReadableStream({
            start(controller) { controller.error(Object.assign(new Error('private body detail'), { code: 'forbidden' })); },
        })) });
        expect(await transport.read(session, address)).toEqual({ status: 'forbidden' });
        const unknown = createSessionSystemRecordTransport({ scope, request: async () => { throw new Error('private unexpected detail'); } });
        expect(await unknown.read(session, address)).toEqual({ status: 'server_error', retryable: false });
        for (const [error, retryable] of [
            [new RetryableServerResponseError(503, 'private server detail'), true],
            [new NonRetryableServerResponseError(503, 'private server detail'), false],
            [Object.assign(new Error('private server detail'), { code: 'server_error', retryable: true }), true],
        ] as const) {
            const refused = createSessionSystemRecordTransport({ scope, request: async () => { throw error; } });
            expect(await refused.read(session, address)).toEqual({ status: 'server_error', retryable });
        }
        const malformed = createSessionSystemRecordTransport({ scope, request: async () => new Response('not json') });
        expect(await malformed.read(session, address)).toEqual({ status: 'invalid_response' });
    });

    it('does not classify an already-consumed response body as an offline Home', async () => {
        const response = Response.json({ record: null });
        await response.json();
        const transport = createSessionSystemRecordTransport({ scope, request: async () => response });
        expect(await transport.read(session, address)).toEqual({ status: 'server_error', retryable: false });
    });

    it('selects legacy only when strict capability is absent and fails closed for unsupported versions', () => {
        expect(selectWorkflowSystemRecordQuery({ localId: address.localId, protocolVersions: null })).toEqual({
            status: 'ready',
            query: { type: 'legacy_workflow', localId: address.localId },
        });
        expect(selectWorkflowSystemRecordQuery({ localId: address.localId, protocolVersions: [1] })).toEqual({
            status: 'ready',
            query: { type: 'read', address },
        });
        expect(selectWorkflowSystemRecordQuery({ localId: address.localId, protocolVersions: [2] })).toEqual({
            status: 'protocol_unavailable',
        });
    });

    it('accepts one exact strict V1 row and rejects revisionless or malformed strict responses without legacy retry', async () => {
        const requests: string[] = [];
        let response = new Response(JSON.stringify({ record: {
            id: 'strict-record',
            address,
            content: { t: 'plain', v: makeSessionWorkflowRunSnapshot({ runId: 'run-one' }) },
            revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
            createdAt: '2026-09-05T00:00:00.000Z',
            updatedAt: '2026-09-05T00:00:00.000Z',
        } }));
        const transport = createSessionSystemRecordTransport({ scope, request: async (path) => {
            requests.push(path);
            return response;
        } });

        expect(await transport.read(session, address)).toMatchObject({ status: 'ok', value: { revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ' } });
        response = new Response(JSON.stringify({ record: {
            id: 'revisionless-record',
            sessionId: session.sessionId,
            namespace: address.namespace,
            kind: address.kind,
            localId: address.localId,
            content: { t: 'plain', v: makeSessionWorkflowRunSnapshot({ runId: 'run-one' }) },
            createdAt: '2026-09-05T00:00:00.000Z',
            updatedAt: '2026-09-05T00:00:00.000Z',
        } }));
        expect(await transport.read(session, address)).toEqual({ status: 'invalid_response' });
        expect(requests).toHaveLength(2);
        expect(requests.every((path) => new URL(path, 'https://home-a').searchParams.get('owner') === 'host')).toBe(true);
    });

    it('reads a predecessor workflow without inventing a revision and rejects another Session row', async () => {
        const payload = makeSessionWorkflowRunSnapshot({ runId: 'run-one' });
        const legacyRecord = {
            id: 'legacy-record', sessionId: session.sessionId, namespace: 'activity', kind: 'workflow_run.v1',
            localId: address.localId, content: { t: 'plain', v: payload }, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
        };
        let returnedRecord = legacyRecord;
        const paths: string[] = [];
        const options = { scope, request: async (path: string) => {
            paths.push(path);
            return new Response(JSON.stringify({ record: returnedRecord }));
        } };
        const result = await readLegacyWorkflowSystemRecord(options, session, address.localId);
        expect(result).toEqual({
            status: 'ok', value: {
                source: 'legacy-host-compatibility',
                address,
                content: legacyRecord.content,
            },
        });
        if (result.status !== 'ok') throw new Error('expected predecessor record');
        await expect(openWorkflowRunSystemRecord({
            runId: 'run-one',
            record: result.value,
            context: { mode: 'plain' },
        })).resolves.toEqual({ status: 'ready', value: payload });
        expect(new URL(paths[0], 'https://home-a').searchParams.has('owner')).toBe(false);
        returnedRecord = { ...legacyRecord, sessionId: 'different-session' };
        expect(await readLegacyWorkflowSystemRecord(options, session, address.localId)).toEqual({ status: 'invalid_response' });
    });
    it('keeps absence, denied, feature disabled, protocol unavailable, malformed and offline outcomes distinct', async () => {
        let response = new Response(JSON.stringify({ record: null }));
        // Fetch is the network boundary; the transport and strict parsers remain real.
        const transport = createSessionSystemRecordTransport({ scope, request: async () => response });
        expect(await transport.read(session, address)).toEqual({ status: 'not_found' });
        response = new Response(JSON.stringify({ error: 'denied', code: 'plugin_session_record_forbidden' }), { status: 403 });
        expect(await transport.read(session, address)).toEqual({ status: 'forbidden' });
        response = new Response(JSON.stringify({ error: 'disabled', code: 'plugin_session_record_feature_disabled' }), { status: 404 });
        expect(await transport.read(session, address)).toEqual({ status: 'feature_disabled' });
        response = new Response(JSON.stringify({ error: 'unavailable', code: 'plugin_session_records_unavailable' }), { status: 503 });
        expect(await transport.read(session, address)).toEqual({ status: 'protocol_unavailable' });
        response = new Response(JSON.stringify({ error: 'route missing' }), { status: 404 });
        expect(await transport.read(session, address)).toEqual({ status: 'invalid_response' });
        const offline = createSessionSystemRecordTransport({ scope, request: async () => { throw new TypeError('Failed to fetch'); } });
        expect(await offline.read(session, address)).toEqual({ status: 'offline' });
    });

    it('never sends another Home through a captured authority or invents plugin authority', async () => {
        const requests: Array<{ path: string; headers: Headers }> = [];
        const transport = createSessionSystemRecordTransport({ scope, request: async (path, init) => {
            requests.push({ path, headers: new Headers(init?.headers) });
            return new Response(JSON.stringify({ record: null }));
        } });
        expect(await transport.read({ ...session, serverId: 'home-b' }, address)).toEqual({ status: 'forbidden' });
        expect(requests).toHaveLength(0);
        await transport.read(session, address);
        expect(new URL(requests[0].path, 'https://home-a').searchParams.get('owner')).toBe('host');
        expect(requests[0].headers.get('x-happier-session-system-records-protocol')).toBe('1');
        expect(requests[0].headers.has('x-happier-plugin-id')).toBe(false);
    });
});
