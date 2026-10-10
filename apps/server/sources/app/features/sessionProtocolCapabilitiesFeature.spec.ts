import { describe, expect, it } from 'vitest';

import { resolveSessionProtocolCapabilitiesFeature } from './sessionProtocolCapabilitiesFeature';

describe('session protocol capability payload', () => {
    it('advertises the session protocol capabilities including Follow context', () => {
        expect(resolveSessionProtocolCapabilitiesFeature()).toEqual({
            capabilities: {
                session: {
                    runtimeActivity: { protocolVersion: 2 },
                    pendingInput: { protocolVersion: 4 },
                    publisherAuthority: { protocolVersion: 1 },
                    externalImport: { publicationFenceVersion: 3 },
                    follow: { contextVersion: 1 },
                },
            },
        });
    });
});
