import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { ManagedInstallationServerOriginV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import {
  authorizeMachineRpcRequest,
  type MachineRpcAdmissionBoundary,
} from './machineRpcAuthorization';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerCapabilitiesHandlers } from '@/rpc/handlers/capabilities';
import { getLiveSystemTasksRunnerAdapter } from '@/capabilities/systemTasks/liveSystemTasksRunner';
import { SystemTaskExecutionError } from '@happier-dev/cli-common/systemTasks';

function stamp(taskId = 'task') {
  return ManagedInstallationServerOriginV1Schema.parse({
    kind: 'machine.managedInstallation.serverOrigin',
    actorAccountId: 'requester',
    custodianAccountId: 'owner',
    purpose: {
      homeId: 'home',
      managedId: 'managed',
      requestId: 'creation',
      expectedIntentRevision: 0,
      controller: { machineId: 'controller', installationId: 'installation' },
      resource: {
        contributionRef: { pluginId: 'fixture.compute', localId: 'vm' },
        schemaVersion: 1,
        value: {},
      },
      operationId: 'operation',
      taskId,
      expectedPromptKind: 'auth.approveRemoteProvisioning',
      phase: 'delivery',
    },
  });
}

describe('managed installation RPC authorization', () => {
  it('refuses a managed installation disclosure without an installed Machine boundary or the authenticated Home socket', async () => {
    const authorization = stamp();
    const { phase: _phase, ...purpose } = authorization.purpose;
    expect(
      await authorizeMachineRpcRequest({
        method: `controller:${RPC_METHODS.CAPABILITIES_INVOKE}`,
        params: {
          id: 'tool.systemTasks',
          method: 'respond',
          params: { ...purpose, delivery: { kind: 'terminalPairing' } },
        },
        authorization,
      }),
    ).toMatchObject({ ok: false });
  });

  it.each(['plain', 'e2ee'] as const)(
    'uses the real %s host registration, capability and current task without a controller key or retained secret',
    async (mode) => {
      const runner = getLiveSystemTasksRunnerAdapter();
      let delivered: unknown;
      let taskId: string | undefined;
      const task = await runner.startAdmitted({
        async run(context) {
          await context.prompt(
            Object.assign(
              {
                kind: 'auth.approveRemoteProvisioning',
                message: 'Approve guest',
                data: {},
                deliver: async (request: unknown) => {
                  delivered = request;
                  return { secretB64Url: 'never-retain-pairing-secret' };
                },
              },
              {
                validateResponse: async (value: unknown) => {
                  const origin =
                    ManagedInstallationServerOriginV1Schema.safeParse(value);
                  if (
                    !origin.success ||
                    origin.data.actorAccountId !== 'requester' ||
                    origin.data.purpose.managedId !== 'managed' ||
                    origin.data.purpose.operationId !== 'operation' ||
                    origin.data.purpose.taskId !== taskId ||
                    origin.data.purpose.phase !== 'answer'
                  )
                    throw new SystemTaskExecutionError(
                      'permission_denied',
                      'Wrong pending installer',
                    );
                },
              },
            ),
          );
          return { approved: true };
        },
      });
      taskId = task.taskId;
      const authorization = stamp(task.taskId);
      const { phase: _phase, ...purpose } = authorization.purpose;
      // The controller makes no Home call to accept a socket-relayed stamp.
      const http = vi.spyOn(axios, 'post').mockImplementation(async () => {
        throw new Error('unexpected Home call');
      });
      const diagnostics: unknown[] = [];
      const target: MachineRpcAdmissionBoundary = {
        machineId: 'controller',
        resolveCustodianAccountId: async () => 'owner',
        resolveInstallationId: () => 'installation',
        // Never reached: a managed stamp carries no Machine admission.
        verifyMachineAdmission: async () => false,
      };
      const rpc = new RpcHandlerManager({
        scopePrefix: 'controller',
        localMachineId: 'controller',
        ...(mode === 'e2ee'
          ? { encryptionMode: 'e2ee' as const,
              encryptionKey: new Uint8Array(32).fill(7),
              encryptionVariant: 'legacy' as const,
            }
          : { encryptionMode: 'plain' as const }),
        logger: (message, data) => {
          diagnostics.push([message, data]);
        },
        authorizeRequest: (request, source) =>
          authorizeMachineRpcRequest(request, target, source),
      });
      registerCapabilitiesHandlers(rpc);
      const packet = {
        method: `controller:${RPC_METHODS.CAPABILITIES_INVOKE}`,
        params: {
          id: 'tool.systemTasks',
          method: 'respond',
          params: { ...purpose, delivery: { kind: 'terminalPairing' } },
        },
        authorization,
      };
      // Stands in for the controller's authenticated Home socket.
      const home = (request: Parameters<typeof rpc.handleRequest>[0]) =>
        rpc.handleRequest(request, undefined, 'authenticated_home_socket');
      try {
        expect(await home(packet)).toMatchObject({
          ok: true,
          result: { secretB64Url: 'never-retain-pairing-secret' },
        });
        expect(delivered).toEqual({
          request: { kind: 'terminalPairing' },
          authorization,
        });
        expect(
          JSON.stringify(await runner.poll({ taskId: task.taskId, cursor: 0 })),
        ).not.toContain('never-retain');
        expect(JSON.stringify(diagnostics)).not.toContain('never-retain');
        const answerAuthorization = {
          ...authorization,
          purpose: { ...authorization.purpose, phase: 'answer' as const },
        };
        const foreignPurpose = {
          ...purpose,
          managedId: 'other-managed-row',
          answer: { approved: true },
        };
        expect(
          await home({
            ...packet,
            authorization: {
              ...answerAuthorization,
              purpose: {
                ...answerAuthorization.purpose,
                managedId: foreignPurpose.managedId,
              },
            },
            params: {
              id: 'tool.systemTasks',
              method: 'respond',
              params: foreignPurpose,
            },
          }),
        ).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
        expect(
          await rpc.invokeLocal(RPC_METHODS.CAPABILITIES_INVOKE, {
            id: 'tool.systemTasks',
            method: 'respond',
            params: {
              taskId: task.taskId,
              expectedPromptKind: 'auth.approveRemoteProvisioning',
              answer: { approved: true },
              responseAuthorization: answerAuthorization,
            },
          }),
        )
          // A copied stamp in params supplies no installed requester custody.
          .toMatchObject({
            ok: false,
            error: { code: 'filesystem_identity_custody_unavailable' },
          });
        expect(
          await home({
            ...packet,
            authorization: answerAuthorization,
            params: {
              id: 'tool.systemTasks',
              method: 'respond',
              params: { ...purpose, answer: { approved: true } },
            },
          }),
        ).toMatchObject({ ok: true });
        expect(await runner.wait({ taskId: task.taskId })).toMatchObject({
          ok: true,
        });
        expect(http).not.toHaveBeenCalled();
      } finally {
        http.mockRestore();
        await runner.cancel({ taskId: task.taskId });
      }
    },
  );

  it('refuses a stamp presented through local invoke or any ingress other than the authenticated Home socket', async () => {
    const runner = getLiveSystemTasksRunnerAdapter();
    const secret = 'never-disclose-pairing-secret';
    let delivered: unknown;
    let answered = false;
    const task = await runner.startAdmitted({
      async run(context) {
        await context.prompt(
          Object.assign(
            {
              kind: 'auth.approveRemoteProvisioning',
              message: 'Approve guest',
              data: {},
              deliver: async (request: unknown) => {
                delivered = request;
                return { secretB64Url: secret };
              },
            },
            {
              validateResponse: async (value: unknown) => {
                if (
                  !ManagedInstallationServerOriginV1Schema.safeParse(value)
                    .success
                )
                  throw new SystemTaskExecutionError(
                    'permission_denied',
                    'Wrong pending installer',
                  );
                answered = true;
              },
            },
          ),
        );
        return { approved: true };
      },
    });
    const authorization = stamp(task.taskId);
    const { phase: _phase, ...purpose } = authorization.purpose;
    const answerAuthorization = {
      ...authorization,
      purpose: { ...authorization.purpose, phase: 'answer' as const },
    };
    // A genuine stamp: only the ingress decides.
    const target: MachineRpcAdmissionBoundary = {
      machineId: 'controller',
      resolveCustodianAccountId: async () => 'owner',
      resolveInstallationId: () => 'installation',
      verifyMachineAdmission: async () => true,
    };
    const rpc = new RpcHandlerManager({
      scopePrefix: 'controller',
      localMachineId: 'controller',
      encryptionMode: 'plain',
      logger: () => {},
      authorizeRequest: (request, source) =>
        authorizeMachineRpcRequest(request, target, source),
    });
    registerCapabilitiesHandlers(rpc);
    const delivery = {
      id: 'tool.systemTasks',
      method: 'respond',
      params: { ...purpose, delivery: { kind: 'terminalPairing' } },
    };
    const packet = {
      method: `controller:${RPC_METHODS.CAPABILITIES_INVOKE}`,
      params: delivery,
      authorization,
    };
    try {
      const local = [
        await rpc.invokeLocal(RPC_METHODS.CAPABILITIES_INVOKE, delivery),
        await rpc.invokeLocal(RPC_METHODS.CAPABILITIES_INVOKE, {
          ...delivery,
          authorization,
        }),
        await rpc.invokeLocal(RPC_METHODS.CAPABILITIES_INVOKE, {
          id: 'tool.systemTasks',
          method: 'respond',
          params: {
            taskId: task.taskId,
            expectedPromptKind: 'auth.approveRemoteProvisioning',
            delivery: { request: { kind: 'terminalPairing' }, authorization },
          },
        }),
        await rpc.invokeLocal(
          RPC_METHODS.CAPABILITIES_INVOKE,
          {
            id: 'tool.systemTasks',
            method: 'respond',
            params: {
              taskId: task.taskId,
              expectedPromptKind: 'auth.approveRemoteProvisioning',
              answer: { approved: true },
              responseAuthorization: answerAuthorization,
            },
          },
          { verifiedPeerAuthority: 'present_user' },
        ),
        await rpc.invokeLocal(RPC_METHODS.CAPABILITIES_INVOKE, delivery, {
          verifiedPeerAuthority: 'account_automation',
        }),
      ];
      for (const result of local) {
        // Each local path refuses with its own typed shape; none may succeed or disclose.
        expect(result).not.toMatchObject({ ok: true });
        expect(JSON.stringify(result)).not.toContain(secret);
      }
      expect(await rpc.handleRequest(packet)).toMatchObject({
        errorCode: RPC_ERROR_CODES.FORBIDDEN,
      });
      expect(
        await rpc.handleRequest({
          ...packet,
          authorization: answerAuthorization,
          params: {
            id: 'tool.systemTasks',
            method: 'respond',
            params: { ...purpose, answer: { approved: true } },
          },
        }),
      ).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(delivered).toBeUndefined();
      expect(answered).toBe(false);
      // Control: the same stamp on the authenticated Home socket is admitted.
      expect(
        await rpc.handleRequest(packet, undefined, 'authenticated_home_socket'),
      ).toMatchObject({ ok: true, result: { secretB64Url: secret } });
      expect(delivered).toEqual({
        request: { kind: 'terminalPairing' },
        authorization,
      });
    } finally {
      await runner.cancel({ taskId: task.taskId });
    }
  });
});
