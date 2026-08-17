import { describe, expect, it } from 'vitest';

import { serializePendingMaterializedMessage } from './serializePendingMaterializedMessage';

describe('serializePendingMaterializedMessage', () => {
    it('carries the server-issued admission receipt to the target reconciler', () => {
        expect(serializePendingMaterializedMessage({
            id: null,
            seq: null,
            localId: 'protected-local',
            messageRole: 'user',
            content: { t: 'plain', v: { role: 'user' } },
            requestedAction: { v: 1, kind: 'enqueue' },
            inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' },
            createdAt: new Date(1_000),
            updatedAt: new Date(2_000),
        })).toMatchObject({
            inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' },
        });
    });
});
