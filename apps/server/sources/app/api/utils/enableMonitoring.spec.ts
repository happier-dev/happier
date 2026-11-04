import Fastify from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fastify as HappierFastify } from '../types';

const mockQueryRaw = vi.fn();
const mockHttpRequestsInc = vi.fn();
const mockHttpRequestDurationObserve = vi.fn();
const mockDbReadinessChecksInc = vi.fn();
const mockDbReadinessDurationObserve = vi.fn();
const mockLog = vi.fn();

vi.mock('@/storage/db', () => ({
    probeDbReadiness: () => mockQueryRaw(),
}));

vi.mock('@/app/monitoring/metrics2', () => ({
    httpRequestsCounter: { inc: mockHttpRequestsInc },
    httpRequestDurationHistogram: { observe: mockHttpRequestDurationObserve },
    dbReadinessChecksCounter: { inc: mockDbReadinessChecksInc },
    dbReadinessDurationHistogram: { observe: mockDbReadinessDurationObserve },
}));

// Logging is a process-output boundary; keep expected failure-path tests quiet.
vi.mock('@/utils/logging/log', () => ({
    log: mockLog,
}));

function createMonitoringApp(): HappierFastify {
    return Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as HappierFastify;
}

describe('enableMonitoring (unit)', () => {
    const originalDbReadinessTimeoutMs = process.env.HAPPIER_DB_READINESS_TIMEOUT_MS;

    beforeEach(() => {
        mockQueryRaw.mockReset();
        mockHttpRequestsInc.mockReset();
        mockHttpRequestDurationObserve.mockReset();
        mockDbReadinessChecksInc.mockReset();
        mockDbReadinessDurationObserve.mockReset();
        mockLog.mockReset();
    });

    afterEach(() => {
        if (originalDbReadinessTimeoutMs === undefined) {
            delete process.env.HAPPIER_DB_READINESS_TIMEOUT_MS;
        } else {
            process.env.HAPPIER_DB_READINESS_TIMEOUT_MS = originalDbReadinessTimeoutMs;
        }
        vi.useRealTimers();
    });

    it('returns process liveness for /health without querying the database', async () => {
        mockQueryRaw.mockRejectedValue(new Error('SQLITE_CANTOPEN: cannot open database'));

        const { enableMonitoring } = await import('./enableMonitoring');
        const app = createMonitoringApp();

        try {
            enableMonitoring(app);
            await app.ready();

            const res = await app.inject({ method: 'GET', url: '/health' });
            expect(res.statusCode).toBe(200);
            const body = res.json() as { status?: string; timestamp?: string; service?: string };
            expect(body.status).toBe('ok');
            expect(body.service).toBe('happier-server');
            expect(typeof body.timestamp).toBe('string');
            expect(mockQueryRaw).not.toHaveBeenCalled();
            expect(mockDbReadinessChecksInc).not.toHaveBeenCalled();
            expect(mockDbReadinessDurationObserve).not.toHaveBeenCalled();
        } finally {
            await app.close().catch(() => {});
        }
    });

    it.each(['/live', '/health/db'])('does not register deprecated monitoring alias %s', async (url) => {
        const { enableMonitoring } = await import('./enableMonitoring');
        const app = createMonitoringApp();

        try {
            enableMonitoring(app);
            await app.ready();

            const res = await app.inject({ method: 'GET', url });
            expect(res.statusCode).toBe(404);
            expect(mockQueryRaw).not.toHaveBeenCalled();
            expect(mockDbReadinessChecksInc).not.toHaveBeenCalled();
            expect(mockDbReadinessDurationObserve).not.toHaveBeenCalled();
        } finally {
            await app.close().catch(() => {});
        }
    });

    it('records successful database readiness checks with duration telemetry', async () => {
        mockQueryRaw.mockResolvedValueOnce([{ one: 1 }]);

        const { enableMonitoring } = await import('./enableMonitoring');
        const app = createMonitoringApp();

        try {
            enableMonitoring(app);
            await app.ready();

            const res = await app.inject({ method: 'GET', url: '/ready' });
            expect(res.statusCode).toBe(200);
            expect(mockDbReadinessChecksInc).toHaveBeenCalledWith({ result: 'ok', reason: 'none' });
            expect(mockDbReadinessDurationObserve).toHaveBeenCalledWith(
                { result: 'ok', reason: 'none' },
                expect.any(Number),
            );
        } finally {
            await app.close().catch(() => {});
        }
    });

    it('coalesces concurrent database readiness checks into a single probe', async () => {
        const query = { resolve: null as ((value: unknown) => void) | null };
        mockQueryRaw.mockReturnValueOnce(new Promise((resolve) => {
            query.resolve = resolve;
        }));

        const { enableMonitoring } = await import('./enableMonitoring');
        const app = createMonitoringApp();

        try {
            enableMonitoring(app);
            await app.ready();

            const first = app.inject({ method: 'GET', url: '/ready' });
            const second = app.inject({ method: 'GET', url: '/ready' });

            await vi.waitFor(() => {
                expect(mockQueryRaw).toHaveBeenCalledTimes(1);
            });

            query.resolve?.([{ one: 1 }]);
            const [firstRes, secondRes] = await Promise.all([first, second]);

            expect(firstRes.statusCode).toBe(200);
            expect(secondRes.statusCode).toBe(200);
            expect(mockQueryRaw).toHaveBeenCalledTimes(1);
            expect(mockDbReadinessChecksInc).toHaveBeenCalledTimes(2);
            expect(mockDbReadinessDurationObserve).toHaveBeenCalledTimes(2);
        } finally {
            await app.close().catch(() => {});
        }
    });

    it('returns 503 with a structured database readiness error body when /ready query fails', async () => {
        mockQueryRaw.mockRejectedValueOnce(new Error('SQLITE_CANTOPEN: cannot open database'));

        const { enableMonitoring } = await import('./enableMonitoring');
        const app = createMonitoringApp();

        try {
            enableMonitoring(app);
            await app.ready();

            const res = await app.inject({ method: 'GET', url: '/ready' });
            expect(res.statusCode).toBe(503);
            const body = res.json() as { status?: string; service?: string; error?: string; reason?: string };
            expect(body.status).toBe('error');
            expect(body.service).toBe('happier-server');
            expect(body.error).toBe('Database connectivity failed');
            expect(body.reason).toBe('db_error');
            expect(mockDbReadinessChecksInc).toHaveBeenCalledWith({ result: 'error', reason: 'db_error' });
            expect(mockDbReadinessDurationObserve).toHaveBeenCalledWith(
                { result: 'error', reason: 'db_error' },
                expect.any(Number),
            );
        } finally {
            await app.close().catch(() => {});
        }
    });

    it('classifies Prisma pool timeout readiness failures as backpressure', async () => {
        const error = new Error('Timed out fetching a new connection from the connection pool');
        Object.assign(error, { code: 'P2024' });
        mockQueryRaw.mockRejectedValueOnce(error);

        const { enableMonitoring } = await import('./enableMonitoring');
        const app = createMonitoringApp();

        try {
            enableMonitoring(app);
            await app.ready();

            const res = await app.inject({ method: 'GET', url: '/ready' });
            expect(res.statusCode).toBe(503);
            const body = res.json() as { reason?: string };
            expect(body.reason).toBe('backpressure');
            expect(mockDbReadinessChecksInc).toHaveBeenCalledWith({ result: 'error', reason: 'backpressure' });
        } finally {
            await app.close().catch(() => {});
        }
    });

    it('does not log raw database readiness error messages', async () => {
        mockQueryRaw.mockRejectedValueOnce(new Error('DATABASE_URL=postgres://user:secret-password@example.test/db'));

        const { enableMonitoring } = await import('./enableMonitoring');
        const app = createMonitoringApp();

        try {
            enableMonitoring(app);
            await app.ready();

            const res = await app.inject({ method: 'GET', url: '/ready' });
            expect(res.statusCode).toBe(503);
            expect(JSON.stringify(mockLog.mock.calls)).not.toContain('secret-password');
        } finally {
            await app.close().catch(() => {});
        }
    });

    it('returns 503 when database readiness exceeds the configured timeout', async () => {
        vi.useFakeTimers();
        process.env.HAPPIER_DB_READINESS_TIMEOUT_MS = '25';
        mockQueryRaw.mockReturnValueOnce(new Promise(() => {}));

        const { enableMonitoring } = await import('./enableMonitoring');
        const app = createMonitoringApp();

        try {
            enableMonitoring(app);
            await app.ready();

            const response = app.inject({ method: 'GET', url: '/ready' });
            await vi.advanceTimersByTimeAsync(25);

            const res = await response;
            expect(res.statusCode).toBe(503);
            const body = res.json() as { status?: string; service?: string; error?: string; reason?: string };
            expect(body.status).toBe('error');
            expect(body.service).toBe('happier-server');
            expect(body.error).toBe('Database connectivity failed');
            expect(body.reason).toBe('db_timeout');
            expect(mockDbReadinessChecksInc).toHaveBeenCalledWith({ result: 'error', reason: 'db_timeout' });
            expect(mockDbReadinessDurationObserve).toHaveBeenCalledWith(
                { result: 'error', reason: 'db_timeout' },
                expect.any(Number),
            );
        } finally {
            await app.close().catch(() => {});
        }
    });

    it('uses a 15s default database readiness timeout', async () => {
        vi.useFakeTimers();
        delete process.env.HAPPIER_DB_READINESS_TIMEOUT_MS;
        mockQueryRaw.mockReturnValueOnce(new Promise(() => {}));

        const { enableMonitoring } = await import('./enableMonitoring');
        const app = createMonitoringApp();

        try {
            enableMonitoring(app);
            await app.ready();

            const response = app.inject({ method: 'GET', url: '/ready' });
            let settled = false;
            void response.finally(() => {
                settled = true;
            });

            await vi.advanceTimersByTimeAsync(5_000);
            expect(settled).toBe(false);

            await vi.advanceTimersByTimeAsync(10_000);
            const res = await response;
            expect(res.statusCode).toBe(503);
            const body = res.json() as { reason?: string };
            expect(body.reason).toBe('db_timeout');
        } finally {
            await app.close().catch(() => {});
        }
    });

    it('returns 503 from /health during shutdown without querying the database', async () => {
        vi.resetModules();
        mockQueryRaw.mockResolvedValueOnce([{ one: 1 }]);

        const { enableMonitoring } = await import('./enableMonitoring');
        const { initiateShutdown } = await import('@/utils/process/shutdown');
        const app = createMonitoringApp();

        try {
            enableMonitoring(app);
            await app.ready();
            await initiateShutdown('test');

            const res = await app.inject({ method: 'GET', url: '/health' });
            expect(res.statusCode).toBe(503);
            const body = res.json() as { status?: string; service?: string; reason?: string };
            expect(body.status).toBe('error');
            expect(body.service).toBe('happier-server');
            expect(body.reason).toBe('shutting_down');
            expect(mockQueryRaw).not.toHaveBeenCalled();
        } finally {
            await app.close().catch(() => {});
        }
    });

    it('returns 503 from /ready during shutdown without querying the database', async () => {
        vi.resetModules();
        mockQueryRaw.mockResolvedValueOnce([{ one: 1 }]);

        const { enableMonitoring } = await import('./enableMonitoring');
        const { initiateShutdown } = await import('@/utils/process/shutdown');
        const app = createMonitoringApp();

        try {
            enableMonitoring(app);
            await app.ready();
            await initiateShutdown('test');

            const res = await app.inject({ method: 'GET', url: '/ready' });
            expect(res.statusCode).toBe(503);
            const body = res.json() as { status?: string; service?: string; reason?: string };
            expect(body.status).toBe('error');
            expect(body.service).toBe('happier-server');
            expect(body.reason).toBe('shutting_down');
            expect(mockQueryRaw).not.toHaveBeenCalled();
            expect(mockDbReadinessChecksInc).not.toHaveBeenCalled();
        } finally {
            await app.close().catch(() => {});
        }
    });
});
