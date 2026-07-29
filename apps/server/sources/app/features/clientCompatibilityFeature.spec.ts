import { describe, expect, it } from 'vitest';
import { resolveClientCompatibilityFeature } from './clientCompatibilityFeature';

describe('client compatibility HTTP feature payload', () => {
    it('publishes the bundled current session-sync, Pending-input, and import-fence requirements', () => {
        expect(resolveClientCompatibilityFeature()).toMatchObject({ capabilities: { compatibility: {
            sessionSync: {
                currentSessionSyncProtocolVersion: 2,
            },
            pendingInput: {
                currentPendingInputProtocolVersion: 1,
            },
            externalSessionImport: {
                currentPublicationFenceVersion: 3,
            },
        } } });
    });

    it('publishes the configured required provider-host floors from the compatibility policy owner', () => {
        expect(resolveClientCompatibilityFeature({
            HAPPIER_SESSION_SYNC_COMPATIBILITY__ENFORCEMENT: 'required',
            HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_PROTOCOL_VERSION: '2',
            HAPPIER_SESSION_SYNC_COMPATIBILITY__MINIMUM_VERSIONS_JSON: JSON.stringify({
                daemon: '0.2.10',
                'session-runner': '0.2.10',
            }),
        } as NodeJS.ProcessEnv)).toMatchObject({ capabilities: { compatibility: { sessionSync: {
            enforcement: 'required',
            minimumVersionsByClientKind: {
                daemon: '0.2.10',
                'session-runner': '0.2.10',
            },
        } } } });
    });
});
