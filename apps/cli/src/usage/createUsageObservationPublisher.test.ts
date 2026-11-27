import { AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it, vi } from 'vitest';

import { UsageEventIngestRequestSchema, type UsageEventIngestRequest } from '@happier-dev/protocol';

import { createUsageObservationPublisher } from './createUsageObservationPublisher';
import { logger } from '@/ui/logger';
import { buildAcpUsageUpdateObservation } from '@/agent/acp/usage/buildAcpUsageObservation';

const nativeSubject = { kind: 'native' as const, machineId: 'machine-1',
    agent: { pluginId: 'happier.agent.codex', localId: 'codex' }, sourceRootKey: 'root', nativeSessionKey: 'native' };
const nativeObservation = { provider: 'codex', source: 'codex-native', scope: 'turn_delta' as const, key: null, modelId: null,
    tokens: { total: 12, input: 12, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: null,
    contextUsedTokens: null, contextWindowTokens: null };
const sessionObservation = {
    provider: 'claude', source: 'claude-assistant-usage', scope: 'turn_delta' as const, key: 'claude-session', modelId: null,
    tokens: { total: 12, input: 7, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: null, contextUsedTokens: null, contextWindowTokens: null,
};
const notFound = () => Object.assign(new Error('Not found'), { response: { status: 404 } });

/** The Home's Session socket boundary: records each acknowledged `usage-event` emit. */
function createSocketHome(ack: unknown = { success: true, eventId: 'event-1', createdAt: 1 }) {
    const emitted: UsageEventIngestRequest[] = [];
    return { emitted, emitUsageEvent: (request: UsageEventIngestRequest) => {
        emitted.push(request);
        return Promise.resolve(ack);
    } };
}

describe('createUsageObservationPublisher', () => {
    it('preserves an explicit native ingest credential-scope refusal when a replacement token is available', async () => {
        const resolveToken = vi.fn(async () => 'replacement');
        const postJson = vi.fn<() => Promise<{ ok: true }>>().mockRejectedValueOnce(new AxiosError('Refused', undefined, undefined, undefined, {
            status: 403, statusText: 'Forbidden', data: { error: 'credential_scope_denied' },
            headers: {}, config: { headers: new AxiosHeaders() },
        })).mockResolvedValue({ ok: true });
        const publisher = createUsageObservationPublisher({ token: 'token', apiServerUrl: 'https://api.example.test',
            resolveToken, postJson, emitUsageEvent: () => null });

        expect(await publisher.publish({ subject: nativeSubject, externalKey: 'inference', observation: nativeObservation }))
            .toEqual({ status: 'failed', errorCode: 'credential_scope_denied' });
        expect(resolveToken).not.toHaveBeenCalled();
    });

    it('publishes prompt-cache facts and unknown child measurements as one acknowledged socket emit each, never over HTTP', async () => {
        const home = createSocketHome();
        const postJson = vi.fn(async () => ({ ok: true as const }));
        const publisher = createUsageObservationPublisher({ token: 'token-1', apiServerUrl: 'https://api.example.test',
            postJson, emitUsageEvent: home.emitUsageEvent });

        expect(await publisher.publish({
            sessionId: 'session-1', observedAt: 10,
            observation: { provider: 'claude', source: 'claude-sdk-result', scope: 'session_final', key: 'claude-session',
                modelId: 'claude-sonnet', promptCache: { lastUseAtMs: 0 },
                tokens: { total: 20, input: 12, output: 8, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
                cost: { reportedUsd: 0.2, estimatedUsd: 0, currency: 'USD' }, contextUsedTokens: null, contextWindowTokens: null },
        })).toEqual({ status: 'sent', transport: 'socket' });
        expect(home.emitted[0]).toMatchObject({ sessionId: 'session-1', agentId: 'claude', source: 'claude-sdk-result',
            scope: 'session_final', isCumulative: true, promptCache: { lastUseAtMs: 0 } });

        expect(await publisher.publish({
            sessionId: 'session-1', observedAt: 20,
            observation: { provider: 'runtime-agent', source: 'runtime', scope: 'turn_delta', key: null, modelId: null,
                tokens: null, cost: null, contextUsedTokens: null, contextWindowTokens: null,
                promptCache: { lastUseAtMs: 10, ttlMs: 300_000 } },
        })).toEqual({ status: 'skipped' });

        expect(await publisher.publish({
            sessionId: 'session-1', observedAt: 30, externalKey: 'child-identity',
            metadata: { usageAccounting: { path: 'runtime', status: 'unknown', asOfMs: 30, nativeSessionId: 'child-native' } },
            observation: { provider: 'runtime-agent', source: 'native-statistics', scope: 'session_cumulative',
                key: null, modelId: null, tokens: null, cost: null, contextUsedTokens: null, contextWindowTokens: null },
        })).toEqual({ status: 'sent', transport: 'socket' });
        expect(home.emitted).toHaveLength(2);
        expect(UsageEventIngestRequestSchema.parse(home.emitted[1])).toMatchObject({
            tokens: { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null, total: null },
            cost: { reportedUsd: null, estimatedUsd: null },
            metadata: { usageAccounting: { nativeSessionId: 'child-native' } },
        });
        expect(postJson).not.toHaveBeenCalled();
    });

    it.each([true, false])('retains tokenless costs in v2 accounting (context=%s)', async withContext => {
        const home = createSocketHome();
        const publisher = createUsageObservationPublisher({ token: 'token', apiServerUrl: 'https://api.example.test',
            emitUsageEvent: home.emitUsageEvent });
        const observation = buildAcpUsageUpdateObservation({ provider: 'fixture', update: {
            ...(withContext ? { used: 900, size: 1000 } : {}), cost: { amount: 0.25, currency: 'USD' },
        } });
        if (!observation) throw new Error('Expected a usage observation');
        expect(await publisher.publish({ sessionId: 'session', observation })).toEqual({ status: 'sent', transport: 'socket' });
        expect(home.emitted[0]).toEqual(expect.objectContaining({
            tokens: expect.objectContaining({ total: null }),
            cost: expect.objectContaining({ reportedUsd: 0.25 }),
            context: withContext ? { usedTokens: 900, windowTokens: 1000 } : undefined,
        }));
    });

    it.each([
        { ack: { success: false, error: 'Forbidden' }, native: false, expected: 'failed' },
        { ack: { success: false, error: 'Invalid parameters' }, native: true, expected: 'failed', errorCode: 'invalid-params' },
        { ack: { success: false, error: 'Session not found' }, native: false, expected: 'failed' },
    ] as const)('maps a refused socket acknowledgement ($ack.error, native=$native) to $expected without a second transport', async ({ ack, native, expected, ...diagnostic }) => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const home = createSocketHome(ack);
        const postJson = vi.fn(async () => ({ ok: true as const }));
        const publisher = createUsageObservationPublisher({ token: 'token', apiServerUrl: 'https://api.example.test',
            postJson, emitUsageEvent: home.emitUsageEvent });
        try {
            expect(await publisher.publish(native
                ? { subject: nativeSubject, externalKey: 'inference', observation: nativeObservation }
                : { sessionId: 'session-1', observation: sessionObservation })).toEqual({ status: expected, ...diagnostic });
            expect(home.emitted).toHaveLength(1);
            expect(postJson).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    it('keeps canceled native HTTP capture pending instead of acknowledging it', async () => {
        const controller = new AbortController();
        const publisher = createUsageObservationPublisher({
            token: 'token', apiServerUrl: 'https://api.example.test', emitUsageEvent: () => null,
            postJson: async (request) => {
                controller.abort();
                const signal = Reflect.get(request, 'signal');
                if (signal instanceof AbortSignal && signal.aborted) throw new DOMException('Canceled', 'AbortError');
                return { ok: true };
            },
        });
        expect(await publisher.publish({ signal: controller.signal, subject: nativeSubject, externalKey: 'inference',
            observation: nativeObservation })).toEqual({ status: 'failed' });
    });

    it.each([400, 404, 401])('never acknowledges native capture after HTTP %s', async (status) => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const publisher = createUsageObservationPublisher({
            token: 'token', apiServerUrl: 'https://api.example.test', emitUsageEvent: () => null,
            postJson: async () => { throw Object.assign(new Error('refused'), { response: { status } }); },
        });
        try {
            expect(await publisher.publish({ subject: nativeSubject, externalKey: 'inference', observation: nativeObservation }))
                .toEqual({ status: status === 401 ? 'failed' : 'unsupported' });
        } finally {
            warn.mockRestore();
        }
    });

    it('re-attempts native HTTP ingest on explicit replay after the server becomes supported', async () => {
        let supported = false;
        const publisher = createUsageObservationPublisher({
            token: 'token', apiServerUrl: 'https://api.example.test', emitUsageEvent: () => null,
            postJson: async () => { if (!supported) throw notFound(); return { ok: true }; },
        });
        const input = { subject: nativeSubject, externalKey: 'inference', observation: nativeObservation };
        expect(await publisher.publish(input)).toEqual({ status: 'unsupported' });
        supported = true;
        expect(await publisher.publish(input)).toEqual({ status: 'sent', transport: 'http' });
    });

    it('returns a failure and warns when HTTP transport fails without losing the stable retry key', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const postJson = vi.fn().mockRejectedValueOnce(new Error('network unavailable')).mockResolvedValueOnce({ ok: true });
        const publisher = createUsageObservationPublisher({ token: 'token', apiServerUrl: 'https://api.example.test',
            postJson, emitUsageEvent: () => null });
        const input = { sessionId: 'session-1', externalKey: 'native-record-1', observation: sessionObservation };
        try {
            await expect(publisher.publish(input)).resolves.toEqual({ status: 'failed' });
            expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: 'network unavailable' }));
            await expect(publisher.publish(input)).resolves.toEqual({ status: 'sent', transport: 'http' });
            expect(postJson.mock.calls.map(([request]) => request.body.externalKey)).toEqual(['native-record-1', 'native-record-1']);
        } finally {
            warn.mockRestore();
        }
    });

    it.each([true, false])('refreshes the bearer token once after an HTTP auth failure (recovers=%s)', async recovers => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const unauthorized = Object.assign(new Error('unauthorized'), { response: { status: 401 } });
        const postJson = recovers
            ? vi.fn().mockRejectedValueOnce(unauthorized).mockResolvedValueOnce({ ok: true as const })
            : vi.fn().mockRejectedValue(unauthorized);
        const resolveToken = vi.fn(async () => 'token-2');
        const publisher = createUsageObservationPublisher({ token: 'token-1', apiServerUrl: 'https://api.example.test',
            postJson, resolveToken, emitUsageEvent: () => null });
        try {
            expect(await publisher.publish({ sessionId: 'session-1', observation: sessionObservation }))
                .toEqual(recovers ? { status: 'sent', transport: 'http' } : { status: 'failed' });
            expect(resolveToken).toHaveBeenCalledTimes(1);
            expect(postJson.mock.calls.map(([request]) => [request.token, request.path])).toEqual([
                ['token-1', '/v2/usage-events'], ['token-2', '/v2/usage-events'],
            ]);
        } finally {
            warn.mockRestore();
        }
    });
});
