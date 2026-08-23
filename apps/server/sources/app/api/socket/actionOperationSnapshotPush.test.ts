import { describe, expect, it } from 'vitest';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';

import { projectActionOperationSnapshotPush } from './actionOperationSnapshotPush';

describe('Action operation snapshot push ingress', () => {
    const ciphertext = sealAccountScopedBlobCiphertext({
        kind: 'action_operation_snapshot',
        material: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
        payload: { operationId: 'operation-1' },
        randomBytes: (length) => new Uint8Array(length).fill(3),
    });

    it('forwards only the authenticated machine-bound encrypted domain', () => {
        expect(projectActionOperationSnapshotPush({
            v: 1, machineId: 'machine-1', ciphertext,
        }, 'machine-1')).toEqual({
            type: 'action-operation-snapshot',
            machineId: 'machine-1',
            ciphertext,
        });
        expect(projectActionOperationSnapshotPush({
            v: 1, machineId: 'machine-2', ciphertext,
        }, 'machine-1')).toBeNull();
        expect(projectActionOperationSnapshotPush({
            v: 1, machineId: 'machine-1', ciphertext: 'not-an-envelope',
        }, 'machine-1')).toBeNull();
    });
});
