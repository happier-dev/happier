import { describe, expect, it } from 'vitest';

import {
    ConversationProviderConnectionsSnapshotV1Schema,
    hasCurrentConversationProviderConnectionV1,
} from './connection.js';

const reconciliationSnapshot = {
    v: 1,
    connectionId: 'connection-1',
    providerConnectionKey: 'provider:connection-1',
    providerConfigVersion: 1,
    providerConfig: {},
    credentialRef: null,
    authorityEpoch: 1,
    enabled: true,
    deletionState: 'none',
    requiresFullSharedMessageContent: false,
} as const;

describe('Channels V1 provider connection snapshots', () => {
    it('keeps caller-filtered connection maps structural and leaves key-to-child admission to reconciliation', () => {
        const snapshot = {
            'connection-1': reconciliationSnapshot,
        } as const;

        expect(ConversationProviderConnectionsSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
        expect(ConversationProviderConnectionsSnapshotV1Schema.safeParse({
            'bad connection id': reconciliationSnapshot,
        }).success).toBe(true);
        expect(ConversationProviderConnectionsSnapshotV1Schema.jsonSchema).toMatchObject({
            type: 'object',
            properties: {},
        });
        expect(JSON.stringify(ConversationProviderConnectionsSnapshotV1Schema.jsonSchema))
            .toContain('"connectionId"');
        expect(ConversationProviderConnectionsSnapshotV1Schema.jsonSchema).not.toHaveProperty('propertyNames');
    });

    it('matches one exact enabled current provider identity and credential without caller-local variants', () => {
        const credentialRef = {
            service: { pluginId: 'example.provider', localId: 'account' },
            accountId: 'account-1',
        } as const;
        const connections = {
            'connection-1': { ...reconciliationSnapshot, credentialRef },
        };
        expect(hasCurrentConversationProviderConnectionV1({
            connections,
            providerConnectionKey: 'provider:connection-1',
            credentialRef,
        })).toBe(true);
        expect(hasCurrentConversationProviderConnectionV1({
            connections,
            providerConnectionKey: 'provider:connection-1',
            credentialRef: { ...credentialRef, accountId: 'account-2' },
        })).toBe(false);
        expect(hasCurrentConversationProviderConnectionV1({
            connections: {
                'connection-1': { ...connections['connection-1'], enabled: false },
            },
            providerConnectionKey: 'provider:connection-1',
            credentialRef,
        })).toBe(false);
        expect(hasCurrentConversationProviderConnectionV1({
            connections: {
                'connection-1': {
                    ...connections['connection-1'],
                    // Declared deleting arm: a retained row is disabled and
                    // `pendingStopReconciliation` (arm 2 pins enabled:false).
                    enabled: false,
                    deletionState: 'pendingStopReconciliation',
                },
            },
            providerConnectionKey: 'provider:connection-1',
            credentialRef,
        })).toBe(false);
    });
});
