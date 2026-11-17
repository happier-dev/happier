import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { settleSessionInputRequestV1, withSessionInputAuthorityV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readSessionInputResult } from './sendSessionMessage';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { getActionSpec } from '@happier-dev/protocol/actions';
import type { SessionMessageReplyReadResultV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';

afterEach(() => vi.restoreAllMocks());

describe('exact Session input result', () => {
    it.each(['original', 'reply'] as const)('retains the actual HTTP read cause through the public Action output (%s)', async projection => {
        const sessionId = 'c1234567890123456789012345';
        let failure: 'refused' | 'not_found' | null = null;
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
            if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain' }) } };
            if (failure === 'not_found') throw Object.assign(new Error('Message not found'), {
                name: 'AxiosError', isAxiosError: true, response: { status: 404, data: { error: 'Message not found' } },
            });
            if (failure === 'refused') throw Object.assign(new Error('Private transport message'), {
                name: 'AxiosError', isAxiosError: true, code: 'not_authenticated',
                response: { status: 403, data: { error: 'Private response body' } },
            });
            if (projection === 'reply') return { status: 200, data: { v: 1, status: 'unavailable' } };
            return { status: 200, data: { message: { id: 'original-message', seq: 1, localId: 'original',
                createdAt: 1, updatedAt: 1, content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Original' } } } } } };
        });
        const executor = createActionExecutor(createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
            sessionId, mode: 'plain', ctx: null }));
        const read = () => runWithServerHttpBaseUrl('https://input-result.test', () => executor.execute('session.input.result.get',
            { sessionId, localId: 'original', ...(projection === 'reply' ? { projection } : {}) },
            { surface: 'agent', authority: 'account_automation' }));
        expect(await read()).toMatchObject({ ok: true, result: { ok: true } });
        const outputSchema = getActionSpec('session.input.result.get').outputSchema;
        if (!outputSchema) throw new Error('Expected the input-result Action output schema');
        if (projection === 'original') {
            failure = 'not_found';
            const absent = await read();
            expect(absent).toEqual({ ok: true, result: { ok: false, code: 'result_read_failed', failureCause: {
                phase: 'session.input.result.get', errorClass: 'AxiosError', errorCode: null, httpStatus: 404,
            } } });
            if (!absent.ok) throw new Error('Expected the public input-result Action output');
            expect(outputSchema.parse(absent.result)).toEqual(absent.result);
            expect(await runWithServerHttpBaseUrl('https://input-result.test', () => readSessionInputResult({
                credentials: { token: 'token', encryption: null }, idOrPrefix: sessionId, localId: 'original', callerPluginId: 'foreign.watch',
            }))).toEqual({ ok: false, code: 'result_read_failed' });
        }
        failure = 'refused';
        const result = await read();
        expect(result).toEqual({ ok: true, result: { ok: false, code: 'result_read_failed', failureCause: {
            phase: 'session.input.result.get', errorClass: 'AxiosError', errorCode: 'not_authenticated', httpStatus: 403,
        } } });
        if (!result.ok) throw new Error('Expected the public input-result Action output');
        expect(outputSchema.parse(result.result)).toEqual(result.result);
    });
    it.each(['plain', 'e2ee'] as const)('reads live Ask progress through the existing Action before an original materializes (%s)', async encryptionMode => {
        const sessionId = 'c1234567890123456789012345';
        let reply: Extract<SessionMessageReplyReadResultV1, { status: 'available' }> = {
            v: 1, status: 'available', progress: { v: 1, mode: 'wait', disposition: 'observing' },
        };
        let unavailable = false;
        const reads: string[] = [];
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            reads.push(path);
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
            if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: createSessionRecordFixture({ id: sessionId, encryptionMode }) } };
            if (path === `/v2/sessions/${sessionId}/messages/by-local-id/original/reply`)
                return { status: 200, data: unavailable ? { v: 1, status: 'unavailable' } : reply };
            return { status: 404, data: { error: 'Message not found' } };
        });
        const executor = createActionExecutor(createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
            sessionId, mode: 'plain', ctx: null }));
        const read = () => runWithServerHttpBaseUrl('https://input-result.test', () => executor.execute('session.input.result.get',
            { sessionId, localId: 'original', projection: 'reply' }, { surface: 'agent', authority: 'account_automation' }));
        const pending = await read();
        expect(pending).toMatchObject({ ok: true, result: { ok: true, sessionId, localId: 'original', projection: 'reply', reply } });
        if (!pending.ok) throw new Error('Reply read Action failed');
        const outputSchema = getActionSpec('session.input.result.get').outputSchema;
        if (!outputSchema) throw new Error('Expected the input-result Action output schema');
        expect(outputSchema.parse(pending.result)).toMatchObject({ reply });
        reply = { ...reply, progress: { ...reply.progress, outcome: { kind: 'pass' } } };
        expect(await read()).toMatchObject({ ok: true, result: { reply } });
        unavailable = true;
        expect(await read()).toMatchObject({ ok: true, result: { reply: { v: 1, status: 'unavailable' } } });
        expect(reads.filter(path => path.endsWith('/original/reply'))).toHaveLength(3);
        expect(reads.some(path => path.endsWith('/original') || path.endsWith('/messages'))).toBe(false);
    });
    it.each(['in_progress', 'waiting', 'completed', 'failed', 'cancelled'] as const)('reads the host witness and existing result for %s without observation timers', async status => {
        const sessionId = 'c1234567890123456789012345';
        const receipt = { v: 1, issuer: 'authenticatedMachine' } as const;
        let admittedReceipt: unknown = receipt;
        const authority = settleSessionInputRequestV1({ request: { v: 1, producer: 'pluginSession',
            caller: { kind: 'plugin', pluginId: 'acme.watch', contributionLocalId: 'watch' }, permission: {} },
            currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: receipt });
        const content = { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Original' },
            meta: withSessionInputAuthorityV1({}, authority) } };
        const turn = { turnId: 'native-turn', status, startedAt: 10, updatedAt: 20,
            transcriptAnchors: { userMessageSeqs: [1], startUserMessageSeq: 1, startSeqInclusive: 1,
                endSeqInclusive: 2, finalAssistantMessageSeq: null } };
        const paths: string[] = [];
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            paths.push(path);
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
            if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain' }) } };
            if (path.endsWith('/messages/by-local-id/original')) return { status: 200, data: { message: {
                id: 'original-message', seq: 1, localId: 'original', createdAt: 1, updatedAt: 1, content,
                inputAdmissionReceipt: admittedReceipt, acceptedTurnId: 'native-turn', turnStartWitnessId: 'native-turn', turn,
            } } };
            if (path.endsWith('/turns')) return { status: 200, data: { v: 1, sessionId, updatedAt: 20, turns: [turn] } };
            if (path.endsWith('/messages')) return { status: 200, data: { messages: [], hasMore: false, nextAfterSeq: null, nextBeforeSeq: null } };
            throw new Error(`Unexpected HTTP path: ${path}`);
        });
        const result = await runWithServerHttpBaseUrl('https://input-result.test', () => readSessionInputResult({
            credentials: { token: 'token', encryption: null }, idOrPrefix: sessionId, localId: 'original', callerPluginId: 'acme.watch',
        }));
        expect(result).toMatchObject({ ok: true, localId: 'original', acceptedTurnId: 'native-turn',
            turnStartWitnessId: 'native-turn', turnStatus: status,
            result: { kind: status === 'completed' ? 'terminal_no_result' : status === 'failed' || status === 'cancelled' ? status : 'pending' } });
        expect(paths.filter(path => path.endsWith('/messages/by-local-id/original'))).toHaveLength(1);
        expect(paths.filter(path => path.endsWith('/turns'))).toHaveLength(0);
        if (status === 'in_progress' || status === 'waiting') {
            expect(paths.filter(path => path.endsWith('/messages'))).toHaveLength(0);
        }
        const denied = await runWithServerHttpBaseUrl('https://input-result.test', () => readSessionInputResult({
            credentials: { token: 'token', encryption: null }, idOrPrefix: sessionId, localId: 'original', callerPluginId: 'foreign.watch',
        }));
        expect(denied).toEqual({ ok: false, code: 'result_read_failed' });
        admittedReceipt = undefined;
        const unproven = await runWithServerHttpBaseUrl('https://input-result.test', () => readSessionInputResult({
            credentials: { token: 'token', encryption: null }, idOrPrefix: sessionId, localId: 'original', callerPluginId: 'acme.watch',
        }));
        expect(unproven).toEqual({ ok: false, code: 'result_read_failed' });
    });
});
