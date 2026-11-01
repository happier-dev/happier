import { afterEach, describe, expect, it, vi } from 'vitest';

import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import type { Machine } from './types';

const ioMock = vi.hoisted(() => vi.fn());

vi.mock('socket.io-client', () => ({
  io: ioMock,
}));

vi.mock('@/configuration', () => ({
  configuration: {
    serverUrl: 'https://example.test',
    apiServerUrl: 'https://example.test',
    socketForceWebsocketOnly: false,
    socketIoTransports: ['polling', 'websocket'],
  },
}));

vi.mock('@/utils/proxy/socketIoProxy', () => ({
  getSocketIoProxyOptions: () => ({}),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: () => undefined,
    warn: () => undefined,
    debugLargeJson: () => undefined,
  },
}));

describe('ApiMachineClient updates', () => {
  afterEach(() => {
    ioMock.mockReset();
    vi.resetModules();
  });

  it('dispatches non-machine updates to subscribers', async () => {
    const machineSocket = createApiSessionSocketStub();
    bindApiSessionSocketMock(ioMock, machineSocket);

    const { ApiMachineClient } = await import('./apiMachine');
    const client = new ApiMachineClient('token', {
      id: 'machine-1',
      encryptionKey: new Uint8Array(32).fill(1),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    });

    const handler = vi.fn(() => true);
    client.onUpdate(handler);

    client.connect();

    const updateHandler = machineSocket.getHandler('update');
    expect(updateHandler).toBeDefined();

    const relayOwnerProbeHandler = machineSocket.getHandler('relay-owner-probe');
    expect(relayOwnerProbeHandler).toBeUndefined();

    updateHandler?.({
      id: 'u-1',
      seq: 123,
      createdAt: Date.now(),
      body: {
        t: 'automation-assignment-updated',
        machineId: 'machine-1',
        automationId: 'automation-1',
        enabled: true,
        updatedAt: Date.now(),
      },
    } as any);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('retires machine RPC before applying content encrypted with a changed key', async () => {
    const machineSocket = createApiSessionSocketStub();
    bindApiSessionSocketMock(ioMock, machineSocket);
    const { ApiMachineClient } = await import('./apiMachine');
    const machine: Machine = {
      id: 'machine-1', encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'legacy',
      publishedDataEncryptionKey: null, metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
    };
    const client = new ApiMachineClient('token', machine);
    const onContentKeyChanged = vi.fn();
    client.connect({ onContentKeyChanged });
    machineSocket.getHandler('update')?.({ id: 'key-change', seq: 1, createdAt: 1, body: {
      t: 'update-machine', machineId: 'machine-1', dataEncryptionKey: 'changed-key',
      metadata: { value: 'unreadable', version: 1 }, daemonState: null,
    } });
    await vi.waitFor(() => expect(onContentKeyChanged).toHaveBeenCalledOnce());
    expect(machine.metadataVersion).toBe(0);
    expect(machine.metadata).toBeNull();
  });
});
