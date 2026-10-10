import { createJiti } from 'jiti';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSessionRuntime, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { createNativeAgentSessionPublications } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';

import { createTestApiSessionClient } from '@/testkit/backends/createTestApiSessionClient';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';
import { decodeBase64, decrypt } from '@/api/encryption';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { SocketAckError } from '@/session/transport/shared/socketAck';
import { PendingQueueAcceptedSettlementError } from './pendingQueueV2Transport';
import {
  ApiSessionClient,
  type ApiSessionClientOptions,
} from './sessionClient';

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;
const resolveAcceptedMock = vi.hoisted(() => vi.fn());
const resolveAcceptedExecutionRunMock = vi.hoisted(() => vi.fn());
const blockDeliveryMock = vi.hoisted(() => vi.fn());
const listDeliveryStatusesMock = vi.hoisted(() => vi.fn());
const sendSessionMessageMock = vi.hoisted(() => vi.fn());

vi.mock('@/session/services/sendSessionMessage', () => ({
  sendSessionMessage: sendSessionMessageMock,
}));

vi.mock('./sockets', () => ({
  createUserScopedSocket: () => {
    if (!userSocketStub) throw new Error('Missing user socket stub');
    return userSocketStub as any;
  },
}));

vi.mock('./connection/createSessionSocketTransport', () => ({
  createSessionSocketTransport: () => {
    if (!sessionSocketStub) throw new Error('Missing session socket stub');
    return {
      socket: sessionSocketStub as any,
      transport: {
        connect: async () => {},
        disconnect: async () => {},
        destroy: async () => {},
        isConnected: () => sessionSocketStub?.connected === true,
        onConnected: () => () => {},
        onDisconnected: () => () => {},
        onError: () => () => {},
      },
    };
  },
}));

vi.mock('@happier-dev/connection-supervisor', () => ({
  DEFAULT_MANAGED_CONNECTION_POLICY: {},
  createManagedConnectionSupervisor: (params: { createTransport: () => unknown; onConnected?: () => Promise<void> | void }) => ({
    start: async () => {
      params.createTransport();
      await params.onConnected?.();
    },
    stop: async () => {},
  }),
}));

vi.mock('./pendingQueueV2Transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pendingQueueV2Transport')>();
  return {
    ...actual,
    resolveAcceptedPendingQueueV2Delivery: resolveAcceptedMock,
    resolveAcceptedPendingExecutionRunDelivery: resolveAcceptedExecutionRunMock,
    blockPendingQueueV2Delivery: blockDeliveryMock,
    listPendingQueueV2DeliveryStatusesFromServer: listDeliveryStatusesMock,
  };
});

function createTranscriptLookupHttpError(params: {
  message: string;
  status?: number;
  data?: unknown;
  code?: string;
}): Error {
  return Object.assign(new Error(params.message), {
    isAxiosError: true,
    ...(params.status !== undefined ? { response: { status: params.status, data: params.data } } : {}),
    ...(params.code ? { code: params.code } : {}),
  });
}

function markMaterializedProviderInput(client: ApiSessionClient, localId: string): void {
  const fixture = client as unknown as {
    materializationRuntime: { markPendingQueueMaterializedLocalId(inputId: string): void };
  };
  fixture.materializationRuntime.markPendingQueueMaterializedLocalId(localId);
}

// Load the real plugin boundary during collection so source transforms do not consume the behavior deadline.
const loader = createJiti(import.meta.url, { fsCache: false, moduleCache: true, interopDefault: false });
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/plugins/claude/src/agent/runtime');
const fixtures = await loader.import(`${pluginRoot}/engine.testkit.ts`) as {
  createTerminalHostFixture(): { service: { injectUserPrompt: ReturnType<typeof vi.fn> } };
  createEventsFixture(): { service: unknown };
  createPluginContextFixture(terminal: unknown, events: unknown): unknown;
};
const leaf = await loader.import(`${pluginRoot}/terminal/unified/turnOperations.ts`) as {
  createClaudeUnifiedTerminalTurnOperations(params: unknown): { observeTerminalLifecycle(event: unknown): Promise<void>; isTurnInFlight(): boolean };
};
const native = await loader.import(`${pluginRoot}/nativeRuntime.ts`) as {
  createClaudeNativeSessionRuntimeFromOperations(operations: unknown, request: unknown, context: unknown): AgentSessionRuntime;
};

describe('ApiSessionClient provider-input settlement', () => {
  beforeEach(() => {
    // HTTP is the real rejoin boundary: these fixtures start with no persisted copy of their input.
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v2/sessions/s1/pending') return { data: { pending: [] } };
      if (path.startsWith('/v2/sessions/s1/messages/by-local-id/')) {
        throw createTranscriptLookupHttpError({ message: 'Message not found', status: 404, data: { error: 'Message not found' } });
      }
      throw new Error(`Unexpected HTTP GET in provider-input settlement fixture: ${path}`);
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resolveAcceptedMock.mockReset();
    resolveAcceptedExecutionRunMock.mockReset();
    blockDeliveryMock.mockReset();
    listDeliveryStatusesMock.mockReset();
    sendSessionMessageMock.mockReset();
  });

  it('branches on the exact protected admission result instead of a generic send code', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    sendSessionMessageMock.mockResolvedValueOnce({
      ok: false,
      code: 'timeout',
      admissionResult: {
        status: 'outcomeUnknown',
        localId: 'runtime-first-input',
        code: 'machine_admission_acknowledgement_failed',
      },
    });
    const credentials = { token: 'tok', encryption: null };
    const client = createTestApiSessionClient(ApiSessionClient,
      'tok',
      createPlainSessionFixture({ id: 's1' }),
      { metadataAuthority: { kind: 'owner', credentials } },
    );

    await expect(client.enqueueSessionUserMessage({
      text: 'Hello',
      localId: 'runtime-first-input',
    })).rejects.toThrow(
      'Session user input admission outcomeUnknown: machine_admission_acknowledgement_failed',
    );
  });

  it('preserves a conditional-steer request through canonical Session admission', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const localId = 'generated-completion-1';
    sendSessionMessageMock.mockResolvedValueOnce({
      admissionResult: { status: 'accepted', localId, code: 'accepted' },
    });
    const client = createTestApiSessionClient(ApiSessionClient,
      'tok',
      createPlainSessionFixture({ id: 's1' }),
      { metadataAuthority: { kind: 'owner', credentials: { token: 'tok', encryption: null } } },
    );

    await client.enqueueSessionUserMessage({
      text: 'Execution run run_1 succeeded.',
      localId,
      requestedAction: { v: 1, kind: 'steer_if_active' },
    });

    expect(sendSessionMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      localId,
      requestedAction: { v: 1, kind: 'steer_if_active' },
    }));
    await client.close();
  });

  it('notifies prepared Composer attachments after durable admission and on an exact already-accepted retry, never from terminal settlement', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const localId = 'composer-accepted-local-1';
    const firstAttachment = {
      v: 1 as const,
      instanceId: 'review-instance-1',
      attachment: { pluginId: 'acme.review-comments', localId: 'review-comment' },
      key: 'review-42',
      value: { reviewId: '42' },
      presentation: { label: 'Review #42', typeLabel: 'Review comment' },
    };
    const secondAttachment = {
      ...firstAttachment,
      instanceId: 'review-instance-2',
      key: 'review-43',
      value: { reviewId: '43' },
    };
    const afterComposerAttachmentMessageAccepted = vi.fn<NonNullable<
      ApiSessionClientOptions['afterComposerAttachmentMessageAccepted']
    >>(async () => {
      throw new Error('post-admission target unavailable');
    });
    const machineAdmissionTransport = vi.fn(async () => ({
      status: 'accepted' as const,
      localId,
    }));
    const admissionOrder: string[] = [];
    sendSessionMessageMock
      .mockImplementationOnce(async () => {
        admissionOrder.push('durable:accepted');
        return {
          admissionResult: { status: 'accepted', localId, code: 'accepted' },
        };
      })
      .mockImplementationOnce(async () => {
        admissionOrder.push('durable:alreadyAccepted');
        return {
          admissionResult: { status: 'alreadyAccepted', localId, code: 'already_accepted' },
        };
      });
    const client = createTestApiSessionClient(ApiSessionClient,
      'tok',
      createPlainSessionFixture({ id: 's1' }),
      {
        metadataAuthority: { kind: 'owner', credentials: { token: 'tok', encryption: null } },
        transformSessionInputBeforeCommit: async (payload) => ({
          ...payload,
          preparedComposerAttachments: (payload.meta as {
            happierStructuredInputV1: { composerAttachments: unknown[] };
          }).happierStructuredInputV1.composerAttachments,
        }),
        afterComposerAttachmentMessageAccepted: async (input) => {
          admissionOrder.push('after');
          await afterComposerAttachmentMessageAccepted(input);
        },
        // RED seam: the runner must supply its authenticated daemon-backed
        // machine admission transport to the Session client.
        machineAdmissionTransport,
      },
    );
    const request = {
      text: '',
      localId,
      meta: {
        happierStructuredInputV1: {
          v: 1 as const,
          composerAttachments: [firstAttachment, secondAttachment],
        },
      },
    };

    await expect(client.enqueueSessionUserMessage(request)).resolves.toBeUndefined();

    expect(sendSessionMessageMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      machineAdmissionTransport,
      signal: expect.any(AbortSignal),
    }));
    expect(admissionOrder).toEqual(['durable:accepted', 'after']);
    expect(afterComposerAttachmentMessageAccepted).toHaveBeenCalledOnce();
    expect(afterComposerAttachmentMessageAccepted).toHaveBeenCalledWith({
      attachment: { pluginId: 'acme.review-comments', localId: 'review-comment' },
      event: {
        sessionId: 's1',
        localId,
        attachments: [
          { instanceId: 'review-instance-1', key: 'review-42', value: { reviewId: '42' } },
          { instanceId: 'review-instance-2', key: 'review-43', value: { reviewId: '43' } },
        ],
      },
      signal: expect.any(AbortSignal),
    });
    expect(afterComposerAttachmentMessageAccepted.mock.calls[0]?.[0]?.event)
      .not.toHaveProperty('messageId');
    const firstNotification = afterComposerAttachmentMessageAccepted.mock.calls[0]?.[0];
    expect(firstNotification?.signal.aborted).toBe(false);

    await expect(client.observeProviderInputSettlement({
      kind: 'accepted',
      localId,
      userMessageSeq: 5,
    })).resolves.toBe(false);
    expect(afterComposerAttachmentMessageAccepted).toHaveBeenCalledOnce();

    await expect(client.enqueueSessionUserMessage(request)).resolves.toBeUndefined();
    expect(sendSessionMessageMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      machineAdmissionTransport,
      signal: expect.any(AbortSignal),
    }));
    expect(admissionOrder).toEqual([
      'durable:accepted',
      'after',
      'durable:alreadyAccepted',
      'after',
    ]);
    expect(afterComposerAttachmentMessageAccepted).toHaveBeenCalledTimes(2);

    await client.close();
    expect(firstNotification?.signal.aborted).toBe(true);
  });

  it('starts the acceptance notification without waiting for staged-media settlement', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const localId = 'composer-accepted-before-settlement';
    const attachment = {
      v: 1 as const,
      instanceId: 'media-instance-1',
      attachment: { pluginId: 'com.example.media', localId: 'composer' },
      key: 'media-1',
      value: { media: 'review' },
      presentation: { label: 'Review image', typeLabel: 'Review media' },
    };
    const order: string[] = [];
    let releaseSettlement: (() => void) | undefined;
    const settlementReached = new Promise<void>((resolve) => {
      releaseSettlement = resolve;
    });
    // Staged-media settlement is a daemon round trip whose default budget is
    // 300s. The best-effort acceptance notification contractually FOLLOWS
    // durable acceptance, not settlement, so it must not be serialized behind it.
    const onAccepted = vi.fn(async () => {
      order.push('settlement:start');
      await settlementReached;
      order.push('settlement:end');
    });
    const afterComposerAttachmentMessageAccepted = vi.fn(async () => {
      order.push('notify');
      releaseSettlement?.();
    });
    sendSessionMessageMock.mockResolvedValueOnce({
      admissionResult: { status: 'accepted', localId, code: 'accepted' },
    });
    const client = createTestApiSessionClient(ApiSessionClient,
      'tok',
      createPlainSessionFixture({ id: 's1' }),
      {
        metadataAuthority: { kind: 'owner', credentials: { token: 'tok', encryption: null } },
        transformSessionInputBeforeCommit: async (payload) => ({
          transformed: {
            ...payload,
            preparedComposerAttachments: (payload.meta as {
              happierStructuredInputV1: { composerAttachments: unknown[] };
            }).happierStructuredInputV1.composerAttachments,
          },
          settlement: { onAccepted, onDefinitiveAdmissionFailure: vi.fn(async () => undefined) },
        }),
        afterComposerAttachmentMessageAccepted,
      },
    );

    await expect(client.enqueueSessionUserMessage({
      text: '',
      localId,
      meta: {
        happierStructuredInputV1: { v: 1, composerAttachments: [attachment] },
      },
    })).resolves.toBeUndefined();

    expect(afterComposerAttachmentMessageAccepted).toHaveBeenCalledOnce();
    expect(order).toEqual(['notify', 'settlement:start', 'settlement:end']);
    await client.close();
  });

  it('returns accepted without waiting for staged-media release settlement', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const localId = 'composer-accepted-independent-of-settlement';
    let releaseSettlement: (() => void) | undefined;
    const settlementBlocked = new Promise<void>((resolve) => {
      releaseSettlement = resolve;
    });
    const onAccepted = vi.fn(async () => await settlementBlocked);
    sendSessionMessageMock.mockResolvedValueOnce({
      admissionResult: { status: 'accepted', localId, code: 'accepted' },
    });
    const client = createTestApiSessionClient(ApiSessionClient,
      'tok',
      createPlainSessionFixture({ id: 's1' }),
      {
        metadataAuthority: { kind: 'owner', credentials: { token: 'tok', encryption: null } },
        transformSessionInputBeforeCommit: async (payload) => ({
          transformed: payload,
          settlement: {
            onAccepted,
            onDefinitiveAdmissionFailure: vi.fn(async () => undefined),
          },
        }),
      },
    );

    const enqueue = client.enqueueSessionUserMessage({
      text: 'Message with staged media',
      localId,
    });
    await vi.waitFor(() => expect(onAccepted).toHaveBeenCalledOnce());
    await expect(Promise.race([
      enqueue.then(() => 'accepted' as const),
      new Promise<'timedOut'>((resolve) => setTimeout(() => resolve('timedOut'), 100)),
    ])).resolves.toBe('accepted');

    releaseSettlement?.();
    await client.close();
  });

  it('does not notify a Composer attachment target when durable admission is unknown', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const localId = 'composer-unknown-admission-local-1';
    const afterComposerAttachmentMessageAccepted = vi.fn(async () => undefined);
    sendSessionMessageMock.mockResolvedValueOnce({
      admissionResult: {
        status: 'outcomeUnknown',
        localId,
        code: 'machine_admission_acknowledgement_failed',
      },
    });
    const client = createTestApiSessionClient(ApiSessionClient,
      'tok',
      createPlainSessionFixture({ id: 's1' }),
      {
        metadataAuthority: { kind: 'owner', credentials: { token: 'tok', encryption: null } },
        transformSessionInputBeforeCommit: async (payload) => ({
          ...payload,
          preparedComposerAttachments: (payload.meta as {
            happierStructuredInputV1: { composerAttachments: unknown[] };
          }).happierStructuredInputV1.composerAttachments,
        }),
        afterComposerAttachmentMessageAccepted,
      },
    );

    await expect(client.enqueueSessionUserMessage({
      text: '',
      localId,
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [{
            v: 1,
            instanceId: 'review-instance-1',
            attachment: { pluginId: 'acme.review-comments', localId: 'review-comment' },
            key: 'review-42',
            value: { reviewId: '42' },
            presentation: { label: 'Review #42', typeLabel: 'Review comment' },
          }],
        },
      },
    })).rejects.toThrow(
      'Session user input admission outcomeUnknown: machine_admission_acknowledgement_failed',
    );
    expect(afterComposerAttachmentMessageAccepted).not.toHaveBeenCalled();

    await client.close();
  });

  it.each([
    { status: 'accepted' as const, code: 'accepted' as const },
    { status: 'alreadyAccepted' as const, code: 'already_accepted' as const },
  ])('settles staged-media custody only for known Composer $status admission', async ({ status, code }) => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const attachment = {
      v: 1 as const,
      instanceId: 'media-instance-1',
      attachment: { pluginId: 'com.example.media', localId: 'composer' },
      key: 'media-1',
      value: { media: 'review' },
      presentation: { label: 'Review image', typeLabel: 'Review media' },
    };
    const onAccepted = vi.fn(async () => undefined);
    const onDefinitiveAdmissionFailure = vi.fn(async () => undefined);
    const localId = 'staged-media-local-1';
    sendSessionMessageMock.mockResolvedValueOnce({
      admissionResult: { status, localId, code },
    });
    const client = createTestApiSessionClient(ApiSessionClient,
      'tok',
      createPlainSessionFixture({ id: 's1' }),
      {
        metadataAuthority: { kind: 'owner', credentials: { token: 'tok', encryption: null } },
        transformSessionInputBeforeCommit: async (payload) => ({
          transformed: {
            ...payload,
            preparedComposerAttachments: (payload.meta as {
              happierStructuredInputV1: { composerAttachments: unknown[] };
            }).happierStructuredInputV1.composerAttachments,
          },
          settlement: { onAccepted, onDefinitiveAdmissionFailure },
        }),
      },
    );

    await expect(client.enqueueSessionUserMessage({
      text: '',
      localId,
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [attachment],
        },
      },
    })).resolves.toBeUndefined();

    expect(onAccepted).toHaveBeenCalledOnce();
    expect(onDefinitiveAdmissionFailure).not.toHaveBeenCalled();
    await client.close();
  });

  it('keeps staged-media settlement inert when Composer admission is outcome-unknown', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const localId = 'staged-media-unknown-local-1';
    const onAccepted = vi.fn(async () => undefined);
    const onDefinitiveAdmissionFailure = vi.fn(async () => undefined);
    sendSessionMessageMock.mockResolvedValueOnce({
      admissionResult: {
        status: 'outcomeUnknown',
        localId,
        code: 'machine_admission_acknowledgement_failed',
      },
    });
    const client = createTestApiSessionClient(ApiSessionClient,
      'tok',
      createPlainSessionFixture({ id: 's1' }),
      {
        metadataAuthority: { kind: 'owner', credentials: { token: 'tok', encryption: null } },
        transformSessionInputBeforeCommit: async (payload) => ({
          transformed: {
            ...payload,
            preparedComposerAttachments: (payload.meta as {
              happierStructuredInputV1: { composerAttachments: unknown[] };
            }).happierStructuredInputV1.composerAttachments,
          },
          settlement: { onAccepted, onDefinitiveAdmissionFailure },
        }),
      },
    );

    await expect(client.enqueueSessionUserMessage({
      text: '',
      localId,
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [{
            v: 1,
            instanceId: 'media-instance-1',
            attachment: { pluginId: 'com.example.media', localId: 'composer' },
            key: 'media-1',
            value: { media: 'review' },
            presentation: { label: 'Review image', typeLabel: 'Review media' },
          }],
        },
      },
    })).rejects.toThrow(
      'Session user input admission outcomeUnknown: machine_admission_acknowledgement_failed',
    );
    expect(onAccepted).not.toHaveBeenCalled();
    expect(onDefinitiveAdmissionFailure).not.toHaveBeenCalled();
    await client.close();
  });

  it('settles staged-media custody for an explicit rejected Composer admission only', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const localId = 'staged-media-rejected-local-1';
    const onAccepted = vi.fn(async () => undefined);
    const onDefinitiveAdmissionFailure = vi.fn(async () => undefined);
    sendSessionMessageMock.mockResolvedValueOnce({
      admissionResult: { status: 'rejected', code: 'session_input_cancelled' },
    });
    const client = createTestApiSessionClient(ApiSessionClient,
      'tok',
      createPlainSessionFixture({ id: 's1' }),
      {
        metadataAuthority: { kind: 'owner', credentials: { token: 'tok', encryption: null } },
        transformSessionInputBeforeCommit: async (payload) => ({
          transformed: {
            ...payload,
            preparedComposerAttachments: (payload.meta as {
              happierStructuredInputV1: { composerAttachments: unknown[] };
            }).happierStructuredInputV1.composerAttachments,
          },
          settlement: { onAccepted, onDefinitiveAdmissionFailure },
        }),
      },
    );

    await expect(client.enqueueSessionUserMessage({
      text: '',
      localId,
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [{
            v: 1,
            instanceId: 'media-instance-1',
            attachment: { pluginId: 'com.example.media', localId: 'composer' },
            key: 'media-1',
            value: { media: 'review' },
            presentation: { label: 'Review image', typeLabel: 'Review media' },
          }],
        },
      },
    })).rejects.toThrow('Session user input admission rejected: session_input_cancelled');

    expect(onAccepted).not.toHaveBeenCalled();
    expect(onDefinitiveAdmissionFailure).toHaveBeenCalledOnce();
    await client.close();
  });

  it('settles staged-media custody when missing owner credentials make admission definitively impossible', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const onAccepted = vi.fn(async () => undefined);
    const onDefinitiveAdmissionFailure = vi.fn(async () => undefined);
    const client = createTestApiSessionClient(ApiSessionClient,
      'missing-credentials-token-never-stored',
      createPlainSessionFixture({ id: 's1' }),
      {
        metadataAuthority: { kind: 'owner', credentials: { token: 'different-account-token', encryption: null },
          readCurrentCredentials: async () => null },
        transformSessionInputBeforeCommit: async (payload) => ({
          transformed: payload,
          settlement: { onAccepted, onDefinitiveAdmissionFailure },
        }),
      },
    );

    await expect(client.enqueueSessionUserMessage({
      text: 'Message with staged media',
      localId: 'staged-media-missing-credentials',
    })).rejects.toThrow('Current Account credentials are required to admit Session user input');

    expect(sendSessionMessageMock).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
    expect(onDefinitiveAdmissionFailure).toHaveBeenCalledOnce();
    await client.close();
  });

  it('retires only exact absent terminal custody without emitting a provider settlement', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId('manual-handled-local');
    listDeliveryStatusesMock.mockResolvedValueOnce([
      { localId: 'later-local', status: 'queued', deliveryStatus: { status: 'queued' } },
    ]);

    const retired: string[] = [];
    const unsubscribe = client.subscribePendingProviderInputRetirement((localId) => {
      expect(client.hasPendingProviderInput(localId)).toBe(false);
      retired.push(localId);
    });
    await expect(client.reconcilePendingProviderInputCustodyBeforeMaterialization()).resolves.toBe(true);

    expect(retired).toEqual(['manual-handled-local']);
    unsubscribe?.();
    expect(client.hasPendingProviderInput('manual-handled-local')).toBe(false);
    expect(resolveAcceptedMock).not.toHaveBeenCalled();
    expect(blockDeliveryMock).not.toHaveBeenCalled();
  });

  it('keeps provider custody when protected admission removed the Pending row before provider acceptance', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    const localId = 'admitted-before-provider';
    markMaterializedProviderInput(client, localId);
    listDeliveryStatusesMock.mockResolvedValueOnce([]);
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: { message: {
        id: 'admitted-user-message', seq: 42, localId, sidechainId: null,
        createdAt: 100, updatedAt: 101,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'PONG' } } },
      } },
    } as never);
    const retired: string[] = [];
    const unsubscribe = client.subscribePendingProviderInputRetirement((id) => retired.push(id));

    await expect(client.reconcilePendingProviderInputCustodyBeforeMaterialization()).resolves.toBe(false);

    expect(client.hasPendingProviderInput(localId)).toBe(true);
    expect(retired).toEqual([]);
    unsubscribe();
    await client.close();
  });

  it('does not retire provider custody when an absent Pending row cannot be checked against the transcript', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    markMaterializedProviderInput(client, 'lookup-unavailable');
    listDeliveryStatusesMock.mockResolvedValueOnce([]);
    vi.spyOn(axios, 'get').mockRejectedValueOnce(createTranscriptLookupHttpError({
      message: 'connection reset', code: 'ECONNRESET',
    }));

    await expect(client.reconcilePendingProviderInputCustodyBeforeMaterialization()).resolves.toBe(false);
    expect(client.hasPendingProviderInput('lookup-unavailable')).toBe(true);
    await client.close();
  });

  it('reconciles archived uncertain custody again when its exact server row is later removed', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    markMaterializedProviderInput(client, 'archived-local');
    const retired: string[] = [];
    const unsubscribe = client.subscribePendingProviderInputRetirement((localId) => retired.push(localId));
    listDeliveryStatusesMock.mockResolvedValueOnce([{ localId: 'archived-local', status: 'discarded',
      deliveryStatus: { status: 'discarded', reason: 'dismissed_uncertain' } }]);
    await expect(client.reconcilePendingProviderInputCustodyBeforeMaterialization()).resolves.toBe(true);
    expect(client.hasPendingProviderInput('archived-local')).toBe(true);
    expect(retired).toEqual([]);
    listDeliveryStatusesMock.mockResolvedValueOnce([]);
    await client.reconcilePendingProviderInputCustodyBeforeMaterialization();
    expect(client.hasPendingProviderInput('archived-local')).toBe(false);
    expect(retired).toEqual(['archived-local']);
    expect(resolveAcceptedMock).not.toHaveBeenCalled();
    unsubscribe();
    await client.close();
  });

  it('allows manual retirement after an accepted settlement has failed and stopped', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    markMaterializedProviderInput(client, 'failed-acceptance');
    resolveAcceptedMock.mockRejectedValueOnce(new Error('settlement failed'));
    await client.observeProviderInputSettlement({ kind: 'accepted', localId: 'failed-acceptance', userMessageSeq: null });
    expect(client.hasPendingProviderInput('failed-acceptance')).toBe(true);
    const retired: string[] = [];
    const unsubscribe = client.subscribePendingProviderInputRetirement((localId) => retired.push(localId));
    listDeliveryStatusesMock.mockResolvedValueOnce([]);
    await client.reconcilePendingProviderInputCustodyBeforeMaterialization();
    expect(client.hasPendingProviderInput('failed-acceptance')).toBe(false);
    expect(retired).toEqual(['failed-acceptance']);
    expect(client.getCommittedUserMessageSeq('failed-acceptance')).toBeNull();
    unsubscribe();
    await client.close();
  });

  it('preserves accepted settlement that starts while server retirement is being read', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    markMaterializedProviderInput(client, 'accepted-race');
    let finishStatuses!: (statuses: []) => void;
    listDeliveryStatusesMock.mockImplementationOnce(() => new Promise((resolve) => { finishStatuses = resolve; }));
    let finishAcceptance!: (result: unknown) => void;
    resolveAcceptedMock.mockImplementationOnce(() => new Promise((resolve) => { finishAcceptance = resolve; }));
    const retired: string[] = [];
    const unsubscribe = client.subscribePendingProviderInputRetirement((localId) => retired.push(localId));
    const reconciliation = client.reconcilePendingProviderInputCustodyBeforeMaterialization();
    await vi.waitFor(() => expect(finishStatuses).toBeTypeOf('function'));
    const acceptance = client.observeProviderInputSettlement({ kind: 'accepted', localId: 'accepted-race', userMessageSeq: 42 });
    await vi.waitFor(() => expect(finishAcceptance).toBeTypeOf('function'));
    finishStatuses([]);
    await reconciliation;
    expect(retired).toEqual([]);
    expect(client.hasPendingProviderInput('accepted-race')).toBe(true);
    finishAcceptance({ didResolve: true, pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 3 },
      message: { localId: 'accepted-race', seq: 42 } });
    await acceptance;
    expect(client.getCommittedUserMessageSeq('accepted-race')).toBe(42);
    unsubscribe();
    await client.close();
  });

  it('releases the real Claude submission and unstarted host wait after exact server retirement', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    const terminal = fixtures.createTerminalHostFixture();
    const ctx = fixtures.createPluginContextFixture(terminal.service, fixtures.createEventsFixture().service);
    const controller = new AbortController();
    const publications = createNativeAgentSessionPublications({
      agentId: 'claude', session: client, signal: controller.signal,
      isCurrent: () => true, supportsInFlightSteer: true,
    });
    const context = { session: { id: 's1', services: publications.services } } as unknown as AgentSessionRuntimeContext;
    const operations = leaf.createClaudeUnifiedTerminalTurnOperations({
      ctx, directory: '/tmp/claude-project', happierSessionId: 's1',
      hostPreference: 'zellij', launchEnv: {}, permissionMode: 'default',
    });
    const session = native.createClaudeNativeSessionRuntimeFromOperations(operations, {
      kind: 'create', sessionId: 's1', cwd: '/tmp/claude-project',
    }, context);
    const lifecycle = {
      onTurnTerminal: () => undefined,
      subscribePendingProviderInputRetirement: (listener: (localId: string) => void) =>
        client.subscribePendingProviderInputRetirement(listener),
    };
    const runtime = createNativeAgentSessionOperations(session, 's1', undefined, undefined, undefined,
      undefined, undefined, {
        context, cwd: '/tmp/claude-project', connectedAccounts: [],
        capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
        cancellation: { declared: false }, configuration: { declared: false }, manualCompaction: { declared: false },
      }, publications, [], lifecycle);
    try {
      // Server materialization is already owned by the real Pending client before dispatch.
      markMaterializedProviderInput(client, 'retired-input');
      await runtime.sendTurnPrompt('first prompt', { localId: 'retired-input', turnId: 'first-turn' });
      let completed = false;
      const completion = runtime.waitForTurnCompletion().then(() => { completed = true; });
      void completion.catch(() => undefined); // Disposal rejects this wait when a preceding assertion fails.
      markMaterializedProviderInput(client, 'unrelated-input');
      listDeliveryStatusesMock.mockResolvedValueOnce([
        { localId: 'retired-input', status: 'delivering', deliveryStatus: { status: 'delivering' } },
      ]);
      await client.reconcilePendingProviderInputCustodyBeforeMaterialization();
      expect(completed).toBe(false);
      listDeliveryStatusesMock.mockResolvedValueOnce([
        { localId: 'next-input', status: 'queued', deliveryStatus: { status: 'queued' } },
      ]);
      userSocketStub.trigger('update', {
        id: 'retirement-update', seq: 1, createdAt: 100,
        body: { t: 'pending-changed', sid: 's1', pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 },
      });
      await vi.waitFor(() => expect(completed).toBe(true));
      await completion;
      await runtime.sendTurnPrompt('next prompt', { localId: 'next-input', turnId: 'next-turn' });
      expect(terminal.service.injectUserPrompt).toHaveBeenCalledTimes(2);
      expect(resolveAcceptedMock).not.toHaveBeenCalled();
      expect(blockDeliveryMock).not.toHaveBeenCalled();
      await operations.observeTerminalLifecycle({ agentId: 'claude', type: 'prompt_submitted',
        promptText: 'next prompt', observedAtMs: 100, source: 'hook' });
      markMaterializedProviderInput(client, 'next-input');
      listDeliveryStatusesMock.mockResolvedValueOnce([]);
      await client.reconcilePendingProviderInputCustodyBeforeMaterialization();
      expect(operations.isTurnInFlight()).toBe(true);
      expect(client.listenerCount('pending-provider-input-retired')).toBe(1);
    } finally {
      await runtime.resetOrDisposeRuntime();
      expect(client.listenerCount('pending-provider-input-retired')).toBe(0);
      publications.dispose();
      await client.close();
    }
  });

  it('retires an exact discarded terminal custody claim', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId('discarded-local');
    listDeliveryStatusesMock.mockResolvedValueOnce([
      { localId: 'discarded-local', status: 'discarded', deliveryStatus: { status: 'discarded', reason: null } },
    ]);

    await expect(client.reconcilePendingProviderInputCustodyBeforeMaterialization()).resolves.toBe(true);

    expect(client.hasPendingProviderInput('discarded-local')).toBe(false);
  });

  it('keeps archived uncertain custody available for delayed acceptance without blocking later Pending work', async () => {
    resolveAcceptedMock.mockResolvedValueOnce({
      didResolve: true,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 3 },
      message: { localId: 'dismissed-local', seq: 42 },
    });
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId('dismissed-local');
    listDeliveryStatusesMock.mockResolvedValueOnce([
      {
        localId: 'dismissed-local',
        status: 'discarded',
        deliveryStatus: { status: 'discarded', reason: 'dismissed_uncertain' },
      },
      { localId: 'later-local', status: 'queued', deliveryStatus: { status: 'queued' } },
    ]);

    await expect(client.reconcilePendingProviderInputCustodyBeforeMaterialization()).resolves.toBe(true);

    expect(listDeliveryStatusesMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      includeDiscarded: true,
    }));
    expect(client.hasPendingProviderInput('dismissed-local')).toBe(true);

    await expect(client.observeProviderInputSettlement({
      kind: 'accepted',
      localId: 'dismissed-local',
      userMessageSeq: 42,
    })).resolves.toBe(false);

    expect(resolveAcceptedMock).toHaveBeenCalledWith({
      socket: sessionSocketStub,
      sessionId: 's1',
      localId: 'dismissed-local',
    });
    expect(client.hasPendingProviderInput('dismissed-local')).toBe(false);
    expect(client.getCommittedUserMessageSeq('dismissed-local')).toBe(42);
    await client.close();
  });

  it.each(['queued', 'delivering', 'blocked'] as const)(
    'retains exact local custody while the server row remains %s',
    async (status) => {
      sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
      userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
      const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
      const localId = `unresolved-${status}`;
      (client as any).materializationRuntime.markPendingQueueMaterializedLocalId(localId);
      const deliveryStatus = status === 'blocked'
        ? { status, reason: 'runtime_config_blocked' as const }
        : { status };
      listDeliveryStatusesMock.mockResolvedValueOnce([{ localId, status, deliveryStatus }]);

      await expect(client.reconcilePendingProviderInputCustodyBeforeMaterialization()).resolves.toBe(false);

      expect(client.hasPendingProviderInput(localId)).toBe(true);
    },
  );

  it('retains exact local custody when status reconciliation fails', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId('network-failure-local');
    listDeliveryStatusesMock.mockRejectedValueOnce(new Error('network unavailable'));

    await expect(client.reconcilePendingProviderInputCustodyBeforeMaterialization()).resolves.toBe(false);

    expect(client.hasPendingProviderInput('network-failure-local')).toBe(true);
  });

  it('does not retire exact local custody from another localId terminal status', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId('exact-live-local');
    listDeliveryStatusesMock.mockResolvedValueOnce([
      { localId: 'wrong-terminal-local', status: 'discarded', deliveryStatus: { status: 'discarded', reason: null } },
      { localId: 'exact-live-local', status: 'delivering', deliveryStatus: { status: 'delivering' } },
    ]);

    await expect(client.reconcilePendingProviderInputCustodyBeforeMaterialization()).resolves.toBe(false);

    expect(client.hasPendingProviderInput('exact-live-local')).toBe(true);
  });

  it('reads durable provider-input acceptance from the incumbent Pending delivery state', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    vi.spyOn(axios, 'get').mockRejectedValue(createTranscriptLookupHttpError({
      message: 'Message not found',
      status: 404,
      data: { error: 'Message not found' },
    }));

    // Only a status that proves no provider effect is classified as not accepted.
    listDeliveryStatusesMock.mockResolvedValueOnce([
      { localId: 'archived-local', status: 'discarded', deliveryStatus: { status: 'discarded', reason: 'cancelled' } },
    ]);
    await expect(client.readDurableProviderInputAcceptanceV1('archived-local')).resolves.toBe('not_accepted');
    expect(listDeliveryStatusesMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', includeDiscarded: true }),
    );

    // Absence is not positive acceptance evidence: the row may never have existed, may have
    // been deleted before provider dispatch, or may have resolved without this client's
    // committed-message tracker observing the result.
    listDeliveryStatusesMock.mockResolvedValueOnce([
      { localId: 'other-local', status: 'queued', deliveryStatus: { status: 'queued' } },
    ]);
    await expect(client.readDurableProviderInputAcceptanceV1('resolved-local')).resolves.toBe('unknown');

    // An unreadable durable status is never reported as either outcome.
    listDeliveryStatusesMock.mockRejectedValueOnce(new Error('network unavailable'));
    await expect(client.readDurableProviderInputAcceptanceV1('unreadable-local')).resolves.toBe('unknown');

    // A durable effect-possible status is ambiguous even while this daemon still holds local
    // custody; local runtime state cannot strengthen the Pending owner's durable truth.
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId('claimed-local');
    listDeliveryStatusesMock.mockResolvedValueOnce([
      { localId: 'claimed-local', status: 'delivering', deliveryStatus: { status: 'delivering' } },
    ]);
    await expect(client.readDurableProviderInputAcceptanceV1('claimed-local')).resolves.toBe('unknown');

    listDeliveryStatusesMock.mockResolvedValueOnce([
      {
        localId: 'uncertain-local',
        status: 'blocked',
        deliveryStatus: { status: 'blocked', reason: 'delivery_outcome_uncertain' },
      },
    ]);
    await expect(client.readDurableProviderInputAcceptanceV1('uncertain-local')).resolves.toBe('unknown');

    for (const reason of ['dismissed_uncertain', 'resent_as_new'] as const) {
      listDeliveryStatusesMock.mockResolvedValueOnce([
        {
          localId: reason,
          status: 'discarded',
          deliveryStatus: { status: 'discarded', reason },
        },
      ]);
      await expect(client.readDurableProviderInputAcceptanceV1(reason)).resolves.toBe('unknown');
    }

    await client.close();
  });

  it('recovers exact committed provider-input acceptance after restart before consulting Pending status', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    const transcriptGet = vi.spyOn(axios, 'get');

    expect(client.getCommittedUserMessageSeq('committed-after-restart')).toBeNull();
    transcriptGet.mockResolvedValueOnce({
      status: 200,
      data: {
        message: {
          id: 'message-committed-after-restart',
          seq: 42,
          localId: 'committed-after-restart',
          sidechainId: null,
          createdAt: 100,
          updatedAt: 101,
          content: {
            t: 'plain',
            v: { role: 'user', content: { type: 'text', text: 'committed prompt' } },
          },
        },
      },
    } as never);

    await expect(client.readDurableProviderInputAcceptanceV1('committed-after-restart'))
      .resolves.toBe('accepted');
    expect(listDeliveryStatusesMock).not.toHaveBeenCalled();

    const notFound = createTranscriptLookupHttpError({
      message: 'Message not found',
      status: 404,
      data: { error: 'Message not found' },
    });
    transcriptGet.mockRejectedValueOnce(notFound);
    listDeliveryStatusesMock.mockResolvedValueOnce([
      {
        localId: 'not-committed',
        status: 'queued',
        deliveryStatus: { status: 'queued' },
      },
    ]);

    await expect(client.readDurableProviderInputAcceptanceV1('not-committed'))
      .resolves.toBe('not_accepted');
    expect(listDeliveryStatusesMock).toHaveBeenCalledTimes(1);

    await client.close();
  });

  it('recovers target-run rejection after reconnect from the exact Pending route', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    vi.spyOn(axios, 'get').mockRejectedValueOnce(createTranscriptLookupHttpError({
      message: 'Message not found', status: 404, data: { error: 'Message not found' },
    }));
    listDeliveryStatusesMock.mockResolvedValueOnce([
      {
        localId: 'target-rejected-after-reconnect',
        status: 'blocked',
        deliveryStatus: { status: 'blocked', reason: 'provider_rejected_before_acceptance' },
      },
    ]);

    await expect(client.readDurableProviderInputAcceptanceV1(
      'target-rejected-after-reconnect',
      'run-a',
    )).resolves.toBe('not_accepted');
    expect(listDeliveryStatusesMock).toHaveBeenCalledWith({
      token: 'tok', sessionId: 's1', includeDiscarded: true,
      recipient: { kind: 'execution_run', runId: 'run-a' },
    });
    await client.close();
  });

  it('recovers target-run acceptance after restart from the committed transcript anchor', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        message: {
          id: 'target-message-after-restart', seq: 7, localId: 'target-accepted-after-restart',
          sidechainId: 'run-sidechain', createdAt: 100, updatedAt: 101,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'target prompt' } } },
        },
      },
    } as never);

    const binding = client.bindExecutionRunPendingInput({
      recipient: { kind: 'execution_run', runId: 'run-a' },
      sidechainId: 'run-sidechain',
      isCurrent: () => true,
      foregroundState: () => 'ready',
      getMetadataSnapshot: () => client.getMetadataSnapshot(),
      consume: () => true,
    });
    await expect(binding.readDurableProviderInputAcceptanceV1(
      'target-accepted-after-restart',
    )).resolves.toBe('accepted');
    expect(listDeliveryStatusesMock).not.toHaveBeenCalled();
    binding.dispose();
    await client.close();
  });

  it('reads target acceptance from the exact execution-run Pending route after reconnect', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    const recipient = { kind: 'execution_run' as const, runId: 'run-a' };
    const binding = client.bindExecutionRunPendingInput({
      recipient,
      sidechainId: 'sidechain-a',
      isCurrent: () => true,
      foregroundState: () => 'ready',
      getMetadataSnapshot: () => client.getMetadataSnapshot(),
      consume: () => true,
    });
    const localId = 'target-accepted-after-reconnect';
    (client as any).executionRunPendingCustody.set(localId, (client as any).executionRunPendingBindings.get('run-a'));
    vi.spyOn(axios, 'get').mockRejectedValueOnce(createTranscriptLookupHttpError({
      message: 'Message not found',
      status: 404,
      data: { error: 'Message not found' },
    }));
    listDeliveryStatusesMock.mockResolvedValueOnce([
      { localId, status: 'discarded', deliveryStatus: { status: 'discarded', reason: 'cancelled' } },
    ]);

    await expect(binding.readDurableProviderInputAcceptanceV1(localId)).resolves.toBe('not_accepted');
    expect(listDeliveryStatusesMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      includeDiscarded: true,
      recipient,
    }));
    binding.dispose();
    await client.close();
  });

  it('releases exact execution-run custody after accepted delivery commits', async () => {
    resolveAcceptedExecutionRunMock.mockResolvedValueOnce({
      didResolve: true,
      message: {
        id: 'committed-target-message',
        seq: 9,
        localId: 'target-accepted-cleanup',
      },
    });
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    const binding = client.bindExecutionRunPendingInput({
      recipient: { kind: 'execution_run', runId: 'run-a' },
      sidechainId: 'sidechain-a',
      isCurrent: () => true,
      foregroundState: () => 'ready',
      getMetadataSnapshot: () => client.getMetadataSnapshot(),
      consume: () => true,
    });
    const localId = 'target-accepted-cleanup';
    const internalBinding = (client as any).executionRunPendingBindings.get('run-a');
    (client as any).executionRunPendingCustody.set(localId, internalBinding);
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId(localId);

    await binding.observeProviderInputSettlement({
      kind: 'accepted',
      localId,
      userMessageSeq: 9,
    });

    expect(client.hasPendingProviderInput(localId)).toBe(false);
    expect((client as any).executionRunPendingCustody.has(localId)).toBe(false);
    binding.dispose();
    await client.close();
  });

  it.each([
    ['auth failure', createTranscriptLookupHttpError({
      message: 'unauthorized',
      status: 401,
      data: { error: 'Unauthorized' },
    })],
    ['unhealthy lookup', createTranscriptLookupHttpError({
      message: 'connection reset',
      code: 'ECONNRESET',
    })],
  ])('keeps durable provider-input acceptance unknown on %s', async (_label, lookupError) => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    vi.spyOn(axios, 'get').mockRejectedValueOnce(lookupError);

    await expect(client.readDurableProviderInputAcceptanceV1('lookup-failed'))
      .resolves.toBe('unknown');
    expect(listDeliveryStatusesMock).not.toHaveBeenCalled();

    await client.close();
  });

  it('keeps durable provider-input acceptance unknown on mismatched or invalid exact lookup responses', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    vi.spyOn(axios, 'get')
      .mockResolvedValueOnce({
        status: 200,
        data: {
          message: {
            id: 'wrong-message',
            seq: 42,
            localId: 'another-local-id',
            sidechainId: null,
            createdAt: 100,
            updatedAt: 101,
            content: {
              t: 'plain',
              v: { role: 'user', content: { type: 'text', text: 'another prompt' } },
            },
          },
        },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        data: { message: { id: 'malformed' } },
      } as never);

    await expect(client.readDurableProviderInputAcceptanceV1('lookup-mismatched'))
      .resolves.toBe('unknown');

    await expect(client.readDurableProviderInputAcceptanceV1('lookup-malformed'))
      .resolves.toBe('unknown');
    expect(listDeliveryStatusesMock).not.toHaveBeenCalled();

    await client.close();
  });

  it('routes normalized accepted, pre-effect, and ambiguous outcomes through the canonical Pending actions', async () => {
    resolveAcceptedMock.mockResolvedValue({
      didResolve: true,
      pendingQueueState: { known: true, pendingCount: 2, pendingBlockedCount: 0, pendingVersion: 2 },
    });
    blockDeliveryMock.mockResolvedValue({
      pendingQueueState: { known: true, pendingCount: 2, pendingBlockedCount: 2, pendingVersion: 4 },
    });
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    const materializationRuntime = (client as any).materializationRuntime;
    for (const localId of ['accepted-local', 'rejected-local', 'uncertain-local']) {
      materializationRuntime.markPendingQueueMaterializedLocalId(localId);
    }

    const accepted = client.observeProviderInputSettlement({
      kind: 'accepted',
      localId: 'accepted-local',
      userMessageSeq: 1,
    });
    const rejected = client.observeProviderInputSettlement({
      kind: 'rejected_before_effect',
      localId: 'rejected-local',
      userMessageSeq: 2,
      reason: 'provider_rejected_before_acceptance',
      diagnostic: { code: 'provider_rejected', severity: 'error' },
      retryable: false,
    });
    const uncertain = client.observeProviderInputSettlement({
      kind: 'effect_may_have_occurred',
      localId: 'uncertain-local',
      userMessageSeq: 3,
      issue: { code: 'response_lost', severity: 'error' },
    });

    await Promise.all([accepted, rejected, uncertain]);
    await vi.waitFor(() => expect(resolveAcceptedMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(blockDeliveryMock).toHaveBeenCalledTimes(2));
    expect(resolveAcceptedMock).toHaveBeenCalledWith({
      socket: sessionSocketStub,
      sessionId: 's1',
      localId: 'accepted-local',
    });
    expect(blockDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
      localId: 'rejected-local',
      reason: 'provider_rejected_before_acceptance',
    }));
    expect(blockDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
      localId: 'uncertain-local',
      reason: 'delivery_outcome_uncertain',
    }));
    expect(client.hasPendingProviderInput('accepted-local')).toBe(false);
    expect(client.hasPendingProviderInput('rejected-local')).toBe(false);
    expect(client.hasPendingProviderInput('uncertain-local')).toBe(true);

  });

  it('releases local custody only when the current server requeues a conditional steer', async () => {
    blockDeliveryMock.mockResolvedValueOnce({
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 5 },
    });
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    const localId = 'conditional-steer-requeued-local';
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId(localId);
    (client as any).materializationRuntime.markAgentQueueEchoSuppressedLocalId(localId);

    await expect(client.observeProviderInputSettlement({
      kind: 'rejected_before_effect',
      localId,
      userMessageSeq: 42,
      reason: 'conditional_steer_unavailable',
      diagnostic: { code: 'steering_unavailable', severity: 'warning' },
      retryable: true,
    })).resolves.toBe(false);

    expect(blockDeliveryMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      localId,
      reason: 'conditional_steer_unavailable',
    }));
    expect(client.hasPendingProviderInput(localId)).toBe(false);
    expect((client as any).materializationRuntime.hasAgentQueueEchoSuppressedLocalId(localId)).toBe(false);
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId(localId);
    expect(client.hasPendingProviderInput(localId)).toBe(true);
  });

  it('does not reopen delivery when an older server degrades a conditional steer to a strict block', async () => {
    blockDeliveryMock.mockResolvedValueOnce({
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 5 },
      usedLegacySteeringUnavailableFallback: true,
    });
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    const localId = 'conditional-steer-legacy-blocked-local';
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId(localId);
    (client as any).materializationRuntime.markAgentQueueEchoSuppressedLocalId(localId);

    await expect(client.observeProviderInputSettlement({
      kind: 'rejected_before_effect',
      localId,
      userMessageSeq: 43,
      reason: 'conditional_steer_unavailable',
      diagnostic: { code: 'steering_unavailable', severity: 'warning' },
      retryable: true,
    })).resolves.toBe(false);

    expect(client.hasPendingProviderInput(localId)).toBe(false);
    expect((client as any).materializationRuntime.hasAgentQueueEchoSuppressedLocalId(localId)).toBe(true);
  });

  it('publishes the accepted dispatch-time model without changing selected-next intent', async () => {
    resolveAcceptedMock.mockResolvedValueOnce({
      didResolve: true,
      pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 2 },
    });
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const fixture = createPlainSessionFixture({ id: 's1' });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', {
      ...fixture,
      metadata: {
        ...fixture.metadata,
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 20,
          selection: {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            providerConnectionId: null,
            modelId: 'gpt-5.6-sol',
          },
        },
      },
    });
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId('accepted-local');
    vi.spyOn(client, 'updateMetadata').mockImplementation(async (updater) => {
      (client as any).metadata = updater((client as any).metadata);
    });

    client.observeProviderInputSettlement({
      kind: 'accepted',
      localId: 'accepted-local',
      userMessageSeq: 43,
      appliedModel: {
        provider: 'codex',
        selection: {
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: null,
          modelId: 'gpt-5.6-terra',
        },
      },
    });

    await vi.waitFor(() => expect(client.getMetadataSnapshot()?.sessionAppliedModelV1).toMatchObject({
      v: 1,
      provider: 'codex',
      modelId: 'gpt-5.6-terra',
      selection: {
        agentTargetKey: 'agent:happier.agent.codex/codex',
        providerConnectionId: null,
        modelId: 'gpt-5.6-terra',
      },
    }));
    expect(client.getMetadataSnapshot()?.modelSelectionIntentV1?.selection?.modelId).toBe('gpt-5.6-sol');
  });

  it.each([
    'terminal_composer_draft',
    'runtime_config_blocked',
    'provider_unavailable_before_acceptance',
  ] as const)('retains the exact claim through reversible %s blocking for late acceptance', async (reason) => {
    blockDeliveryMock.mockResolvedValueOnce({
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 2 },
    });
    resolveAcceptedMock.mockResolvedValueOnce({
      didResolve: true,
      pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 3 },
    });
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    const localId = `reversible-${reason}`;
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId(localId);

    client.observeProviderInputSettlement({
      kind: 'rejected_before_effect',
      localId,
      userMessageSeq: 42,
      reason,
      diagnostic: { code: reason, severity: 'error' },
      retryable: true,
    });

    await vi.waitFor(() => expect(blockDeliveryMock).toHaveBeenCalledTimes(1));
    expect(client.hasPendingProviderInput(localId)).toBe(true);

    client.observeProviderInputSettlement({
      kind: 'accepted',
      localId,
      userMessageSeq: 42,
    });

    await vi.waitFor(() => expect(resolveAcceptedMock).toHaveBeenCalledTimes(1));
    expect(client.hasPendingProviderInput(localId)).toBe(false);
  });

  it('retires local custody only after the exact pre-provider rejection is durably blocked', async () => {
    blockDeliveryMock.mockResolvedValueOnce({
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 2 },
    });
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    const localId = 'admission-unavailable-blocked-local';
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId(localId);

    await expect(client.observeProviderInputSettlement({
      kind: 'rejected_before_effect',
      localId,
      userMessageSeq: 42,
      reason: 'provider_unavailable_before_acceptance',
      diagnostic: { code: 'daemon_turn_admission_unavailable', severity: 'error' },
      retryable: true,
      retireLocalCustodyAfterDurableBlock: true,
    })).resolves.toBe(true);

    await vi.waitFor(() => expect(blockDeliveryMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(client.hasPendingProviderInput(localId)).toBe(false));

    // A later materialization of the same exact local id is no longer suppressed by stale
    // pre-provider custody once the terminal block has been acknowledged.
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId(localId);
    expect(client.hasPendingProviderInput(localId)).toBe(true);
  });

  it('retains exact local custody when the pre-provider durable block fails', async () => {
    blockDeliveryMock.mockRejectedValueOnce(new Error('block unavailable'));
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    const localId = 'admission-unavailable-block-failed-local';
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId(localId);

    await expect(client.observeProviderInputSettlement({
      kind: 'rejected_before_effect',
      localId,
      userMessageSeq: 42,
      reason: 'provider_unavailable_before_acceptance',
      diagnostic: { code: 'daemon_turn_admission_unavailable', severity: 'error' },
      retryable: true,
      retireLocalCustodyAfterDurableBlock: true,
    })).resolves.toBe(false);

    await vi.waitFor(() => expect(blockDeliveryMock).toHaveBeenCalledTimes(1));
    expect(client.hasPendingProviderInput(localId)).toBe(true);
  });

  it('retains generic provider-unavailable custody without exact pre-provider proof', async () => {
    blockDeliveryMock.mockResolvedValueOnce({
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 2 },
    });
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    const localId = 'generic-provider-unavailable-local';
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId(localId);

    client.observeProviderInputSettlement({
      kind: 'rejected_before_effect',
      localId,
      userMessageSeq: 42,
      reason: 'provider_unavailable_before_acceptance',
      diagnostic: { code: 'provider_unavailable_before_acceptance', severity: 'error' },
      retryable: true,
    });

    await vi.waitFor(() => expect(blockDeliveryMock).toHaveBeenCalledTimes(1));
    expect(client.hasPendingProviderInput(localId)).toBe(true);
  });

  it('retries an accepted settlement once at the typed operation-local delay and accepts exact committed replay', async () => {
    const infoFileSpy = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    resolveAcceptedMock
      .mockRejectedValueOnce(new PendingQueueAcceptedSettlementError(
        'transaction-unavailable',
        1_250,
        'accepted-settlement-1',
      ))
      .mockResolvedValueOnce({
        didResolve: false,
        pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 3 },
        message: { localId: 'accepted-local', seq: 43 },
      });
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    const materializationRuntime = (client as any).materializationRuntime;
    materializationRuntime.markPendingQueueMaterializedLocalId('accepted-local');

    client.observeProviderInputSettlement({
      kind: 'accepted',
      localId: 'accepted-local',
      userMessageSeq: 43,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(resolveAcceptedMock).toHaveBeenCalledTimes(1);
    expect(client.hasPendingProviderInput('accepted-local')).toBe(true);
    await vi.advanceTimersByTimeAsync(1_249);
    expect(resolveAcceptedMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(resolveAcceptedMock).toHaveBeenCalledTimes(2);
    expect(client.hasPendingProviderInput('accepted-local')).toBe(false);
    expect(client.getCommittedUserMessageSeq('accepted-local')).toBe(43);
    expect(resolveAcceptedMock.mock.calls[0][0].acceptedDelivery).toBeUndefined();
    expect(resolveAcceptedMock.mock.calls[1][0].acceptedDelivery).toBeUndefined();
    expect(infoFileSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('records a final accepted-settlement failure in the default file log without terminal output', async () => {
    const infoFileSpy = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    resolveAcceptedMock.mockRejectedValueOnce(
      new PendingQueueAcceptedSettlementError('internal', undefined, 'accepted-settlement-final'),
    );
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    const localId = 'accepted-final-failure-local';
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId(localId);

    await expect(client.observeProviderInputSettlement({
      kind: 'accepted',
      localId,
      userMessageSeq: null,
    })).resolves.toBe(false);

    expect(infoFileSpy).toHaveBeenCalledOnce();
    expect(infoFileSpy).toHaveBeenCalledWith(
      '[pendingQueue] accepted provider-input settlement remains unresolved',
      expect.objectContaining({
        sessionId: 's1',
        localId,
        reason: 'settlement_error',
        attempt: 1,
        error: expect.objectContaining({
          code: 'pending_queue_accepted_settlement_failed',
          settlementError: 'internal',
          correlationId: 'accepted-settlement-final',
        }),
      }),
    );
    expect(warnSpy).not.toHaveBeenCalled();
    expect(client.hasPendingProviderInput(localId)).toBe(true);
  });

  it('records an unexpected accepted-settlement resolution crash in the default file log without terminal output', async () => {
    const infoFileSpy = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    resolveAcceptedMock.mockRejectedValueOnce({
      toString() {
        throw new Error('settlement diagnostic serialization failed');
      },
    });
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    const localId = 'accepted-crash-local';
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId(localId);

    await expect(client.observeProviderInputSettlement({
      kind: 'accepted',
      localId,
      userMessageSeq: null,
    })).resolves.toBe(false);

    expect(infoFileSpy).toHaveBeenCalledOnce();
    expect(infoFileSpy).toHaveBeenCalledWith(
      '[pendingQueue] accepted provider-input settlement resolution crashed',
      expect.objectContaining({
        sessionId: 's1',
        localId,
        error: expect.objectContaining({
          message: 'settlement diagnostic serialization failed',
        }),
      }),
    );
    expect(warnSpy).not.toHaveBeenCalled();
    expect(client.hasPendingProviderInput(localId)).toBe(true);
  });

  it.each(['plain', 'e2ee'] as const)('records the exact committed message returned by a first accepted settlement (%s)', async (mode) => {
    resolveAcceptedMock.mockResolvedValueOnce({
      didResolve: true,
      pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 2 },
      message: { localId: 'accepted-first-local', seq: 44 },
    });
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const encryptionKey = new Uint8Array(32).fill(7);
    const session = mode === 'plain' ? createPlainSessionFixture({ id: 's1' }) : {
      ...createPlainSessionFixture({ id: 's1' }), encryptionMode: 'e2ee' as const,
      encryptionKey, encryptionVariant: 'dataKey' as const,
    };
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', session);
    markMaterializedProviderInput(client, 'accepted-first-local');

    client.observeProviderInputSettlement({
      kind: 'accepted',
      localId: 'accepted-first-local',
      userMessageSeq: null,
      providerDeliveryKind: 'steer',
      providerTurnId: 'turn-observed',
      acceptedAtMs: 1234,
    });

    await vi.waitFor(() => expect(resolveAcceptedMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(client.hasPendingProviderInput('accepted-first-local')).toBe(false));
    expect(client.getCommittedUserMessageSeq('accepted-first-local')).toBe(44);
    const acceptedDelivery = resolveAcceptedMock.mock.calls[0][0].acceptedDelivery;
    const facts = { v: 1, acceptedAtMs: 1234, delivery: { kind: 'steer', turnId: 'turn-observed' } };
    if (mode === 'plain') expect(acceptedDelivery).toEqual({ t: 'plain', v: facts });
    else {
      expect(acceptedDelivery).toEqual({ t: 'encrypted', c: expect.any(String) });
      expect(decrypt(encryptionKey, 'dataKey', decodeBase64(acceptedDelivery.c))).toEqual(facts);
    }
  });

  it('rejoins once after socket ACK response loss, then stops after a second failure and ignores later wakes', async () => {
    vi.useFakeTimers();
    const ackResponseLoss = new SocketAckError({
      code: 'socket_ack_timeout',
      event: 'pending-delivery-accepted-v1',
      timeoutMs: 10_000,
    });
    resolveAcceptedMock
      .mockRejectedValueOnce(ackResponseLoss)
      .mockRejectedValueOnce(new PendingQueueAcceptedSettlementError('transaction-unavailable', 1_250));
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    const materializationRuntime = (client as any).materializationRuntime;
    materializationRuntime.markPendingQueueMaterializedLocalId('response-lost-local');

    client.observeProviderInputSettlement({
      kind: 'accepted',
      localId: 'response-lost-local',
      userMessageSeq: 43,
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(resolveAcceptedMock).toHaveBeenCalledTimes(2);
    expect(client.hasPendingProviderInput('response-lost-local')).toBe(true);

    client.wakePendingMaterialization();
    sessionSocketStub.trigger('session-turn-updated', { status: 'completed' });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(resolveAcceptedMock).toHaveBeenCalledTimes(2);
    expect(client.hasPendingProviderInput('response-lost-local')).toBe(true);
  });

  it('abandons the accepted settlement retry when the session connection epoch changes', async () => {
    vi.useFakeTimers();
    resolveAcceptedMock
      .mockRejectedValueOnce(new PendingQueueAcceptedSettlementError('transaction-unavailable', 1_250))
      .mockResolvedValueOnce({ didResolve: true });
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    const materializationRuntime = (client as any).materializationRuntime;
    materializationRuntime.markPendingQueueMaterializedLocalId('epoch-fenced-local');

    client.observeProviderInputSettlement({
      kind: 'accepted',
      localId: 'epoch-fenced-local',
      userMessageSeq: 43,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveAcceptedMock).toHaveBeenCalledTimes(1);

    (client as any).sessionConnectionEpoch += 1;
    await vi.advanceTimersByTimeAsync(1_250);

    expect(resolveAcceptedMock).toHaveBeenCalledTimes(1);
    expect(client.hasPendingProviderInput('epoch-fenced-local')).toBe(true);
  });

  it('keeps an unrelated accepted-settlement no-op visible for exact reconciliation', async () => {
    const infoFileSpy = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    resolveAcceptedMock.mockResolvedValueOnce({
      didResolve: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 },
      message: null,
    });
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    const materializationRuntime = (client as any).materializationRuntime;
    materializationRuntime.markPendingQueueMaterializedLocalId('unrelated-noop-local');

    client.observeProviderInputSettlement({
      kind: 'accepted',
      localId: 'unrelated-noop-local',
      userMessageSeq: 43,
    });

    await vi.waitFor(() => expect(resolveAcceptedMock).toHaveBeenCalledTimes(1));
    expect(client.hasPendingProviderInput('unrelated-noop-local')).toBe(true);
    expect(infoFileSpy).toHaveBeenCalledOnce();
    expect(infoFileSpy).toHaveBeenCalledWith(
      '[pendingQueue] accepted provider-input settlement remains unresolved',
      expect.objectContaining({
        sessionId: 's1',
        localId: 'unrelated-noop-local',
        reason: 'settlement_noop_without_exact_commit',
      }),
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('re-drives exact provider acceptance after reconnect when acceptance arrived while disconnected', async () => {
    resolveAcceptedMock.mockResolvedValueOnce({
      didResolve: true,
      pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 3 },
      message: { localId: 'accepted-while-disconnected', seq: 45 },
    });
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = createTestApiSessionClient(ApiSessionClient, 'tok', createPlainSessionFixture({ id: 's1' }));
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId('accepted-while-disconnected');

    sessionSocketStub.connected = false;
    await expect(client.observeProviderInputSettlement({
      kind: 'accepted',
      localId: 'accepted-while-disconnected',
      userMessageSeq: null,
      providerDeliveryKind: 'followUp',
      providerTurnId: 'turn-before-reconnect',
      acceptedAtMs: 987,
    })).resolves.toBe(false);

    expect(resolveAcceptedMock).not.toHaveBeenCalled();
    expect(client.hasPendingProviderInput('accepted-while-disconnected')).toBe(true);
    expect((client as any).acceptedPendingSettlementLocalIds.has('accepted-while-disconnected')).toBe(true);

    sessionSocketStub.connected = true;
    (client as any).sessionConnectionEpoch += 1;
    (client as any).reofferAcceptedProviderInputSettlementsAfterConnection();
    await vi.waitFor(() => expect(resolveAcceptedMock).toHaveBeenCalledTimes(1));
    expect(client.hasPendingProviderInput('accepted-while-disconnected')).toBe(false);
    expect(client.getCommittedUserMessageSeq('accepted-while-disconnected')).toBe(45);
    expect(resolveAcceptedMock.mock.calls[0][0].acceptedDelivery).toEqual({ t: 'plain', v: {
      v: 1, acceptedAtMs: 987, delivery: { kind: 'followUp', turnId: 'turn-before-reconnect' },
    } });
  });
});
