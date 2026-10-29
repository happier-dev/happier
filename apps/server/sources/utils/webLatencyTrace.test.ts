import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { symbols, type DestinationStream } from 'pino';

import { logger, resolveServerLogLevelFromEnv } from './logging/log';
import { annotateWebLatencyQuery, readWebLatencyRequestId, timeWebLatencyPhase, withWebLatencyTrace } from './webLatencyTrace';
import { enableMonitoring } from '@/app/api/utils/enableMonitoring';
import type { Fastify as HappierFastify } from '@/app/api/types';

const originalLevel = logger.level;

beforeEach(() => {
    logger.level = resolveServerLogLevelFromEnv({ HAPPIER_SERVER_LOG_LEVEL: 'debug' });
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    logger.level = originalLevel;
});

describe('web latency request correlation', () => {
    it('runs operations without phase clocks or submissions when detailed tracing is disabled', async () => {
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '0');
        const clock = vi.spyOn(performance, 'now');
        const debug = vi.spyOn(logger, 'debug');
        const trace = vi.spyOn(logger, 'trace');
        const result = await withWebLatencyTrace('req-disabled', () => timeWebLatencyPhase('db.Session.findMany', () => {
            expect(readWebLatencyRequestId()).toBe('req-disabled');
            expect(annotateWebLatencyQuery('SELECT 1')).toBe('SELECT 1');
            return 'ok';
        }));
        expect(result).toBe('ok');
        expect(clock).not.toHaveBeenCalled();
        expect(debug).not.toHaveBeenCalled();
        expect(trace).not.toHaveBeenCalled();
    });

    it('keeps successful database span detail at trace while debug retains request summaries and failures', async () => {
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
        const originalLevel = logger.level;
        const records: { phase?: string; level?: string; spanId?: number; parentSpanId?: number }[] = [];
        const stream = (logger as unknown as { [symbols.streamSym]: DestinationStream })[symbols.streamSym];
        vi.spyOn(stream, 'write').mockImplementation(message => {
            records.push(JSON.parse(message));
        });
        try {
            logger.level = 'debug';
            // Observe submissions to external Pino, before its real threshold filtering.
            const trace = vi.spyOn(logger, 'trace');
            await withWebLatencyTrace('23b2ed82-2ef7-4e4e-af0f-f64d599a08c6', async () => {
                for (let index = 0; index < 1_000; index++) {
                    expect(await timeWebLatencyPhase('db.Session.findMany', () => {
                        expect(annotateWebLatencyQuery('SELECT 1')).toContain(`happier-web-latency:23b2ed82-2ef7-4e4e-af0f-f64d599a08c6:${index + 1}`);
                        return index;
                    })).toBe(index);
                }
                await timeWebLatencyPhase('http.GET./v2/changes', () => 'ok');
                await expect(timeWebLatencyPhase('db.transaction.attempt', () => { throw new Error('private'); })).rejects.toThrow();
            });
            expect(records.map(record => record.phase)).toEqual(['http.GET./v2/changes', 'db.transaction.attempt']);
            expect(trace.mock.calls.length).toBe(0);
            logger.level = 'trace';
            const enabledTrace = vi.spyOn(logger, 'trace');
            await withWebLatencyTrace('req-enabled', () => timeWebLatencyPhase('db.transaction.callback', () =>
                timeWebLatencyPhase('db.Session.findMany', () => 'ok')));
            expect(enabledTrace).toHaveBeenCalledTimes(2);
            const child = records.find(record => record.phase === 'db.Session.findMany');
            const parent = records.find(record => record.phase === 'db.transaction.callback');
            expect(parent).toMatchObject({ spanId: 1 });
            expect(child).toMatchObject({ phase: 'db.Session.findMany', level: 'trace', spanId: 2, parentSpanId: parent?.spanId });
        } finally {
            logger.level = originalLevel;
        }
    });
    it('links nested database spans and records safe failure outcomes without exception content', async () => {
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
        const sink = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
        const requestId = '23b2ed82-2ef7-4e4e-af0f-f64d599a08c6';
        const failure = Object.assign(new Error('private database input'), { code: 'P2010', meta: { code: '40P01' } });
        await expect(withWebLatencyTrace(requestId, () => timeWebLatencyPhase('db.transaction.attempt',
            () => timeWebLatencyPhase('db.raw.$queryRawUnsafe', () => { throw failure; }))))
            .rejects.toBe(failure);
        const records = sink.mock.calls.map(([record]) => record).filter(
            (record): record is Record<string, unknown> => typeof record === 'object' && record !== null,
        );
        const transaction = records.find(record => record.phase === 'db.transaction.attempt');
        const query = records.find(record => record.phase === 'db.raw.$queryRawUnsafe');
        expect(transaction).toMatchObject({ requestId, spanId: expect.any(Number), status: 'failed', code: 'P2010', sqlState: '40P01' });
        expect(query).toMatchObject({ requestId, spanId: expect.any(Number), parentSpanId: transaction?.spanId, status: 'failed' });
        expect(query?.spanId).not.toBe(transaction?.spanId);
        expect(JSON.stringify(records)).not.toContain('private database input');
    });

    it('correlates ordinary concurrent HTTP reads through the real monitoring hooks', async () => {
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
        const sink = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
        const requestRecords: { reqId?: string; req?: object; res?: object }[] = [];
        const stream = (logger as unknown as { [symbols.streamSym]: DestinationStream })[symbols.streamSym];
        vi.spyOn(stream, 'write').mockImplementation(message => { requestRecords.push(JSON.parse(message)); });
        const requestIds = new Map<string, string>();
        const traceObservations = new Map<string, { requestId?: string; sql: string }>();
        const app = Fastify({ loggerInstance: logger }).withTypeProvider<ZodTypeProvider>() as unknown as HappierFastify;
        enableMonitoring(app);
        app.addHook('preHandler', async () => {
            await timeWebLatencyPhase('probe.admission', async () => { await Promise.resolve(); });
        });
        app.get<{ Params: { id: string } }>('/trace/:id', async (request) => {
            requestIds.set(request.params.id, request.id);
            await withWebLatencyTrace('23b2ed82-2ef7-4e4e-af0f-f64d599a08c6', () =>
                timeWebLatencyPhase(`probe.${request.params.id}`, async () => {
                    await Promise.resolve();
                    traceObservations.set(request.params.id, {
                        requestId: readWebLatencyRequestId(), sql: annotateWebLatencyQuery('SELECT 1'),
                    });
                }));
            return { ok: true };
        });
        try {
            const responses = await Promise.all([
                app.inject({ url: '/trace/a?private=must-not-be-logged', headers: { 'request-id': 'private-header-input' } }),
                app.inject({ url: '/trace/b?private=must-not-be-logged', headers: { 'request-id': 'private-header-input' } }),
            ]);
            expect(responses.map(response => response.json())).toEqual([{ ok: true }, { ok: true }]);
            const records = sink.mock.calls.map(([record]) => record).filter(
                (record): record is Record<string, unknown> => typeof record === 'object' && record !== null,
            );
            const first = records.find(record => record?.phase === 'probe.a');
            const second = records.find(record => record?.phase === 'probe.b');
            expect(first).toEqual(expect.objectContaining({ requestId: requestIds.get('a') }));
            expect(second).toEqual(expect.objectContaining({ requestId: requestIds.get('b') }));
            expect(first?.requestId).not.toBe(second?.requestId);
            for (const [key, requestId] of requestIds) {
                expect(traceObservations.get(key)?.requestId).toBe(requestId);
                expect(traceObservations.get(key)?.sql).toContain(`happier-web-latency:${requestId}:`);
            }
            for (const requestId of [first?.requestId, second?.requestId]) {
                expect(requestRecords).toEqual(expect.arrayContaining([
                    expect.objectContaining({ reqId: requestId, req: expect.any(Object) }),
                    expect.objectContaining({ reqId: requestId, res: expect.any(Object) }),
                ]));
                expect(records).toEqual(expect.arrayContaining([
                    expect.objectContaining({ phase: 'probe.admission', requestId }),
                    expect.objectContaining({ phase: 'http.GET./trace/:id', requestId }),
                ]));
            }
            expect(JSON.stringify(records)).not.toContain('must-not-be-logged');
            expect(JSON.stringify(records)).not.toContain('private-header-input');
        } finally {
            await app.close();
        }
    });

    it.each(['', 'new-session-attempt-'])('retains the existing %s request identity across asynchronous dispatch', async (prefix) => {
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
        // Pino is the logging output boundary; dispatch and context propagation remain real.
        const sink = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
        const requestId = `${prefix}23b2ed82-2ef7-4e4e-af0f-f64d599a08c6`;
        const failure = new Error('dispatch failed');

        await expect(withWebLatencyTrace(requestId, async () => {
            await Promise.resolve();
            return await timeWebLatencyPhase('action.http.dispatch', async () => { throw failure; });
        })).rejects.toBe(failure);

        expect(sink).toHaveBeenCalledWith(expect.objectContaining({
            phase: 'action.http.dispatch', requestId,
        }), '[web-latency]');
    });

    it('keeps failed attempts at debug and successful database detail at trace', async () => {
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
        logger.level = 'trace';
        const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
        const trace = vi.spyOn(logger, 'trace').mockImplementation(() => undefined);
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        await timeWebLatencyPhase('db.transaction.attempt', () => 'ok');
        const failure = Object.assign(new Error('private database input'), { code: 'P2024' });
        await expect(timeWebLatencyPhase('db.transaction.attempt', () => { throw failure; })).rejects.toBe(failure);
        expect(trace).toHaveBeenCalledWith(expect.objectContaining({
            module: 'web-latency', phase: 'db.transaction.attempt', status: 'completed',
        }), '[web-latency]');
        expect(debug).toHaveBeenCalledWith(expect.objectContaining({
            module: 'web-latency', phase: 'db.transaction.attempt', status: 'failed', code: 'P2024',
        }), '[web-latency]');
        expect(warn).not.toHaveBeenCalled();
    });

    it.each(['private free-form input', 'req-private/input', "req-private'input", 'req-private\ninput'])(
        'omits arbitrary input (%s) and leaves tracing disabled unless requested', async (requestId) => {
        const sink = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
        await withWebLatencyTrace(requestId, () => timeWebLatencyPhase('dispatch', () => 'ok'));
        expect(sink).toHaveBeenCalledWith(expect.not.objectContaining({ requestId: expect.anything() }), '[web-latency]');
        sink.mockClear();
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '0');
        expect(await withWebLatencyTrace('23b2ed82-2ef7-4e4e-af0f-f64d599a08c6', () => timeWebLatencyPhase('dispatch', () => 'ok'))).toBe('ok');
        expect(sink).not.toHaveBeenCalled();
    });
});
