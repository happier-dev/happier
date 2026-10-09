import { describe, expect, it } from 'vitest';
import type { AccessibleMachineAccessV1 } from '@happier-dev/protocol';
import { serializeAccessibleMachineRow, type MachineSerializationRow } from './machineSerialization';

const row: MachineSerializationRow = {
    id: 'shared-machine', kind: 'persistent', metadata: 'resource-metadata', metadataVersion: 4,
    daemonState: 'resource-state', daemonStateVersion: 8, dataEncryptionKey: new Uint8Array([1, 2, 3]),
    installationId: 'current-installation', seq: 1, active: true,
    lastActiveAt: new Date(3), revokedAt: null, replacedByMachineId: null,
    createdAt: new Date(1), updatedAt: new Date(2),
};
const access: AccessibleMachineAccessV1 = {
    custodian: { accountId: 'custodian', displayName: 'Alice' },
    role: 'use', resourceMode: 'e2ee', accessState: 'ready',
};

describe('accessible Machine serialization', () => {
    it('keeps the recipient opening envelope separate from the persisted custodian write basis', () => {
        const projected = serializeAccessibleMachineRow(row, {
            access, owned: false, callerDataEncryptionKey: new Uint8Array([4, 5, 6]),
        });
        expect(projected).toMatchObject({
            metadata: row.metadata, daemonState: row.daemonState, dataEncryptionKey: 'BAUG', access,
            keyBasis: { dataEncryptionKey: 'AQID', metadataVersion: 4, daemonStateVersion: 8 },
        });
        expect(projected.dataEncryptionKey).not.toBe(projected.keyBasis.dataEncryptionKey);
    });

    it.each([
        ['key_pending', new Uint8Array([4, 5, 6])],
        ['refused', new Uint8Array([4, 5, 6])],
        ['ready', null],
    ] as const)('withholds foreign E2EE content for %s without a current readable tuple', (accessState, callerDataEncryptionKey) => {
        const projected = serializeAccessibleMachineRow(row, {
            access: { ...access, accessState }, owned: false, callerDataEncryptionKey,
        });
        expect(projected).toMatchObject({ metadata: null, daemonState: null, dataEncryptionKey: null });
        expect(projected.keyBasis).toEqual({ dataEncryptionKey: 'AQID', metadataVersion: 4, daemonStateVersion: 8 });
    });

    it('reads ready Plain resource content keylessly and preserves the legacy own transition basis', () => {
        const plainAccess = { ...access, resourceMode: 'plain' as const };
        const shared = serializeAccessibleMachineRow(row, { access: plainAccess, owned: false, callerDataEncryptionKey: null });
        expect(shared).toMatchObject({ metadata: row.metadata, daemonState: row.daemonState, dataEncryptionKey: null, storageMode: 'plain' });
        expect(shared.keyBasis).toEqual({ dataEncryptionKey: 'AQID', metadataVersion: 4, daemonStateVersion: 8 });
        const own = serializeAccessibleMachineRow(row, { access, owned: true, callerDataEncryptionKey: row.dataEncryptionKey });
        expect(own).toMatchObject({ dataEncryptionKey: 'AQID', keyBasis: { dataEncryptionKey: 'AQID', metadataVersion: 4, daemonStateVersion: 8 } });
    });
});
