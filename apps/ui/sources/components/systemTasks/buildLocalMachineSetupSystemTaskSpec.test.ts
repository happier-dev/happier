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
});
