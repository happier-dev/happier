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
});
