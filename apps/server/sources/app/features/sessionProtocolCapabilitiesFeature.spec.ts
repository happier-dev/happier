import { describe, expect, it } from 'vitest';

import { resolveSessionProtocolCapabilitiesFeature } from './sessionProtocolCapabilitiesFeature';

describe('session protocol capability payload', () => {
    it('advertises only the independent session capabilities', () => {
        expect(resolveSessionProtocolCapabilitiesFeature()).toEqual({
            capabilities: {
                session: {
                    runtimeActivity: { protocolVersion: 2 },
                    pendingInput: { protocolVersion: 1 },
                    publisherAuthority: { protocolVersion: 1 },
                    externalImport: { publicationFenceVersion: 3 },
                },
            },
        });
    });
});
