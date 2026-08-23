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
    it('opens and validates the full snapshot while preserving only its bounded request reference', () => {
        expect(openActionOperationRevisionEphemeral({
            update: {
                type: 'action-operation-updated',
                machineId: 'machine-1',
                content: { t: 'encrypted', c: ciphertext(snapshot) },
            },
            machineKey,
        })).toEqual(snapshot);
    });

    it('rejects an authenticated snapshot whose scope does not match the outer routed machine', () => {
        expect(openActionOperationRevisionEphemeral({
            update: {
                type: 'action-operation-updated',
                machineId: 'machine-other',
                content: { t: 'encrypted', c: ciphertext(snapshot) },
            },
            machineKey,
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
        })).toBeNull();
    });
});
