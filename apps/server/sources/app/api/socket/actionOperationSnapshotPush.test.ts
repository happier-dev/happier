import { describe, expect, it } from 'vitest';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';

import { projectActionOperationSnapshotPush } from './actionOperationSnapshotPush';

describe('Action operation snapshot push ingress', () => {
    it('admits Plain content only for the authenticated requester mode and exact Machine and Account', () => {
        const snapshot = { version: 1, operationId: 'operation-1', revision: 1,
            actionId: 'projects.script.run', state: 'accepted', scope: { accountId: 'requester', machineId: 'machine-1' },
            title: 'Run Script', createdAt: 1, cancellation: 'supported', domainRef: { kind: 'projectCommand', purpose: 'script',
                serverId: 'home', machineId: 'worker', workspaceRefId: 'target', cwd: '/target',
                sourceWorkspace: { serverId: 'home', machineId: 'source', workspaceId: 'source', rootPath: '/source' },
                script: { name: 'check', source: { kind: 'command', command: 'check' } } } } as const;
        const payload = { type: 'action-operation-updated', machineId: 'machine-1', content: { t: 'plain', v: snapshot } };
        expect(projectActionOperationSnapshotPush(payload, 'machine-1', { accountId: 'requester', encryptionMode: 'plain' })).toEqual(payload);
        expect(projectActionOperationSnapshotPush(payload, 'machine-1', { accountId: 'requester', encryptionMode: 'e2ee' })).toBeNull();
        expect(projectActionOperationSnapshotPush(payload, 'machine-1', { accountId: 'custodian', encryptionMode: 'plain' })).toBeNull();
        expect(projectActionOperationSnapshotPush(payload, 'another-machine', { accountId: 'requester', encryptionMode: 'plain' })).toBeNull();
        expect(projectActionOperationSnapshotPush({ ...payload, content: { t: 'plain', v: { ...snapshot, unexpected: true } } },
            'machine-1', { accountId: 'requester', encryptionMode: 'plain' })).toBeNull();
    });
    const ciphertext = sealAccountScopedBlobCiphertext({
        kind: 'action_operation_snapshot',
        material: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
        payload: { operationId: 'operation-1' },
        randomBytes: (length) => new Uint8Array(length).fill(3),
    });

    it('forwards only the authenticated machine-bound encrypted domain', () => {
        expect(projectActionOperationSnapshotPush({
            v: 1, machineId: 'machine-1', ciphertext,
        }, 'machine-1', { accountId: 'account-1', encryptionMode: 'e2ee' })).toEqual({
            type: 'action-operation-updated',
            machineId: 'machine-1',
            content: { t: 'encrypted', c: ciphertext },
        });
        expect(projectActionOperationSnapshotPush({
            v: 1, machineId: 'machine-2', ciphertext,
        }, 'machine-1', { accountId: 'account-1', encryptionMode: 'e2ee' })).toBeNull();
        expect(projectActionOperationSnapshotPush({
            v: 1, machineId: 'machine-1', ciphertext: 'not-an-envelope',
        }, 'machine-1', { accountId: 'account-1', encryptionMode: 'e2ee' })).toBeNull();
    });

    it('preserves the immutable released 0.2.11 producer and outward envelope', () => {
        expect(projectActionOperationSnapshotPush({
            type: 'action-operation-updated',
            machineId: 'machine-1',
            content: { t: 'encrypted', c: ciphertext },
        }, 'machine-1', { accountId: 'account-1', encryptionMode: 'e2ee' })).toEqual({
            type: 'action-operation-updated',
            machineId: 'machine-1',
            content: { t: 'encrypted', c: ciphertext },
        });
        expect(projectActionOperationSnapshotPush({
            type: 'action-operation-updated',
            machineId: 'machine-2',
            content: { t: 'encrypted', c: ciphertext },
        }, 'machine-1', { accountId: 'account-1', encryptionMode: 'e2ee' })).toBeNull();
        expect(projectActionOperationSnapshotPush({
            type: 'action-operation-updated',
            machineId: 'machine-1',
            content: { t: 'plain', v: 'secret' },
        }, 'machine-1', { accountId: 'account-1', encryptionMode: 'e2ee' })).toBeNull();
    });
});
