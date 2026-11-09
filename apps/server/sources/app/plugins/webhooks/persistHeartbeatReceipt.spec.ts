import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { persistPluginWebhookHeartbeatReceiptV1 } from './persistHeartbeatReceipt';

afterEach(() => vi.unstubAllEnvs());

describe('heartbeat provider liveness writes', () => {
    it('preserves PostgreSQL content clocks through null, equal, out-of-order and concurrent receipts in a real engine', async () => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'pglite');
        const engine = new PGlite();
        try {
            await engine.exec(`CREATE TABLE "PluginWebhookEndpoint" ("id" text PRIMARY KEY,
                "lastAcceptedAt" timestamp, "updatedAt" timestamp NOT NULL, "revision" integer NOT NULL);
                INSERT INTO "PluginWebhookEndpoint" VALUES ('endpoint', NULL, '2026-01-01', 7);`);
            const tx = {
                async $executeRaw(parts: TemplateStringsArray, ...values: unknown[]) {
                    const query = parts.reduce((sql, part, index) => sql + (index ? `$${index}` : '') + part, '');
                    const result = await engine.query(query, values);
                    return result.affectedRows ?? 0;
                },
            };
            const write = (timestamp: number) => persistPluginWebhookHeartbeatReceiptV1(tx,
                { endpointId: 'endpoint', receivedAt: new Date(timestamp) });
            const base = Date.UTC(2026, 9, 1);
            expect(await write(base)).toBe(1);
            expect(await write(base)).toBe(0);
            expect(await write(base - 1)).toBe(0);
            await Promise.all([base + 100, base + 50, base + 200, base - 10].map(write));
            const { rows } = await engine.query<{ lastAcceptedAt: number; updatedAt: number; revision: number }>(
                'SELECT (EXTRACT(epoch FROM "lastAcceptedAt") * 1000)::float8 AS "lastAcceptedAt", '
                + '(EXTRACT(epoch FROM "updatedAt") * 1000)::float8 AS "updatedAt", "revision" FROM "PluginWebhookEndpoint"');
            expect(rows).toEqual([{ lastAcceptedAt: base + 200, updatedAt: Date.UTC(2026, 0, 1), revision: 7 }]);
        } finally {
            await engine.close();
        }
    });

    it.each(['mysql', 'sqlite', 'postgres'] as const)('parameterizes %s null-safe monotonic updates without content-clock assignments', async provider => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', provider);
        let statement = '';
        let parameters: unknown[] = [];
        const tx = { async $executeRaw(parts: TemplateStringsArray, ...values: unknown[]) {
            statement = parts.join('?'); parameters = values; return 1;
        } };
        const timestamp = new Date('2026-10-01T00:00:00Z');
        expect(await persistPluginWebhookHeartbeatReceiptV1(tx, { endpointId: "id-with-'quote", receivedAt: timestamp })).toBe(1);
        expect(statement).toContain(provider === 'sqlite' ? 'MAX(COALESCE(' : 'GREATEST(COALESCE(');
        expect(statement).not.toContain("id-with-'quote");
        expect(statement).not.toMatch(/updatedAt|revision|providerConfirmedAt/);
        expect(parameters).toContain("id-with-'quote");
        expect(parameters).toContainEqual(provider === 'postgres' ? timestamp.toISOString() : timestamp);
    });
});
