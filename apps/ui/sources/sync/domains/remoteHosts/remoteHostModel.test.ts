import { describe, expect, it } from 'vitest';

import { readRemoteHosts } from './remoteHostModel';

describe('readRemoteHosts', () => {
    it('exposes only current remote-host records from the retained settings collection', () => {
        const currentHost = {
            id: 'host-1',
            name: 'Developer workstation',
            ssh: {
                target: 'developer@example.test',
                authMode: 'agent' as const,
            },
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: 1,
        };

        const historicalHost = {
            ...currentHost,
            id: 'host-legacy',
            name: 'Historical workstation',
            lastUsedAt: null,
        };

        expect(readRemoteHosts([
            currentHost,
            historicalHost,
            { v: 2, id: 'future-host', transport: 'unrecognized' },
            'malformed',
        ])).toEqual([currentHost, historicalHost]);
    });
});
