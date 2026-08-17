import { describe, expect, it } from 'vitest';

import { resolveAccountStoredContentCompatibilityFeature } from './accountStoredContentCompatibilityFeature';

describe('account stored-content compatibility payload', () => {
    it('advertises the account-storage contract independently from session capabilities', () => {
        expect(resolveAccountStoredContentCompatibilityFeature()).toEqual({
            capabilities: {
                accountStoredContentCompatibility: {
                    v: 1,
                    minimumProtocolVersion: 2,
                    currentProtocolVersion: 3,
                    declarationTransport: 'http-header-and-socket-auth-v1',
                },
            },
        });
    });
});
