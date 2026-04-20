import { describe, expect, it, vi } from 'vitest';

describe('buildLocalMachineSetupSystemTaskSpec', () => {
    it('uses channel=dev for publicdev builds (systemTasks channels are labels, not ring ids)', async () => {
        vi.resetModules();
        vi.doMock('@/config', () => ({
            config: {
                variant: 'publicdev',
            },
        }));

        const { buildLocalMachineSetupSystemTaskSpec } = await import('./buildLocalMachineSetupSystemTaskSpec');

        const spec = buildLocalMachineSetupSystemTaskSpec();
        const params = spec.params as Record<string, unknown>;
        expect(params.channel).toBe('dev');
    });

    it('includes the explicit UI-selected relay profile when provided', async () => {
        vi.resetModules();
        const { buildLocalMachineSetupSystemTaskSpec } = await import('./buildLocalMachineSetupSystemTaskSpec');

        const spec = buildLocalMachineSetupSystemTaskSpec({
            activeRelayUrl: 'https://relay.example.test',
            activeWebappUrl: 'https://app.example.test',
            activeLocalRelayUrl: 'http://127.0.0.1:53288',
            installService: true,
        });
        const params = spec.params as Record<string, unknown>;

        expect(params).toMatchObject({
            activeRelayUrl: 'https://relay.example.test',
            activeWebappUrl: 'https://app.example.test',
            activeLocalRelayUrl: 'http://127.0.0.1:53288',
            installService: true,
        });
    });
});
