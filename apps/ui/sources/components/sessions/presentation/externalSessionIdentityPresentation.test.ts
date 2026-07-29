import { describe, expect, it } from 'vitest';

import { resolveExternalSessionIdentityPresentation } from './externalSessionIdentityPresentation';

describe('resolveExternalSessionIdentityPresentation', () => {
    it('owns the shared header and row identity for a linked external session', () => {
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
        }, (key) => key)).toEqual({
            agentId: 'codex',
            agentLabel: 'Codex',
            machineLabel: 'MacBook Pro',
            storageLabel: 'sessionsList.storageExternalFilter',
            headerBadgeLabel: 'Codex · MacBook Pro',
            rowMetadataLabel: 'sessionsList.storageExternalFilter · MacBook Pro',
        });
    });

    it('keeps hosted identity on the same presentation owner', () => {
        expect(resolveExternalSessionIdentityPresentation({
            host: 'MacBook Pro',
        }, (key) => key)).toEqual({
            agentId: null,
            agentLabel: null,
            machineLabel: null,
            storageLabel: 'sessionsList.storagePersistedTab',
            headerBadgeLabel: null,
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
        }, (key) => key)).toMatchObject({
            agentId: 'customAcp',
            agentLabel: 'Custom Acp',
            headerBadgeLabel: 'Custom Acp · Remote host',
        });
    });
});
