import { describe, expect, it, vi } from 'vitest';

import {
  SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
  SESSION_SERVER_START_INGRESS_EVENT_V1,
  SessionServerStartIngressRequestV1Schema,
  type SessionServerStartIngressRequestV1,
  type SessionServerStartIngressResponseV1,
} from '@happier-dev/protocol';
import type { Machine } from '@/api/types';

import { ApiMachineClient } from './apiMachine';

function createMachine(): Machine {
  return {
    id: 'machine-1',
    encryptionKey: new Uint8Array(32).fill(1),
    encryptionVariant: 'legacy',
    metadata: null,
    metadataVersion: 0,
    daemonState: null,
    daemonStateVersion: 0,
  };
}

const request = SessionServerStartIngressRequestV1Schema.parse({
  v: 1,
  kind: 'session.serverStart.ingress',
  runId: 'run-1',
  attempt: 1,
  requestEnvelope: {
    t: 'plain',
    v: {
      creationKey: 'automation-run:run-1',
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      directory: '/workspace/project',
      organizationPlacement: { folderId: null, tagIds: [] },
      agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
      },
      initialMessage: 'Start the automation task.',
    },
  },
});

function rpcInvoker(client: ApiMachineClient): Readonly<{
  invokeLocal(
    method: string,
    params: unknown,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<unknown>;
}> {
  return (client as unknown as Readonly<{
    rpcHandlerManager: {
      invokeLocal(
        method: string,
        params: unknown,
        options?: Readonly<{ signal?: AbortSignal }>,
      ): Promise<unknown>;
    };
  }>).rpcHandlerManager;
}

describe('ApiMachineClient Session server-start ingress', () => {
  it('uses the server-stamped local dispatch and never locally falls back after a cross-machine result', async () => {
    const client = new ApiMachineClient('token', createMachine());
    const dispatch = {
      v: 1,
      kind: 'session.serverStart.dispatch',
      target: {
        accountId: 'account-1',
        machineId: 'machine-1',
        machineInstallationId: 'installation-1',
      },
      start: {
        automationId: 'automation-1',
        runId: request.runId,
        origin: 'schedule',
        accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
        requestEnvelope: request.requestEnvelope,
      },
    } as const;
    const emitWithAck = vi.fn<() => Promise<SessionServerStartIngressResponseV1>>(
      async () => ({ v: 1, kind: 'local', dispatch }),
    );
    (client as unknown as { socket: unknown }).socket = {
      connected: true,
      timeout: vi.fn(() => ({ emitWithAck })),
    };
    const invokeLocal = vi.spyOn(rpcInvoker(client), 'invokeLocal').mockResolvedValue({
      type: 'success',
      disposition: 'created',
      sessionId: 'session-1',
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'accepted', localId: 'automation:run:run-1' },
    });

    await expect(client.dispatchSessionServerStart(request)).resolves.toEqual({
      type: 'success',
      disposition: 'created',
      sessionId: 'session-1',
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'accepted', localId: 'automation:run:run-1' },
    });
    expect(emitWithAck).toHaveBeenCalledWith(SESSION_SERVER_START_INGRESS_EVENT_V1, request);
    expect(invokeLocal).toHaveBeenCalledWith(
      SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
      dispatch,
      undefined,
    );

    emitWithAck.mockResolvedValueOnce({
      v: 1,
      kind: 'result',
      result: {
        type: 'error',
        code: 'machine_offline',
        retryable: true,
      },
    });
    invokeLocal.mockClear();
    await expect(client.dispatchSessionServerStart(request)).resolves.toEqual({
      type: 'error',
      code: 'machine_offline',
      retryable: true,
    });
    expect(invokeLocal).not.toHaveBeenCalled();
  });

  it('keeps an acknowledgement lost after ingress as pending with the same creation key', async () => {
    const client = new ApiMachineClient('token', createMachine());
    const emitWithAck = vi.fn(async () => new Promise<unknown>(() => {}));
    (client as unknown as { socket: unknown }).socket = {
      connected: true,
      timeout: vi.fn(() => ({ emitWithAck })),
    };
    const cancellation = new AbortController();
    const pending = client.dispatchSessionServerStart(request, { signal: cancellation.signal });
    await vi.waitFor(() => expect(emitWithAck).toHaveBeenCalledOnce());
    cancellation.abort();

    await expect(pending).resolves.toEqual({
      type: 'pending',
      retryWithSameCreationKey: true,
      outcome: 'unknown',
    });
    expect(emitWithAck).toHaveBeenCalledWith(SESSION_SERVER_START_INGRESS_EVENT_V1, request);
  });
});
