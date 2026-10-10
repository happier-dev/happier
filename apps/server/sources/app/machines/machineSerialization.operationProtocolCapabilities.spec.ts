import { describe, expect, it } from 'vitest';

import { serializeAccessibleMachineRow, serializeMachineRow, type MachineSerializationRow } from './machineSerialization';

const baseMachineRow: MachineSerializationRow = {
    id: 'machine-1',
    metadata: 'encrypted-metadata',
    metadataVersion: 3,
    daemonState: null,
    daemonStateVersion: 0,
    dataEncryptionKey: null,
    seq: 2,
    active: true,
    lastActiveAt: new Date(10),
    revokedAt: null,
    replacedByMachineId: null,
    createdAt: new Date(1),
    updatedAt: new Date(2),
};

describe('serializeMachineRow operation protocol capabilities', () => {
    it('keeps the canonical owner key basis separate from the foreign recipient envelope', () => {
        const ownerEnvelope = new Uint8Array([0, 1, 2]);
        const recipientEnvelope = new Uint8Array([0, 3, 4]);
        const projection = serializeAccessibleMachineRow({ ...baseMachineRow, dataEncryptionKey: ownerEnvelope }, {
            access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'e2ee', accessState: 'ready' },
            owned: false, callerDataEncryptionKey: recipientEnvelope,
        });
        expect(projection.dataEncryptionKey).toBe('AAME');
        expect(projection.keyBasis).toEqual({ dataEncryptionKey: 'AAEC', metadataVersion: 3, daemonStateVersion: 0 });
    });

    it('projects the exact persisted Runner key proof and Account verification key only for a Runner', () => {
        const binding = {
            v: 1,
            purpose: 'happier.ephemeral-runner.machine-content-key',
            homeServerIdentityId: 'home-1',
            activationId: '11111111-1111-4111-8111-111111111111',
            creatorAccountId: 'account-1',
            machineId: 'machine-1',
            installationId: 'installation-1',
            machineContentKeyFingerprint: `runner-machine-content-key-sha256:${'a'.repeat(64)}`,
            accountSignatureBase64Url: 'A'.repeat(86),
        };
        expect(serializeMachineRow({
            ...baseMachineRow,
            kind: 'ephemeral_session_runner',
            installationId: 'installation-1',
            runnerContentKeyBinding: binding,
        })).toMatchObject({
            kind: 'ephemeral_session_runner',
            installationId: 'installation-1',
            runnerContentKeyBinding: binding,
        });

        expect(serializeMachineRow({
            ...baseMachineRow,
            kind: 'persistent',
            runnerContentKeyBinding: binding,
        })).toMatchObject({
            runnerContentKeyBinding: null,
        });
    });

    it('withholds the additive placement-origin leaf from a pre-V4 recipient', () => {
        const row = {
            ...baseMachineRow,
            operationProtocolCapabilities: {
                sessionSpawn: { protocolVersions: [1] },
                sessionSpawnPlacementOrigin: { protocolVersions: [1] },
            },
            operationProtocolCapabilitiesRevision: 4,
        };

        expect(serializeMachineRow(row, { recipientAccountStoredContentProtocolVersion: 3 }))
            .toMatchObject({
                operationProtocolCapabilities: {
                    sessionSpawn: { protocolVersions: [1] },
                },
            });
        expect(serializeMachineRow(row, { recipientAccountStoredContentProtocolVersion: 4 }))
            .toMatchObject({
                operationProtocolCapabilities: {
                    sessionSpawn: { protocolVersions: [1] },
                    sessionSpawnPlacementOrigin: { protocolVersions: [1] },
                },
            });
    });

    it('projects known stored capabilities and revision while dropping extras', () => {
        expect(serializeMachineRow({
            ...baseMachineRow,
            operationProtocolCapabilities: {
                sessionSpawn: { protocolVersions: [1], future: true },
                futureCapability: { protocolVersions: [1] },
            },
            operationProtocolCapabilitiesRevision: 4,
        })).toEqual(expect.objectContaining({
            operationProtocolCapabilities: {
                sessionSpawn: { protocolVersions: [1] },
            },
            operationProtocolCapabilitiesRevision: 4,
        }));
    });

    it('fails closed for malformed persisted JSON instead of projecting a usable leaf', () => {
        expect(serializeMachineRow({
            ...baseMachineRow,
            operationProtocolCapabilities: {
                sessionSpawn: { protocolVersions: [2] },
            },
            operationProtocolCapabilitiesRevision: 4,
        })).toMatchObject({
            operationProtocolCapabilities: null,
            operationProtocolCapabilitiesRevision: null,
        });
    });

    it.each([
        ['revoked', { revokedAt: new Date(3) }],
        ['replaced', { replacedByMachineId: 'machine-replacement' }],
        ['malformed replacement marker', { replacedByMachineId: '' }],
    ])('does not advertise a persisted capability snapshot from a %s Machine', (_state, unavailableState) => {
        expect(serializeMachineRow({
            ...baseMachineRow,
            ...unavailableState,
            operationProtocolCapabilities: {
                sessionSpawn: { protocolVersions: [1] },
            },
            operationProtocolCapabilitiesRevision: 4,
        })).toMatchObject({
            operationProtocolCapabilities: null,
            operationProtocolCapabilitiesRevision: null,
        });
    });
});
