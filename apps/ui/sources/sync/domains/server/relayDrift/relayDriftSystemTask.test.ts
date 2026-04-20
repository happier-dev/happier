import { describe, expect, it, vi } from 'vitest';

import { buildRelayDriftRepairSystemTaskSpec } from './relayDriftSystemTask';

describe('buildRelayDriftRepairSystemTaskSpec', () => {
    it('builds the stable repair task contract for aligning the background service to the active relay', () => {
        expect(buildRelayDriftRepairSystemTaskSpec({
            activeRelayUrl: 'https://relay.example.test/path',
            activeWebappUrl: 'https://app.example.test',
            activeLocalRelayUrl: 'http://127.0.0.1:3012',
        })).toEqual({
            protocolVersion: 1,
            kind: 'setup.repairThisComputer.v1',
            params: {
                channel: 'stable',
                activeRelayUrl: 'https://relay.example.test/path',
                activeWebappUrl: 'https://app.example.test',
                activeLocalRelayUrl: 'http://127.0.0.1:3012',
                surface: 'desktop.ui',
            },
        });
    });

    it('uses channel=dev for publicdev builds', async () => {
        vi.resetModules();
        vi.doMock('@/config', () => ({
            config: {
                variant: 'publicdev',
            },
        }));

        const { buildRelayDriftRepairSystemTaskSpec } = await import('./relayDriftSystemTask');

        const spec = buildRelayDriftRepairSystemTaskSpec({
            activeRelayUrl: 'https://relay.example.test/path',
            activeWebappUrl: 'https://app.example.test',
        });
        const params = spec.params as Record<string, unknown>;
        expect(params.channel).toBe('dev');
    });
});
