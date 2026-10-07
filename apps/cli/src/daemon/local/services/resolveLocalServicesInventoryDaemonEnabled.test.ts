import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';

import { resolveLocalServicesInventoryDaemonEnabled } from './resolveLocalServicesInventoryDaemonEnabled';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';

describe('resolveLocalServicesInventoryDaemonEnabled', () => {
    afterEach(() => {
        resetServerFeaturesClientForTests();
        vi.unstubAllGlobals();
    });

    it('returns true when the server reports localServices inventory enabled (default-allow)', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn<typeof fetch>(async () => new Response(JSON.stringify(
                    FeaturesResponseSchema.parse({
                        features: { localServices: { enabled: true, inventory: { enabled: true } } },
                        capabilities: {},
                    })), { status: 200, headers: { 'content-type': 'application/json' } })),
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
            vi.fn<typeof fetch>(async () => new Response(JSON.stringify(
                    FeaturesResponseSchema.parse({
                        features: { localServices: { enabled: false, inventory: { enabled: false } } },
                        capabilities: {},
                    })), { status: 200, headers: { 'content-type': 'application/json' } })),
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
            vi.fn<typeof fetch>(async () => {
                throw new Error('network down');
            }),
        );

        const enabled = await resolveLocalServicesInventoryDaemonEnabled({
            env: {},
            serverUrl: 'https://api.example.test',
            timeoutMs: 100,
        });

        expect(enabled).toBe(false);
    });
});
