import { describe, expect, it } from 'vitest';

import {
    resolveExternalSessionBrowseCandidateIdentityPresentation,
    resolveExternalSessionIdentityPresentation,
} from './externalSessionIdentityPresentation';

describe('resolveExternalSessionIdentityPresentation', () => {
    it('owns Browse candidate title, identity, and home-relative path presentation', () => {
        expect(resolveExternalSessionBrowseCandidateIdentityPresentation({
            remoteSessionId: 'native-session-1',
            title: '  Improve browse UX  ',
            path: '/Users/alice/projects/happier',
            homeDir: '/Users/alice',
            agentLabel: 'Codex',
            machineLabel: 'MacBook Pro',
        })).toEqual({
            title: 'Improve browse UX',
            pathLabel: '~/projects/happier',
            identityLabel: 'Codex · MacBook Pro',
            secondaryLabel: 'Codex · MacBook Pro · ~/projects/happier',
        });

        expect(resolveExternalSessionBrowseCandidateIdentityPresentation({
            remoteSessionId: 'native-session-2',
            title: 'native-session-2',
            path: 'C:\\Users/alice\\projects/happier',
            homeDir: 'C:\\Users\\alice',
            agentLabel: 'Codex',
            machineLabel: 'Windows PC',
        })).toEqual({
            title: '~/projects/happier',
            pathLabel: '~/projects/happier',
            identityLabel: 'Codex · Windows PC',
            secondaryLabel: 'Codex · Windows PC',
        });
    });

    it('omits the machine from shared identity only for the exact current machine', () => {
        expect(resolveExternalSessionIdentityPresentation({
            host: 'MacBook Pro',
            externalSessionV1: {
                v: 1,
                agentId: 'codex',
                machineId: 'machine-a',
                remoteSessionId: 'native-session-1',
                source: {
                    kind: 'codexHome',
                    home: 'user',
                    homePath: '/Users/test/.codex',
                },
            },
        }, 'machine-a', (key) => key)).toEqual({
            agentId: 'codex',
            agentLabel: 'Codex',
            machineLabel: 'MacBook Pro',
            storageLabel: 'sessionsList.storageExternalFilter',
            identityLabel: 'Codex',
            rowMetadataLabel: 'sessionsList.storageExternalFilter · Codex',
        });
    });

    it.each([
        ['another machine', 'machine-b'],
        ['a whitespace-different machine identity', ' machine-a '],
        ['missing current-machine identity', null],
        ['malformed current-machine identity', { id: 'machine-a' }],
    ])('keeps the machine for %s', (_name, currentMachineId) => {
        const presentation = resolveExternalSessionIdentityPresentation({
            host: 'MacBook Pro',
            externalSessionV1: {
                v: 1,
                agentId: 'codex',
                machineId: 'machine-a',
                remoteSessionId: 'native-session-1',
                source: {
                    kind: 'codexHome',
                    home: 'user',
                    homePath: '/Users/test/.codex',
                },
            },
        }, currentMachineId, (key) => key);

        expect(presentation).toMatchObject({
            identityLabel: 'Codex · MacBook Pro',
            rowMetadataLabel: 'sessionsList.storageExternalFilter · Codex · MacBook Pro',
        });
    });

    it('does not suppress an other-machine label merely because it equals the Agent label', () => {
        expect(resolveExternalSessionIdentityPresentation({
            host: 'Codex',
            externalSessionV1: {
                v: 1,
                agentId: 'codex',
                machineId: 'machine-a',
                remoteSessionId: 'native-session-1',
                source: { kind: 'customArchive' },
            },
        }, 'machine-b', (key) => key)).toMatchObject({
            identityLabel: 'Codex · Codex',
            rowMetadataLabel: 'sessionsList.storageExternalFilter · Codex · Codex',
        });
    });

    it('keeps hosted identity on the same presentation owner', () => {
        expect(resolveExternalSessionIdentityPresentation({
            host: 'MacBook Pro',
        }, 'machine-a', (key) => key)).toEqual({
            agentId: null,
            agentLabel: null,
            machineLabel: null,
            storageLabel: 'sessionsList.storagePersistedTab',
            identityLabel: null,
            rowMetadataLabel: null,
        });
    });

    it('fails closed for malformed external-session metadata', () => {
        expect(resolveExternalSessionIdentityPresentation({
            host: 'MacBook Pro',
            externalSessionV1: {
                v: 1,
                agentId: 'codex',
                machineId: '',
                remoteSessionId: 'native-session-1',
                source: { kind: 'customArchive' },
            },
        }, 'machine-a', (key) => key)).toEqual({
            agentId: null,
            agentLabel: null,
            machineLabel: null,
            storageLabel: 'sessionsList.storagePersistedTab',
            identityLabel: null,
            rowMetadataLabel: null,
        });
    });

    it('formats an opaque projected Agent id without consulting the static Agent core', () => {
        expect(resolveExternalSessionIdentityPresentation({
            host: 'Remote host',
            externalSessionV1: {
                v: 1,
                agentId: 'customAcp',
                machineId: 'machine-a',
                remoteSessionId: 'native-session-1',
                source: { kind: 'customArchive' },
            },
        }, 'machine-b', (key) => key)).toMatchObject({
            agentId: 'customAcp',
            agentLabel: 'Custom Acp',
            identityLabel: 'Custom Acp · Remote host',
            rowMetadataLabel: 'sessionsList.storageExternalFilter · Custom Acp · Remote host',
        });
    });
});
