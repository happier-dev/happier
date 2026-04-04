import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const mockQueryRaw = vi.fn();

vi.mock('@/storage/db', () => ({
    db: { $queryRaw: mockQueryRaw },
}));

describe('enableMonitoring (unit)', () => {
    it('returns 503 with a database connectivity error body when the health query fails', async () => {
        mockQueryRaw.mockRejectedValueOnce(new Error('SQLITE_CANTOPEN: cannot open database'));

        const { enableMonitoring } = await import('./enableMonitoring');
        const app = Fastify({ logger: false }) as any;

        try {
            enableMonitoring(app);
            await app.ready();

            const res = await app.inject({ method: 'GET', url: '/health' });
            expect(res.statusCode).toBe(503);
            const body = res.json() as { status?: string; service?: string; error?: string };
            expect(body.status).toBe('error');
            expect(body.service).toBe('happier-server');
            expect(body.error).toBe('Database connectivity failed');
        } finally {
            await app.close().catch(() => {});
        }
    });
});
