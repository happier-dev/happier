import { describe, expect, it } from 'vitest';

import { serializeMachineRow, type MachineSerializationRow } from './machineSerialization';

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
    it('projects the strict complete capability snapshot and its revision', () => {
        expect(serializeMachineRow({
            ...baseMachineRow,
            operationProtocolCapabilities: {
                sessionSpawn: { protocolVersions: [1] },
            },
            operationProtocolCapabilitiesRevision: 4,
        })).toMatchObject({
            operationProtocolCapabilities: {
                sessionSpawn: { protocolVersions: [1] },
            },
            operationProtocolCapabilitiesRevision: 4,
        });
    });

    it('fails closed for malformed persisted JSON instead of projecting a usable leaf', () => {
        expect(serializeMachineRow({
            ...baseMachineRow,
            operationProtocolCapabilities: {
                sessionSpawn: { protocolVersions: [1], untrusted: true },
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
