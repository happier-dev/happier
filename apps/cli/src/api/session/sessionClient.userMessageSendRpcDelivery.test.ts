import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMockSession as createMockSessionBase,
  createPlainSessionFixture as createPlainSessionFixtureBase,
} from '@/testkit/backends/sessionFixtures';
import {
  createApiSessionSocketStub as createApiSessionSocketStubBase,
  flushApiSessionClientMessageCommitQueue,
  resolveApiSessionSocketDefaultAck,
  type ApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { waitForCondition } from '@/testkit/async/waitFor';
import { decodeBase64, decrypt } from '../encryption';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import * as persistence from '@/persistence';
import * as machineRpc from '@/session/transport/rpc/machineRpc';

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;
let materializedEnqueueCallCount = 0;

function createApiSessionSocketStub(
  options: Parameters<typeof createApiSessionSocketStubBase>[0] = {},
): ApiSessionSocketStub {
  return createApiSessionSocketStubBase({
    ...options,
    emitWithAck: async (event, payload, socket) => {
      if (options.emitWithAck) return await options.emitWithAck(event, payload, socket);
      if (event === 'ping' || event === 'session-runtime-activity-snapshot') {
        return resolveApiSessionSocketDefaultAck(event, payload);
      }
      return options.emitWithAckResult ?? resolveApiSessionSocketDefaultAck(event, payload);
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
import type { SessionClientPort } from './sessionClientPort';
import { createClaudeReadyHandler } from '@/backends/claude/ready/createClaudeReadyHandler';
import { DeferredApiSessionClient, type DeferredApiSessionTarget } from '@/agent/runtime/startup/DeferredApiSessionClient';
import { createClaudeRemoteProviderInputOutcomeBridge } from '@/backends/claude/remote/claudeRemoteProviderInputOutcome';

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
  await client.getRuntimeActivitySnapshotPublisher().publish({ state: 'idle', activeCount: 0 });
  await waitForCondition(
    () => (client as any).sessionSyncPendingInputServerContract?.pendingInput === 'v1',
    { timeoutMs: 5_000, intervalMs: 10, label: 'current Pending-input server contract' },
  );
}

async function waitForReleasedServerPendingInputContract(client: ApiSessionClient): Promise<void> {
  await waitForCondition(
    () => (client as any).sessionSyncPendingInputServerContract?.pendingInput === 'released_server_v0_2_1',
    { timeoutMs: 5_000, intervalMs: 10, label: 'released-server Pending-input server contract' },
  );
}

describe('ApiSessionClient session.userMessage.send delivery', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({
      features: {
        sessions: { enabled: true, usageLimitRecovery: { enabled: true } },
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
    })), { status: 200 })));
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

  it.each(['before', 'after'] as const)('settles a claimed Claude prompt through a deferred client bound %s attach', async (bindingTime) => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainClaudeSessionFixture('deferred-claude'));
    await waitForCurrentPendingInputContract(client);
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-claude',
      limits: { maxEntries: 10, maxBytes: 10_000 },
    });
    if (bindingTime === 'after') await deferred.attach(client as unknown as DeferredApiSessionTarget);
    const staleBridge = createClaudeRemoteProviderInputOutcomeBridge(deferred);
    const bridge = createClaudeRemoteProviderInputOutcomeBridge(deferred);
    if (bindingTime === 'before') await deferred.attach(client as unknown as DeferredApiSessionTarget);

    const receivedLocalIds: Array<string | null | undefined> = [];
    client.onUserMessage((message) => receivedLocalIds.push(message.localId));
    await deferred.enqueueSessionUserMessage({ text: 'hello from local to remote', localId: 'deferred-prompt' });
    expect(receivedLocalIds).toEqual(['deferred-prompt']);
    expect(client.hasCanonicalPendingProviderInputDelivery('deferred-prompt')).toBe(true);
    expect(bridge.hasAccepted(['deferred-prompt'])).toBe(false);

    staleBridge.observeAccepted(['deferred-prompt']);
    expect(client.hasPendingProviderInputAcceptance('deferred-prompt')).toBe(false);
    bridge.observeAccepted(['deferred-prompt']);

    expect(bridge.hasAccepted(['deferred-prompt'])).toBe(true);
    await vi.waitFor(() => expect(client.hasCanonicalPendingProviderInputDelivery('deferred-prompt')).toBe(false));
    expect(resolveAcceptedPendingQueueV2DeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'deferred-claude', localId: 'deferred-prompt',
    }));
  });

  it.each(['provider rejection', 'explicit block', 'termination', 'cancellation'] as const)(
    'preserves deferred provider delivery custody for %s', async (outcome) => {
      sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
      userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
      const client = new ApiSessionClient('tok', createPlainClaudeSessionFixture('deferred-custody'));
      await waitForCurrentPendingInputContract(client);
      const deferred = new DeferredApiSessionClient({
        placeholderSessionId: 'PID-claude',
        limits: { maxEntries: 10, maxBytes: 10_000 },
      });
      const bridge = createClaudeRemoteProviderInputOutcomeBridge(deferred);
      await deferred.attach(client as unknown as DeferredApiSessionTarget);
      client.onUserMessage(() => {});
      await deferred.enqueueSessionUserMessage({ text: 'keep custody', localId: 'custody-prompt' });
      expect(deferred.hasCanonicalPendingProviderInputDelivery('custody-prompt')).toBe(true);
      expect(deferred.hasCanonicalPendingProviderInputDelivery('unclaimed-prompt')).toBe(false);

      const pushSender = { sendToAllDevices: vi.fn() };
      const notifyReady = createClaudeReadyHandler({
        session: deferred,
        pushSender,
        waitingForCommandLabel: 'Claude',
        logPrefix: '[test]',
        getPending: () => null,
        getQueueSize: () => 1,
        hasOnlyBlockedPendingWork: () => (deferred as SessionClientPort).hasOnlyBlockedPendingWork?.() === true,
      });
      notifyReady();
      expect(pushSender.sendToAllDevices).not.toHaveBeenCalled();

      if (outcome === 'provider rejection') {
        bridge.observeRejectedBeforeEffect({
          userMessageLocalIds: ['custody-prompt'], reason: 'provider_rejected_before_acceptance',
        });
      } else if (outcome === 'explicit block') {
        expect(await deferred.blockPendingMessageDelivery({
          localIds: ['custody-prompt'], reason: 'provider_rejected_before_acceptance', providerEffect: 'none',
        })).toBe(true);
      } else {
        if (outcome === 'termination') deferred.beginRuntimeTermination();
        else deferred.cancel();
        bridge.observeAccepted(['custody-prompt']);
      }

      if (outcome === 'provider rejection' || outcome === 'explicit block') {
        await vi.waitFor(() => expect(blockPendingQueueV2DeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
          sessionId: 'deferred-custody', localId: 'custody-prompt', reason: 'provider_rejected_before_acceptance',
        })));
        await vi.waitFor(() => expect(client.hasOnlyBlockedPendingWork()).toBe(true));
        notifyReady();
        expect(pushSender.sendToAllDevices).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
          sessionId: 'deferred-custody',
        });
      } else {
        expect(blockPendingQueueV2DeliveryMock).not.toHaveBeenCalled();
      }
      expect(resolveAcceptedPendingQueueV2DeliveryMock).not.toHaveBeenCalled();
      expect(client.hasPendingProviderInputAcceptance('custody-prompt')).toBe(false);
    },
  );

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

  it('wakes canonical pending reconciliation when durable enqueue races transport contract readiness', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    await waitForCurrentPendingInputContract(client);
    const wakePendingMaterialization = vi.spyOn(client, 'wakePendingMaterialization').mockImplementation(() => {});

    // Simulate the startup/reconnect window: durable enqueue is available, but the negotiated
    // materialization contract has not yet become current for this session generation.
    (client as any).sessionSyncPendingInputServerContract = null;
    await (client as any).enqueueSessionUserMessage({
      text: 'deliver after transport readiness',
      localId: 'transport-race-local',
      meta: { source: 'ui' },
    });

    expect(enqueuePendingQueueV2MessageViaHttpMock).toHaveBeenCalledTimes(1);
    expect(wakePendingMaterialization).toHaveBeenCalledTimes(1);
  });

  it('revalidates paused recovery exactly once before accepting a fresh direct prompt', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    await waitForCurrentPendingInputContract(client);
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

  it('keeps active recovery checks with the daemon owner rather than the provider-local recovery loop', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const fixture = createPlainSessionFixture({ id: 's1' });
    const client = new ApiSessionClient('tok', {
      ...fixture,
      metadata: {
        ...fixture.metadata,
        sessionUsageLimitRecoveryV1: {
          v: 1,
          status: 'waiting',
          issueFingerprint: 'usage-limit:codex:turn-1:1:1000',
          runtimeAuthRecoveryAttemptId: 'attempt-1',
          armedAtMs: 1,
          resetAtMs: 1000,
          nextCheckAtMs: 1000,
          attemptCount: 0,
          maxAttempts: 5,
          lastProbeError: null,
          resumePromptMode: 'standard',
          selectedAuth: { kind: 'profile', serviceId: 'openai-codex', profileId: 'profile-1' },
        },
      },
    });
    const localControl = vi.fn(async () => ({ ok: true, status: 'resumed' }));
    client.setSessionRuntimeControls({ checkUsageLimitRecoveryNow: localControl });
    const credentialRead = vi.spyOn(persistence, 'readCredentials').mockResolvedValue({
      token: 'tok', encryption: { type: 'legacy', secret: new Uint8Array(32) },
    });
    const daemonCheck = vi.spyOn(machineRpc, 'callMachineRpc').mockResolvedValue({ ok: true, status: 'waiting' });
    try {
      await waitForCurrentPendingInputContract(client);
      // Use the real registered control through its RPC boundary; no recovery owner is mocked.
      const result = await client.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW, {
        sessionId: 's1', provider: 'codex', resumePromptMode: 'custom',
      });
      expect(result).toMatchObject({ ok: true, status: 'waiting' });
      expect(daemonCheck).toHaveBeenCalledWith(expect.objectContaining({
        machineId: 'machine-1',
        method: RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW,
        request: { sessionId: 's1', provider: 'codex', resumePromptMode: 'custom' },
        authorization: { kind: 'session.write', sessionId: 's1' },
      }));
      expect(localControl).not.toHaveBeenCalled();

      const received: unknown[] = [];
      client.onUserMessage((message) => received.push(message));
      const prompt = await client.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, {
        text: 'explicit retry', localId: 'owned-retry', meta: { source: 'ui' },
      });
      expect(prompt).toMatchObject({ ok: true, providerAcceptancePending: true });
      expect(enqueuePendingQueueV2MessageViaHttpMock).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 's1', body: expect.objectContaining({ localId: 'owned-retry' }),
      }));
      expect(daemonCheck).toHaveBeenCalledTimes(1);
      expect(received).toHaveLength(1);
      expect(localControl).not.toHaveBeenCalled();

      daemonCheck.mockRejectedValueOnce(new Error('daemon unavailable'));
      const unavailable = await client.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW, { sessionId: 's1' });
      expect(unavailable).toMatchObject({ ok: false, errorCode: 'session_usage_limit_recovery_control_remote_unavailable' });
      expect(localControl).not.toHaveBeenCalled();

      const providerAction = await client.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW, {
        sessionId: 's1', operation: 'switch_account_now',
      });
      expect(providerAction).toMatchObject({ ok: true, status: 'resumed' });
      expect(localControl).toHaveBeenLastCalledWith({ sessionId: 's1', operation: 'switch_account_now' });
    } finally {
      credentialRead.mockRestore();
      daemonCheck.mockRestore();
      await client.close();
    }
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

  it('durably enqueues generated session input without treating it as an explicit recovery prompt', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm-generated', seq: 1, localId: 'generated-run-completion' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const checkUsageLimitRecoveryNow = vi.fn(async () => ({ ok: true, status: 'waiting' }));
    (client as any).sessionRuntimeControls.checkUsageLimitRecoveryNow = checkUsageLimitRecoveryNow;

    await expect((client as any).enqueueSessionUserMessage({
      text: 'execution run finished',
      localId: 'generated-run-completion',
      meta: { source: 'execution_run' },
      inputOrigin: 'session_generated',
    })).resolves.toBeUndefined();

    expect(checkUsageLimitRecoveryNow).not.toHaveBeenCalled();
    expect(enqueuePendingQueueV2MessageViaHttpMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      body: expect.objectContaining({ localId: 'generated-run-completion', messageRole: 'user' }),
    }));
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

  it('delivers a first prompt when recovery control is unsupported before the provider runtime exists', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm-first', seq: 1, localId: 'first-prompt' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const checkUsageLimitRecoveryNow = vi.fn(async () => ({
      ok: false,
      errorCode: 'unsupported_session_runtime_method',
      error: 'unsupported_session_runtime_method:session.usageLimit.checkNow',
    }));
    (client as any).sessionRuntimeControls.checkUsageLimitRecoveryNow = checkUsageLimitRecoveryNow;
    client.onUserMessage(() => undefined);

    await expect((client as any).enqueueSessionUserMessage({
      text: 'create the first provider turn',
      localId: 'first-prompt',
      meta: { source: 'ui' },
    })).resolves.toBeUndefined();

    expect(checkUsageLimitRecoveryNow).toHaveBeenCalledTimes(1);
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

  it('admits explicit input while generic recovery retains the automatic quota wait', async () => {
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
    await waitForCurrentPendingInputContract(client);
    const received: any[] = [];
    client.onUserMessage((message) => received.push(message));

    await expect((client as any).enqueueSessionUserMessage({
      text: 'fresh Claude prompt',
      localId: 'request-missing-control',
      meta: { source: 'ui' },
    })).resolves.toEqual({ providerAcceptancePending: true });

    expect(received).toHaveLength(1);
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

  it('delivers persisted Pending once without waiting for a daemon lifecycle response', async () => {
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
      await waitForCondition(() => received.length === 1, {
        timeoutMs: 1_000,
        label: 'prompt delivery while daemon notification remains pending',
      });
      expect(order.filter((phase) => phase !== 'authorize')).toEqual(['persist', 'provider']);
      expect(notifyDaemonConnectedServiceTurnLifecycleMock).toHaveBeenCalledExactlyOnceWith({
        sessionId: 's1',
        event: 'prompt_or_steer',
        requestedAction: { v: 1, kind: 'enqueue' },
        activeTurnId: null,
      });
      expect(received).toHaveLength(1);

      const release = ((value: ((result: unknown) => void) | null): ((result: unknown) => void) => {
        if (typeof value !== 'function') {
          throw new Error('expected pending daemon lifecycle notification');
        }
        return value;
      })(releaseLifecycleNotify);
      release({ error: 'connected_service_turn_lifecycle_timeout' });
      await enqueuePromise;
      await (client as any).daemonTurnLifecycleNotifyTail;
      await (client as any).enqueueSessionUserMessage({
        text: 'hello',
        localId: 'l1',
        meta: { source: 'ui', sentFrom: 'ios' },
        requestedAction: { v: 1, kind: 'enqueue' },
      });

      expect(order.filter((phase) => phase !== 'authorize')).toEqual(['persist', 'provider']);
      expect(received).toHaveLength(1);
      expect(received[0]?.content?.text).toBe('hello');
      expect(blockPendingQueueV2DeliveryMock).not.toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
    }
  });

  it.each([
    ['handler unavailable', { error: 'handler unavailable' }],
    ['malformed continue', { status: 'continue' }],
    ['transport loss', new Error('daemon transport lost')],
  ] as const)('delivers admitted input despite daemon notification %s', async (_label, outcome) => {
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
      expect(received).toHaveLength(1);
      expect(blockPendingQueueV2DeliveryMock).not.toHaveBeenCalled();
      expect((client as any).canonicalPendingDeliveryByLocalId.has('fail-closed-local')).toBe(true);
      expect((client as any).serverBlockedCanonicalPendingDeliveryLocalIds.has('fail-closed-local')).toBe(false);
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
    } finally {
      transcriptLookup.mockRestore();
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
    await waitForCurrentPendingInputContract(client);

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
