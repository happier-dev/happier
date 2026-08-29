import { describe, expect, it, vi } from 'vitest';

describe('buildLocalRelayRuntimeSystemTaskSpec', () => {
    it('uses channel=dev on publicdev builds', async () => {
        vi.resetModules();
        vi.doMock('@/config', () => ({
            config: {
                variant: 'publicdev',
            },
        }));

        const { buildLocalRelayRuntimeSystemTaskSpec } = await import('./buildLocalRelayRuntimeSystemTaskSpec');
        const spec = buildLocalRelayRuntimeSystemTaskSpec('relay.runtime.status.v1');
        const params = spec.params as Record<string, unknown>;
        expect(params.channel).toBe('dev');
    });

    it('carries the fixed Personal Home purpose and environment', async () => {
        vi.resetModules();
        const { buildLocalRelayRuntimeSystemTaskSpec } = await import('./buildLocalRelayRuntimeSystemTaskSpec');
        const spec = buildLocalRelayRuntimeSystemTaskSpec('relay.runtime.installOrUpdate.v1', {
            purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' },
        });
        const params = spec.params as Record<string, unknown>;
        expect(params.purpose).toEqual({ kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' });
        expect(params.env).toEqual(expect.objectContaining({
            HAPPIER_SERVER_HOST: '127.0.0.1',
            PORT: '43123',
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain',
        }));
    });
});
