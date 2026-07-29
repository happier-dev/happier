import { describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';

import {
  createConnectedAccountDaemonClient,
} from './connectedAccountDaemonClient';

const credentials: Credentials = {
  token: 'token-1',
  encryption: {
    type: 'dataKey',
    publicKey: new Uint8Array(32),
    machineKey: new Uint8Array(32),
  },
};
const service = Object.freeze({ pluginId: 'acme.accounts', localId: 'work' });

describe('createConnectedAccountDaemonClient', () => {
  it('uses the one account-scoped machine RPC for auth and control commands', async () => {
    const callMachineRpc = vi.fn()
      .mockResolvedValueOnce({
        status: 'awaitingManual',
        attemptId: 'attempt-1',
      })
      .mockResolvedValueOnce({
        status: 'described',
        service,
        descriptor: {
          id: 'work',
          title: 'Acme Work',
          authentication: {
            defaultModeId: 'manual',
            modes: [{
              id: 'manual',
              kind: 'manual',
              outcomeReconciliation: 'none',
              fields: [{
                id: 'token',
                title: 'Token',
                schema: { type: 'string' },
                secret: true,
              }],
            }],
          },
        },
        generation: 'generation-1',
        immutableGenerationId: 'artifact-1',
        accounts: [],
      })
      .mockResolvedValueOnce({
        status: 'outcomeUnknown',
        account: {
          service,
          accountId: 'account-1',
        },
      });
    const client = createConnectedAccountDaemonClient({
      credentials,
      machineId: 'machine-1',
      callMachineRpc,
    });

    await expect(client.authenticate({
      operation: 'beginConnect',
      service,
      modeId: 'manual',
    })).resolves.toMatchObject({
      status: 'awaitingManual',
      attemptId: 'attempt-1',
    });
    await expect(client.control({
      operation: 'describeService',
      service,
    })).resolves.toMatchObject({
      status: 'described',
      service,
    });
    await expect(client.control({
      operation: 'revokeAccount',
      account: {
        service,
        accountId: 'account-1',
      },
      cleanupGroupReferences: false,
    })).resolves.toEqual({
      status: 'outcomeUnknown',
      account: {
        service,
        accountId: 'account-1',
      },
    });
    expect(callMachineRpc).toHaveBeenNthCalledWith(1, {
      credentials,
      machineId: 'machine-1',
      method: 'daemon.connectedAccounts.authentication.command',
      request: {
        v: 1,
        machineId: 'machine-1',
        command: {
          operation: 'beginConnect',
          service,
          modeId: 'manual',
        },
      },
    });
    expect(callMachineRpc).toHaveBeenNthCalledWith(2, {
      credentials,
      machineId: 'machine-1',
      method: 'daemon.connectedAccounts.control.command',
      request: {
        v: 1,
        machineId: 'machine-1',
        command: {
          operation: 'describeService',
          service,
        },
      },
    });
    expect(callMachineRpc).toHaveBeenNthCalledWith(3, {
      credentials,
      machineId: 'machine-1',
      method: 'daemon.connectedAccounts.control.command',
      request: {
        v: 1,
        machineId: 'machine-1',
        command: {
          operation: 'revokeAccount',
          account: {
            service,
            accountId: 'account-1',
          },
          cleanupGroupReferences: false,
        },
      },
    });
  });
});
