import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';
import axios from 'axios';
import type { Socket } from 'socket.io';
import tweetnacl from 'tweetnacl';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import {
  MACHINE_PLAIN_DATA_KEY_MARKER,
  encodePlainMachineStoredContent,
} from '@happier-dev/protocol';
import { auth } from '@/app/auth/auth';
import { db } from '@/storage/db';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import {
  createAuthenticatedFakeSocket,
  createSocketRoomDiscoveryHarness,
  triggerSocketHandler,
} from '@/app/api/testkit/socketHarness';
import { qualifyCurrentAccountStoredContentSocket } from '@/app/api/testkit/accountStoredContentCompatibility';
import { registerSocketRpcHandlers } from '@/app/api/socket/rpc/registerSocketRpcHandlers';
import {
  ManagedInstallationServerOriginV1Schema,
  type ManagedInstallationServerOriginV1,
} from '@happier-dev/protocol/machines/managed/actionsV1';
import * as prisma from '@/storage/prisma';
import {
  authorizeMachineRpcRequest,
  type MachineRpcAdmissionBoundary,
} from '../../../../../cli/src/api/machine/machineRpcAuthorization';
import { RpcHandlerManager } from '../../../../../cli/src/api/rpc/RpcHandlerManager';
import { registerCapabilitiesHandlers } from '../../../../../cli/src/rpc/handlers/capabilities';
import { getLiveSystemTasksRunnerAdapter } from '../../../../../cli/src/capabilities/systemTasks/liveSystemTasksRunner';
import {
  createManagedEnrollmentPairingDelivery,
  createManagedEnrollmentResponseValidation,
} from '../../../../../cli/src/machines/managed/enrollmentPairing';

describe('managed installation requester transport (real SQLite)', () => {
  let harness: LightSqliteHarness;
  const homeId = `srv_${'8'.repeat(32)}`;
  beforeAll(async () => {
    harness = await createLightSqliteHarness({
      tempDirPrefix: 'happier-managed-installation-',
      initAuth: true,
      env: { HAPPIER_SERVER_IDENTITY_ID: homeId },
    });
  }, 120_000);
  afterAll(async () => {
    if (harness) await harness.close();
  });

  it('delivers only the admitted requester exact current pre-enrollment purpose without a controller grant', async () => {
    const owner = await db.account.create({
      data: { encryptionMode: 'plain' },
    });
    const requester = await db.account.create({
      data: { encryptionMode: 'plain' },
    });
    const stranger = await db.account.create({
      data: { encryptionMode: 'plain' },
    });
    const controllerKeys = tweetnacl.sign.keyPair();
    const controller = await db.machine.create({
      data: {
        id: randomUUID(),
        accountId: owner.id,
        installationId: randomUUID(),
        installationPublicKey: new Uint8Array(controllerKeys.publicKey),
        active: true,
        metadata: encodePlainMachineStoredContent({
          host: 'controller',
          platform: 'linux',
          happyCliVersion: 'test',
          homeDir: '/home/controller',
          happyHomeDir: '/home/controller/.happier',
        }),
        dataEncryptionKey: new Uint8Array(
          Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
        ),
      },
    });
    const resource = {
      contributionRef: { pluginId: 'fixture.compute', localId: 'vm' },
      schemaVersion: 1,
      value: { id: 'native' },
    };
    const requestId = randomUUID();
    const row = await db.managedMachine.create({
      data: {
        homeId,
        custodianAccountId: owner.id,
        controllerMachineId: controller.id,
        controllerInstallationId: controller.installationId!,
        admittedActionRequestId: requestId,
        admittedInput: { enrollmentAccountId: requester.id },
        allocation: 'bound',
        creationState: 'active',
        desired: 'start',
        desiredWhen: 'now',
        intentRevision: 0,
        launch: {
          provider: resource.contributionRef,
          schemaVersion: 1,
          name: 'Guest',
          choices: {},
        },
        resource,
        retention: { kind: 'until-delete' },
        wakeOnAcceptedMessage: false,
      },
    });
    const response = {
      homeId,
      managedId: row.id,
      requestId,
      controller: {
        machineId: controller.id,
        installationId: controller.installationId!,
      },
      expectedIntentRevision: 0,
      resource,
      operationId: randomUUID(),
      taskId: '',
      expectedPromptKind: 'auth.approveRemoteProvisioning',
      delivery: { kind: 'terminalPairing' },
    };
    // The controller makes no Home call to accept a socket-relayed stamp.
    const http = vi.spyOn(axios, 'post').mockImplementation(async () => {
      throw new Error('unexpected Home call');
    });
    const runner = getLiveSystemTasksRunnerAdapter();
    const responseOwner = {
      correlation: response,
      operationId: response.operationId,
      enrollmentAccountId: requester.id,
      custodianAccountId: owner.id,
      readTaskId: () => response.taskId,
    };
    const pairing = {
      secretB64Url: Buffer.alloc(32, 7).toString('base64url'),
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    };
    const context = {
      publicKey: Buffer.alloc(32, 8).toString('base64'),
      homeServerIdentityId: homeId,
      pairing,
      supportsTokenOnly: true,
    };
    const task = await runner.startAdmitted({
      async run(taskContext) {
        await taskContext.prompt({
          kind: response.expectedPromptKind,
          message: 'Approve guest',
          data: {},
          validateResponse: createManagedEnrollmentResponseValidation(
            responseOwner,
            { kind: response.expectedPromptKind },
          ),
          deliver: (request) =>
            createManagedEnrollmentPairingDelivery(responseOwner)({
              ...context,
              request,
            }),
        });
        return { approved: true };
      },
    });
    response.taskId = task.taskId;
    onTestFinished(async () => {
      http.mockRestore();
      await runner.cancel(task);
    });
    const boundary: MachineRpcAdmissionBoundary = {
      machineId: controller.id,
      resolveCustodianAccountId: async () => owner.id,
      resolveInstallationId: () => controller.installationId!,
      // Never reached: a managed stamp carries no Machine admission.
      verifyMachineAdmission: async () => false,
    };
    const rpc = new RpcHandlerManager({
      scopePrefix: controller.id,
      localMachineId: controller.id,
      encryptionMode: 'plain',
      authorizeRequest: (request, source) =>
        authorizeMachineRpcRequest(request, boundary, source),
    });
    registerCapabilitiesHandlers(rpc);
    // Observe real database I/O, preserving the snapshot and all admission results.
    let managedRowReads = 0;
    const snapshot = prisma.withSqliteReadSnapshot;
    const reads = vi
      .spyOn(prisma, 'withSqliteReadSnapshot')
      .mockImplementation((read, options) =>
        snapshot(
          (tx) =>
            read(
              new Proxy(tx, {
                get(owner, property, receiver) {
                  if (property !== 'managedMachine')
                    return Reflect.get(owner, property, receiver);
                  return new Proxy(owner.managedMachine, {
                    get(model, method, modelReceiver) {
                      const value: unknown = Reflect.get(
                        model,
                        method,
                        modelReceiver,
                      );
                      if (method !== 'findFirst' || typeof value !== 'function')
                        return value;
                      return (...args: unknown[]) => {
                        managedRowReads += 1;
                        return Reflect.apply(value, model, args);
                      };
                    },
                  });
                },
              }),
            ),
          options,
        ),
      );
    onTestFinished(() => {
      reads.mockRestore();
    });
    let observedAuthorization: ManagedInstallationServerOriginV1 | undefined;
    const deliver = vi.fn(
      async (
        _event: string,
        packet: { method: string; authorization?: unknown; params: unknown },
      ) => {
        observedAuthorization = ManagedInstallationServerOriginV1Schema.parse(
          packet.authorization,
        );
        expect(packet.authorization).toMatchObject({
          kind: 'machine.managedInstallation.serverOrigin',
          actorAccountId: requester.id,
          custodianAccountId: owner.id,
          purpose: { managedId: row.id, requestId },
        });
        // This relay stands in for the controller's authenticated Home socket.
        return rpc.handleRequest(
          { ...packet, authorization: observedAuthorization },
          undefined,
          'authenticated_home_socket',
        );
      },
    );
    const target = {
      id: randomUUID(),
      data: {
        clientType: 'machine-scoped',
        userId: owner.id,
        machineId: controller.id,
        verifiedMachineInstallationId: controller.installationId,
      },
      timeout: () => ({ emitWithAck: deliver }),
    };
    qualifyCurrentAccountStoredContentSocket(target);
    const io = createSocketRoomDiscoveryHarness(async (room) =>
      room === target.id || room.startsWith(`rpc:${owner.id}:${controller.id}:`)
        ? [target]
        : [],
    );
    const call = async (
      actor: typeof requester,
      input: unknown,
      extra: Record<string, unknown> = {},
      authority: 'present_user' | 'account_automation' = 'present_user',
    ) => {
      const kind = authority === 'present_user' ? 'account' : 'terminal';
      const token = await auth.createToken(actor.id, undefined, {
        kind,
        authority,
      });
      const caller = Object.assign(
        createAuthenticatedFakeSocket({
          data: { clientType: 'user-scoped', userId: actor.id, authTokenKind: kind, authAuthority: authority },
        }),
        { handshake: { auth: { token } } },
      );
      qualifyCurrentAccountStoredContentSocket(caller);
      registerSocketRpcHandlers({
        userId: actor.id,
        socket: caller as unknown as Socket,
        io,
      });
      const callback = vi.fn();
      await triggerSocketHandler(
        caller,
        SOCKET_RPC_EVENTS.CALL,
        {
          method: `${controller.id}:${RPC_METHODS.CAPABILITIES_INVOKE}`,
          requestId: randomUUID(),
          timeoutMs: null,
          params: { id: 'tool.systemTasks', method: 'respond', params: input },
          ...extra,
        },
        callback,
      );
      return callback.mock.calls[0]?.[0];
    };
    expect(await call(requester, response)).toMatchObject({
      ok: true,
      result: {
        ok: true,
        result: {
          ...context,
          pairingRequirement: 'v3',
          enrollmentAccountId: requester.id,
        },
      },
    });
    // Home admits the row once at forward; the controller trusts its authenticated socket.
    expect(managedRowReads).toBe(1);
    expect(http).not.toHaveBeenCalled();
    expect(
      JSON.stringify(await runner.poll({ taskId: task.taskId, cursor: 0 })),
    ).not.toContain(pairing.secretB64Url);
    const sibling = await db.managedMachine.create({
      data: {
        homeId,
        custodianAccountId: owner.id,
        controllerMachineId: controller.id,
        controllerInstallationId: controller.installationId!,
        admittedActionRequestId: randomUUID(),
        admittedInput: { enrollmentAccountId: stranger.id },
        allocation: 'bound',
        creationState: 'active',
        desired: 'start',
        desiredWhen: 'now',
        intentRevision: 0,
        launch: {
          provider: resource.contributionRef,
          schemaVersion: 1,
          name: 'Other guest',
          choices: {},
        },
        resource,
        retention: { kind: 'until-delete' },
        wakeOnAcceptedMessage: false,
      },
    });
    let siblingTaskId: string | undefined;
    const siblingOwner = {
      ...responseOwner,
      correlation: {
        ...response,
        managedId: sibling.id,
        requestId: sibling.admittedActionRequestId!,
      },
      enrollmentAccountId: stranger.id,
      operationId: randomUUID(),
      readTaskId: () => siblingTaskId,
    };
    const siblingContext = {
      ...context,
      pairing: {
        ...pairing,
        secretB64Url: Buffer.alloc(32, 9).toString('base64url'),
      },
    };
    const siblingTask = await runner.startAdmitted({
      async run(taskContext) {
        await taskContext.prompt({
          kind: response.expectedPromptKind,
          message: 'Approve other guest',
          data: {},
          validateResponse: createManagedEnrollmentResponseValidation(
            siblingOwner,
            { kind: response.expectedPromptKind },
          ),
          deliver: (request) =>
            createManagedEnrollmentPairingDelivery(siblingOwner)({
              ...siblingContext,
              request,
            }),
        });
        return { approved: true };
      },
    });
    siblingTaskId = siblingTask.taskId;
    onTestFinished(async () => {
      await runner.cancel(siblingTask);
    });
    expect(
      await call(requester, { ...response, taskId: siblingTask.taskId }),
    ).toMatchObject({
      ok: true,
      result: { ok: false, error: { code: 'permission_denied' } },
    });
    const crossPersonResponse = await call(requester, {
      ...response,
      taskId: siblingTask.taskId,
      operationId: siblingOwner.operationId,
    });
    // Both addressing ids are caller-supplied; the Home must not let row A disclose row B's context.
    expect.soft(crossPersonResponse?.ok).toBe(true);
    expect.soft(crossPersonResponse?.result?.ok).toBe(false);
    expect
      .soft(crossPersonResponse?.result?.error?.code)
      .toBe('permission_denied');
    const exposesSiblingSecret = JSON.stringify(crossPersonResponse).includes(
      siblingContext.pairing.secretB64Url,
    );
    expect.soft(exposesSiblingSecret).toBe(false);
    const { requestId: _omitted, ...withoutRequestId } = response;
    expect(await call(requester, withoutRequestId)).toMatchObject({ ok: true });
    if (!observedAuthorization)
      throw new Error('Home did not produce an installation purpose');
    const admitted = observedAuthorization;
    // A captured admitted stamp replayed off the authenticated Home socket admits nothing.
    expect(
      await rpc.handleRequest({
        method: `${controller.id}:${RPC_METHODS.CAPABILITIES_INVOKE}`,
        params: {
          id: 'tool.systemTasks',
          method: 'respond',
          params: { ...response, requestId: admitted.purpose.requestId },
        },
        authorization: admitted,
      }),
    ).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    deliver.mockClear();
    for (const input of [
      { ...response, requestId: randomUUID() },
      { ...response, expectedIntentRevision: 1 },
      { ...response, resource: { ...resource, value: { id: 'other' } } },
      {
        ...response,
        controller: { ...response.controller, installationId: randomUUID() },
      },
    ]) {
      expect(await call(requester, input)).toMatchObject({ ok: false });
    }
    expect(await call(stranger, response)).toMatchObject({ ok: false });
    expect(await call(owner, response)).toMatchObject({ ok: false });
    // Coordination owns replacing this existing present-user floor with canonical agent self-decision policy.
    expect(
      await call(requester, response, {}, 'account_automation'),
    ).toMatchObject({ ok: false });
    expect(
      await call(requester, response, { authorization: admitted }),
    ).toMatchObject({ ok: false });
    expect(
      await call(requester, response, {
        authorization: admitted,
        params: {
          id: 'tool.systemTasks',
          method: 'respond',
          params: {
            taskId: task.taskId,
            expectedPromptKind: response.expectedPromptKind,
            delivery: response.delivery,
          },
        },
      }),
    ).toMatchObject({ ok: false });
    expect(
      await call(requester, { ...response, accountId: owner.id }),
    ).toMatchObject({ ok: false });
    expect(
      await call(requester, response, {
        params: { id: 'tool.systemTasks', method: 'start', params: response },
      }),
    ).toMatchObject({ ok: false });
    expect(
      await call(requester, response, {
        method: `${controller.id}:${RPC_METHODS.BASH}`,
        params: { command: 'true' },
      }),
    ).toMatchObject({ ok: false });
    expect(deliver).not.toHaveBeenCalled();
    const guest = await db.machine.create({
      data: {
        id: randomUUID(),
        accountId: requester.id,
        installationId: randomUUID(),
        installationPublicKey: new Uint8Array(
          tweetnacl.sign.keyPair().publicKey,
        ),
        active: true,
        metadata: controller.metadata,
        dataEncryptionKey: controller.dataEncryptionKey,
      },
    });
    await db.managedMachine.update({
      where: { id: row.id },
      data: { enrolledMachineId: guest.id },
    });
    expect(await call(requester, response)).toMatchObject({ ok: false });
    const { delivery: _delivery, ...answer } = response;
    expect(
      await call(requester, { ...answer, answer: { approved: true } }),
    ).toMatchObject({ ok: true });
    expect(observedAuthorization?.purpose.phase).toBe('answer');
    deliver.mockClear();
    await db.managedMachine.update({
      where: { id: row.id },
      data: { creationState: 'canceled', enrolledMachineId: null },
    });
    expect(await call(requester, response)).toMatchObject({ ok: false });
    expect(deliver).not.toHaveBeenCalled();
  });
});
