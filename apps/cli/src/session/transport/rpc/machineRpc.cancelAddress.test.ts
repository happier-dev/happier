import { describe, expect, it } from 'vitest';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { ExternalActionMachineRpcExecutionV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ACTION_OPERATION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/operations/v1';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { MachineInstallationIdentityV1 } from '@happier-dev/protocol';
import { socketRpcCodec } from '@happier-dev/sync-client';
import type { ClientToServerEvents } from '@/api/types';
import { createActionOperationCancellationFixture } from '@/daemon/actionOperations/actionOperationCancellation.testkit';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { createActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import { createCliMachineActionDeps } from '@/session/actions/cliActionDeps/machine';
import { createCliMachineActionTransport } from '@/session/actions/cliActionDeps/machineTransport';

type PublishedMachineRpcCall = Parameters<ClientToServerEvents[typeof SOCKET_RPC_EVENTS.CALL]>[0];

describe('ordinary signed cancellation Machine RPC publisher', () => {
  it('retains the reviewed cancel envelope and fresh sealed requester through the canonical Action sender', async () => {
    const address = { serverId: 'srv_cancel', machineId: 'machine', operationId: 'pending-operation' };
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, resolveAction: () => null });
    let installation: MachineInstallationIdentityV1 | undefined;
    const fixture = await createActionOperationCancellationFixture({ mode: 'plain', accountId: 'requester', address, store, runner,
      requestHttp: request => {
        if (request.method !== 'GET' || !request.url.endsWith('/v1/machines/machine')) return undefined;
        if (!installation) throw new Error('Missing actual test installation');
        return { status: 200, data: { machine: { id: address.machineId, kind: 'persistent', revokedAt: null,
          replacedByMachineId: null, storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
          installationId: installation.installationId,
          installationPublicKey: Buffer.from(installation.publicKey, 'base64url').toString('base64') } } };
      } });
    installation = fixture.installation;
    const published: PublishedMachineRpcCall[] = [];
    // Reuse the genuine loopback Home socket boundary; no RPC sender, codec,
    // requester admission or Action owner is replaced.
    fixture.socketServer.on('connection', socket => {
      socket.on(SOCKET_RPC_EVENTS.CALL, (request: PublishedMachineRpcCall, acknowledge: (result: unknown) => void) => {
        published.push(request);
        acknowledge({ ok: true, result: { kind: 'requested' } });
      });
    });
    const prepared = await fixture.prepareRoot();
    if (!prepared) throw new Error(`Requester preparation refused: ${JSON.stringify(fixture.diagnostics)}`);
    try {
      const transport = createCliMachineActionTransport({ credentials: fixture.credentials,
        serverId: address.serverId, serverIdentityId: address.serverId, serverHttpBaseUrl: 'https://cancel-home.invalid',
        externalActionMachineInstallationId: installation.installationId,
        externalActionMachineRequestPrivateKey: installation.privateKey });
      const actions = createCliMachineActionDeps({ credentials: fixture.credentials, token: fixture.credentials.token,
        serverId: address.serverId, serverHttpBaseUrl: 'https://cancel-home.invalid' }, transport);
      const result = await actions.actionOperationAction!({ actionId: 'action.operations.cancel', input: address,
        context: { surface: 'rpc', authority: 'present_user', serverId: address.serverId,
          actionRequestId: 'canonical-cancel-sender', externalActionExecutionAuthorization: prepared.authorization,
          externalActionTarget: prepared.authorization.binding.target, originalActionEnvelope: fixture.envelope } });
      expect(result).toEqual({ kind: 'requested' });
      expect(published).toHaveLength(1);
      const call = published[0];
      if (!call) throw new Error('Missing actual published cancellation');
      expect(call.method).toBe(`${address.machineId}:${ACTION_OPERATION_RPC_METHODS_V1.cancel}`);
      const execution = ExternalActionMachineRpcExecutionV1Schema.parse(call.externalActionExecution);
      expect(execution.authorization.token === fixture.root.token, 'sender must retain the admitted root').toBe(true);
      const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, call.params, call.method);
      const opened = openExternalActionRequesterAccountContextV1({ authorization: execution.authorization,
        purpose: { kind: 'machine_rpc', method: ACTION_OPERATION_RPC_METHODS_V1.cancel, params: decoded.params },
        machineId: address.machineId, installationId: installation.installationId, serverIdentityId: address.serverId,
        installationPrivateKey: Buffer.from(installation.privateKey, 'base64url'), includeInvocation: true });
      expect(opened?.credentials.token === fixture.credentials.token, 'sender must reseal actual fresh requester custody').toBe(true);
      expect(sameStrictJsonValue(call.originalActionEnvelope, fixture.envelope),
        'canonical sender must retain the original reviewed cancel envelope').toBe(true);
    } finally { await prepared.dispose(); }
  });
});
