import { Manager } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveSessionControlSocketAckTimeoutMs } from '@/session/transport/shared/sessionTimeouts';

import { publishMachineOperationProtocolCapabilitiesOnSocket } from './publishMachineOperationProtocolCapabilities';

describe('Machine capability publication lifetime', () => {
  afterEach(() => vi.useRealTimers());

  it('receives the typed publication failure after the unrelated Session control ACK deadline', async () => {
    vi.useFakeTimers();
    const manager = new Manager({ autoConnect: false });
    const socket = manager.socket('/');
    socket.connected = true;
    Reflect.set(manager, '_packet', vi.fn());
    let acknowledge!: (value: unknown) => void;
    // Network delivery is the boundary; publication and response parsing stay real.
    vi.spyOn(socket, 'emitWithAck').mockImplementation(() => new Promise(resolve => { acknowledge = resolve; }));
    let settled = false;
    const result = publishMachineOperationProtocolCapabilitiesOnSocket({
      socket, machineId: 'publication-machine', capabilities: { sessionSpawn: { protocolVersions: [1] } },
    }).then(value => { settled = true; return value; }, error => { settled = true; return error; });

    await vi.advanceTimersByTimeAsync(resolveSessionControlSocketAckTimeoutMs() + 1);
    expect(settled).toBe(false);
    acknowledge({ v: 1, result: 'error', code: 'internal_error' });
    expect(await result).toMatchObject({ message: expect.stringContaining('internal_error') });
    socket.disconnect();
  });

  it('settles the publication on a real Socket.IO disconnect without replaying it', async () => {
    const manager = new Manager({ autoConnect: false });
    const socket = manager.socket('/');
    socket.connected = true;
    // Retain Socket.IO ACK/disconnect handling; replace only packet delivery.
    const packet = vi.fn();
    Reflect.set(manager, '_packet', packet);
    const result = publishMachineOperationProtocolCapabilitiesOnSocket({
      socket, machineId: 'publication-machine', capabilities: {},
    }).catch((error: unknown) => error);
    socket.disconnect();
    expect(await result).toBeInstanceOf(Error);
    expect(packet.mock.calls.filter(([value]) => value.type === 2)).toHaveLength(1);
  });
});
