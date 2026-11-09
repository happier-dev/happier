import { expect, it } from 'vitest';
import { MachineUpdateStateRequestSchema } from '@happier-dev/protocol/machines/metadataUpdate';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import type { Machine } from '../types';
import { createMachineContentCodec } from './machineStoredContent';
import { createMachineDaemonStatePublication } from './machineDaemonStatePublication';

it('carries only real activity changes as a non-persisted wake hint through the canonical state publisher', async () => {
    const machine: Machine = { id: 'guest', encryptionMode: 'plain', metadata: null, metadataVersion: 0,
        daemonState: { status: 'running' }, daemonStateVersion: 0 };
    const sent: unknown[] = [];
    const publish = createMachineDaemonStatePublication({ getMachine: () => machine, shouldSuppress: () => false,
        prepareWrite: async () => ({ codec: createMachineContentCodec({ encryptionMode: 'plain' }),
            expectedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, isCurrent: () => true,
            socket: { emitWithAck: async (_event, raw) => {
                sent.push(raw);
                const request = MachineUpdateStateRequestSchema.parse(raw);
                return { result: 'success', version: request.expectedVersion + 1, daemonState: request.daemonState };
            } } }),
        retireAndRefreshContent: async () => {}, needsPersistedIrohEndpointWithdrawal: () => false,
        acknowledgeDaemonStatePublication: () => {}, discardUnverifiedIrohEndpoint: value => value,
        synchronizeIrohMachineEndpointAuthority: async () => {},
    });
    const options = { allowWhileQuiescing: false, managedActivityChanged: true as const };
    const activity = { kind: 'idle' as const, since: 123 };
    expect(await publish(state => ({ ...state!, managedActivity: activity }), options)).toBe('published');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ managedActivityChanged: true });
    expect(machine.daemonState).not.toHaveProperty('managedActivityChanged');
    for (let index = 0; index < 32; index++) {
        expect(await publish(state => ({ ...state!, managedActivity: activity }), options)).toBe('unchanged');
    }
    expect(sent).toHaveLength(1);
    expect(await publish(state => ({ ...state!, pid: 42 }))).toBe('published');
    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toHaveProperty('managedActivityChanged');
});

it.each(['Internal error', undefined])('retains the server rejection cause and settles without retrying (%s)', async message => {
    const machine: Machine = { id: 'rejected-publication', encryptionMode: 'plain', metadata: null, metadataVersion: 0,
        daemonState: { status: 'running' }, daemonStateVersion: 0 };
    let attempts = 0;
    const publish = createMachineDaemonStatePublication({ getMachine: () => machine, shouldSuppress: () => false,
        prepareWrite: async () => ({ codec: createMachineContentCodec({ encryptionMode: 'plain' }),
            expectedDataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, isCurrent: () => true,
            socket: { emitWithAck: async () => { attempts++; return { result: 'error', ...(message ? { message } : {}) }; } } }),
        retireAndRefreshContent: async () => {}, needsPersistedIrohEndpointWithdrawal: () => false,
        acknowledgeDaemonStatePublication: () => {}, discardUnverifiedIrohEndpoint: value => value,
        synchronizeIrohMachineEndpointAuthority: async () => {},
    });
    await expect(publish(state => ({ ...state!, pid: 42 }))).rejects.toMatchObject({
        message: `Machine daemon-state update failed: ${message ?? 'Server rejected the publication'}`, retryable: false,
    });
    expect(attempts).toBe(1);
    expect(machine.daemonStateVersion).toBe(0);
});
