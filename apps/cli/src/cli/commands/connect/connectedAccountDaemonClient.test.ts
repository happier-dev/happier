import { describe, expect, it, vi } from 'vitest';

import type { StoredCredentials } from '@/persistence';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { createCliConnectedServiceAction } from '@/session/actions/connectedServiceActionDeps';

import {
  createConnectedAccountDaemonClient,
} from './connectedAccountDaemonClient';

const credentials: StoredCredentials = {
  token: 'token-1',
  encryption: null,
};
const service = Object.freeze({ pluginId: 'acme.accounts', localId: 'work' });

describe('createConnectedAccountDaemonClient', () => {
  it('requires canonical Action approval before revoking a connected account', async () => {
    const callMachineRpc = vi.fn(async () => ({ status: 'outcomeUnknown' as const,
      account: { service, accountId: 'account-1' } }));
    const actionExecutor = createActionExecutor({
      isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, {}, context),
      connectedServiceAction: createCliConnectedServiceAction({ credentials,
        resolveHeaders: () => ({ Authorization: `Bearer ${credentials.token}` }),
        callMachineAction: callMachineRpc,
      }),
    });
    const params = { credentials, machineId: 'machine-1', callMachineRpc, actionExecutor };
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
    const client = createConnectedAccountDaemonClient({
      credentials,
      machineId: 'machine-1',
      callMachineRpc,
      actionExecutor: createActionExecutor({
        isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id,
          { v: 1, approvalWaivedSurfaces: { 'connectedServices.authentication.beginConnect': ['cli'],
            'connectedServices.accounts.revoke': ['cli'] } }, context),
        connectedServiceAction: createCliConnectedServiceAction({ credentials,
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
