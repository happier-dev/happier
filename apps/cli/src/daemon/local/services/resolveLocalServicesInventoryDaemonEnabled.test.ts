import { describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';

import { resolveLocalServicesInventoryDaemonEnabled } from './resolveLocalServicesInventoryDaemonEnabled';

describe('resolveLocalServicesInventoryDaemonEnabled', () => {
    it('returns true when the server reports localServices inventory enabled (default-allow)', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                status: 200,
                json: async () =>
                    FeaturesResponseSchema.parse({
                        features: { localServices: { enabled: true, inventory: { enabled: true } } },
                        capabilities: {},
                    }),
            })) as unknown as typeof fetch,
        );

        const enabled = await resolveLocalServicesInventoryDaemonEnabled({
            env: {},
            serverUrl: 'https://api.example.test',
            timeoutMs: 100,
        });

        expect(enabled).toBe(true);
    });

    it('returns false when the server reports localServices inventory disabled', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                status: 200,
                json: async () =>
                    FeaturesResponseSchema.parse({
                        features: { localServices: { enabled: false, inventory: { enabled: false } } },
                        capabilities: {},
                    }),
            })) as unknown as typeof fetch,
        );

        const enabled = await resolveLocalServicesInventoryDaemonEnabled({
            env: {},
            serverUrl: 'https://api.example.test',
            timeoutMs: 100,
        });

        expect(enabled).toBe(false);
    });

    it('fails closed when the server features endpoint is unreachable', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new Error('network down');
            }) as unknown as typeof fetch,
        );

        const enabled = await resolveLocalServicesInventoryDaemonEnabled({
            env: {},
            serverUrl: 'https://api.example.test',
            timeoutMs: 100,
        });

        expect(enabled).toBe(false);
    });
});
