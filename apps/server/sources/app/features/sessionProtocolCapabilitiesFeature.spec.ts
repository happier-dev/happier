import { describe, expect, it } from 'vitest';

import { resolveSessionProtocolCapabilitiesFeature } from './sessionProtocolCapabilitiesFeature';

describe('session protocol capability payload', () => {
    it('advertises Runtime Activity and Pending-input independently', () => {
        expect(resolveSessionProtocolCapabilitiesFeature()).toEqual({
            capabilities: {
                session: {
                    runtimeActivity: { protocolVersion: 2 },
                    pendingInput: { protocolVersion: 2 },
                },
            },
        });
    });
});
