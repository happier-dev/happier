import { expect, it } from 'vitest';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import type { Machine } from '../types';
import { createMachineContentCodec } from './machineStoredContent';
import { createMachineDaemonStatePublication } from './machineDaemonStatePublication';

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
