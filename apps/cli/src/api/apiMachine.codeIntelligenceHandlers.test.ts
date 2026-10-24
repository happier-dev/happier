import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { Machine } from '@/api/types';
import type { CodeIntelligenceWorkerHandle } from '@/daemon/codeIntelligence/codeIntelligenceWorker';

import { ApiMachineClient } from './apiMachine';
import type { RpcHandlerManager } from './rpc/RpcHandlerManager';

describe('ApiMachineClient code intelligence handlers', () => {
  it('registers the code intelligence RPCs when the daemon hands it a worker', () => {
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
    client.setRPCHandlers({
      spawnSession: async () => ({ type: 'success', sessionId: 'session-1' }),
      stopSession: async () => true,
      requestShutdown: () => {},
      codeIntelligence: {} as CodeIntelligenceWorkerHandle,
    });

    const rpcHandlerManager = Reflect.get(client, 'rpcHandlerManager') as RpcHandlerManager;
    expect(rpcHandlerManager.hasHandler(RPC_METHODS.DAEMON_CODE_INTELLIGENCE_SNAPSHOT_GET)).toBe(true);
    expect(rpcHandlerManager.hasHandler(RPC_METHODS.DAEMON_CODE_INTELLIGENCE_SETTINGS_SET)).toBe(true);
  });
});
