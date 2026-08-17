import { describe, expect, it } from 'vitest';

import { ConversationProviderConnectionsSnapshotV1Schema } from './connection.js';

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
});
