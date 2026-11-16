import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { StoredCredentials } from '@/persistence';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCliConnectedServiceAction } from '@/session/actions/connectedServiceActionDeps';
import { createRpcCallError } from '@happier-dev/protocol/rpc/errors';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import axios from '@/api/client/credentialAxios';
import { absentAccountPluginAvailabilityHttpResponse } from '@/testkit/http/accountPluginAvailability';

import {
  createConnectedAccountDaemonClient,
} from './connectedAccountDaemonClient';

const credentials: StoredCredentials = {
  token: 'token-1',
  encryption: null,
};
const service = Object.freeze({ pluginId: 'acme.accounts', localId: 'work' });

describe('createConnectedAccountDaemonClient', () => {
  it('retains the transport cause and no-effect fact while excluding opaque transport details through the real Action executor', async () => {
    const failureCause = projectActionFailureCauseV1(Object.assign(new Error('private'), { code: 'ECONNREFUSED' }), 'connected_account.authentication');
    const details = { requiredFact: 'connected_account_machine_online' };
    // HTTP and Machine RPC are transport boundaries; keep registry/executor logic real.
    const previousAdapter = axios.defaults.adapter;
    axios.defaults.adapter = async () => {
      throw createRpcCallError({ error: 'Transport unavailable', errorCode: 'RPC_TRANSPORT_UNAVAILABLE', failureCause, details, effectAttempted: false });
    };
    const callMachineRpc = vi.fn(async () => {
      throw createRpcCallError({ error: 'Transport unavailable', errorCode: 'RPC_TRANSPORT_UNAVAILABLE', failureCause, details, effectAttempted: false });
    });
    const client = createConnectedAccountDaemonClient({ serverId: 'home', serverHttpBaseUrl: 'http://home.test', credentials, machineId: 'machine-1', callMachineRpc,
      actionExecutor: createActionExecutor({
        ...createUnavailableActionTransportDeps(),

        connectedServiceAction: createCliConnectedServiceAction({ serverId: 'home', credentials,
          resolveHeaders: () => ({ Authorization: `Bearer ${credentials.token}` }),
          callMachineAction: async () => callMachineRpc(),
        }),
      }),
    });
    try {
      const failure = await client.control({ operation: 'listPendingAttempts', service }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'RPC_TRANSPORT_UNAVAILABLE', failureCause, effectAttempted: false });
      expect(failure).not.toHaveProperty('details');
    } finally { await client.dispose(); axios.defaults.adapter = previousAdapter; }
  });

  it('admits new credential input through the same Action policy without a Machine', async () => {
    const callMachineRpc = vi.fn(async () => { throw new Error('Account admission must not call a Machine'); });
    const actionExecutor = createActionExecutor({
      ...createUnavailableActionTransportDeps(),
      readActionsSettings: () => normalizeActionsSettingsV1({}),
      connectedServiceAction: createCliConnectedServiceAction({ serverId: 'home', credentials,
        resolveHeaders: () => ({ Authorization: `Bearer ${credentials.token}` }),
        callMachineAction: callMachineRpc,
      }),
    });
    const client = createConnectedAccountDaemonClient({ serverId: 'home', serverHttpBaseUrl: 'http://home.test', credentials, callMachineRpc, actionExecutor });
    await expect(client.authenticate({ operation: 'submitManual', attemptId: 'attempt-account',
      fields: { token: 'private-token' },
    })).rejects.toMatchObject({ code: 'approvals_not_supported' });
    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('requires canonical Action approval before revoking a connected account', async () => {
    const callMachineRpc = vi.fn(async () => ({ status: 'outcomeUnknown' as const,
      account: { service, accountId: 'account-1' } }));
    const actionExecutor = createActionExecutor({
      ...createUnavailableActionTransportDeps(),
      readActionsSettings: () => normalizeActionsSettingsV1({}),
      connectedServiceAction: createCliConnectedServiceAction({ serverId: 'home', credentials,
        resolveHeaders: () => ({ Authorization: `Bearer ${credentials.token}` }),
        callMachineAction: callMachineRpc,
      }),
    });
    const params = { credentials, serverId: 'home', serverHttpBaseUrl: 'http://home.test', machineId: 'machine-1', callMachineRpc, actionExecutor };
    const client = createConnectedAccountDaemonClient(params);

    await expect(client.control({ operation: 'revokeAccount',
      account: { service, accountId: 'account-1' }, cleanupGroupReferences: false,
      expectedCredentialRevision: `csr_${'a'.repeat(22)}`,
    })).rejects.toMatchObject({ code: 'approvals_not_supported' });
    await expect(client.authenticate({ operation: 'submitManual', attemptId: 'attempt-1',
      fields: { token: 'private-token' },
    })).rejects.toMatchObject({ code: 'approvals_not_supported' });
    expect(callMachineRpc).not.toHaveBeenCalled();
  });
  it('uses the one account-scoped machine RPC for auth and control commands', async () => {
    const previousAdapter = axios.defaults.adapter;
    onTestFinished(() => { axios.defaults.adapter = previousAdapter; });
    axios.defaults.adapter = async config => {
      expect(new URL(config.url!).origin).toBe('http://home.test');
      const response = absentAccountPluginAvailabilityHttpResponse(config.url!, JSON.parse(config.data));
      if (!response) throw new Error(`Unexpected Account Home request: ${config.url}`);
      return { ...response, statusText: 'OK', headers: {}, config };
    };
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
        occurrenceId: 'occurrence-1',
        sourceCustody: { kind: 'managed', immutableGenerationId: 'artifact-1', installSource: 'archive' },
        accounts: [],
      })
      .mockResolvedValueOnce({
        status: 'outcomeUnknown',
        account: {
          service,
          accountId: 'account-1',
        },
      });
    const client = createConnectedAccountDaemonClient({ serverId: 'home', serverHttpBaseUrl: 'http://home.test',
      credentials,
      machineId: 'machine-1',
      callMachineRpc,
      actionExecutor: createActionExecutor({
        ...createUnavailableActionTransportDeps(),
        readActionsSettings: () => normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'connectedServices.authentication.beginConnect': ['cli'],
            'connectedServices.accounts.revoke': ['cli'] } }),
        connectedServiceAction: createCliConnectedServiceAction({ serverId: 'home', credentials,
          resolveHeaders: () => ({ Authorization: `Bearer ${credentials.token}` }),
          callMachineAction: async ({ machineId, method, request, signal }) => callMachineRpc({ credentials,
            machineId, method, request, ...(signal ? { signal } : {}) }),
        }),
      }),
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
      expectedCredentialRevision: `csr_${'a'.repeat(22)}`,
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
          expectedCredentialRevision: `csr_${'a'.repeat(22)}`,
        },
      },
    });
  });
});
