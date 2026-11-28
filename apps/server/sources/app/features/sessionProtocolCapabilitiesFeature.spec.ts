import { describe, expect, it } from 'vitest';

import { resolveSessionProtocolCapabilitiesFeature } from './sessionProtocolCapabilitiesFeature';

describe('session protocol capability payload', () => {
    it('advertises Runtime Activity, Pending-input and terminal handoff independently', () => {
        expect(resolveSessionProtocolCapabilitiesFeature()).toEqual({
            capabilities: {
                session: {
                    runtimeActivity: { protocolVersion: 2 },
                    pendingInput: { protocolVersion: 2 },
                    pendingTerminalHandoff: true,
                },
            },
        });
    });
});
