import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveSessionCreationTagV1, type SessionInputAdmissionResultV1 } from '@happier-dev/protocol';

const mocks = vi.hoisted(() => ({
  resolveSessionTransportContext: vi.fn(),
  enqueuePendingQueueV2MessageViaHttp: vi.fn(),
  listPendingQueueV2DeliveryStatusesFromServer: vi.fn(),
  tryDecryptSessionOwnerMetadataView: vi.fn(),
  resolveSessionMessageModel: vi.fn(),
  requestInactiveSessionResume: vi.fn(),
}));

vi.mock('./resolveSessionTransportContext', () => ({
  resolveSessionTransportContext: mocks.resolveSessionTransportContext,
}));
vi.mock('@/api/session/pendingQueueV2Transport', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/session/pendingQueueV2Transport')>(),
  enqueuePendingQueueV2MessageViaHttp: mocks.enqueuePendingQueueV2MessageViaHttp,
  listPendingQueueV2DeliveryStatusesFromServer: mocks.listPendingQueueV2DeliveryStatusesFromServer,
  readBlockedPendingQueueV2DeliveryByLocalIdFromServer: vi.fn(),
}));
vi.mock('./requestInactiveSessionResume', () => ({
  requestInactiveSessionResume: mocks.requestInactiveSessionResume,
}));
vi.mock('@/session/transport/encryption/sessionEncryptionContext', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/encryption/sessionEncryptionContext')>(),
  tryDecryptSessionOwnerMetadataView: mocks.tryDecryptSessionOwnerMetadataView,
}));
vi.mock('./resolveSessionMessageModel', async (importOriginal) => ({
  ...await importOriginal<typeof import('./resolveSessionMessageModel')>(),
  resolveSessionMessageModel: mocks.resolveSessionMessageModel,
}));

import { sendSessionMessage } from './sendSessionMessage';

type MachineAdmissionRequest = Parameters<
  NonNullable<Parameters<typeof sendSessionMessage>[0]['machineAdmissionTransport']>
>[0];

function requireMachineAdmissionRequest(
  request: MachineAdmissionRequest | null,
): MachineAdmissionRequest {
  if (!request) throw new Error('Expected a machine admission request');
  return request;
}

const credentials = {
  token: 'token',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32) },
};

function protectedHostSendParams(localId: string) {
  return {
    credentials,
    idOrPrefix: 'session-1',
    message: 'human prompt',
    wait: false,
    timeoutMs: 30_000,
    localId,
    requestedAction: { v: 1, kind: 'enqueue' } as const,
    inputAdmission: {
      provenance: { v: 1, kind: 'host', producer: 'happierApp' } as const,
      request: {
        v: 1,
        producer: 'happierApp',
        caller: { kind: 'host' },
        permission: {},
      } as const,
    },
  };
}

function setInactiveE2eeSession(): void {
  mocks.resolveSessionTransportContext.mockResolvedValue({
    ok: true,
    sessionId: 'session-1',
    mode: 'e2ee',
    ctx: { encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'legacy' },
    accountEncryptionCurrentness: { mode: 'e2ee' },
    rawSession: { id: 'session-1', active: false, archivedAt: null },
  });
}

describe('sendSessionMessage machine admission', () => {
  beforeEach(() => {
    mocks.resolveSessionTransportContext.mockReset();
    mocks.enqueuePendingQueueV2MessageViaHttp.mockReset();
    mocks.listPendingQueueV2DeliveryStatusesFromServer.mockReset();
    mocks.tryDecryptSessionOwnerMetadataView.mockReset();
    mocks.resolveSessionMessageModel.mockReset();
    mocks.requestInactiveSessionResume.mockReset();
    mocks.resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'session-1',
      mode: 'plain',
      ctx: null,
      accountEncryptionCurrentness: { mode: 'plain' },
      rawSession: { id: 'session-1', active: true, archivedAt: null },
    });
    mocks.tryDecryptSessionOwnerMetadataView.mockReturnValue({
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 1,
      sessionCreationCorrespondenceV1: {
        v: 1,
        sessionCreationTag: deriveSessionCreationTagV1({
          callerCreationNamespace: 'user',
          creationKey: 'machine-admission-test',
        }),
        recipe: {
          execution: { machineId: 'target-machine', directory: '/workspace' },
          organization: { folderId: null, tagIds: [] },
          agentTarget: {
            kind: 'agent',
            identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
          },
          modelSelection: null,
          profileId: null,
          requestedPermissionMode: null,
          agentModeId: null,
          configuration: null,
          connectedServices: null,
          mcpSelection: null,
          transcriptStorage: null,
          terminal: null,
          agentSessionStartupInstructionsMarkerV1: null,
          checkout: null,
        },
      },
    });
    mocks.resolveSessionMessageModel.mockReturnValue({ modelId: '', selection: null });
    mocks.listPendingQueueV2DeliveryStatusesFromServer.mockResolvedValue([
      { localId: 'ui-input-e2ee-1', status: 'queued' },
      { localId: 'plugin-input-v1:plain-policy-drift', status: 'queued' },
    ]);
    mocks.requestInactiveSessionResume.mockResolvedValue({ ok: true });
  });

  it('returns an exact protected-input rejection when target resolution fails before admission', async () => {
    mocks.resolveSessionTransportContext.mockResolvedValue({ ok: false, code: 'session_not_found' });

    await expect(sendSessionMessage({
      credentials,
      idOrPrefix: 'missing-session',
      message: 'plugin prompt',
      wait: false,
      timeoutMs: 30_000,
      localId: 'plugin-input-v1:missing-target',
      inputAdmission: {
        provenance: {
          v: 1,
          kind: 'pluginSession',
          pluginId: 'example.plugin',
          contributionLocalId: 'send',
          surface: 'background',
        },
        request: {
          v: 1,
          producer: 'pluginSession',
          caller: { kind: 'plugin', pluginId: 'example.plugin', contributionLocalId: 'send' },
          permission: { requestedPermissionCeiling: 'read-only' },
        },
      },
    })).resolves.toEqual({
      ok: false,
      code: 'session_not_found',
      admissionResult: { status: 'rejected', code: 'session_input_target_unavailable' },
    });
  });

  it('uses authenticated machine admission for protected plugin input with no Account fallback', async () => {
    const machineAdmissionTransport = vi.fn(async () => ({
      status: 'accepted' as const,
      localId: 'plugin-input-v1:stable',
    }));

    await expect(sendSessionMessage({
      credentials,
      idOrPrefix: 'session-1',
      message: 'plugin prompt',
      wait: false,
      timeoutMs: 30_000,
      localId: 'plugin-input-v1:stable',
      inputAdmission: {
        provenance: {
          v: 1,
          kind: 'pluginSession',
          pluginId: 'example.plugin',
          contributionLocalId: 'send',
          surface: 'background',
        },
        request: {
          v: 1,
          producer: 'pluginSession',
          caller: { kind: 'plugin', pluginId: 'example.plugin', contributionLocalId: 'send' },
          permission: { requestedPermissionCeiling: 'read-only' },
        },
      },
      machineAdmissionTransport,
    })).resolves.toMatchObject({
      ok: true,
      localId: 'plugin-input-v1:stable',
      admissionResult: {
        status: 'accepted',
        localId: 'plugin-input-v1:stable',
      },
    });

    expect(machineAdmissionTransport).toHaveBeenCalledWith(expect.objectContaining({
      v: 1,
      sessionId: 'session-1',
      targetMachineId: 'target-machine',
      localId: 'plugin-input-v1:stable',
      content: expect.objectContaining({ t: 'plain' }),
      requestedAction: { v: 1, kind: 'steer_if_active' },
    }));
    expect(mocks.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
  });

  it('cancels a protected machine-admission acknowledgement through transport options without serializing the signal', async () => {
    const cancellation = new AbortController();
    const machineAdmissionTransport = vi.fn((...args: unknown[]) => {
      const [request, options] = args as [
        MachineAdmissionRequest,
        Readonly<{ signal?: AbortSignal }> | undefined,
      ];
      if (!options?.signal) {
        return Promise.resolve<SessionInputAdmissionResultV1>({
          status: 'rejected',
          code: 'session_input_target_update_required',
        });
      }
      return new Promise<SessionInputAdmissionResultV1>((resolve) => {
        options.signal?.addEventListener('abort', () => resolve({
          status: 'outcomeUnknown',
          localId: request.localId,
          code: 'machine_socket_disconnected',
        }), { once: true });
      });
    });

    const pending = sendSessionMessage({
      credentials,
      idOrPrefix: 'session-1',
      message: 'plugin prompt',
      wait: false,
      timeoutMs: 30_000,
      localId: 'plugin-input-v1:cancelled-machine-ack',
      inputAdmission: {
        provenance: {
          v: 1,
          kind: 'pluginSession',
          pluginId: 'example.plugin',
          contributionLocalId: 'send',
          surface: 'background',
        },
        request: {
          v: 1,
          producer: 'pluginSession',
          caller: { kind: 'plugin', pluginId: 'example.plugin', contributionLocalId: 'send' },
          permission: { requestedPermissionCeiling: 'read-only' },
        },
      },
      machineAdmissionTransport,
      signal: cancellation.signal,
    });

    await vi.waitFor(() => expect(machineAdmissionTransport).toHaveBeenCalledOnce());
    cancellation.abort();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: 'timeout',
      admissionResult: {
        status: 'outcomeUnknown',
        localId: 'plugin-input-v1:cancelled-machine-ack',
        code: 'machine_socket_disconnected',
      },
    });
    const [request, options] = machineAdmissionTransport.mock.calls[0] ?? [];
    expect(request).not.toHaveProperty('signal');
    expect(options).toEqual({ signal: cancellation.signal });
    expect(mocks.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
  });

  it('returns a definite protected-input rejection when already cancelled before emit', async () => {
    const cancellation = new AbortController();
    cancellation.abort();
    const machineAdmissionTransport = vi.fn();

    await expect(sendSessionMessage({
      credentials,
      idOrPrefix: 'session-1',
      message: 'plugin prompt',
      wait: false,
      timeoutMs: 30_000,
      localId: 'plugin-input-v1:cancelled-before-emit',
      inputAdmission: {
        provenance: {
          v: 1,
          kind: 'pluginSession',
          pluginId: 'example.plugin',
          contributionLocalId: 'send',
          surface: 'background',
        },
        request: {
          v: 1,
          producer: 'pluginSession',
          caller: { kind: 'plugin', pluginId: 'example.plugin', contributionLocalId: 'send' },
          permission: { requestedPermissionCeiling: 'read-only' },
        },
      },
      machineAdmissionTransport,
      signal: cancellation.signal,
    })).resolves.toMatchObject({
      ok: false,
      code: 'cancelled',
      admissionResult: {
        status: 'rejected',
        code: 'session_input_cancelled',
      },
    });
    expect(machineAdmissionTransport).not.toHaveBeenCalled();
    expect(mocks.resolveSessionTransportContext).not.toHaveBeenCalled();
  });

  it('keeps the E2EE equality tag stable across mutable Session policy and resolved-model drift', async () => {
    mocks.resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'session-1',
      mode: 'e2ee',
      ctx: { encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'legacy' },
      accountEncryptionCurrentness: { mode: 'e2ee' },
      rawSession: { id: 'session-1', active: true, archivedAt: null },
    });
    mocks.tryDecryptSessionOwnerMetadataView
      .mockReturnValueOnce({
        permissionMode: 'default',
        sessionCreationCorrespondenceV1: {
          v: 1,
          sessionCreationTag: deriveSessionCreationTagV1({
            callerCreationNamespace: 'user',
            creationKey: 'machine-admission-test',
          }),
          recipe: {
            execution: { machineId: 'target-machine', directory: '/workspace' },
            organization: { folderId: null, tagIds: [] },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            modelSelection: null,
            profileId: null,
            requestedPermissionMode: null,
            agentModeId: null,
            configuration: null,
            connectedServices: null,
            mcpSelection: null,
            transcriptStorage: null,
            terminal: null,
            agentSessionStartupInstructionsMarkerV1: null,
            checkout: null,
          },
        },
      })
      .mockReturnValueOnce({
        permissionMode: 'yolo',
        sessionCreationCorrespondenceV1: {
          v: 1,
          sessionCreationTag: deriveSessionCreationTagV1({
            callerCreationNamespace: 'user',
            creationKey: 'machine-admission-test',
          }),
          recipe: {
            execution: { machineId: 'target-machine', directory: '/workspace' },
            organization: { folderId: null, tagIds: [] },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            modelSelection: null,
            profileId: null,
            requestedPermissionMode: null,
            agentModeId: null,
            configuration: null,
            connectedServices: null,
            mcpSelection: null,
            transcriptStorage: null,
            terminal: null,
            agentSessionStartupInstructionsMarkerV1: null,
            checkout: null,
          },
        },
      });
    mocks.resolveSessionMessageModel
      .mockReturnValueOnce({ modelId: 'model-before-policy-change', selection: null })
      .mockReturnValueOnce({ modelId: 'model-after-policy-change', selection: null });
    const machineAdmissionTransport = vi.fn(async (_request: MachineAdmissionRequest) => ({
      status: 'accepted' as const,
      localId: 'plugin-input-v1:policy-drift',
    }));
    const inputAdmission = {
      provenance: {
        v: 1 as const,
        kind: 'pluginSession' as const,
        pluginId: 'example.plugin',
        contributionLocalId: 'send',
        surface: 'background' as const,
        externalActor: { kind: 'human' as const, displayNameSnapshot: 'Ada' },
        contentProvenance: 'forwarded' as const,
      },
      request: {
        v: 1 as const,
        producer: 'pluginSession' as const,
        caller: { kind: 'plugin' as const, pluginId: 'example.plugin', contributionLocalId: 'send' },
        permission: { requestedPermissionCeiling: 'read-only' as const },
      },
    };

    for (let index = 0; index < 2; index += 1) {
      await expect(sendSessionMessage({
        credentials,
        idOrPrefix: 'session-1',
        message: 'same immutable plugin request',
        wait: false,
        timeoutMs: 30_000,
        localId: 'plugin-input-v1:policy-drift',
        inputAdmission,
        machineAdmissionTransport,
      })).resolves.toMatchObject({
        ok: true,
        admissionResult: { status: 'accepted', localId: 'plugin-input-v1:policy-drift' },
      });
    }

    const firstRequest = machineAdmissionTransport.mock.calls[0]?.[0];
    const retryRequest = machineAdmissionTransport.mock.calls[1]?.[0];
    expect(firstRequest?.content).toMatchObject({ t: 'encrypted' });
    expect(retryRequest?.content).toMatchObject({ t: 'encrypted' });
    if (firstRequest?.content.t !== 'encrypted' || retryRequest?.content.t !== 'encrypted') {
      throw new Error('Expected encrypted machine admission requests');
    }
    expect(firstRequest.content.c).not.toBe(retryRequest.content.c);
    expect(firstRequest.requestEqualityEvidenceV1).toEqual(retryRequest.requestEqualityEvidenceV1);
  });

  it('routes protected E2EE host input through authenticated machine admission instead of publishing a tag on the Account route', async () => {
    mocks.resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'session-1',
      mode: 'e2ee',
      ctx: { encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'legacy' },
      accountEncryptionCurrentness: { mode: 'e2ee' },
      rawSession: { id: 'session-1', active: true, archivedAt: null },
    });
    let admissionAttempt = 0;
    const machineAdmissionTransport = vi.fn(async (request: MachineAdmissionRequest) => ({
      status: admissionAttempt++ === 0
        ? 'accepted' as const
        : 'alreadyAccepted' as const,
      localId: request.localId,
    }));

    const uiSend = {
      credentials,
      idOrPrefix: 'session-1',
      message: 'host-owned protected prompt',
      wait: false,
      timeoutMs: 30_000,
      localId: 'ui-input-e2ee-1',
      requestedAction: { v: 1, kind: 'enqueue' },
      inputAdmission: {
        provenance: { v: 1, kind: 'host', producer: 'happierApp' },
        request: {
          v: 1,
          producer: 'happierApp',
          caller: { kind: 'host' },
          permission: {},
        },
      },
      machineAdmissionTransport,
    } as const;

    await expect(sendSessionMessage(uiSend)).resolves.toMatchObject({
      ok: true,
      localId: 'ui-input-e2ee-1',
      admissionResult: { status: 'accepted', localId: 'ui-input-e2ee-1' },
    });
    await expect(sendSessionMessage(uiSend)).resolves.toMatchObject({
      ok: true,
      localId: 'ui-input-e2ee-1',
      admissionResult: { status: 'alreadyAccepted', localId: 'ui-input-e2ee-1' },
    });

    expect(machineAdmissionTransport).toHaveBeenCalledWith(expect.objectContaining({
      localId: 'ui-input-e2ee-1',
      requestEqualityEvidenceV1: {
        kind: 'e2eeTag',
        tag: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      },
    }));
    expect(machineAdmissionTransport).toHaveBeenCalledTimes(2);
    expect(mocks.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
  });

  it('resumes an inactive E2EE Session only when ambiguous machine admission confirms exact Pending custody', async () => {
    setInactiveE2eeSession();
    const localId = 'ui-input-e2ee-pending';
    mocks.listPendingQueueV2DeliveryStatusesFromServer.mockResolvedValue([
      { localId, status: 'queued' },
    ]);
    const machineAdmissionTransport = vi.fn(async () => ({
      status: 'alreadyAccepted' as const,
      localId,
    }));

    const result = await sendSessionMessage({
      ...protectedHostSendParams(localId),
      machineAdmissionTransport,
    });

    expect(result).toMatchObject({
      ok: true,
      localId,
      admissionResult: { status: 'alreadyAccepted', localId },
    });
    expect(result).not.toHaveProperty('terminal');
    expect(mocks.listPendingQueueV2DeliveryStatusesFromServer).toHaveBeenCalledWith({
      token: 'token',
      sessionId: 'session-1',
    });
    expect(mocks.requestInactiveSessionResume).toHaveBeenCalledOnce();
  });

  it('does not resume an inactive E2EE Session when ambiguous machine admission has no exact Pending row', async () => {
    setInactiveE2eeSession();
    const localId = 'ui-input-e2ee-terminal';
    mocks.listPendingQueueV2DeliveryStatusesFromServer.mockResolvedValue([]);
    const machineAdmissionTransport = vi.fn(async () => ({
      status: 'alreadyAccepted' as const,
      localId,
    }));

    const result = await sendSessionMessage({
      ...protectedHostSendParams(localId),
      machineAdmissionTransport,
    });

    expect(result).toMatchObject({
      ok: true,
      localId,
      terminal: true,
      admissionResult: { status: 'alreadyAccepted', localId },
    });
    expect(mocks.requestInactiveSessionResume).not.toHaveBeenCalled();
  });

  it('fails closed when ambiguous machine admission cannot read exact Pending custody', async () => {
    setInactiveE2eeSession();
    const localId = 'ui-input-e2ee-custody-unknown';
    mocks.listPendingQueueV2DeliveryStatusesFromServer.mockRejectedValue(new Error('pending status unavailable'));
    const machineAdmissionTransport = vi.fn(async () => ({
      status: 'alreadyAccepted' as const,
      localId,
    }));

    const result = await sendSessionMessage({
      ...protectedHostSendParams(localId),
      machineAdmissionTransport,
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'timeout',
      admissionResult: { status: 'outcomeUnknown', localId },
    });
    expect(mocks.requestInactiveSessionResume).not.toHaveBeenCalled();
  });

  it('binds the E2EE equality tag to the durable local identity', async () => {
    mocks.resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'session-1',
      mode: 'e2ee',
      ctx: { encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'legacy' },
      accountEncryptionCurrentness: { mode: 'e2ee' },
      rawSession: { id: 'session-1', active: true, archivedAt: null },
    });
    const machineAdmissionTransport = vi.fn(async (request: MachineAdmissionRequest) => ({
      status: 'accepted' as const,
      localId: request.localId,
    }));
    const inputAdmission = {
      provenance: {
        v: 1 as const,
        kind: 'pluginSession' as const,
        pluginId: 'example.plugin',
        contributionLocalId: 'send',
        surface: 'background' as const,
        externalActor: { kind: 'human' as const, displayNameSnapshot: 'Ada' },
        contentProvenance: 'forwarded' as const,
      },
      request: {
        v: 1 as const,
        producer: 'pluginSession' as const,
        caller: { kind: 'plugin' as const, pluginId: 'example.plugin', contributionLocalId: 'send' },
        permission: { requestedPermissionCeiling: 'read-only' as const },
      },
    };

    await sendSessionMessage({
      credentials,
      idOrPrefix: 'session-1',
      message: 'same plugin prompt',
      messageMeta: { displayText: 'same display', callerMeta: 'same' },
      wait: false,
      timeoutMs: 30_000,
      localId: 'plugin-input-v1:first',
      requestedAction: { v: 1, kind: 'enqueue' },
      inputAdmission,
      machineAdmissionTransport,
    });
    await sendSessionMessage({
      credentials,
      idOrPrefix: 'session-1',
      message: 'same plugin prompt',
      messageMeta: { displayText: 'same display', callerMeta: 'same' },
      wait: false,
      timeoutMs: 30_000,
      localId: 'plugin-input-v1:second',
      requestedAction: { v: 1, kind: 'enqueue' },
      inputAdmission,
      machineAdmissionTransport,
    });

    const first = machineAdmissionTransport.mock.calls[0]?.[0];
    const second = machineAdmissionTransport.mock.calls[1]?.[0];
    expect(first?.requestEqualityEvidenceV1).not.toEqual(second?.requestEqualityEvidenceV1);
  });

  it('binds the E2EE equality tag to immutable caller presentation metadata', async () => {
    mocks.resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'session-1',
      mode: 'e2ee',
      ctx: { encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'legacy' },
      accountEncryptionCurrentness: { mode: 'e2ee' },
      rawSession: { id: 'session-1', active: true, archivedAt: null },
    });
    const machineAdmissionTransport = vi.fn(async (request: MachineAdmissionRequest) => ({
      status: 'accepted' as const,
      localId: request.localId,
    }));
    const inputAdmission = {
      provenance: {
        v: 1 as const,
        kind: 'pluginSession' as const,
        pluginId: 'example.plugin',
        contributionLocalId: 'send',
        surface: 'background' as const,
        externalActor: { kind: 'human' as const, displayNameSnapshot: 'Ada' },
        contentProvenance: 'forwarded' as const,
      },
      request: {
        v: 1 as const,
        producer: 'pluginSession' as const,
        caller: { kind: 'plugin' as const, pluginId: 'example.plugin', contributionLocalId: 'send' },
        permission: { requestedPermissionCeiling: 'read-only' as const },
      },
    };

    await sendSessionMessage({
      credentials,
      idOrPrefix: 'session-1',
      message: 'same plugin prompt',
      messageMeta: { displayText: 'first display', callerMeta: 'first' },
      wait: false,
      timeoutMs: 30_000,
      localId: 'plugin-input-v1:same',
      requestedAction: { v: 1, kind: 'enqueue' },
      inputAdmission,
      machineAdmissionTransport,
    });
    await sendSessionMessage({
      credentials,
      idOrPrefix: 'session-1',
      message: 'same plugin prompt',
      messageMeta: { displayText: 'second display', callerMeta: 'second' },
      wait: false,
      timeoutMs: 30_000,
      localId: 'plugin-input-v1:same',
      requestedAction: { v: 1, kind: 'enqueue' },
      inputAdmission,
      machineAdmissionTransport,
    });

    const first = machineAdmissionTransport.mock.calls[0]?.[0];
    const second = machineAdmissionTransport.mock.calls[1]?.[0];
    expect(first?.requestEqualityEvidenceV1).not.toEqual(second?.requestEqualityEvidenceV1);
  });

  it('rejoins a plain protected request across target policy and model-default drift', async () => {
    mocks.tryDecryptSessionOwnerMetadataView
      .mockReturnValueOnce({
        permissionMode: 'default',
        sessionCreationCorrespondenceV1: {
          v: 1,
          sessionCreationTag: deriveSessionCreationTagV1({
            callerCreationNamespace: 'user',
            creationKey: 'machine-admission-plain-drift',
          }),
          recipe: {
            execution: { machineId: 'target-machine', directory: '/workspace' },
            organization: { folderId: null, tagIds: [] },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            modelSelection: null,
            profileId: null,
            requestedPermissionMode: null,
            agentModeId: null,
            configuration: null,
            connectedServices: null,
            mcpSelection: null,
            transcriptStorage: null,
            terminal: null,
            agentSessionStartupInstructionsMarkerV1: null,
            checkout: null,
          },
        },
      })
      .mockReturnValueOnce({
        permissionMode: 'yolo',
        sessionCreationCorrespondenceV1: {
          v: 1,
          sessionCreationTag: deriveSessionCreationTagV1({
            callerCreationNamespace: 'user',
            creationKey: 'machine-admission-plain-drift',
          }),
          recipe: {
            execution: { machineId: 'target-machine', directory: '/workspace' },
            organization: { folderId: null, tagIds: [] },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            modelSelection: null,
            profileId: null,
            requestedPermissionMode: null,
            agentModeId: null,
            configuration: null,
            connectedServices: null,
            mcpSelection: null,
            transcriptStorage: null,
            terminal: null,
            agentSessionStartupInstructionsMarkerV1: null,
            checkout: null,
          },
        },
      });
    mocks.resolveSessionMessageModel
      .mockReturnValueOnce({ modelId: 'model-before-policy-change', selection: null })
      .mockReturnValueOnce({ modelId: 'model-after-policy-change', selection: null });

    let admittedRequest: MachineAdmissionRequest | null = null;
    const machineAdmissionTransport = vi.fn(async (request: MachineAdmissionRequest) => {
      if (admittedRequest === null) {
        admittedRequest = request;
        return { status: 'accepted' as const, localId: 'plugin-input-v1:plain-policy-drift' };
      }
      expect(request).toEqual(admittedRequest);
      return { status: 'alreadyAccepted' as const, localId: 'plugin-input-v1:plain-policy-drift' };
    });
    const inputAdmission = {
      provenance: {
        v: 1 as const,
        kind: 'pluginSession' as const,
        pluginId: 'example.plugin',
        contributionLocalId: 'send',
        surface: 'background' as const,
        externalActor: { kind: 'human' as const, displayNameSnapshot: 'Ada' },
        contentProvenance: 'forwarded' as const,
      },
      request: {
        v: 1 as const,
        producer: 'pluginSession' as const,
        caller: { kind: 'plugin' as const, pluginId: 'example.plugin', contributionLocalId: 'send' },
        permission: { requestedPermissionCeiling: 'read-only' as const },
      },
    };

    for (let index = 0; index < 2; index += 1) {
      await expect(sendSessionMessage({
        credentials,
        idOrPrefix: 'session-1',
        message: 'same immutable plugin request',
        wait: false,
        timeoutMs: 30_000,
        localId: 'plugin-input-v1:plain-policy-drift',
        requestedAction: { v: 1, kind: 'enqueue' },
        inputAdmission,
        machineAdmissionTransport,
      })).resolves.toMatchObject({
        ok: true,
        admissionResult: {
          status: index === 0 ? 'accepted' : 'alreadyAccepted',
          localId: 'plugin-input-v1:plain-policy-drift',
        },
      });
    }

    const capturedRequest = requireMachineAdmissionRequest(admittedRequest);
    expect(capturedRequest.requestedAction).toEqual({ v: 1, kind: 'enqueue' });
    expect(capturedRequest.content).toMatchObject({
      t: 'plain',
      v: {
        meta: {
          happierProvenanceV1: inputAdmission.provenance,
          happierInputRequestV1: inputAdmission.request,
        },
      },
    });
    if (capturedRequest.content.t !== 'plain') {
      throw new Error('Expected a plain machine admission request');
    }
    expect(capturedRequest.content.v).not.toHaveProperty('meta.permissionMode');
    expect(capturedRequest.content.v).not.toHaveProperty('meta.model');
    expect(capturedRequest.content.v).not.toHaveProperty('meta.modelSelectionV1');
    expect(mocks.resolveSessionMessageModel).not.toHaveBeenCalled();
  });

  it('fails closed when protected input has no authenticated machine transport', async () => {
    await expect(sendSessionMessage({
      credentials,
      idOrPrefix: 'session-1',
      message: 'plugin prompt',
      wait: false,
      timeoutMs: 30_000,
      localId: 'plugin-input-v1:stable',
      inputAdmission: {
        provenance: {
          v: 1,
          kind: 'pluginSession',
          pluginId: 'example.plugin',
          contributionLocalId: 'send',
          surface: 'background',
        },
        request: {
          v: 1,
          producer: 'pluginSession',
          caller: { kind: 'plugin', pluginId: 'example.plugin', contributionLocalId: 'send' },
          permission: {},
        },
      },
    })).resolves.toMatchObject({
      ok: false,
      code: 'admission_rejected',
      admissionResult: {
        status: 'rejected',
        code: 'session_input_target_update_required',
      },
    });
    expect(mocks.enqueuePendingQueueV2MessageViaHttp).not.toHaveBeenCalled();
  });

  it('admits host UI provenance through the Account route without letting caller metadata forge protected facts', async () => {
    mocks.enqueuePendingQueueV2MessageViaHttp.mockResolvedValue({
      didWrite: true,
      terminal: false,
      suppressed: false,
    });
    const machineAdmissionTransport = vi.fn();

    await expect(sendSessionMessage({
      credentials,
      idOrPrefix: 'session-1',
      message: 'human prompt',
      wait: false,
      timeoutMs: 30_000,
      localId: 'ui-input-1',
      requestedAction: { v: 1, kind: 'enqueue' },
      messageMeta: {
        source: 'hostile-source',
        happierProvenanceV1: { v: 1, kind: 'automation', automationId: 'forged', runId: 'forged' },
        happierInputRequestV1: { v: 1, producer: 'automation', caller: { kind: 'host' }, automation: { automationId: 'forged', runId: 'forged' }, permission: {} },
      },
      inputAdmission: {
        provenance: { v: 1, kind: 'host', producer: 'happierApp' },
        request: {
          v: 1,
          producer: 'happierApp',
          caller: { kind: 'host' },
          permission: {},
        },
      },
      machineAdmissionTransport,
    })).resolves.toMatchObject({ ok: true, localId: 'ui-input-1' });

    expect(mocks.enqueuePendingQueueV2MessageViaHttp).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      body: expect.objectContaining({
        localId: 'ui-input-1',
        requestedAction: { v: 1, kind: 'enqueue' },
        content: {
          t: 'plain',
          v: expect.objectContaining({
            meta: expect.objectContaining({
              source: 'ui',
              happierProvenanceV1: { v: 1, kind: 'host', producer: 'happierApp' },
              happierInputRequestV1: expect.objectContaining({ producer: 'happierApp' }),
            }),
          }),
        },
      }),
    }));
    expect(machineAdmissionTransport).not.toHaveBeenCalled();
  });

  it('reports malformed Account admission acknowledgement certainty as outcome unknown', async () => {
    mocks.enqueuePendingQueueV2MessageViaHttp.mockResolvedValue({
      didWrite: null,
      terminal: false,
      suppressed: false,
    });

    await expect(sendSessionMessage(
      protectedHostSendParams('ui-input-malformed-ack'),
    )).resolves.toMatchObject({
      ok: false,
      code: 'timeout',
      admissionResult: {
        status: 'outcomeUnknown',
        localId: 'ui-input-malformed-ack',
        code: 'account_admission_result_malformed',
      },
    });
  });

  it('reports an Account HTTP 5xx after request dispatch as outcome unknown', async () => {
    mocks.enqueuePendingQueueV2MessageViaHttp.mockRejectedValue({
      response: { status: 500, data: { error: 'publication-failed' } },
    });

    await expect(sendSessionMessage(
      protectedHostSendParams('ui-input-post-commit-500'),
    )).resolves.toMatchObject({
      ok: false,
      code: 'timeout',
      admissionResult: {
        status: 'outcomeUnknown',
        localId: 'ui-input-post-commit-500',
        code: 'account_admission_acknowledgement_failed',
      },
    });
  });

  it.each([
    {
      status: 400,
      data: { error: 'invalid-params', code: 'session_input_encryption_mode_mismatch' },
      code: 'session_input_encryption_mode_mismatch',
    },
    { status: 403, data: { error: 'forbidden' }, code: 'session_input_unauthorized' },
    { status: 404, data: { error: 'session-not-found' }, code: 'session_input_target_unavailable' },
  ] as const)(
    'preserves owner-proven HTTP $status pre-write rejection certainty',
    async ({ status, data, code }) => {
      mocks.enqueuePendingQueueV2MessageViaHttp.mockRejectedValue({ response: { status, data } });

      await expect(sendSessionMessage(
        protectedHostSendParams(`ui-input-http-${status}`),
      )).resolves.toMatchObject({
        ok: false,
        code: 'admission_rejected',
        admissionResult: { status: 'rejected', code },
      });
    },
  );

  it('preserves the supported predecessor exact requested-action conflict as a definite rejection', async () => {
    mocks.enqueuePendingQueueV2MessageViaHttp.mockRejectedValue({
      response: { status: 409, data: { error: 'requested-action-conflict' } },
    });

    await expect(sendSessionMessage(
      protectedHostSendParams('ui-input-requested-action-conflict'),
    )).resolves.toMatchObject({
      ok: false,
      code: 'admission_rejected',
      admissionResult: {
        status: 'rejected',
        code: 'session_input_idempotency_conflict',
      },
    });
  });

  it.each([
    { error: 'another-conflict' },
    { error: 'requested-action-conflict', detail: 'not-the-supported-exact-shape' },
  ])('keeps non-exact HTTP 409 responses outcome unknown', async (data) => {
    mocks.enqueuePendingQueueV2MessageViaHttp.mockRejectedValue({
      response: { status: 409, data },
    });

    await expect(sendSessionMessage(
      protectedHostSendParams('ui-input-ambiguous-409'),
    )).resolves.toMatchObject({
      ok: false,
      code: 'timeout',
      admissionResult: {
        status: 'outcomeUnknown',
        localId: 'ui-input-ambiguous-409',
      },
    });
  });
});
