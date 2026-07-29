import type { PluginHostAccessRequestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
    fingerprintPluginHostAccessRequest,
    matchesPluginHostAccessGrant,
} from './scope';

function networkRequest(origin: string, methods: readonly ('GET' | 'POST')[]): PluginHostAccessRequestV2 {
    return {
        id: 'api',
        capability: 'network',
        reason: 'API access',
        scope: {
            targets: [{ kind: 'fixedOrigin', origin }],
            methods: [...methods],
        },
    };
}

describe('plugin HostAccess scope identity', () => {
    it('matches only the exact structured request', () => {
        const granted = networkRequest('https://example.test', ['GET']);

        expect(matchesPluginHostAccessGrant(granted, networkRequest('https://example.test', ['GET']))).toBe(true);
        expect(matchesPluginHostAccessGrant(granted, networkRequest('https://other.test', ['GET']))).toBe(false);
        expect(matchesPluginHostAccessGrant(granted, networkRequest('https://example.test', ['POST']))).toBe(false);
    });

    it('binds the full request scope into its fingerprint', () => {
        expect(fingerprintPluginHostAccessRequest(networkRequest('https://example.test', ['GET'])))
            .not.toBe(fingerprintPluginHostAccessRequest(networkRequest('https://other.test', ['GET'])));
        expect(fingerprintPluginHostAccessRequest(networkRequest('https://example.test', ['GET'])))
            .not.toBe(fingerprintPluginHostAccessRequest(networkRequest('https://example.test', ['POST'])));
    });

    it('binds Connected Account materialization kinds into the grant fingerprint', () => {
        const request = (materializationKinds?: readonly ('environment' | 'files')[]): PluginHostAccessRequestV2 => ({
            id: 'account',
            capability: 'connectedAccounts',
            reason: 'Use an account',
            scope: {
                serviceRefs: ['account'],
                operations: ['use'],
                ...(materializationKinds ? { materializationKinds: [...materializationKinds] } : {}),
            },
        });

        expect(fingerprintPluginHostAccessRequest(request(['environment'])))
            .not.toBe(fingerprintPluginHostAccessRequest(request(['files'])));
        expect(fingerprintPluginHostAccessRequest(request(['environment'])))
            .not.toBe(fingerprintPluginHostAccessRequest(request()));
        expect(fingerprintPluginHostAccessRequest(request(['environment', 'files'])))
            .toBe(fingerprintPluginHostAccessRequest(request(['files', 'environment'])));
    });
});
