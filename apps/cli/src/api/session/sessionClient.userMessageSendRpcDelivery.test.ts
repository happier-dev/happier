import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMockSession as createMockSessionBase,
  createPlainSessionFixture as createPlainSessionFixtureBase,
} from '@/testkit/backends/sessionFixtures';
import {
  createApiSessionSocketStub as createApiSessionSocketStubBase,
  flushApiSessionClientMessageCommitQueue,
  type ApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { waitForCondition } from '@/testkit/async/waitFor';
import { decodeBase64, decrypt } from '../encryption';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;
let materializedEnqueueCallCount = 0;

function createApiSessionSocketStub(
  options: Parameters<typeof createApiSessionSocketStubBase>[0] = {},
): ApiSessionSocketStub {
  return createApiSessionSocketStubBase({
    ...options,
    emitWithAck: async (event, payload, socket) => {
      if (event === 'ping') return { v: 1 };
      if (options.emitWithAck) return await options.emitWithAck(event, payload, socket);
      return options.emitWithAckResult ?? { ok: true, id: 'm1', seq: 1, localId: 'l1' };
    },
  });
}

function createPlainSessionFixture(
  ...args: Parameters<typeof createPlainSessionFixtureBase>
): ReturnType<typeof createPlainSessionFixtureBase> {
  const fixture = createPlainSessionFixtureBase(...args);
  return {
    ...fixture,
    metadata: { ...fixture.metadata, machineId: 'machine-1' },
  };
}

function createMockSession(
  ...args: Parameters<typeof createMockSessionBase>
): ReturnType<typeof createMockSessionBase> {
  const fixture = createMockSessionBase(...args);
  return {
    ...fixture,
    metadata: { ...fixture.metadata, machineId: 'machine-1' },
  };
}

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
    getState: () => ({ phase: 'online' }),
  }),
}));

const {
  enqueuePendingQueueV2MessageViaHttpMock,
  materializeNextPendingQueueV2MessageMock,
  listPendingQueueV2DeliveryStatusesFromServerMock,
  listPendingQueueV2ProviderDeliveryLocalIdsFromServerMock,
  notifyDaemonConnectedServiceTurnLifecycleMock,
  blockPendingQueueV2DeliveryMock,
  resolveAcceptedPendingQueueV2DeliveryMock,
} = vi.hoisted(() => ({
  enqueuePendingQueueV2MessageViaHttpMock: vi.fn(),
  materializeNextPendingQueueV2MessageMock: vi.fn(),
  listPendingQueueV2DeliveryStatusesFromServerMock: vi.fn(),
  listPendingQueueV2ProviderDeliveryLocalIdsFromServerMock: vi.fn(),
  notifyDaemonConnectedServiceTurnLifecycleMock: vi.fn(),
  blockPendingQueueV2DeliveryMock: vi.fn(),
  resolveAcceptedPendingQueueV2DeliveryMock: vi.fn(),
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
  return {
    ...actual,
    notifyDaemonConnectedServiceTurnLifecycle: (...args: unknown[]) => notifyDaemonConnectedServiceTurnLifecycleMock(...args),
  };
});

vi.mock('./pendingQueueV2Transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pendingQueueV2Transport')>();
  return {
    ...actual,
    blockPendingQueueV2Delivery: (...args: unknown[]) => blockPendingQueueV2DeliveryMock(...args),
    enqueuePendingQueueV2MessageViaHttp: (...args: unknown[]) => enqueuePendingQueueV2MessageViaHttpMock(...args),
    materializeNextPendingQueueV2Message: (...args: unknown[]) => materializeNextPendingQueueV2MessageMock(...args),
    listPendingQueueV2DeliveryStatusesFromServer: (...args: unknown[]) => listPendingQueueV2DeliveryStatusesFromServerMock(...args),
    listPendingQueueV2ProviderDeliveryLocalIdsFromServer: (...args: unknown[]) =>
      listPendingQueueV2ProviderDeliveryLocalIdsFromServerMock(...args),
    resolveAcceptedPendingQueueV2Delivery: (...args: unknown[]) => resolveAcceptedPendingQueueV2DeliveryMock(...args),
  };
});

import { ApiSessionClient } from './sessionClient';

function createPlainClaudeSessionFixture(id: string) {
  const session = createPlainSessionFixture({ id });
  return {
    ...session,
    metadata: { ...session.metadata, flavor: 'claude' as const },
  };
}

function createProviderInputOutcomeProducer(
  overrides?: Readonly<{ providerId?: 'claude' | 'codex' | 'customAcp'; mode?: string; matchesCurrentSession?: boolean }>,
) {
  return {
    providerId: overrides?.providerId ?? 'claude',
    mode: overrides?.mode ?? 'unifiedTerminal',
    matchesCurrentSession: () => overrides?.matchesCurrentSession ?? true,
  } as const;
}

async function waitForCurrentPendingInputContract(client: ApiSessionClient): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((client as any).sessionSyncPendingInputServerContract?.pendingInput === 'v1') return;
    await Promise.resolve();
  }
  throw new Error('Timed out waiting for current Pending-input server contract');
}

async function waitForReleasedServerPendingInputContract(client: ApiSessionClient): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((client as any).sessionSyncPendingInputServerContract?.pendingInput === 'released_server_v0_2_1') return;
    await Promise.resolve();
  }
  throw new Error('Timed out waiting for released-server Pending-input server contract');
}

describe('ApiSessionClient session.userMessage.send delivery', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      features: {
        sharing: {
          pendingQueueV2: { enabled: true },
          pendingDeliveryState: { enabled: true },
        },
      },
      capabilities: {
        session: {
          runtimeActivity: { protocolVersion: 2 },
          pendingInput: { protocolVersion: 1 },
        },
      },
    }), { status: 200 })));
    enqueuePendingQueueV2MessageViaHttpMock.mockReset();
    enqueuePendingQueueV2MessageViaHttpMock.mockResolvedValue(undefined);
    materializeNextPendingQueueV2MessageMock.mockReset();
    listPendingQueueV2DeliveryStatusesFromServerMock.mockReset();
    listPendingQueueV2DeliveryStatusesFromServerMock.mockResolvedValue([]);
    listPendingQueueV2ProviderDeliveryLocalIdsFromServerMock.mockReset();
    listPendingQueueV2ProviderDeliveryLocalIdsFromServerMock.mockResolvedValue([]);
    blockPendingQueueV2DeliveryMock.mockReset();
    blockPendingQueueV2DeliveryMock.mockResolvedValue({
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 3 },
    });
    resolveAcceptedPendingQueueV2DeliveryMock.mockReset();
    resolveAcceptedPendingQueueV2DeliveryMock.mockImplementation(async ({ localId }: { localId: string }) => ({
      didResolve: true,
      message: { localId, seq: 41 },
      pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 3 },
    }));
    materializedEnqueueCallCount = 0;
    materializeNextPendingQueueV2MessageMock.mockImplementation(async () => {
      const enqueueCall = enqueuePendingQueueV2MessageViaHttpMock.mock.calls[materializedEnqueueCallCount];
      if (!enqueueCall) {
        return {
          didMaterialize: false,
          localId: null,
          didWrite: false,
          pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 },
        };
      }
      materializedEnqueueCallCount += 1;
      // HTTP Queue transport is the genuine boundary under test; mirror the committed
      // materialization response produced for the exact row that was enqueued.
      const request = enqueueCall[0] as Readonly<{
        body: Readonly<{
          localId: string;
          messageRole: 'user';
          content?: unknown;
          ciphertext?: string;
          requestedAction?: { v: 1; kind: 'enqueue' | 'steer_if_active' | 'steer_now' | 'send_now' };
        }>;
      }>;
      return {
        didMaterialize: true,
        localId: request.body.localId,
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 2 },
        message: {
          id: `m-${request.body.localId}`,
          seq: materializedEnqueueCallCount,
          localId: request.body.localId,
          messageRole: request.body.messageRole,
          content: request.body.content ?? request.body.ciphertext,
          requestedAction: request.body.requestedAction,
          deliveryState: { mode: 'provider', unresolved: true },
          createdAt: 1_000,
          updatedAt: 1_000,
        },
      };
    });
    notifyDaemonConnectedServiceTurnLifecycleMock.mockReset();
    notifyDaemonConnectedServiceTurnLifecycleMock.mockResolvedValue({
      status: 'continue',
      turnCustody: {
        status: 'ignored_missing_exact_turn',
        activeTurnId: null,
      },
    });
  });

  it('settles typed provider outcomes only for the exact claimed local input', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainClaudeSessionFixture('s1'));
    (client as any).sessionConnectionSupervisor = null;
    (client as any).canonicalPendingDeliveryByLocalId.set('accepted-local', { mode: 'provider', unresolved: true });
    (client as any).canonicalPendingDeliveryByLocalId.set('rejected-local', { mode: 'provider', unresolved: true });
    (client as any).canonicalPendingDeliveryByLocalId.set('custody-local', { mode: 'provider', unresolved: true });
    (client as any).canonicalPendingDeliveryByLocalId.set('uncertain-local', { mode: 'provider', unresolved: true });

    const observe = client.bindProviderInputOutcomeProducer(createProviderInputOutcomeProducer());
    observe({ kind: 'custody_observed', localId: 'custody-local' });
    observe({ kind: 'effect_may_have_occurred', localId: 'uncertain-local' });
    observe({ kind: 'effect_may_have_occurred', localId: 'uncertain-local' });
    observe({ kind: 'accepted', localId: 'unknown-local' });
    observe({ kind: 'accepted', localId: 'accepted-local' });
    observe({
      kind: 'rejected_before_effect',
      localId: 'rejected-local',
      reason: 'provider_rejected_before_acceptance',
    });

    await vi.waitFor(() => expect(resolveAcceptedPendingQueueV2DeliveryMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(blockPendingQueueV2DeliveryMock).toHaveBeenCalledTimes(2));
    expect(blockPendingQueueV2DeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      localId: 'uncertain-local',
      reason: 'delivery_outcome_uncertain',
    }));
    expect((client as any).canonicalPendingDeliveryByLocalId.has('uncertain-local')).toBe(true);
    observe({ kind: 'accepted', localId: 'uncertain-local' });
    await vi.waitFor(() => expect(resolveAcceptedPendingQueueV2DeliveryMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(
      (client as any).canonicalPendingDeliveryByLocalId.has('accepted-local'),
    ).toBe(false));
    expect(resolveAcceptedPendingQueueV2DeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
      socket: sessionSocketStub,
      sessionId: 's1',
      localId: 'accepted-local',
    }));
    expect(resolveAcceptedPendingQueueV2DeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
      socket: sessionSocketStub,
      sessionId: 's1',
      localId: 'uncertain-local',
    }));
    expect(blockPendingQueueV2DeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      localId: 'rejected-local',
      reason: 'provider_rejected_before_acceptance',
    }));
    expect((client as any).canonicalPendingDeliveryByLocalId.has('custody-local')).toBe(true);
    await vi.waitFor(() => expect(
      (client as any).canonicalPendingDeliveryByLocalId.has('uncertain-local'),
    ).toBe(false));
    expect((client as any).canonicalPendingDeliveryByLocalId.has('unknown-local')).toBe(false);
    expect(resolveAcceptedPendingQueueV2DeliveryMock).toHaveBeenCalledTimes(2);
  });

  it('publishes the model captured at provider acceptance without changing the selected model', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const fixture = createPlainClaudeSessionFixture('s1');
    const client = new ApiSessionClient('tok', {
      ...fixture,
      metadata: {
        ...fixture.metadata,
        sessionModelsV1: {
          v: 1,
          provider: 'claude',
          updatedAt: 20,
          currentModelId: 'claude-selected-next',
          availableModels: [],
        },
      },
    });
    (client as any).sessionConnectionSupervisor = null;
    // Metadata persistence is the socket boundary; exercise the real owner updater against local state.
    vi.spyOn(client, 'updateMetadata').mockImplementation(async (updater) => {
      (client as any).metadata = updater((client as any).metadata);
    });

    const observe = client.bindProviderInputOutcomeProducer(createProviderInputOutcomeProducer());
    observe({
      kind: 'accepted',
      localId: 'immediate-local',
      appliedModelId: 'claude-applied-to-this-prompt',
    });

    await vi.waitFor(() => expect(client.getMetadataSnapshot()?.sessionAppliedModelV1).toMatchObject({
      v: 1,
      provider: 'claude',
      modelId: 'claude-applied-to-this-prompt',
    }));
    expect(client.getMetadataSnapshot()?.sessionModelsV1?.currentModelId).toBe('claude-selected-next');
    expect(resolveAcceptedPendingQueueV2DeliveryMock).not.toHaveBeenCalled();
  });

  it('binds configured ACP flavor aliases to the canonical custom ACP outcome producer', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const fixture = createPlainClaudeSessionFixture('s1');
    const client = new ApiSessionClient('tok', {
      ...fixture,
      metadata: { ...fixture.metadata, flavor: 'acp:configured-backend' },
    });
    (client as any).sessionConnectionSupervisor = null;
    (client as any).canonicalPendingDeliveryByLocalId.set('configured-acp-local', { mode: 'provider', unresolved: true });

    const observe = client.bindProviderInputOutcomeProducer(createProviderInputOutcomeProducer({
      providerId: 'customAcp',
      mode: 'acp',
    }));
    observe({
      kind: 'rejected_before_effect',
      localId: 'configured-acp-local',
      reason: 'provider_rejected_before_acceptance',
    });

    await vi.waitFor(() => expect(blockPendingQueueV2DeliveryMock).toHaveBeenCalledTimes(1));
    expect(blockPendingQueueV2DeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      localId: 'configured-acp-local',
      reason: 'provider_rejected_before_acceptance',
    }));
  });

  it('rejects an ambiguous blocked reason presented as proven pre-effect rejection', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainClaudeSessionFixture('s1'));
    (client as any).sessionConnectionSupervisor = null;
    (client as any).canonicalPendingDeliveryByLocalId.set('ambiguous-local', { mode: 'provider', unresolved: true });

    const observe = client.bindProviderInputOutcomeProducer(
      createProviderInputOutcomeProducer(),
    ) as (outcome: unknown) => void;
    observe({
      kind: 'rejected_before_effect',
      localId: 'ambiguous-local',
      userMessageSeq: 16,
      reason: 'provider_acceptance_timeout',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(blockPendingQueueV2DeliveryMock).not.toHaveBeenCalled();
    expect(resolveAcceptedPendingQueueV2DeliveryMock).not.toHaveBeenCalled();
    expect((client as any).providerInputTerminalOutcomeByLocalId.has('ambiguous-local')).toBe(false);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('ambiguous-local')).toBe(true);
  });

  it('does not downgrade effect-possible custody to pre-effect rejection during runtime shutdown', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainClaudeSessionFixture('s1'));
    (client as any).sessionConnectionSupervisor = null;
    (client as any).canonicalPendingDeliveryByLocalId.set('uncertain-shutdown', { mode: 'provider', unresolved: true });
    const observe = client.bindProviderInputOutcomeProducer(createProviderInputOutcomeProducer());

    observe({ kind: 'effect_may_have_occurred', localId: 'uncertain-shutdown' });
    await vi.waitFor(() => expect(blockPendingQueueV2DeliveryMock).toHaveBeenCalledTimes(1));
    await (client as any).blockUnresolvedCanonicalPendingDeliveriesBeforeClose();

    expect(blockPendingQueueV2DeliveryMock).toHaveBeenCalledTimes(2);
    expect(blockPendingQueueV2DeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      localId: 'uncertain-shutdown',
      reason: 'delivery_outcome_uncertain',
    }));
    expect((client as any).canonicalPendingDeliveryByLocalId.has('uncertain-shutdown')).toBe(true);
  });

  it('keeps exact terminal outcomes monotonic, idempotent, and producer-generation fenced', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainClaudeSessionFixture('s1'));
    (client as any).sessionConnectionSupervisor = null;
    for (const localId of [
      'accepted-first',
      'rejected-first',
      'failure-race',
      'stale-generation',
      'wrong-provider',
      'wrong-mode',
      'missing-validation',
      'valid-before-invalid',
      'terminating-generation',
    ]) {
      (client as any).canonicalPendingDeliveryByLocalId.set(localId, { mode: 'provider', unresolved: true });
    }

    const wrongProviderObserve = client.bindProviderInputOutcomeProducer(createProviderInputOutcomeProducer({
      providerId: 'codex',
      mode: 'appServer',
      matchesCurrentSession: false,
    }));
    wrongProviderObserve({ kind: 'accepted', localId: 'wrong-provider' });
    const staleObserve = client.bindProviderInputOutcomeProducer(createProviderInputOutcomeProducer());
    const observe = client.bindProviderInputOutcomeProducer(createProviderInputOutcomeProducer());
    staleObserve({ kind: 'accepted', localId: 'stale-generation' });
    observe({ kind: 'accepted', localId: 'accepted-first' });
    observe({ kind: 'accepted', localId: 'accepted-first' });
    observe({
      kind: 'rejected_before_effect',
      localId: 'accepted-first',
      reason: 'provider_rejected_before_acceptance',
    });
    observe({
      kind: 'rejected_before_effect',
      localId: 'rejected-first',
      reason: 'provider_rejected_before_acceptance',
    });
    observe({ kind: 'accepted', localId: 'rejected-first' });
    observe({ kind: 'effect_may_have_occurred', localId: 'failure-race' });
    observe({ kind: 'accepted', localId: 'failure-race' });
    const validBeforeInvalidObserve = client.bindProviderInputOutcomeProducer(createProviderInputOutcomeProducer());
    const wrongModeObserve = client.bindProviderInputOutcomeProducer(createProviderInputOutcomeProducer({
      mode: 'agentSdk',
      matchesCurrentSession: false,
    }));
    const missingValidationObserve = client.bindProviderInputOutcomeProducer({
      providerId: 'claude',
      mode: 'unifiedTerminal',
      // Runtime-shape regression fixture: old producers without canonical validation must fail closed.
    } as never);
    wrongModeObserve({ kind: 'accepted', localId: 'wrong-mode' });
    missingValidationObserve({ kind: 'accepted', localId: 'missing-validation' });
    validBeforeInvalidObserve({ kind: 'accepted', localId: 'valid-before-invalid' });
    client.beginRuntimeTermination();
    validBeforeInvalidObserve({ kind: 'accepted', localId: 'terminating-generation' });

    await vi.waitFor(() => expect(resolveAcceptedPendingQueueV2DeliveryMock).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(blockPendingQueueV2DeliveryMock).toHaveBeenCalledTimes(2));
    expect(resolveAcceptedPendingQueueV2DeliveryMock.mock.calls.map(([input]) => input.localId).sort()).toEqual([
      'accepted-first',
      'failure-race',
      'valid-before-invalid',
    ]);
    expect(blockPendingQueueV2DeliveryMock).toHaveBeenCalledWith(expect.objectContaining({ localId: 'rejected-first' }));
    expect(blockPendingQueueV2DeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
      localId: 'failure-race',
      reason: 'delivery_outcome_uncertain',
    }));
    expect((client as any).canonicalPendingDeliveryByLocalId.has('stale-generation')).toBe(true);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('wrong-provider')).toBe(true);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('wrong-mode')).toBe(true);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('missing-validation')).toBe(true);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('terminating-generation')).toBe(true);
  });

  it('abandons an operation-local settlement rejoin when its session connection is replaced', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const timeoutError = Object.assign(new Error('socket acknowledgement timed out'), {
      code: 'socket_ack_timeout' as const,
      retryable: true as const,
    });
    resolveAcceptedPendingQueueV2DeliveryMock.mockRejectedValue(timeoutError);
    const client = new ApiSessionClient('tok', createPlainClaudeSessionFixture('s1'));
    (client as any).sessionConnectionSupervisor = null;
    (client as any).canonicalPendingDeliveryByLocalId.set('stale-connection', { mode: 'provider', unresolved: true });
    const observe = client.bindProviderInputOutcomeProducer(createProviderInputOutcomeProducer());

    vi.useFakeTimers();
    observe({ kind: 'accepted', localId: 'stale-connection' });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveAcceptedPendingQueueV2DeliveryMock).toHaveBeenCalledTimes(1);

    (client as any).sessionConnectionEpoch += 1;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(resolveAcceptedPendingQueueV2DeliveryMock).toHaveBeenCalledTimes(1);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('stale-connection')).toBe(true);
  });

  it('serializes exact daemon turn lifecycle notifications in mutation order', async () => {
    // Boundary fixture: private transport sequencing is the observable contract under test.
    const client = Object.create(ApiSessionClient.prototype) as any;
    client.sessionId = 's1';
    client.startedByDaemonProcess = true;
    client.daemonTurnLifecycleNotifyTail = Promise.resolve();
    let releaseBegin: (() => void) | null = null;
    notifyDaemonConnectedServiceTurnLifecycleMock
      .mockImplementationOnce(async () => await new Promise<void>((resolve) => {
        releaseBegin = resolve;
      }))
      .mockResolvedValueOnce({});

    const begin = client.notifyDaemonConnectedServiceTurnLifecycle(
      'prompt_or_steer',
      undefined,
      'session-turn:exact-1',
    );
    const terminal = client.notifyDaemonConnectedServiceTurnLifecycle(
      'assistant_message_end',
      'completed',
      'session-turn:exact-1',
    );

    await Promise.resolve();
    expect(notifyDaemonConnectedServiceTurnLifecycleMock).toHaveBeenCalledTimes(1);
    expect(notifyDaemonConnectedServiceTurnLifecycleMock).toHaveBeenNthCalledWith(1, {
      sessionId: 's1',
      event: 'prompt_or_steer',
      turnId: 'session-turn:exact-1',
    });

    const release = ((value: unknown): (() => void) => {
      if (typeof value !== 'function') throw new Error('Expected the begin notification to be pending');
      return value as () => void;
    })(releaseBegin);
    release();
    await Promise.all([begin, terminal]);
    expect(notifyDaemonConnectedServiceTurnLifecycleMock).toHaveBeenNthCalledWith(2, {
      sessionId: 's1',
      event: 'assistant_message_end',
      terminalStatus: 'completed',
      turnId: 'session-turn:exact-1',
    });
  });

  it('routes an unconfigured RPC prompt through durable Queue V2 before provider input and ignores its transcript echo', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    await waitForCurrentPendingInputContract(client);

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));
    materializeNextPendingQueueV2MessageMock.mockResolvedValueOnce({
      didMaterialize: true,
      localId: 'l1',
      didWrite: true,
      pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 2 },
      message: {
        id: 'm1',
        seq: 1,
        localId: 'l1',
        messageRole: 'user',
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'hello' },
            localId: 'l1',
            meta: { source: 'ui', sentFrom: 'ios' },
          },
        },
        createdAt: 1_000,
        updatedAt: 1_000,
      },
    });

    // Simulate the daemon/UI invoking the session-scoped RPC handler, which calls the internal enqueue.
    await (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    expect(enqueuePendingQueueV2MessageViaHttpMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      body: expect.objectContaining({ localId: 'l1', messageRole: 'user' }),
    }));
    expect(received).toHaveLength(1);
    expect(received[0]?.content?.type).toBe('text');
    expect(received[0]?.content?.text).toBe('hello');
    expect(received[0]?.localId).toBe('l1');

    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'hello' },
              localId: 'l1',
              meta: { source: 'ui', sentFrom: 'ios' },
            },
          },
          localId: 'l1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    expect(received).toHaveLength(1);
  });

  it('revalidates paused recovery exactly once before accepting a fresh direct prompt', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const checkUsageLimitRecoveryNow = vi.fn(async () => ({ ok: true, status: 'ready' }));
    (client as any).sessionRuntimeControls.checkUsageLimitRecoveryNow = checkUsageLimitRecoveryNow;
    const received: any[] = [];
    client.onUserMessage((message) => received.push(message));

    await (client as any).enqueueSessionUserMessage({
      text: 'retry after daemon restart',
      localId: 'request-once',
      meta: { source: 'ui' },
    });
    await (client as any).enqueueSessionUserMessage({
      text: 'retry after daemon restart',
      localId: 'request-once',
      meta: { source: 'ui' },
    });

    expect(checkUsageLimitRecoveryNow).toHaveBeenCalledExactlyOnceWith({
      sessionId: 's1',
      operation: 'check_now',
    });
    expect(received).toHaveLength(1);
  });

  it('coalesces exact replays without collapsing whitespace-distinct recovery request ids', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1 },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const checkUsageLimitRecoveryNow = vi.fn(async () => ({ ok: true, status: 'waiting' }));
    (client as any).sessionRuntimeControls.checkUsageLimitRecoveryNow = checkUsageLimitRecoveryNow;
    client.onUserMessage(() => undefined);

    for (const localId of [' request-1', 'request-1 ', ' request-1'] as const) {
      await (client as any).enqueueSessionUserMessage({ text: 'retry', localId, meta: { source: 'ui' } });
    }

    expect(checkUsageLimitRecoveryNow).toHaveBeenCalledTimes(2);
  });

  it('returns typed unavailable and does not deliver when explicit recovery revalidation throws', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const checkUsageLimitRecoveryNow = vi.fn(async () => {
      throw new Error('recovery store unavailable');
    });
    (client as any).sessionRuntimeControls.checkUsageLimitRecoveryNow = checkUsageLimitRecoveryNow;
    const received: any[] = [];
    client.onUserMessage((message) => received.push(message));

    await expect((client as any).enqueueSessionUserMessage({
      text: 'still deliver me',
      localId: 'request-error',
      meta: { source: 'ui' },
    })).resolves.toEqual({
      recoveryBlocked: {
        status: 'unavailable',
        errorCode: 'session_user_message_recovery_control_unavailable',
      },
    });

    expect(checkUsageLimitRecoveryNow).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(0);
  });

  it('bounds a stalled recovery decision and never delivers when that stale decision resolves late', async () => {
    vi.useFakeTimers();
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    let resolveRecovery!: (value: { ok: true; status: 'ready' }) => void;
    const checkUsageLimitRecoveryNow = vi.fn(() => new Promise<{ ok: true; status: 'ready' }>((resolve) => {
      resolveRecovery = resolve;
    }));
    (client as any).sessionRuntimeControls.checkUsageLimitRecoveryNow = checkUsageLimitRecoveryNow;
    const received: any[] = [];
    client.onUserMessage((message) => received.push(message));

    const delivery = (client as any).enqueueSessionUserMessage({
      text: 'must not arrive after the authority deadline',
      localId: 'request-stalled-recovery',
      meta: { source: 'ui' },
    });
    await vi.advanceTimersByTimeAsync(7_500);
    await expect(delivery).resolves.toEqual({
      recoveryBlocked: {
        status: 'unavailable',
        errorCode: 'session_user_message_recovery_control_unavailable',
      },
    });
    resolveRecovery({ ok: true, status: 'ready' });
    await vi.advanceTimersByTimeAsync(0);

    expect(checkUsageLimitRecoveryNow).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(0);
    vi.useRealTimers();
  });

  it('keeps a waiting recovery prompt out of provider delivery and coalesces the request id', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const checkUsageLimitRecoveryNow = vi.fn(async () => ({ ok: true, status: 'waiting' }));
    (client as any).sessionRuntimeControls.checkUsageLimitRecoveryNow = checkUsageLimitRecoveryNow;
    const received: any[] = [];
    client.onUserMessage((message) => received.push(message));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect((client as any).enqueueSessionUserMessage({
        text: 'retry after daemon restart',
        localId: 'request-waiting',
        meta: { source: 'ui' },
      })).resolves.toEqual({
        recoveryBlocked: {
          status: 'waiting',
          errorCode: 'session_user_message_recovery_pending',
        },
      });
    }

    expect(checkUsageLimitRecoveryNow).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(0);
  });

  it('delivers ordinary input while provider-ready recovery remains paused for later exact proof', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'ready-to-try' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({
      id: 's1',
      metadata: {
        ...createPlainSessionFixture({ id: 'metadata-seed' }).metadata,
        sessionUsageLimitRecoveryV1: {
          v: 1,
          status: 'paused',
          issueFingerprint: 'usage-limit:openai-codex:ready-to-try',
          armedAtMs: 100,
          runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:ready-to-try',
          resetAtMs: null,
          nextCheckAtMs: null,
          attemptCount: 1,
          maxAttempts: 3,
          lastProbeError: null,
          resumePromptMode: 'standard',
          selectedAuth: {
            kind: 'group',
            serviceId: 'openai-codex',
            groupId: 'team',
            profileId: 'backup',
          },
        },
      },
    }));
    await waitForCurrentPendingInputContract(client);
    const checkUsageLimitRecoveryNow = vi.fn(async () => ({ ok: true, status: 'waiting' }));
    (client as any).sessionRuntimeControls.checkUsageLimitRecoveryNow = checkUsageLimitRecoveryNow;
    const received: any[] = [];
    client.onUserMessage((message) => received.push(message));

    await expect((client as any).enqueueSessionUserMessage({
      text: 'try the exact applied account',
      localId: 'ready-to-try',
      meta: { source: 'ui' },
    })).resolves.toEqual({ providerAcceptancePending: true });

    expect(checkUsageLimitRecoveryNow).not.toHaveBeenCalled();
    expect(received).toHaveLength(1);
    expect((client as any).getMetadataSnapshot().sessionUsageLimitRecoveryV1).toMatchObject({
      status: 'paused',
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:ready-to-try',
    });
  });

  it('fails closed when persisted blocking recovery has no provider decision control', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({
      id: 's1',
      metadata: {
        ...createPlainSessionFixture({ id: 'metadata-seed' }).metadata,
        sessionUsageLimitRecoveryV1: {
          v: 1,
          status: 'waiting',
          issueFingerprint: 'usage-limit:claude:turn-1',
          armedAtMs: 100,
          resetAtMs: null,
          nextCheckAtMs: 200,
          attemptCount: 0,
          maxAttempts: 3,
          lastProbeError: null,
          resumePromptMode: 'standard',
          selectedAuth: { kind: 'native' },
        },
      },
    }));
    const received: any[] = [];
    client.onUserMessage((message) => received.push(message));

    await expect((client as any).enqueueSessionUserMessage({
      text: 'fresh Claude prompt',
      localId: 'request-missing-control',
      meta: { source: 'ui' },
    })).resolves.toEqual({
      recoveryBlocked: {
        status: 'unavailable',
        errorCode: 'session_user_message_recovery_control_unavailable',
      },
    });

    expect(received).toHaveLength(0);
  });

  it('delivers fresh direct prompts while runtime activity projection is active', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm-runtime-active', seq: 1, localId: 'fresh-runtime-active' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const session = createPlainSessionFixture({
      id: 's1',
      runtimeActivityState: 'active',
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: Date.now(),
      runtimeActivityRevision: 1,
    } as Parameters<typeof createPlainSessionFixture>[0] & {
      runtimeActivityState: 'active';
      runtimeActivityActiveCount: number;
      runtimeActivityObservedAt: number;
      runtimeActivityRevision: number;
    });
    const client = new ApiSessionClient('tok', session);
    await waitForCurrentPendingInputContract(client);

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    await (client as any).enqueueSessionUserMessage({
      text: 'fresh while background runtime is active',
      localId: 'fresh-runtime-active',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.content?.text).toBe('fresh while background runtime is active');
    expect(materializeNextPendingQueueV2MessageMock).toHaveBeenCalledTimes(1);
    expect(materializeNextPendingQueueV2MessageMock).toHaveBeenCalledWith(expect.objectContaining({
      token: 'tok',
      sessionId: 's1',
      deliveryStateOptIn: true,
    }));
  });

  it('suppresses a transcript echo that arrives reentrantly during eager RPC prompt delivery', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    await waitForCurrentPendingInputContract(client);

    const received: any[] = [];
    let triggeredEcho = false;
    client.onUserMessage((msg) => {
      received.push(msg);
      if (triggeredEcho) return;
      triggeredEcho = true;
      sessionSocketStub?.trigger('update', {
        id: 'u1',
        createdAt: Date.now(),
        body: {
          t: 'new-message',
          sid: 's1',
          message: {
            id: 'm1',
            seq: 1,
            content: {
              t: 'plain',
              v: {
                role: 'user',
                content: { type: 'text', text: 'hello' },
                localId: 'l1',
                meta: { source: 'ui', sentFrom: 'ios' },
              },
            },
            localId: 'l1',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      });
    });

    await (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.content?.text).toBe('hello');
    expect(received[0]?.localId).toBe('l1');
  });

  it('keeps echo suppression across a delayed transcript echo without a legacy socket commit acknowledgement', async () => {
    vi.useFakeTimers();
    try {
      sessionSocketStub = createApiSessionSocketStub({
        connected: true,
        emitWithAckResult: { ok: true },
      });
      userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
      await waitForCurrentPendingInputContract(client);

      const received: any[] = [];
      client.onUserMessage((msg) => received.push(msg));

      await (client as any).enqueueSessionUserMessage({
        text: 'hello',
        localId: 'l1',
        meta: { source: 'ui', sentFrom: 'ios' },
      });
      expect(received).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(8_000);
      await flushApiSessionClientMessageCommitQueue(client as any);
      expect(sessionSocketStub.emitWithAck.mock.calls.some(([event]) => event === 'message')).toBe(false);

      sessionSocketStub.trigger('update', {
        id: 'u1',
        createdAt: Date.now(),
        body: {
          t: 'new-message',
          sid: 's1',
          message: {
            id: 'm1',
            seq: 1,
            content: {
              t: 'plain',
              v: {
                role: 'user',
                content: { type: 'text', text: 'hello' },
                localId: 'l1',
                meta: { source: 'ui', sentFrom: 'ios' },
              },
            },
            localId: 'l1',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      });

      expect(received).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('routes provider-acceptance RPC prompts through the server pending claim instead of committing a transcript row', async () => {
    const encryptionKey = new Uint8Array(32);
    encryptionKey.fill(7);
    const committedPayloads: unknown[] = [];
    let pendingContent: unknown = null;

    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event, payload) => {
        if (event === 'message') {
          committedPayloads.push(payload);
        }
        return { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    enqueuePendingQueueV2MessageViaHttpMock.mockImplementationOnce(async (params: any) => {
      const body = params?.body;
      pendingContent = typeof body?.ciphertext === 'string'
        ? { t: 'encrypted', c: body.ciphertext }
        : body?.content ?? null;
    });
    materializeNextPendingQueueV2MessageMock.mockImplementationOnce(async () => ({
      didMaterialize: true,
      localId: 'l1',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId: 'l1',
        messageRole: null,
        content: pendingContent,
        createdAt: 1_000,
        updatedAt: 1_000,
        deliveryState: { mode: 'provider', unresolved: true },
      },
    }));

    const client = new ApiSessionClient('tok', createMockSession({
      id: 's1',
      encryptionMode: 'e2ee',
      encryptionKey,
      encryptionVariant: 'legacy',
      pendingCount: 0,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    }) as any);
    await waitForCurrentPendingInputContract(client);

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    await (client as any).enqueueSessionUserMessage({
      text: 'hello from provider claim',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'web' },
    });
    await flushApiSessionClientMessageCommitQueue(client as any);

    expect(enqueuePendingQueueV2MessageViaHttpMock).toHaveBeenCalledTimes(1);
    const enqueueParams = enqueuePendingQueueV2MessageViaHttpMock.mock.calls[0]?.[0] as any;
    expect(enqueueParams?.sessionId).toBe('s1');
    expect(enqueueParams?.body?.localId).toBe('l1');
    expect(enqueueParams?.body?.messageRole).toBe('user');
    expect(typeof enqueueParams?.body?.ciphertext).toBe('string');
    const decoded = decrypt(encryptionKey, 'legacy', decodeBase64(enqueueParams.body.ciphertext));
    expect(decoded).toMatchObject({
      role: 'user',
      content: { type: 'text', text: 'hello from provider claim' },
      meta: { source: 'ui', sentFrom: 'web' },
    });
    expect(materializeNextPendingQueueV2MessageMock).toHaveBeenCalledWith(expect.objectContaining({
      token: 'tok',
      sessionId: 's1',
      deliveryStateOptIn: true,
    }));
    expect(received).toHaveLength(1);
    expect(received[0]?.localId).toBe('l1');
    expect(received[0]?.content?.text).toBe('hello from provider claim');
    expect(committedPayloads).toHaveLength(0);
  });

  it('reports provider-acceptance pending custody in the session user-message RPC ACK', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({
      id: 's1',
      pendingCount: 0,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    }));
    await waitForCurrentPendingInputContract(client);

    const result = await client.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, {
      text: 'send now with durable custody',
      localId: 'rpc-provider-acceptance-local',
      meta: { source: 'ui', sentFrom: 'web' },
    });

    expect(result).toEqual({ ok: true, providerAcceptancePending: true });
    expect(enqueuePendingQueueV2MessageViaHttpMock).toHaveBeenCalledTimes(1);
    expect(enqueuePendingQueueV2MessageViaHttpMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      token: 'tok',
      sessionId: 's1',
      body: expect.objectContaining({
        localId: 'rpc-provider-acceptance-local',
        messageRole: 'user',
      }),
    }));
  });

  it('does not materialize a provider-acceptance RPC prompt while an earlier canonical delivery is unresolved', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({
      id: 's1',
      pendingCount: 0,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    }));
    await waitForCurrentPendingInputContract(client);

    listPendingQueueV2DeliveryStatusesFromServerMock.mockResolvedValueOnce([
      { localId: 'earlier-local', status: 'delivering' },
    ]);
    (client as any).canonicalPendingDeliveryByLocalId.set('earlier-local', {
      mode: 'provider',
      unresolved: true,
    });

    await (client as any).enqueueSessionUserMessage({
      text: 'later send now',
      localId: 'later-local',
      meta: { source: 'ui', sentFrom: 'web' },
    });

    expect(enqueuePendingQueueV2MessageViaHttpMock).toHaveBeenCalledTimes(1);
    expect(materializeNextPendingQueueV2MessageMock).not.toHaveBeenCalled();
  });

  it('materializes a provider-acceptance RPC prompt immediately when no canonical delivery is unresolved', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    materializeNextPendingQueueV2MessageMock.mockResolvedValueOnce({
      didMaterialize: true,
      localId: 'send-now-local',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId: 'send-now-local',
        messageRole: 'user',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'send now' } } },
        createdAt: 1_000,
        updatedAt: 1_000,
        deliveryState: { mode: 'provider', unresolved: true },
      },
    });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({
      id: 's1',
      pendingCount: 0,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    }));
    await waitForCurrentPendingInputContract(client);

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    await (client as any).enqueueSessionUserMessage({
      text: 'send now',
      localId: 'send-now-local',
      meta: { source: 'ui', sentFrom: 'web' },
    });

    expect(enqueuePendingQueueV2MessageViaHttpMock).toHaveBeenCalledTimes(1);
    expect(materializeNextPendingQueueV2MessageMock).toHaveBeenCalledWith(expect.objectContaining({
      token: 'tok',
      sessionId: 's1',
      deliveryStateOptIn: true,
    }));
    expect(received).toHaveLength(1);
    expect(received[0]?.localId).toBe('send-now-local');
  });

  it('does not wait for daemon lifecycle notification before delivering the prompt', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    await waitForCurrentPendingInputContract(client);
    const received: any[] = [];
    const slowLifecycleNotify = vi.fn(() => new Promise<void>(() => {}));

    (client as any).notifyDaemonConnectedServiceTurnLifecycle = slowLifecycleNotify;
    client.onUserMessage((msg) => received.push(msg));

    await (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    expect(slowLifecycleNotify).not.toHaveBeenCalled();
    expect(received).toHaveLength(1);
    expect(received[0]?.content?.text).toBe('hello');
  });

  it('persists Pending before one exact daemon authorization and waits for continue before provider delivery', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const originalArgv = process.argv.slice();
    try {
      process.argv = [...originalArgv, '--started-by', 'daemon'];
      const order: string[] = [];
      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
      await waitForCurrentPendingInputContract(client);
      enqueuePendingQueueV2MessageViaHttpMock.mockImplementationOnce(async () => {
        order.push('persist');
        return undefined;
      });
      const received: any[] = [];
      let releaseLifecycleNotify: ((value: unknown) => void) | null = null;
      notifyDaemonConnectedServiceTurnLifecycleMock.mockImplementationOnce(async () => {
        order.push('authorize');
        return await new Promise((resolve) => {
          releaseLifecycleNotify = resolve;
        });
      });
      client.onUserMessage((msg) => {
        order.push('provider');
        received.push(msg);
      });

      const enqueuePromise = (client as any).enqueueSessionUserMessage({
        text: 'hello',
        localId: 'l1',
        meta: { source: 'ui', sentFrom: 'ios' },
        requestedAction: { v: 1, kind: 'enqueue' },
      });

      await waitForCondition(
        () => notifyDaemonConnectedServiceTurnLifecycleMock.mock.calls.length === 1,
        {
          timeoutMs: 1_000,
          label: 'persisted prompt to reach daemon authorization',
        },
      );
      expect(order).toEqual(['persist', 'authorize']);
      expect(notifyDaemonConnectedServiceTurnLifecycleMock).toHaveBeenCalledExactlyOnceWith({
        sessionId: 's1',
        event: 'prompt_or_steer',
        requestedAction: { v: 1, kind: 'enqueue' },
        activeTurnId: null,
      });
      expect(received).toHaveLength(0);

      const release = ((value: ((result: unknown) => void) | null): ((result: unknown) => void) => {
        if (typeof value !== 'function') {
          throw new Error('expected daemon authorization to block prompt delivery');
        }
        return value;
      })(releaseLifecycleNotify);
      release({
        status: 'continue',
        turnCustody: {
          status: 'ignored_missing_exact_turn',
          activeTurnId: null,
        },
      });
      await enqueuePromise;

      expect(order).toEqual(['persist', 'authorize', 'provider']);
      expect(received).toHaveLength(1);
      expect(received[0]?.content?.text).toBe('hello');
    } finally {
      process.argv = originalArgv;
    }
  });

  it('retains Pending when prompt authorization blocks and never reuses terminal continue as authority', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'blocked-local' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    notifyDaemonConnectedServiceTurnLifecycleMock
      .mockResolvedValueOnce({
        status: 'continue',
        turnCustody: {
          status: 'recorded',
          activeTurnId: null,
        },
      })
      .mockResolvedValueOnce({
        status: 'input_blocked',
        reason: 'request_auth_source_cutover',
      });

    const originalArgv = process.argv.slice();
    try {
      process.argv = [...originalArgv, '--started-by', 'daemon'];
      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
      await waitForCurrentPendingInputContract(client);
      await (client as any).notifyDaemonConnectedServiceTurnLifecycle(
        'assistant_message_end',
        'completed',
        'session-turn:previous',
      );
      (client as any).sessionTurnLifecycle.getActiveTurnId = () => 'session-turn:exact-active';
      const received: any[] = [];
      client.onUserMessage((message) => received.push(message));

      await expect((client as any).enqueueSessionUserMessage({
        text: 'steer this exact turn',
        localId: 'blocked-local',
        meta: { source: 'ui', sentFrom: 'ios' },
        requestedAction: { v: 1, kind: 'steer_if_active' },
      })).resolves.toEqual({ providerAcceptancePending: true });

      expect(enqueuePendingQueueV2MessageViaHttpMock).toHaveBeenCalledTimes(1);
      expect(notifyDaemonConnectedServiceTurnLifecycleMock).toHaveBeenNthCalledWith(1, {
        sessionId: 's1',
        event: 'assistant_message_end',
        terminalStatus: 'completed',
        turnId: 'session-turn:previous',
      });
      expect(notifyDaemonConnectedServiceTurnLifecycleMock).toHaveBeenNthCalledWith(2, {
        sessionId: 's1',
        event: 'prompt_or_steer',
        requestedAction: { v: 1, kind: 'steer_if_active' },
        activeTurnId: 'session-turn:exact-active',
      });
      expect(notifyDaemonConnectedServiceTurnLifecycleMock).toHaveBeenCalledTimes(2);
      expect(received).toHaveLength(0);
      expect((client as any).canonicalPendingDeliveryByLocalId.has('blocked-local')).toBe(true);
      expect((client as any).sourceCutoverDeferredPendingLocalIds.has('blocked-local')).toBe(true);

      listPendingQueueV2ProviderDeliveryLocalIdsFromServerMock.mockResolvedValueOnce(['blocked-local']);
      await (client as any).blockUnresolvedCanonicalPendingDeliveriesBeforeClose();
      await (client as any).blockDurableProviderDeliveriesBeforeClose();
      expect(blockPendingQueueV2DeliveryMock).not.toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
    }
  });

  it.each([
    ['handler unavailable', { error: 'handler unavailable' }],
    ['malformed continue', { status: 'continue' }],
    ['transport loss', new Error('daemon transport lost')],
  ] as const)('fails closed before Provider delivery on daemon authorization %s', async (_label, outcome) => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'fail-closed-local' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    if (outcome instanceof Error) {
      notifyDaemonConnectedServiceTurnLifecycleMock.mockRejectedValueOnce(outcome);
    } else {
      notifyDaemonConnectedServiceTurnLifecycleMock.mockResolvedValueOnce(outcome);
    }

    const originalArgv = process.argv.slice();
    try {
      process.argv = [...originalArgv, '--started-by', 'daemon'];
      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
      await waitForCurrentPendingInputContract(client);
      const received: any[] = [];
      client.onUserMessage((message) => received.push(message));

      await (client as any).enqueueSessionUserMessage({
        text: 'retain until one source owns authorization',
        localId: 'fail-closed-local',
        meta: { source: 'ui', sentFrom: 'ios' },
        requestedAction: { v: 1, kind: 'enqueue' },
      });

      expect(enqueuePendingQueueV2MessageViaHttpMock).toHaveBeenCalledTimes(1);
      expect(notifyDaemonConnectedServiceTurnLifecycleMock).toHaveBeenCalledTimes(1);
      expect(received).toHaveLength(0);
      // An unanswered or unparsable daemon reply is not a source cutover. Resolve the server
      // claim as a reversible pre-acceptance block, then retire local custody so an explicit
      // Retry can rematerialize this same durable row.
      expect(blockPendingQueueV2DeliveryMock).toHaveBeenCalledExactlyOnceWith({
        token: 'tok',
        sessionId: 's1',
        localId: 'fail-closed-local',
        reason: 'provider_unavailable_before_acceptance',
      });
      expect((client as any).sourceCutoverDeferredPendingLocalIds.has('fail-closed-local')).toBe(false);
      expect((client as any).canonicalPendingDeliveryByLocalId.has('fail-closed-local')).toBe(false);
      expect((client as any).serverBlockedCanonicalPendingDeliveryLocalIds.has('fail-closed-local')).toBe(false);
    } finally {
      process.argv = originalArgv;
    }
  });

  it('retires unanswered pre-provider custody after a durable block so explicit retry can deliver the same row once', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const claimedPrompt = {
      didMaterialize: true,
      localId: 'daemon-down-local',
      didWrite: true,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 },
      message: {
        id: 'm-daemon-down-local',
        seq: 21,
        localId: 'daemon-down-local',
        messageRole: 'user',
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'must not starve the queue' },
            localId: 'daemon-down-local',
          },
        },
        requestedAction: { v: 1, kind: 'enqueue' },
        deliveryState: { mode: 'provider', unresolved: true },
        createdAt: 1_000,
        updatedAt: 1_000,
      },
    } as const;

    const originalArgv = process.argv.slice();
    try {
      process.argv = [...originalArgv, '--started-by', 'daemon'];
      const client = new ApiSessionClient('tok', createPlainSessionFixture({
        id: 's1',
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 1,
      }));
      await waitForCurrentPendingInputContract(client);
      const received: any[] = [];
      client.onUserMessage((message) => received.push(message));

      materializeNextPendingQueueV2MessageMock
        .mockResolvedValueOnce(claimedPrompt)
        .mockResolvedValueOnce({
          ...claimedPrompt,
          pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 5 },
          message: {
            ...claimedPrompt.message,
            updatedAt: 1_001,
          },
        })
        .mockResolvedValueOnce({
          ...claimedPrompt,
          pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 5 },
          message: {
            ...claimedPrompt.message,
            updatedAt: 1_001,
          },
        });
      notifyDaemonConnectedServiceTurnLifecycleMock.mockRejectedValueOnce(
        new Error('No daemon running, no state file found'),
      );

      await expect(client.materializeNextPendingMessageSafely()).resolves.toEqual({ type: 'no_pending' });
      expect(received).toHaveLength(0);
      expect(blockPendingQueueV2DeliveryMock).toHaveBeenCalledExactlyOnceWith({
        token: 'tok',
        sessionId: 's1',
        localId: 'daemon-down-local',
        reason: 'provider_unavailable_before_acceptance',
      });
      // No Provider call was possible before this exact lifecycle branch. Once the durable block
      // succeeds, there is no late acceptance race whose process-local identity must survive.
      expect((client as any).sourceCutoverDeferredPendingLocalIds.has('daemon-down-local')).toBe(false);
      expect((client as any).canonicalPendingDeliveryByLocalId.has('daemon-down-local')).toBe(false);
      expect((client as any).serverBlockedCanonicalPendingDeliveryLocalIds.has('daemon-down-local')).toBe(false);

      if (!userSocketStub) throw new Error('missing user socket');
      userSocketStub.trigger('update', {
        id: 'explicit-retry-reopened-pending-row',
        createdAt: Date.now(),
        body: {
          t: 'pending-changed',
          sid: 's1',
          pendingCount: 1,
          pendingBlockedCount: 0,
          pendingVersion: 4,
        },
      });

      await expect(client.materializeNextPendingMessageSafely()).resolves.toMatchObject({
        type: 'materialized',
        localId: 'daemon-down-local',
      });
      expect(received).toHaveLength(1);
      expect(received[0]?.content?.text).toBe('must not starve the queue');

      // A duplicate materialization response from the same retry attempt must remain suppressed.
      await expect((client as any).runMaterializeNextPendingMessageInner()).resolves.toEqual({
        didMaterialize: false,
        result: { type: 'no_pending' },
      });
      expect(received).toHaveLength(1);
      expect(materializeNextPendingQueueV2MessageMock).toHaveBeenCalledTimes(3);
      expect(notifyDaemonConnectedServiceTurnLifecycleMock).toHaveBeenCalledTimes(2);
    } finally {
      process.argv = originalArgv;
    }
  });

  it('retains unanswered pre-provider custody when the durable block fails', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const claimedPrompt = {
      didMaterialize: true,
      localId: 'daemon-block-failed-local',
      didWrite: true,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 },
      message: {
        id: 'm-daemon-block-failed-local',
        seq: 22,
        localId: 'daemon-block-failed-local',
        messageRole: 'user',
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'keep custody until the block is durable' },
            localId: 'daemon-block-failed-local',
          },
        },
        requestedAction: { v: 1, kind: 'enqueue' },
        deliveryState: { mode: 'provider', unresolved: true },
        createdAt: 1_000,
        updatedAt: 1_000,
      },
    } as const;

    const originalArgv = process.argv.slice();
    try {
      process.argv = [...originalArgv, '--started-by', 'daemon'];
      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
      await waitForCurrentPendingInputContract(client);
      const received: any[] = [];
      client.onUserMessage((message) => received.push(message));

      materializeNextPendingQueueV2MessageMock
        .mockResolvedValueOnce(claimedPrompt)
        .mockResolvedValueOnce(claimedPrompt);
      notifyDaemonConnectedServiceTurnLifecycleMock.mockRejectedValueOnce(
        new Error('No daemon running, no state file found'),
      );
      blockPendingQueueV2DeliveryMock.mockRejectedValueOnce(new Error('durable block unavailable'));

      await expect((client as any).runMaterializeNextPendingMessageInner()).resolves.toEqual({
        didMaterialize: false,
        result: { type: 'retryable_transport' },
      });
      expect((client as any).canonicalPendingDeliveryByLocalId.has('daemon-block-failed-local')).toBe(true);
      expect((client as any).serverBlockedCanonicalPendingDeliveryLocalIds.has('daemon-block-failed-local')).toBe(false);

      await expect((client as any).runMaterializeNextPendingMessageInner()).resolves.toEqual({
        didMaterialize: false,
        result: { type: 'no_pending' },
      });
      expect(received).toHaveLength(0);
      expect(materializeNextPendingQueueV2MessageMock).toHaveBeenCalledTimes(2);
      expect(notifyDaemonConnectedServiceTurnLifecycleMock).toHaveBeenCalledTimes(1);
    } finally {
      process.argv = originalArgv;
    }
  });

  it('delivers a released-server materialization without an action even when daemon notification is unavailable', async () => {
    // The server-v0.2.1 materialize contract has no requestedAction concept at all
    // (its ack message carries exactly id/seq/localId) and it commits + dequeues the row
    // atomically, so there is no claim to inherit and no successor to inherit it. Parking
    // such a row as a source cutover loses the prompt permanently.
    const releasedMaterializeAck = {
      ok: true,
      didMaterialize: true,
      didWrite: true,
      message: { id: 'm-released-local', seq: 9, localId: 'released-local' },
    } as const;
    sessionSocketStub = createApiSessionSocketStubBase({
      connected: true,
      emitWithAck: async (event) => {
        if (event === 'ping') return {};
        if (event === 'pending-materialize-next') return releasedMaterializeAck;
        return { ok: true };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    // Released server v0.2.1: no compatibility capability block, Pending queue v2 without
    // the provider delivery-state opt-in.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      features: {
        sharing: {
          pendingQueueV2: { enabled: true },
          pendingDeliveryState: { enabled: false },
        },
      },
    }), { status: 200 })));
    const transcriptLookup = vi.spyOn(axios, 'get').mockResolvedValue({
      status: 200,
      data: {
        message: {
          id: 'm-released-local',
          seq: 9,
          localId: 'released-local',
          sidechainId: null,
          createdAt: 1_000,
          updatedAt: 1_000,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'released prompt' },
              localId: 'released-local',
            },
          },
        },
      },
    });
    notifyDaemonConnectedServiceTurnLifecycleMock.mockRejectedValue(
      new Error('No daemon running, no state file found'),
    );

    const originalArgv = process.argv.slice();
    try {
      process.argv = [...originalArgv, '--started-by', 'daemon'];
      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
      await waitForReleasedServerPendingInputContract(client);
      const received: any[] = [];
      client.onUserMessage((message) => received.push(message));

      await expect((client as any).runMaterializeNextPendingMessageInner()).resolves.toMatchObject({
        didMaterialize: true,
        result: { type: 'materialized', localId: 'released-local', seq: 9 },
      });
      expect(received).toHaveLength(1);
      expect(received[0]?.content?.text).toBe('released prompt');
      // This exact released contract has no action-authorization field and has already
      // atomically committed + dequeued the row. Notification remains best-effort; parking
      // the prompt on a missing daemon would lose it because no server claim remains.
      expect(notifyDaemonConnectedServiceTurnLifecycleMock).toHaveBeenCalledExactlyOnceWith({
        sessionId: 's1',
        event: 'prompt_or_steer',
      });
      expect((client as any).sourceCutoverDeferredPendingLocalIds.has('released-local')).toBe(false);
    } finally {
      transcriptLookup.mockRestore();
      process.argv = originalArgv;
    }
  });

  it('admits an exact active steer on typed continue and never reauthorizes a blocked claimed row', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const claimedSteer = {
      didMaterialize: true,
      localId: 'exact-steer-local',
      didWrite: true,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 },
      message: {
        id: 'm-exact-steer-local',
        seq: 12,
        localId: 'exact-steer-local',
        messageRole: 'user',
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'exact steer' },
            localId: 'exact-steer-local',
          },
        },
        requestedAction: { v: 1, kind: 'steer_if_active' },
        deliveryState: { mode: 'provider', unresolved: true },
        createdAt: 1_000,
        updatedAt: 1_000,
      },
    } as const;

    const originalArgv = process.argv.slice();
    try {
      process.argv = [...originalArgv, '--started-by', 'daemon'];
      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
      await waitForCurrentPendingInputContract(client);
      (client as any).sessionTurnLifecycle.getActiveTurnId = () => 'session-turn:live';
      const received: any[] = [];
      client.onUserMessage((message) => received.push(message));

      materializeNextPendingQueueV2MessageMock.mockResolvedValueOnce(claimedSteer);
      notifyDaemonConnectedServiceTurnLifecycleMock.mockResolvedValueOnce({
        status: 'continue',
        turnCustody: {
          status: 'recorded',
          activeTurnId: 'session-turn:live',
        },
      });
      await expect((client as any).runMaterializeNextPendingMessageInner()).resolves.toMatchObject({
        didMaterialize: true,
        result: {
          type: 'materialized',
          localId: 'exact-steer-local',
        },
      });
      expect(received).toHaveLength(1);
      expect(notifyDaemonConnectedServiceTurnLifecycleMock).toHaveBeenCalledExactlyOnceWith({
        sessionId: 's1',
        event: 'prompt_or_steer',
        requestedAction: { v: 1, kind: 'steer_if_active' },
        activeTurnId: 'session-turn:live',
      });

      received.length = 0;
      notifyDaemonConnectedServiceTurnLifecycleMock.mockClear();
      materializeNextPendingQueueV2MessageMock
        .mockResolvedValueOnce({
          ...claimedSteer,
          localId: 'blocked-replay-local',
          message: {
            ...claimedSteer.message,
            id: 'm-blocked-replay-local',
            localId: 'blocked-replay-local',
          },
        });
      notifyDaemonConnectedServiceTurnLifecycleMock.mockResolvedValueOnce({
        status: 'input_blocked',
        reason: 'request_auth_source_cutover',
      });

      await expect((client as any).runMaterializeNextPendingMessageInner()).resolves.toEqual({
        didMaterialize: false,
        result: {
          type: 'deferred',
          reason: 'request_auth_source_cutover',
        },
      });
      const materializeCallsBeforeNextPump = materializeNextPendingQueueV2MessageMock.mock.calls.length;
      listPendingQueueV2DeliveryStatusesFromServerMock.mockResolvedValueOnce([
        { localId: 'exact-steer-local', status: 'delivering' },
        { localId: 'blocked-replay-local', status: 'delivering' },
      ]);
      await expect(client.materializeNextPendingMessageSafely()).resolves.toEqual({ type: 'no_pending' });
      expect(materializeNextPendingQueueV2MessageMock).toHaveBeenCalledTimes(materializeCallsBeforeNextPump);
      expect(notifyDaemonConnectedServiceTurnLifecycleMock).toHaveBeenCalledTimes(1);
      expect(received).toHaveLength(0);
      expect((client as any).canonicalPendingDeliveryByLocalId.has('blocked-replay-local')).toBe(true);
    } finally {
      process.argv = originalArgv;
    }
  });

  it('blocks an invalid provider contract instead of parking it in unreleasable local custody', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    // Exact shape both materialize transports produce for a row without a usable provider
    // contract: the flag is raised and the message is dropped
    // (pendingQueueV2Transport `message: providerDeliveryContractInvalid ? null : message`).
    materializeNextPendingQueueV2MessageMock.mockResolvedValueOnce({
      didMaterialize: true,
      localId: 'missing-support-local',
      didWrite: true,
      providerDeliveryContractInvalid: true,
      message: null,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 },
    });

    const originalArgv = process.argv.slice();
    try {
      process.argv = [...originalArgv, '--started-by', 'daemon'];
      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
      await waitForCurrentPendingInputContract(client);
      const received: any[] = [];
      client.onUserMessage((message) => received.push(message));

      await expect((client as any).runMaterializeNextPendingMessageInner()).resolves.toEqual({
        didMaterialize: false,
        result: { type: 'no_pending' },
      });
      expect(notifyDaemonConnectedServiceTurnLifecycleMock).not.toHaveBeenCalled();
      expect(received).toHaveLength(0);
      // Blocked is a visible, user-actionable server state; local custody would be neither.
      expect(blockPendingQueueV2DeliveryMock).toHaveBeenCalledTimes(1);
      expect(blockPendingQueueV2DeliveryMock.mock.calls[0]?.[0]).toMatchObject({
        localId: 'missing-support-local',
        reason: 'unsupported_action',
      });
      expect((client as any).sourceCutoverDeferredPendingLocalIds.has('missing-support-local')).toBe(false);
      expect((client as any).canonicalPendingDeliveryByLocalId.has('missing-support-local')).toBe(false);
    } finally {
      process.argv = originalArgv;
    }
  });

  it('does not deliver a retried same-localId prompt to the agent queue twice', async () => {
    const committedPayloads: any[] = [];
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event, payload) => {
        if (event === 'message') {
          committedPayloads.push(payload);
        }
        return { ok: true, id: 'm1', seq: committedPayloads.length, localId: 'l1' };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    await (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });
    await (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    await flushApiSessionClientMessageCommitQueue(client as any);

    expect(received).toHaveLength(1);
    expect(received[0]?.content?.text).toBe('hello');
    expect(enqueuePendingQueueV2MessageViaHttpMock.mock.calls.map(([request]) => request?.body?.localId)).toEqual(['l1', 'l1']);
    expect(committedPayloads).toHaveLength(0);
  });

  it('does not deliver a buffered transcript echo and buffered RPC prompt with the same body localId', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1 },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    await waitForCurrentPendingInputContract(client);

    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'hello' },
              localId: 'l1',
              meta: { source: 'ui', sentFrom: 'ios' },
            },
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });
    await (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    expect(received).toHaveLength(1);
    expect(received[0]?.content?.text).toBe('hello');
    expect(received[0]?.localId).toBe('l1');
  });

  it('does not deliver a buffered RPC prompt and buffered transcript echo with the same body localId', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1 },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    await waitForCurrentPendingInputContract(client);

    await (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });
    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'hello' },
              localId: 'l1',
              meta: { source: 'ui', sentFrom: 'ios' },
            },
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    expect(received).toHaveLength(1);
    expect(received[0]?.content?.text).toBe('hello');
    expect(received[0]?.localId).toBe('l1');
  });

  it('continues delivering prompts without localId or with distinct localIds', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    await waitForCurrentPendingInputContract(client);

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    await (client as any).enqueueSessionUserMessage({
      text: 'first',
      meta: { source: 'ui', sentFrom: 'ios' },
    });
    await (client as any).enqueueSessionUserMessage({
      text: 'second',
      meta: { source: 'ui', sentFrom: 'ios' },
    });
    await (client as any).enqueueSessionUserMessage({
      text: 'third',
      localId: 'l3',
      meta: { source: 'ui', sentFrom: 'ios' },
    });
    await (client as any).enqueueSessionUserMessage({
      text: 'fourth',
      localId: 'l4',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    expect(received.map((message) => message?.content?.text)).toEqual([
      'first',
      'second',
      'third',
      'fourth',
    ]);
    expect(new Set(received.map((message) => message?.localId)).size).toBe(4);
  });

  it('defaults session.userMessage.send meta source/sentFrom to ui when missing', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    await waitForCurrentPendingInputContract(client);

    const received: any[] = [];
    client.onUserMessage((msg) => received.push(msg));

    await (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { permissionMode: 'yolo' },
    });

    await flushApiSessionClientMessageCommitQueue(client as any);

    const enqueueRequest = enqueuePendingQueueV2MessageViaHttpMock.mock.calls[0]?.[0] as Readonly<{
      sessionId: string;
      body: Readonly<{
        localId: string;
        content: {
          t: 'plain';
          v: { meta?: Readonly<{ source?: string; sentFrom?: string }> };
        };
      }>;
    }>;
    expect(enqueueRequest).toEqual(expect.objectContaining({
      sessionId: 's1',
      body: expect.objectContaining({ localId: 'l1' }),
    }));
    expect(enqueueRequest.body.content.t).toBe('plain');
    expect(enqueueRequest.body.content.v.meta).toEqual(expect.objectContaining({
      source: 'ui',
      sentFrom: 'ui',
    }));
    expect(sessionSocketStub.emitWithAck.mock.calls.some(([event]) => event === 'message')).toBe(false);

    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: enqueueRequest.body.content,
          localId: 'l1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.content?.text).toBe('hello');
  });
});
