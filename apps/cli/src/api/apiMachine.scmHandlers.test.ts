import { describe, expect, it } from 'vitest';

import type { Machine } from '@/api/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { ApiMachineClient } from './apiMachine';

describe('ApiMachineClient SCM handlers', () => {
  it('registers SCM RPCs as machine-scoped handlers', () => {
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

    expect(rpc.hasHandler(RPC_METHODS.SCM_STATUS_SNAPSHOT)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.SCM_DIFF_FILE)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.SCM_DIFF_COMMIT)).toBe(true);
    expect(rpc.hasHandler(RPC_METHODS.SCM_LOG_LIST)).toBe(true);
  });
});
