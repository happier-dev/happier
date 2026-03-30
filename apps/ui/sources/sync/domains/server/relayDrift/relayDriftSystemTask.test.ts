import { describe, expect, it } from 'vitest';

import { buildRelayDriftRepairSystemTaskSpec } from './relayDriftSystemTask';

describe('buildRelayDriftRepairSystemTaskSpec', () => {
    it('builds the stable repair task contract for aligning the background service to the active relay', () => {
        expect(buildRelayDriftRepairSystemTaskSpec({
            activeRelayUrl: 'https://relay.example.test/path',
            activeWebappUrl: 'https://app.example.test',
            activeLocalRelayUrl: 'http://127.0.0.1:3012',
        })).toEqual({
            protocolVersion: 1,
            kind: 'relay.connectBackgroundService.v1',
            params: {
                activeRelayUrl: 'https://relay.example.test/path',
                activeWebappUrl: 'https://app.example.test',
                activeLocalRelayUrl: 'http://127.0.0.1:3012',
                surface: 'desktop.ui',
            },
        });
    });
});
