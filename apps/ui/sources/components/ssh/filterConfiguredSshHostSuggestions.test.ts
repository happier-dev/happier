import { describe, expect, it } from 'vitest';

import type { RemoteHost } from '@/sync/domains/remoteHosts/remoteHostModel';

import {
    filterConfiguredSshHostSuggestions,
    type SshConfiguredHostSuggestion,
} from './filterConfiguredSshHostSuggestions';

function remoteHost(overrides: Partial<RemoteHost>): RemoteHost {
    return {
        id: 'host-1',
        name: 'Dev box',
        ssh: {
            target: 'ubuntu@devbox',
            port: 2222,
            authMode: 'agent',
        },
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: 1,
        linkedMachineId: null,
        linkedRelayProfileId: null,
        ...overrides,
    };
}

describe('filterConfiguredSshHostSuggestions', () => {
    it('removes suggestions already represented by saved remote hosts', () => {
        const suggestions: readonly SshConfiguredHostSuggestion[] = [
            {
                id: 'ssh-config:devbox',
                alias: 'devbox',
                hostname: '10.0.0.5',
                port: 2222,
                username: 'ubuntu',
                source: 'ssh-config',
            },
            {
                id: 'known:prod-db',
                alias: 'prod-db',
                hostname: 'prod-db.internal',
                port: 22,
                username: null,
                source: 'known-hosts',
            },
            {
                id: 'ssh-config:devbox-deploy',
                alias: 'devbox',
                hostname: '10.0.0.5',
                port: 2222,
                username: 'deploy',
                source: 'ssh-config',
            },
            {
                id: 'ssh-config:devbox-alt-port',
                alias: 'devbox',
                hostname: '10.0.0.5',
                port: 2200,
                username: 'ubuntu',
                source: 'ssh-config',
            },
        ];

        const filtered = filterConfiguredSshHostSuggestions({
            suggestions,
            remoteHosts: [
                remoteHost({ name: 'Dev box' }),
                remoteHost({
                    id: 'host-2',
                    name: 'prod-db',
                    ssh: {
                        target: 'root@prod-db.internal',
                        port: 22,
                        authMode: 'agent',
                    },
                }),
            ],
        });

        expect(filtered.map((suggestion) => suggestion.id)).toEqual([
            'ssh-config:devbox-deploy',
            'ssh-config:devbox-alt-port',
        ]);
    });

    it('treats a saved host without username as matching a discovered host with username', () => {
        const filtered = filterConfiguredSshHostSuggestions({
            suggestions: [
                {
                    id: 'ssh-config:devbox',
                    alias: 'devbox',
                    hostname: 'devbox',
                    port: 2222,
                    username: 'ubuntu',
                    source: 'ssh-config',
                },
            ],
            remoteHosts: [
                remoteHost({
                    name: 'Dev box',
                    ssh: {
                        target: 'devbox',
                        port: 2222,
                        authMode: 'agent',
                    },
                }),
            ],
        });

        expect(filtered).toEqual([]);
    });
});
