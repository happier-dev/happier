import { describe, expect, it } from 'vitest';

import type { Machine } from '@/api/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { ApiMachineClient } from './apiMachine';

describe('ApiMachineClient filesystem handlers', () => {
  it('registers filesystem RPCs as machine-scoped handlers', () => {
    const machine: Machine = {
      id: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new ApiMachineClient('token', machine);
    const rpc = (client as any).rpcHandlerManager as {
      hasHandler: (method: string) => boolean;
    };

    expect(rpc.hasHandler(RPC_METHODS.READ_FILE)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.WRITE_FILE)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.CREATE_DIRECTORY)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.LIST_DIRECTORY)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.GET_DIRECTORY_TREE)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.STAT_FILE)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.RENAME_PATH)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DELETE_PATH)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_ABORT)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT)).toBe(true);
  });
});
