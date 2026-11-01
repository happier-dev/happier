import { describe, expect, it } from 'vitest';

import {
    sealAccountScopedBlobCiphertext,
    type ActionOperationSnapshotV1,
} from '@happier-dev/protocol';

import { openActionOperationRevisionEphemeral } from './actionOperationEphemeral';

const machineKey = new Uint8Array(32).fill(17);
const snapshot: ActionOperationSnapshotV1 = {
    version: 1,
    operationId: 'operation-1',
    requestId: 'spawn-attempt-1',
    revision: 2,
    actionId: 'session.spawn_new',
    state: 'running',
    scope: { accountId: 'account-1', machineId: 'machine-1' },
    title: 'Create session',
    createdAt: 1,
    startedAt: 2,
    cancellation: 'unsupported',
};

function ciphertext(value: unknown): string {
    return sealAccountScopedBlobCiphertext({
        kind: 'action_operation_snapshot',
        material: { type: 'dataKey', machineKey },
        payload: value,
        randomBytes: (length) => new Uint8Array(length).fill(3),
    });
}

describe('openActionOperationRevisionEphemeral', () => {
    it('opens plain snapshots without key material only for a plain machine row', () => {
        const update = { type: 'action-operation-updated', machineId: 'machine-1', content: { t: 'plain', v: snapshot } } as const;
        expect(openActionOperationRevisionEphemeral({ update, machineKey: null, machineMode: 'plain', accountId: 'account-1' })).toEqual(snapshot);
        expect(openActionOperationRevisionEphemeral({ update, machineKey, machineMode: 'e2ee', accountId: 'account-1' })).toBeNull();
        expect(openActionOperationRevisionEphemeral({
            update: { ...update, content: { t: 'encrypted', c: ciphertext(snapshot) } },
            machineKey,
            machineMode: 'plain', accountId: 'account-1',
        })).toBeNull();
    });

    it('opens and validates the full snapshot while preserving only its bounded request reference', () => {
        expect(openActionOperationRevisionEphemeral({
            update: {
                type: 'action-operation-updated',
                machineId: 'machine-1',
                content: { t: 'encrypted', c: ciphertext(snapshot) },
            },
            machineKey,
            machineMode: 'e2ee', accountId: 'account-1',
        })).toEqual(snapshot);
    });

    it('rejects a valid snapshot belonging to another account', () => {
        expect(openActionOperationRevisionEphemeral({
            update: { type: 'action-operation-updated', machineId: 'machine-1', content: { t: 'encrypted', c: ciphertext(snapshot) } },
            machineKey,
            machineMode: 'e2ee',
            accountId: 'account-other',
        })).toBeNull();
    });

    it('rejects an authenticated snapshot whose scope does not match the outer routed machine', () => {
        expect(openActionOperationRevisionEphemeral({
            update: {
                type: 'action-operation-updated',
                machineId: 'machine-other',
                content: { t: 'encrypted', c: ciphertext(snapshot) },
            },
            machineKey,
            machineMode: 'e2ee', accountId: 'account-1',
        })).toBeNull();
    });

    it('rejects raw input and malformed snapshot fields instead of retaining them', () => {
        expect(openActionOperationRevisionEphemeral({
            update: {
                type: 'action-operation-updated',
                machineId: 'machine-1',
                content: { t: 'encrypted', c: ciphertext({ ...snapshot, input: { prompt: 'secret' } }) },
            },
            machineKey,
            machineMode: 'e2ee', accountId: 'account-1',
        })).toBeNull();
    });
});
