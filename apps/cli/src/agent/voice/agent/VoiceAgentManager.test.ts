import { describe, expect, it, onTestFinished, vi } from 'vitest';
import axios from 'axios';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';

import { ProviderBoundModelRefSchema, buildBackendTargetKeyV2, createVoiceAgentOutputTurnV1, ingestVoiceAgentOutputEventV1, VOICE_OUTPUT_INCOMPLETE_TEXT } from '@happier-dev/protocol';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type { BackendFactory, ResolveVoicePromptPreparationArgs, VoiceAgentTurnStreamEvent } from './voiceAgentTypes';
import { VoiceAgentError, VoiceAgentManager } from './VoiceAgentManager';
import { ConnectedServiceSpawnProfileActionRequiredError } from '@/daemon/connectedServices/resolveConnectedServiceAuthForSpawn';
import { createVoiceSessionRuntimeThroughNativeFactory } from '@/agent/runtime/bridges/executionRun/testkit/nativeSessionContext';
import type { AgentRuntime, AgentSessionOpenRequest, AgentSessionRuntimeContext, AgentSessionRuntimeEvent, AgentSessionSendRequest, AgentSessionSendResult } from '@happier-dev/plugin-sdk/agents/runtime';
import { ApiSessionClient } from '@/api/session/sessionClient';
import { createTestApiSessionClient } from '@/testkit/backends/createTestApiSessionClient';
import { createAccountEncryptionCurrentnessFixture, createPlainSessionFixture, createSessionNotificationContextFixture, createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createApiSessionSocketStub, createSessionRuntimeActivityHomeStub, createSessionTurnMutationAppliedSocketAck } from '@/testkit/backends/apiSessionSocketHarness';
import { createSessionFollowContextReconciler } from '@/agent/runtime/session/follow/sessionFollowContextReconciler';
import { createSessionFollowSourceHydrator, resolveAccountVoiceFollowDisclosure } from '@/agent/runtime/session/follow/sessionFollowSourceHydrator';
import { resolveSessionFollowContextUtf8AllowanceV1 } from '@/agent/runtime/session/follow/sessionFollowContextBudget';
import { SessionTurnMutationV1Schema } from '@happier-dev/protocol';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import type { SessionProviderInputOutcome } from '@/agent/runtime/session/input/providerInputOutcome';
import { ACCOUNT_VOICE_FOLLOW_OBSERVE_PENDING_EVENT_V1, ACCOUNT_VOICE_FOLLOW_ACKNOWLEDGE_EVENT_V1,
  AccountVoiceFollowObservePendingRequestV1Schema, AccountVoiceFollowObservePendingResponseV1Schema,
  AccountVoiceFollowAcknowledgeRequestV1Schema, AccountVoiceFollowAcknowledgeResponseV1Schema,
  type AccountVoiceFollowAcknowledgeRequestV1,
} from '@happier-dev/protocol/sessions/follow/accountVoiceFollowTransportV1';
import type { z } from 'zod';
type AccountVoiceFollowObservePendingRequestV1 = z.infer<typeof AccountVoiceFollowObservePendingRequestV1Schema>;
import { SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1, SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
  SessionTranscriptObservationCapabilityAckSchema, SessionTranscriptObservationCapabilityRequestSchema,
  SessionTranscriptObservationInputSchema, SessionTranscriptObservationAckV1Schema,
} from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
import { resolveCliVoicePromptStackBlocks, resolveCliVoicePromptPreparation } from '@/agent/prompts/library/resolveCliVoicePromptStackBlocks';
import { ArtifactEncryptionMaterialUnavailableError } from '@/api/artifacts/accountArtifactStore';
import { buildMemoryRecallGuidanceBlockV1 } from '@happier-dev/protocol/prompts/memoryRecallGuidanceV1';
import { applyExecutionRunAction } from '@/agent/runtime/bridges/executionRun/executionRunApplyAction';
import { startVoiceAgentTurnStream, readVoiceAgentTurnStream, cancelVoiceAgentTurnStream } from '@/agent/runtime/bridges/executionRun/voiceAgentTurnStreams';
import { ExecutionRunTurnStreamReadResponseSchema } from '@happier-dev/protocol/execution/runs/streaming';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { readSettings, updateSettings, writeSettings } from '@/persistence';
import { DEFAULT_MEMORY_SETTINGS } from '@/settings/memorySettings';
import { resolveCausalPermissionMode } from '@/agent/permissions/causalPermissionMode';
import { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';

type VoiceTestRuntime<T extends object = object> = ExecutionRunHostRuntime & T;

function createInstructionBlocksResolver(readMarkdown: () => Promise<string>) {
  return async (args: ResolveVoicePromptPreparationArgs) => ({ systemAppendBlocks: await resolveCliVoicePromptStackBlocks({
    ...args,
    sessionMetadata: { work: { promptStack: [{ id: 'instruction', ref: { kind: 'doc', artifactId: 'instruction' },
      enabled: true, placement: 'system_append', required: true }] } },
    readArtifact: async ({ artifactId }) => ({
      id: artifactId,
      header: { v: 1, kind: 'prompt_doc.v2', title: 'Instructions' },
      revision: { headerVersion: 1, bodyVersion: 1 },
      body: JSON.stringify({ v: 1, markdown: await readMarkdown(), createdAtMs: 1, updatedAtMs: 2 }),
    }),
    readArtifactHeader: async () => ({ header: { v: 1, kind: 'prompt_doc.v2', title: 'Instructions' } }),
  }), memoryRecallGuidanceEnabled: false, disabledActionIds: [] });
}

async function readVoiceAgentTurnStreamUntilDone(args: Readonly<{
  manager: {
    readTurnStream: (params: Readonly<{
      voiceAgentId: string;
      streamId: string;
      cursor: number;
      maxEvents?: number;
      waitForEvents?: boolean;
    }>) => Promise<{
      streamId: string;
      events: VoiceAgentTurnStreamEvent[];
      nextCursor: number;
      done: boolean;
    }>;
  };
  voiceAgentId: string;
  streamId: string;
  maxEvents?: number;
  maxReads?: number;
}>): Promise<VoiceAgentTurnStreamEvent[]> {
  const events: VoiceAgentTurnStreamEvent[] = [];
  let cursor = 0;

  for (let i = 0; i < (args.maxReads ?? 8); i += 1) {
    const read = await args.manager.readTurnStream({
      voiceAgentId: args.voiceAgentId,
      streamId: args.streamId,
      cursor,
      waitForEvents: true,
      ...(typeof args.maxEvents === 'number' ? { maxEvents: args.maxEvents } : {}),
    });
    events.push(...read.events);
    cursor = read.nextCursor;
    if (read.done) {
      return events;
    }
    await Promise.resolve();
  }

  return events;
}

type VoiceProviderEvent<T = AgentSessionRuntimeEvent> = T extends AgentSessionRuntimeEvent
  ? Omit<T, 'sessionId' | 'sequence' | 'emittedAtMs'>
  : never;

function createDeterministicBackend(label: string, options: Readonly<{
  session?: ApiSessionClient;
  emitAdmissionEvents?: boolean;
  resumeSupported?: boolean;
  providerSessionId?: string;
  onOpen?: (request: AgentSessionOpenRequest, context: AgentSessionRuntimeContext) => void | Promise<void>;
  onSend?: (request: AgentSessionSendRequest, publish: (event: VoiceProviderEvent) => void) => void | AgentSessionSendResult | Promise<void | AgentSessionSendResult>;
  onCancel?: (turnId: string, publish: (event: VoiceProviderEvent) => void) => void | Promise<void>;
  onWatch?: (listener: (event: AgentSessionRuntimeEvent) => void) => void;
  onWatchDispose?: () => void | Promise<void>;
  onDispose?: () => void | Promise<void>;
}> = {}): VoiceTestRuntime<{ getSeenPrompts(): string[]; publish(event: VoiceProviderEvent): void }> {
  const seenPrompts: string[] = [];
  const sessionId = `s-${label}`;
  const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
  let sequence = 0;
  const publish = (event: VoiceProviderEvent) => {
    const value = { ...event, sessionId: 'session-parent', sequence: sequence++, emittedAtMs: 1 };
    for (const listener of listeners) listener(value);
  };
  // Agent SDK boundary only; native admission, output projection and lifecycle stay real.
  const runtime: AgentRuntime = { sessions: { async open(request, context) {
    if (options.onOpen) await options.onOpen(request, context);
    return {
    watch(listener) {
      options.onWatch?.(listener);
      listeners.add(listener);
      listener({ kind: 'provider-session-id', sessionId: 'session-parent', providerSessionId: request.kind === 'resume' ? request.providerSessionId : options.providerSessionId ?? sessionId, sequence: sequence++, emittedAtMs: 1 });
      return { dispose() { listeners.delete(listener); return options.onWatchDispose?.(); } };
    },
    async send(request) {
      const prompt = request.input.text;
      seenPrompts.push(prompt);
      const turnId = request.delivery.turnId;
      if (options.emitAdmissionEvents !== false) {
        publish({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
        publish({ kind: 'turn-start', turnId, startedBy: 'host' });
      }
      if (options.onSend) {
        const result = await options.onSend(request, publish);
        if (result) return result;
      }
      else {
        publish({ kind: 'message-delta', turnId, channel: 'assistant', text: `${label}:${prompt}` });
        publish({ kind: 'turn-complete', turnId });
      }
      return { status: 'admitted' as const };
    },
    async cancel(request) {
      await options.onCancel?.(request.turnId, publish);
      return { status: 'requested' as const, turnId: request.turnId };
    },
    async dispose() { listeners.clear(); await options.onDispose?.(); },
  }; } } };
  const host = createVoiceSessionRuntimeThroughNativeFactory({
    runtime, modelId: label, session: options.session, capabilities: {
      open: options.resumeSupported === false ? ['create'] : ['create', 'resume'], delivery: ['newTurn'], cancel: true,
    },
  });
  return Object.defineProperties({
    ...host,
    getSeenPrompts: () => [...seenPrompts],
    publish,
  }, Object.getOwnPropertyDescriptors(host));
}

async function createAccountVoiceFollowTransportFixture(options: Readonly<{
  localId: string;
  userMessageSeq: number;
  holdHydration?: boolean;
  holdAdmission?: boolean;
}>) {
  const credentials = { token: 'voice-follow-token', encryption: null };
  const sessionId = 'session-parent';
  const sourceSessionId = 'source-follow-session-0123456789';
  const machineId = 'voice-fixture-machine';
  const observed = { transcriptSeq: 4, readyEventSeq: 0, agentStateVersion: 0, turn: null };
  const observeRequests: AccountVoiceFollowObservePendingRequestV1[] = [];
  const acknowledgements: AccountVoiceFollowAcknowledgeRequestV1[] = [];
  const home = createSessionRuntimeActivityHomeStub({ machineId });
  let announceHydration!: () => void;
  const hydrationStarted = new Promise<void>((resolve) => { announceHydration = resolve; });
  let releaseHydration!: () => void;
  const hydrationReleased = new Promise<void>((resolve) => { releaseHydration = resolve; });
  const source = {
    ...createSessionNotificationContextFixture(sourceSessionId),
    encryptionMode: 'plain' as const,
    metadata: JSON.stringify(createTestMetadata({ path: '/repo/source', host: 'source-host' })),
    agentState: JSON.stringify({}), active: true, activeAt: Date.now(),
  };
  const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { session: {
    runtimeActivity: { protocolVersion: 2 }, pendingInput: { protocolVersion: 1 }, publisherAuthority: { protocolVersion: 1 },
  } } });
  // The real connection supervisor negotiates over Fetch, separately from the
  // source-content Axios reads. Both network leaves must describe the same Home.
  const fetchBoundary = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    return path === '/v1/features' || path === '/v1/features/authenticated'
      ? Response.json(features)
      : Response.json({}, { status: 404 });
  });
  // Only Socket/HTTP leaves are scripted. ApiSessionClient owns committed seq,
  // the native factory owns custody, and the real hydrator/reconciler own Follow.
  const http = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/auth/ping') return { status: 200, data: { ok: true } };
    if (path === '/v1/account/encryption/currentness') {
      return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    }
    if (path === `/v2/sessions/${sourceSessionId}` || path === `/v1/sessions/${sourceSessionId}`) {
      announceHydration();
      if (options.holdHydration) {
        // The real HTTP boundary observes the caller's abort signal. Keep
        // hydration held until cancellation, rather than making it finish first.
        const signal = config?.signal;
        await new Promise<void>((resolve, reject) => {
          const aborted = () => reject(new Error('Source hydration aborted'));
          if (signal?.aborted) { aborted(); return; }
          signal?.addEventListener?.('abort', aborted, { once: true });
          hydrationReleased.then(() => {
            signal?.removeEventListener?.('abort', aborted);
            resolve();
          });
        });
      }
      return { status: 200, data: { session: source } };
    }
    if (path === `/v1/sessions/${sourceSessionId}/messages`) {
      return { status: 200, data: { messages: [{
        id: 'source-update-4', seq: 4, createdAt: 4,
        content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'SOURCE FOLLOW UPDATE' } } },
      }], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null } };
    }
    return { status: 404, data: {} };
  });
  const socket = createApiSessionSocketStub({
    connected: true,
    emit(event, args) {
      if (event === 'ping' && typeof args[0] === 'function') args[0]();
    },
    emitWithAck(event, payload) {
      if (event === ACCOUNT_VOICE_FOLLOW_OBSERVE_PENDING_EVENT_V1) {
        observeRequests.push(AccountVoiceFollowObservePendingRequestV1Schema.parse(payload));
        const response = AccountVoiceFollowObservePendingResponseV1Schema.parse({
          ok: true, v: 1, voiceSessionId: sessionId, publisherGeneration: '3',
          executionRunOccurrenceId: 'voice-occurrence',
          observations: [{ sourceSessionId, voiceSessionId: sessionId, expected: null, observed }],
        });
        if (options.holdAdmission) {
          announceHydration();
          return hydrationReleased.then(() => response);
        }
        return response;
      }
      if (event === ACCOUNT_VOICE_FOLLOW_ACKNOWLEDGE_EVENT_V1) {
        acknowledgements.push(AccountVoiceFollowAcknowledgeRequestV1Schema.parse(payload));
        return AccountVoiceFollowAcknowledgeResponseV1Schema.parse({
          ok: true, v: 1, voiceSessionId: sessionId, sourceSessionId, delivered: observed,
        });
      }
      if (event === 'session-turn-mutation') {
        return createSessionTurnMutationAppliedSocketAck(SessionTurnMutationV1Schema.parse(payload));
      }
      if (event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1) {
        SessionTranscriptObservationCapabilityRequestSchema.parse(payload);
        return SessionTranscriptObservationCapabilityAckSchema.parse({ ok: true, capability: 'session-transcript-observation-v1' });
      }
      if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) {
        const observation = SessionTranscriptObservationInputSchema.parse(payload);
        return SessionTranscriptObservationAckV1Schema.parse({
          ok: true, status: 'observed', id: 'observed-agent-message', seq: options.userMessageSeq + 1,
          localId: observation.localId, didWrite: true, ingestedAt: 200,
        });
      }
      const activity = home.answer(event, payload);
      if (activity) return activity;
      const message = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown> : null;
      return { ok: true, id: 'committed-agent-message', seq: options.userMessageSeq + 1, localId: message?.localId };
    },
  });
  const session = createTestApiSessionClient(ApiSessionClient, credentials.token,
    createPlainSessionFixture({ id: sessionId }), {
      metadataAuthority: { kind: 'owner', credentials, readCurrentCredentials: async () => credentials },
      localMachineId: machineId,
      transport: {
        serverId: 'voice-follow-home', serverUrl: 'https://voice-follow.example.test',
        // The incumbent Socket.IO fixture is deliberately structural at this
        // external boundary; the Session transport/supervisor remain real.
        createSessionSocketTransport: () => ({ socket: socket as never, transport: createSocketTransportAdapter(socket as never) }),
      },
    });
  try {
    await vi.waitFor(() => expect(socket.getHandler('update')).toBeTypeOf('function'));
    await vi.waitFor(() => expect(session.getServerFeaturesSnapshot()?.status).toBe('ready'));
    socket.trigger('update', { id: 'committed-voice-user', createdAt: Date.now(), body: {
      t: 'new-message', delivery: 'full' as const, sid: sessionId, message: {
        id: 'voice-user-message', seq: options.userMessageSeq, localId: options.localId, messageRole: 'user',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'what changed?' }, meta: { sentFrom: 'cli' } } },
      },
    } });
    expect(session.getCommittedUserMessageSeq(options.localId)).toBe(options.userMessageSeq);
  } catch (error) {
    releaseHydration();
    try { await session.close(); } finally { http.mockRestore(); fetchBoundary.mockRestore(); }
    throw error;
  }
  const reconcile = createSessionFollowContextReconciler({
    session, observer: { kind: 'account_voice', accountId: 'account', voiceSessionId: sessionId },
    hydrateObservation: createSessionFollowSourceHydrator({
      session, credentials, disclosure: resolveAccountVoiceFollowDisclosure({ voice: {
        privacy: { shareSessionSummary: true, shareRecentMessages: true },
        ui: { updates: { activeSession: 'snippets', snippetsMaxMessages: 2 } },
      } }),
    }),
  });
  return {
    session, observeRequests, acknowledgements, hydrationStarted, releaseHydration,
    prepareFollowContext: async ({ executionRunId, requiredPrompt, signal }: Readonly<{
      executionRunId: string; requiredPrompt: string; signal: AbortSignal;
    }>) => await reconcile({ executionRunId, signal, maxFollowContextUtf8Bytes:
      resolveSessionFollowContextUtf8AllowanceV1({ requiredPrompt, activeModelId: null, contextUsage: null }).maxUtf8Bytes }),
    async dispose() {
      releaseHydration();
      try { await session.close(); } finally { http.mockRestore(); fetchBoundary.mockRestore(); }
    },
  };
}

function createDeltaOnlyBackend(label: string): ExecutionRunHostRuntime {
  let n = 0;
  return createDeterministicBackend(label, {
    onSend(request, publish) {
      n += 1;
      publish({ kind: 'message-delta', turnId: request.delivery.turnId, channel: 'assistant', text: `${label}:${n}` });
      publish({ kind: 'turn-complete', turnId: request.delivery.turnId });
    },
  });
}

function createBlockingBackend(label: string, opts: Readonly<{ waitForSendPrompt: () => Promise<void> }>): ExecutionRunHostRuntime {
  return createDeterministicBackend(label, {
    async onSend(request, publish) {
      publish({ kind: 'message-delta', turnId: request.delivery.turnId, channel: 'assistant', text: `${label}:${request.input.text}` });
      await opts.waitForSendPrompt();
      publish({ kind: 'turn-complete', turnId: request.delivery.turnId });
    },
  });
}

function createMultiDeltaBackend(label: string, deltas: string[]): ExecutionRunHostRuntime {
  return createDeterministicBackend(label, {
    onSend(request, publish) {
      for (const textDelta of deltas) {
        publish({ kind: 'message-delta', turnId: request.delivery.turnId, channel: 'assistant', text: textDelta });
      }
      publish({ kind: 'turn-complete', turnId: request.delivery.turnId });
    },
  });
}

function createDelayedCompletionBackend(
  label: string,
): VoiceTestRuntime<{ completeCurrentResponse: () => void; appendDelta: (text: string) => void; hasCurrentResponse: () => boolean }> {
  let lastPrompt = '';
  let turnId: string | undefined;
  let resolveCurrent: (() => void) | null = null;
  let currentResponseDone: Promise<void> | null = null;
  let pendingComplete = false;

  const runtime = createDeterministicBackend(label, {
    onSend(request, publish) {
      lastPrompt = request.input.text;
      turnId = request.delivery.turnId;
      currentResponseDone = new Promise<void>((resolve) => {
        resolveCurrent = () => {
          publish({ kind: 'message-delta', turnId: request.delivery.turnId, channel: 'assistant', text: `${label}:${lastPrompt}` });
          publish({ kind: 'turn-complete', turnId: request.delivery.turnId });
          resolve();
          resolveCurrent = null;
          currentResponseDone = null;
        };
      });
      if (pendingComplete) {
        pendingComplete = false;
        resolveCurrent?.();
      }
    },
  });
  return Object.defineProperties({ ...runtime,
    hasCurrentResponse: () => currentResponseDone !== null,
    appendDelta(text: string) {
      if (!turnId) throw new Error('Provider turn has not started');
      runtime.publish({ kind: 'message-delta', turnId, channel: 'assistant', text });
    },
    completeCurrentResponse() {
      if (resolveCurrent) {
        pendingComplete = false;
        resolveCurrent();
      } else {
        pendingComplete = true;
      }
    },
  }, Object.getOwnPropertyDescriptors(runtime));
}

function createCancelableBlockingBackend(
  label: string,
  onDispose?: () => void | Promise<void>,
): VoiceTestRuntime<{ wasCancelled: () => boolean; getSeenPrompts(): string[] }> {
  let cancelled = false;
  const runtime = createDeterministicBackend(label, {
    onDispose,
    onSend(request, publish) {
      publish({ kind: 'message-delta', turnId: request.delivery.turnId, channel: 'assistant', text: `${label}:${request.input.text}` });
    },
    onCancel(turnId, publish) {
      cancelled = true;
      publish({ kind: 'turn-cancelled', turnId, cause: 'user' });
      publish({ kind: 'runtime-ended', cause: 'connectionLost', retryable: true });
    },
  });
  return Object.defineProperties({ ...runtime,
    wasCancelled: () => cancelled,
  }, Object.getOwnPropertyDescriptors(runtime));
}

function createLateResolvingCancellationBackend(
  responseText: string,
): VoiceTestRuntime<{ wasCancelled: () => boolean; getSeenPrompts(): string[] }> {
  let cancelled = false;

  const runtime = createDeterministicBackend('late-cancel', {
    onSend() {},
    onCancel(turnId, publish) {
      cancelled = true;
      // Model output arriving as cancellation resolves is the race W0.6 must
      // make terminal: it must not become a delta, action, history, or commit input.
      publish({ kind: 'message-delta', turnId, channel: 'assistant', text: responseText });
      publish({ kind: 'turn-cancelled', turnId, cause: 'user' });
      publish({ kind: 'runtime-ended', cause: 'connectionLost', retryable: true });
    },
  });

  return Object.defineProperties({ ...runtime,
    wasCancelled: () => cancelled,
  }, Object.getOwnPropertyDescriptors(runtime));
}

function createPostDetachOutputBackend(cancelledText: string): VoiceTestRuntime<{ getSeenPrompts(): string[]; emitLateOutput(): void }> {
  let lastTurnId: string | undefined;
  const runtime = createDeterministicBackend('post-detach-cancel', {
    onSend(request, publish) {
      lastTurnId = request.delivery.turnId;
      if (request.input.text.includes('cancel this turn')) {
        return;
      }
      publish({ kind: 'message-delta', turnId: request.delivery.turnId, channel: 'assistant', text: cancelledText });
      publish({ kind: 'turn-complete', turnId: request.delivery.turnId });
    },
    onCancel(turnId, publish) {
      publish({ kind: 'turn-cancelled', turnId, cause: 'user' });
      publish({ kind: 'runtime-ended', cause: 'connectionLost', retryable: true });
    },
  });
  return Object.defineProperties({ ...runtime, emitLateOutput() {
    if (!lastTurnId) throw new Error('Provider turn has not started');
    runtime.publish({ kind: 'message-delta', turnId: lastTurnId, channel: 'assistant', text: cancelledText });
  } }, Object.getOwnPropertyDescriptors(runtime));
}

function createStaticResponseBackend(label: string, responseText: string): ExecutionRunHostRuntime {
  return createDeterministicBackend(label, {
    onSend(request, publish) {
      publish({ kind: 'message-delta', turnId: request.delivery.turnId, channel: 'assistant', text: responseText });
      publish({ kind: 'turn-complete', turnId: request.delivery.turnId });
    },
  });
}

function createPromptCaptureBackend(
  sequence: Array<{ responseText: string }>,
  options?: Readonly<{ resumeSupported?: boolean }>,
): VoiceTestRuntime<{ prompts: string[] }> {
  const prompts: string[] = [];
  let idx = 0;

  const runtime = createDeterministicBackend('capture', {
    resumeSupported: options?.resumeSupported === true,
    onSend(request, publish) {
      prompts.push(request.input.text);
      const next = sequence[Math.min(idx, sequence.length - 1)];
      idx += 1;
      publish({ kind: 'message-delta', turnId: request.delivery.turnId, channel: 'assistant', text: next?.responseText ?? '' });
      publish({ kind: 'turn-complete', turnId: request.delivery.turnId });
    },
  });
  return Object.defineProperties({ ...runtime, prompts }, Object.getOwnPropertyDescriptors(runtime));
}

describe('VoiceAgentManager', () => {
  it('accepts a completed nonliteral warm-up turn and never replays its text', async () => {
    const backend = createPromptCaptureBackend([
      { responseText: 'Warm-up completed successfully.' }, { responseText: 'Real answer.' }, { responseText: 'Instruction.' },
    ]);
    const manager = new VoiceAgentManager({ createRuntime: () => backend });
    try {
      const { voiceAgentId } = await manager.start({ backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        chatModelId: 'chat-model', commitModelId: 'chat-model', permissionIntent: 'read-only',
        idleTtlSeconds: 3600, initialContext: 'WARM_CONTEXT', bootstrapMode: 'ready_handshake' });
      expect(backend.prompts).toHaveLength(1);
      await expect(manager.sendTurn({ voiceAgentId, userText: 'Real question.' })).resolves.toEqual({ assistantText: 'Real answer.' });
      expect(backend.prompts[1]).not.toContain('WARM_CONTEXT');
      await manager.commit({ voiceAgentId });
      expect(backend.prompts[2]).not.toContain('Warm-up completed successfully.');
    } finally { await manager.dispose(); }
  });

  it.each([73, Number.NaN])('retires at the chosen or canonical idle deadline without a sweep (%s)', async ttl => {
    const { VoiceLocalConversationSchema } = await import('@happier-dev/protocol/voice/settings/localConversation');
    const expectedTtlMs = (Number.isFinite(ttl) ? ttl : VoiceLocalConversationSchema.parse({}).agent.idleTtlSeconds) * 1000;
    vi.useFakeTimers();
    const reaped: string[] = [];
    const manager = new VoiceAgentManager({ createRuntime: () => createDeterministicBackend('idle-deadline'),
      onIdleReaped: async id => { reaped.push(id); } });
    try {
      const { voiceAgentId } = await manager.start({ backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        chatModelId: 'chat-model', commitModelId: 'chat-model', permissionIntent: 'read-only',
        idleTtlSeconds: ttl, initialContext: '' });
      await vi.advanceTimersByTimeAsync(expectedTtlMs - 1);
      expect(reaped).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(reaped).toEqual([voiceAgentId]);
      await vi.advanceTimersByTimeAsync(expectedTtlMs);
      expect(reaped).toEqual([voiceAgentId]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { await manager.dispose(); vi.useRealTimers(); }
  });

  it('pauses the idle deadline during native work and gives completion a full idle lifetime', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const admitted = new Promise<void>(resolve => { entered = resolve; });
    const reaped: string[] = [];
    const backend = createBlockingBackend('idle-during-work', { waitForSendPrompt: () => { entered(); return held; } });
    vi.useFakeTimers();
    const manager = new VoiceAgentManager({ createRuntime: () => backend,
      onIdleReaped: async id => { reaped.push(id); } });
    let sending: ReturnType<VoiceAgentManager['sendTurn']> | undefined;
    try {
      const { voiceAgentId } = await manager.start({ backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        chatModelId: 'chat', commitModelId: 'chat', permissionIntent: 'read-only', idleTtlSeconds: 73, initialContext: '' });
      sending = manager.sendTurn({ voiceAgentId, userText: 'Take your time.' });
      await admitted;
      await vi.advanceTimersByTimeAsync(146_000);
      expect(reaped).toEqual([]);
      release();
      await sending;
      await vi.advanceTimersByTimeAsync(72_999);
      expect(reaped).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(reaped).toEqual([voiceAgentId]);
    } finally { release(); await sending?.catch(() => {}); await manager.dispose(); vi.useRealTimers(); }
  });

  it('allows a native turn beyond the former 120 second response cutoff and still cancels it', async () => {
    let entered!: () => void;
    const sending = new Promise<void>(resolve => { entered = resolve; });
    let enteredAgain!: () => void;
    const sendingAgain = new Promise<void>(resolve => { enteredAgain = resolve; });
    let sends = 0;
    let complete: (() => void) | undefined;
    const backend = createDeterministicBackend('long-native-turn', {
      onSend(request, publish) {
        complete = () => {
          publish({ kind: 'message-delta', turnId: request.delivery.turnId, channel: 'assistant', text: 'Finished.' });
          publish({ kind: 'turn-complete', turnId: request.delivery.turnId });
        };
        sends += 1;
        if (sends === 1) entered();
        else enteredAgain();
      },
      onCancel(turnId, publish) {
        complete = undefined;
        publish({ kind: 'turn-cancelled', turnId, cause: 'user' });
      },
    });
    const manager = new VoiceAgentManager({ createRuntime: () => backend });
    const { voiceAgentId } = await manager.start({ backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model', commitModelId: 'chat-model', permissionIntent: 'read-only',
      idleTtlSeconds: 3600, initialContext: '' });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      const { streamId } = await manager.startTurnStream({ voiceAgentId, userText: 'Take your time.' });
      await sending;
      await vi.advanceTimersByTimeAsync(120_001);
      expect(manager.isTurnInFlight(voiceAgentId)).toBe(true);
      // Only the deadline observation uses virtual time. Completion and the
      // fresh native admission keep their real transport scheduling.
      vi.useRealTimers();
      complete?.();
      const events = await readVoiceAgentTurnStreamUntilDone({ manager, voiceAgentId, streamId });
      expect(events).toContainEqual(expect.objectContaining({ t: 'voice_output',
        output: expect.objectContaining({ kind: 'turn_final', text: 'Finished.' }) }));
      const next = await manager.startTurnStream({ voiceAgentId, userText: 'Now stop.' });
      await sendingAgain;
      await manager.cancelTurnStream({ voiceAgentId, streamId: next.streamId });
      expect(manager.isTurnInFlight(voiceAgentId)).toBe(false);
    } finally {
      complete?.();
      vi.useRealTimers();
      await manager.dispose();
    }
  });

  it('honors the existing explicit response timeout override after native admission', async () => {
    let entered!: () => void;
    const sending = new Promise<void>(resolve => { entered = resolve; });
    const backend = createDeterministicBackend('explicit-response-deadline', {
      onSend() { entered(); },
      onCancel(turnId, publish) { publish({ kind: 'turn-cancelled', turnId, cause: 'user' }); },
    });
    const manager = new VoiceAgentManager({ createRuntime: () => backend, responseTimeoutMs: 240_000 });
    const { voiceAgentId } = await manager.start({ backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model', commitModelId: 'chat-model', permissionIntent: 'read-only',
      idleTtlSeconds: 3600, initialContext: '' });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      const { streamId } = await manager.startTurnStream({ voiceAgentId, userText: 'Wait for the provider.' });
      await sending;
      await vi.advanceTimersByTimeAsync(239_999);
      expect(manager.isTurnInFlight(voiceAgentId)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      vi.useRealTimers();
      const events = await readVoiceAgentTurnStreamUntilDone({ manager, voiceAgentId, streamId });
      expect(events.some(event => event.t === 'error')).toBe(true);
      expect(events.some(event => event.t === 'voice_output' && event.output.kind === 'turn_final')).toBe(false);
    } finally { vi.useRealTimers(); await manager.dispose(); }
  });

  it.each(['delivered', 'refused', 'cancelled'] as const)('publishes instruction receipts through the real stream reader only after %s delivery', async outcome => {
    const previousSettings = await readSettings();
    await updateSettings(current => ({ ...current, servers: { ...current.servers, home: {
      id: 'home', name: 'Receipt Home', serverUrl: 'https://receipt.example.test', webappUrl: 'https://receipt.example.test',
      createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
      homeConnectionDescriptor: { v: 1, homeServerIdentityId: 'srv_receipt_home', canonicalServerUrl: 'https://receipt.example.test',
        revision: 1, endpoints: [{ kind: 'https', url: 'https://receipt.example.test' }] },
    } } }));
    onTestFinished(async () => { await writeSettings(previousSettings); });
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const sending = new Promise<void>(resolve => { entered = resolve; });
    const backend = createDeterministicBackend('receipt', { onSend: async (request, publish) => {
      entered();
      await pending;
      if (outcome === 'refused') return { status: 'rejected', diagnostic: { code: 'provider_busy', severity: 'error' }, retryable: false };
      publish({ kind: 'message-delta', turnId: request.delivery.turnId, channel: 'assistant', text: 'ready' });
      publish({ kind: 'turn-complete', turnId: request.delivery.turnId });
      return undefined;
    } });
    const manager = new VoiceAgentManager({ createRuntime: () => backend,
      resolvePromptPreparation: async args => resolveCliVoicePromptPreparation({ ...args, serverId: 'home',
        accountEntries: [], profileEntries: [], sessionMetadata: { work: { promptStack: [{ id: 'session.instructions',
          ref: { kind: 'doc', artifactId: 'instructions' }, enabled: true, required: true, placement: 'system_append' }] } },
        readArtifactHeader: async () => ({ header: { v: 1, kind: 'prompt_doc.v2', title: 'Instructions' } }),
        readArtifact: async () => ({ id: 'instructions', header: { v: 1, kind: 'prompt_doc.v2', title: 'Instructions' },
          revision: { headerVersion: 1, bodyVersion: 1 }, body: JSON.stringify({ v: 1, markdown: 'PERSONA', createdAtMs: 1, updatedAtMs: 1 }) }),
      }) });
    try {
      const { voiceAgentId } = await manager.start({ backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        contextSessionId: 'target', chatModelId: 'chat', commitModelId: 'chat', permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: '' });
      const run: ExecutionRunState = { runId: voiceAgentId, callId: 'call', sidechainId: 'sidechain', sessionId: 'control', depth: 0,
        intent: 'voice_agent', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, backendId: 'claude', instructions: '',
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 0 };
      const controller: ExecutionRunController = { kind: 'voice_agent', controllerOccurrenceId: 'receipt-controller', voiceAgentId,
        cancelled: false, lastMarkerWriteAtMs: 0, terminalPromise: Promise.resolve(), resolveTerminal: () => {},
        transcript: { persistenceMode: 'ephemeral', epoch: 1 }, externalStreamIdByInternal: new Map(), internalStreamIdByExternal: new Map(),
        pendingTranscriptTurnByExternalStreamId: new Map(), terminalReadByExternalStreamId: new Map(), readInFlightByExternalStreamId: new Map() };
      const base = { runId: voiceAgentId, runs: new Map([[voiceAgentId, run]]), controllers: new Map([[voiceAgentId, controller]]),
        voiceAgentManager: manager, transcriptWriter: null };
      const started = await startVoiceAgentTurnStream({ ...base, params: { message: 'hello' } });
      if (!started.ok) throw new Error(started.error);
      const { streamId } = started;
      const readStream = async (cursor: number, waitForEvents = false) => {
        const read = await readVoiceAgentTurnStream({ ...base, params: { streamId, cursor, waitForEvents },
          writeActivityMarker: async () => {}, getNowMs: () => 1 });
        if (!read.ok) throw new Error(read.error);
        return ExecutionRunTurnStreamReadResponseSchema.parse(read);
      };
      await sending;
      expect(await readStream(0)).not.toHaveProperty('preparedInstructionsFor');
      const cancellation = outcome === 'cancelled' ? cancelVoiceAgentTurnStream({ ...base, params: { streamId } }) : null;
      const cancelledRead = cancellation ? await readStream(0) : null;
      release();
      await cancellation;
      let read = cancelledRead ?? await readStream(0, true);
      while (!read.done) read = await readStream(read.nextCursor, true);
      if (outcome === 'delivered') expect(read).toHaveProperty('preparedInstructionsFor', { serverId: 'srv_receipt_home', sessionId: 'target' });
      else expect(read).not.toHaveProperty('preparedInstructionsFor');
    } finally { release(); await manager.dispose(); }
  });
  it.each(['welcome', 'turn', 'commit', 'isolated commit'] as const)(
    'reports actual work activity for %s and becomes idle after completion',
    async (operation) => {
      const { VoiceAgentManager } = await import('./VoiceAgentManager');
      const backend = createDelayedCompletionBackend('activity');
      const activity: Array<{ voiceAgentId: string; active: boolean }> = [];
      const manager = new VoiceAgentManager({
        createBackend: () => backend,
        onActivityChanged: (voiceAgentId) => {
          activity.push({ voiceAgentId, active: manager.isTurnInFlight(voiceAgentId) });
        },
      });
      const { voiceAgentId } = await manager.start({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, chatModelId: 'chat-model', commitModelId: 'chat-model',
        commitIsolation: operation === 'isolated commit',
        permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: 'CTX',
      });
      activity.length = 0;
      let work: Promise<unknown> | undefined;
      try {
        expect(manager.isTurnInFlight(voiceAgentId)).toBe(false);
        work = operation === 'welcome'
          ? manager.welcome({ voiceAgentId })
          : operation === 'turn'
            ? manager.sendTurn({ voiceAgentId, userText: 'hello' })
            : manager.commit({ voiceAgentId });
        expect(activity).toEqual([{ voiceAgentId, active: true }]);
        expect(manager.isTurnInFlight(voiceAgentId)).toBe(true);
        backend.completeCurrentResponse();
        await work;
        expect(manager.isTurnInFlight(voiceAgentId)).toBe(false);
        expect(activity.filter((value, index) => index === 0 || value.active !== activity[index - 1]?.active))
          .toEqual([{ voiceAgentId, active: true }, { voiceAgentId, active: false }]);
      } finally {
        backend.completeCurrentResponse();
        await work;
        await manager.dispose();
      }
    },
  );

  it('reports a completed unread stream as idle and notifies again for the next stream', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');
    const backend = createDelayedCompletionBackend('stream');
    const activity: boolean[] = [];
    const manager = new VoiceAgentManager({
      createBackend: () => backend,
      onActivityChanged: (voiceAgentId) => activity.push(manager.isTurnInFlight(voiceAgentId)),
    });
    const { voiceAgentId } = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, chatModelId: 'chat-model', commitModelId: 'chat-model',
      permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: 'CTX',
    });
    activity.length = 0;
    try {
      for (const userText of ['first', 'second']) {
        const { streamId } = await manager.startTurnStream({ voiceAgentId, userText });
        expect(manager.isTurnInFlight(voiceAgentId)).toBe(true);
        backend.completeCurrentResponse();
        await vi.waitFor(() => expect(manager.isTurnInFlight(voiceAgentId)).toBe(false));
        expect((await manager.readTurnStream({ voiceAgentId, streamId, cursor: 0 })).done).toBe(true);
      }
      expect(activity.filter((value, index) => index === 0 || value !== activity[index - 1]))
        .toEqual([true, false, true, false]);
    } finally {
      backend.completeCurrentResponse();
      await manager.dispose();
    }
  });

  it('keeps cancellation active until backend work settles', async () => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');
    const backend = createDelayedCompletionBackend('cancel');
    const activity: boolean[] = [];
    const manager = new VoiceAgentManager({
      createBackend: () => backend,
      onActivityChanged: (voiceAgentId) => activity.push(manager.isTurnInFlight(voiceAgentId)),
    });
    const { voiceAgentId } = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, chatModelId: 'chat-model', commitModelId: 'chat-model',
      permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: 'CTX',
    });
    activity.length = 0;
    try {
      const { streamId } = await manager.startTurnStream({ voiceAgentId, userText: 'hello' });
      const cancel = manager.cancelTurnStream({ voiceAgentId, streamId });
      expect(activity.at(-1)).toBe(true);
      expect(manager.isTurnInFlight(voiceAgentId)).toBe(true);
      backend.completeCurrentResponse();
      await cancel;
      expect(manager.isTurnInFlight(voiceAgentId)).toBe(false);
      expect(activity.at(-1)).toBe(false);
    } finally {
      backend.completeCurrentResponse();
      await manager.dispose();
    }
  });

  it.each(['stop', 'dispose'] as const)('notifies removal of active work during %s', async (operation) => {
    const { VoiceAgentManager } = await import('./VoiceAgentManager');
    const backend = createDelayedCompletionBackend('removal');
    const activity: boolean[] = [];
    const manager = new VoiceAgentManager({
      createBackend: () => backend,
      onActivityChanged: (voiceAgentId) => activity.push(manager.isTurnInFlight(voiceAgentId)),
    });
    const { voiceAgentId } = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, chatModelId: 'chat-model', commitModelId: 'chat-model',
      permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: 'CTX',
    });
    activity.length = 0;
    const work = manager.sendTurn({ voiceAgentId, userText: 'hello' });
    await vi.waitFor(() => expect(backend.hasCurrentResponse()).toBe(true));
    try {
      const removal = operation === 'stop' ? manager.stop({ voiceAgentId }) : manager.dispose();
      expect(activity.at(-1)).toBe(false);
      expect(manager.isTurnInFlight(voiceAgentId)).toBe(false);
      backend.completeCurrentResponse();
      await work;
      await removal;
      expect(activity.at(-1)).toBe(false);
    } finally {
      backend.completeCurrentResponse();
      await work;
      await manager.dispose();
    }
  });

  it.each(['stop', 'dispose'] as const)('releases the native runtime before joining an active Voice turn during %s', async operation => {
    let disposed = false;
    let completeTurn: (() => void) | undefined;
    const backend = createDeterministicBackend('retire-active', {
      onSend(request, publish) {
        completeTurn = () => publish({ kind: 'turn-complete', turnId: request.delivery.turnId });
      },
      onDispose() { disposed = true; },
    });
    const manager = new VoiceAgentManager({ createRuntime: () => backend });
    const { voiceAgentId } = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, chatModelId: 'chat-model', commitModelId: 'chat-model',
      permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: 'CTX',
    });
    const work = manager.sendTurn({ voiceAgentId, userText: 'still running' });
    void work.catch(() => {});
    let retirement: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(backend.getSeenPrompts()).toHaveLength(1));
      retirement = operation === 'stop' ? manager.stop({ voiceAgentId }) : manager.dispose();
      await vi.waitFor(() => expect(disposed).toBe(true));
      await retirement;
      expect(manager.isTurnInFlight(voiceAgentId)).toBe(false);
    } finally {
      completeTurn?.();
      await Promise.allSettled([work, retirement]);
      await manager.dispose();
    }
  });

  it.each(['READY', 'unexpected response'])(
    'reports bootstrap activity and settlement for %s',
    async (responseText) => {
      const { VoiceAgentManager } = await import('./VoiceAgentManager');
      const backend = createStaticResponseBackend('bootstrap', responseText);
      const activity: Array<{ voiceAgentId: string; active: boolean }> = [];
      const manager = new VoiceAgentManager({
        createBackend: () => backend,
        onActivityChanged: (voiceAgentId) => activity.push({ voiceAgentId, active: manager.isTurnInFlight(voiceAgentId) }),
      });
      try {
        const request = new AbortController();
        const start = manager.start({
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, chatModelId: 'chat-model', commitModelId: 'chat-model',
          permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: 'CTX',
          bootstrapMode: 'ready_handshake',
        }, { signal: request.signal });
        if (responseText === 'READY') {
          const started = await start;
          request.abort();
          expect(manager.readCurrentRuntimeOccurrence(started.voiceAgentId)).not.toBeNull();
        }
        else await expect(start).rejects.toMatchObject({ code: 'VOICE_AGENT_START_FAILED' });
        expect(activity.map(({ active }) => active)).toEqual([true, false]);
        expect(manager.isTurnInFlight(activity[0]!.voiceAgentId)).toBe(false);
      } finally {
        await manager.dispose();
      }
    },
  );

  it('retires the native READY bootstrap when its start request is cancelled', async () => {
    let releaseDisposal!: () => void;
    const disposal = new Promise<void>((resolve) => { releaseDisposal = resolve; });
    const disposed = vi.fn(async () => { await disposal; });
    const backend = createDeterministicBackend('cancel-start', { onSend: async () => undefined, onDispose: disposed });
    const manager = new VoiceAgentManager({ createRuntime: () => backend });
    const controller = new AbortController();
    let outcome = 'pending';
    const started = manager.start({
      voiceAgentId: 'cancelled-start', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model', commitModelId: 'chat-model', permissionIntent: 'read-only',
      idleTtlSeconds: 60, initialContext: '', bootstrapMode: 'ready_handshake',
    }, { signal: controller.signal });
    const observed = started.then(() => { outcome = 'started'; }, () => { outcome = 'failed'; });
    try {
      await vi.waitFor(() => expect(backend.getSeenPrompts()).toHaveLength(1));
      controller.abort(new Error('Carrier runtime failed'));
      await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce());
      expect(outcome).toBe('pending');
      releaseDisposal();
      await vi.waitFor(() => expect(outcome).toBe('failed'));
      await observed;
      expect(disposed).toHaveBeenCalledOnce();
      expect(manager.readCurrentRuntimeOccurrence('cancelled-start')).toBeNull();
      expect(manager.isTurnInFlight('cancelled-start')).toBe(false);
    } finally {
      releaseDisposal();
      await manager.dispose();
      await observed;
    }
  });

  it('holds an empty stream read until the owner appends events and aborts observation independently', async () => {
    const backend = createDelayedCompletionBackend('push-read');
    const manager = new VoiceAgentManager({ createBackend: () => backend });
    try {
      const started = await manager.start({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        chatModelId: 'chat-model', commitModelId: 'commit-model',
        permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: 'CTX',
      });
      const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'hello' });
      const controller = new AbortController();
      const request = { voiceAgentId: started.voiceAgentId, streamId: stream.streamId, cursor: 0, waitForEvents: true, signal: controller.signal };
      let settled = false;
      const abortedRead = manager.readTurnStream(request);
      const pushedRead = manager.readTurnStream({ ...request, signal: new AbortController().signal });
      void abortedRead.then(() => { settled = true; }, () => { settled = true; });
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      controller.abort(new Error('observation cancelled'));
      await expect(abortedRead).rejects.toThrow('observation cancelled');
      await vi.waitFor(() => expect(backend.hasCurrentResponse()).toBe(true));
      backend.appendDelta('Streaming words. '.repeat(40));
      const page = await pushedRead;
      expect(page.events).toEqual(expect.arrayContaining([expect.objectContaining({
        t: 'voice_output', output: expect.objectContaining({ kind: 'speech_segment' }),
      })]));
      expect(page.done).toBe(false);
      expect(page.nextCursor).toBe(page.events.length);
      expect(page.streamId).toBe(stream.streamId);
      const terminal = manager.readTurnStream({ ...request, cursor: page.nextCursor, signal: new AbortController().signal });
      backend.completeCurrentResponse();
      let finalPage = await terminal;
      const remainingEvents = [...finalPage.events];
      while (!finalPage.done) {
        finalPage = await manager.readTurnStream({
          ...request, cursor: finalPage.nextCursor, signal: new AbortController().signal,
        });
        remainingEvents.push(...finalPage.events);
      }
      expect(finalPage.streamId).toBe(stream.streamId);
      expect(remainingEvents).toEqual(expect.arrayContaining([expect.objectContaining({
        t: 'voice_output', output: expect.objectContaining({ kind: 'turn_final' }),
      })]));
    } finally {
      await manager.dispose();
    }
  });
  it.each(['stop', 'dispose'] as const)('settles a held stream read on %s while a completed turn handoff is still pending', async (retirement) => {
    const backend = createDelayedCompletionBackend('held-terminal-handoff');
    const manager = new VoiceAgentManager({ createBackend: () => backend });
    let releaseHandoff!: () => void;
    let handoffStarted!: () => void;
    const handoff = new Promise<void>((resolve) => { releaseHandoff = resolve; });
    const startedHandoff = new Promise<void>((resolve) => { handoffStarted = resolve; });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model', commitModelId: 'commit-model',
      permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: 'CTX',
    });
    const stream = await manager.startTurnStream({
      voiceAgentId: started.voiceAgentId, userText: 'hello',
      onTurnFinal: async () => { handoffStarted(); await handoff; },
    });
    backend.completeCurrentResponse();
    await startedHandoff;
    let cursor = 0;
    for (;;) {
      const page = await manager.readTurnStream({ voiceAgentId: started.voiceAgentId, streamId: stream.streamId, cursor });
      cursor = page.nextCursor;
      expect(page.done).toBe(false);
      if (page.events.length === 0) break;
    }
    const read = manager.readTurnStream({ voiceAgentId: started.voiceAgentId, streamId: stream.streamId, cursor, waitForEvents: true });
    let settled = false;
    void read.then(() => { settled = true; });
    const retiring = retirement === 'stop' ? manager.stop({ voiceAgentId: started.voiceAgentId }) : manager.dispose();
    try {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(true);
      await expect(read).resolves.toMatchObject({ done: true, events: [] });
    } finally {
      releaseHandoff();
      await retiring;
      await manager.dispose();
    }
  });

  it('proves only an actual provisioning runtime while keeping startup authority unpublished', async () => {
    let releasePreparation!: () => void;
    let releaseOpen!: () => void;
    let enteredOpen!: () => void;
    const preparation = new Promise<void>(resolve => { releasePreparation = resolve; });
    const opening = new Promise<void>(resolve => { releaseOpen = resolve; });
    const entered = new Promise<void>(resolve => { enteredOpen = resolve; });
    const runtime = createDeterministicBackend('occurrence-provisioning', {
      onOpen: async () => { enteredOpen(); await opening; },
    });
    const manager = new VoiceAgentManager({ createRuntime: () => runtime,
      resolvePromptPreparation: async () => { await preparation; return { systemAppendBlocks: [], memoryRecallGuidanceEnabled: false, disabledActionIds: [] }; } });
    const starting = manager.start({ voiceAgentId: 'provisioning-occurrence', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model', commitModelId: 'commit-model', permissionIntent: 'read-only', idleTtlSeconds: 60,
      initialContext: '', bootstrapMode: 'none' });
    const outcome = starting.catch(error => error);
    try {
      expect(manager.isTurnInFlight('provisioning-occurrence')).toBe(true);
      expect(manager.readCurrentRuntimeOccurrence('provisioning-occurrence')).toBeNull();
      expect(manager.readCurrentRuntimeAuthority('provisioning-occurrence')).toBeNull();
      releasePreparation();
      await entered;
      expect(manager.readCurrentRuntimeAuthority('provisioning-occurrence')).toBeNull();
      const occurrence = manager.readCurrentRuntimeOccurrence('provisioning-occurrence');
      expect(occurrence?.runtime).toBe(runtime);
      expect(occurrence?.activeTurnAdmissionWitness).toBeNull();
      await manager.stop({ voiceAgentId: 'provisioning-occurrence' });
      expect(manager.readCurrentRuntimeOccurrence('provisioning-occurrence')).toBeNull();
      releaseOpen();
      expect(await outcome).toBeInstanceOf(VoiceAgentError);
    } finally { releasePreparation(); releaseOpen(); await outcome; await manager.dispose(); }
  });

  it('projects current idle and active-turn authority from the exact live Voice runtime', async () => {
    let publishRuntimeEvent: ((event: AgentSessionRuntimeEvent) => void) | undefined;
    let activeTurnId: string | undefined;
    let sequence = 0;
    const activity: boolean[] = [];
    const runtime: AgentRuntime = { sessions: { async open() { return {
      watch(listener) {
        publishRuntimeEvent = listener;
        return { dispose() { publishRuntimeEvent = undefined; } };
      },
      async send(request) {
        activeTurnId = request.delivery.turnId;
        publishRuntimeEvent?.({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery, sessionId: 'session-parent', sequence: sequence++, emittedAtMs: 1 });
        publishRuntimeEvent?.({ kind: 'turn-start', turnId: activeTurnId, startedBy: 'host', sessionId: 'session-parent', sequence: sequence++, emittedAtMs: 1 });
        return { status: 'admitted' as const };
      },
      async dispose() {},
    }; } } };
    const host = createVoiceSessionRuntimeThroughNativeFactory({
      runtime, modelId: 'chat-model', capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
    });
    const manager = new VoiceAgentManager({
      createRuntime: () => host,
      onActivityChanged: (voiceAgentId) => activity.push(manager.isTurnInFlight(voiceAgentId)),
    });
    try {
      await manager.start({
        voiceAgentId: 'voice-authority',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        chatModelId: 'chat-model',
        commitModelId: 'commit-model',
        permissionIntent: 'read-only',
        idleTtlSeconds: 60,
        initialContext: 'CTX',
      });
      activity.length = 0;
      const idle = manager.readCurrentRuntimeAuthority('voice-authority');
      expect(idle).toMatchObject({ runtimeState: 'idle' });
      expect(manager.isTurnInFlight('voice-authority')).toBe(false);
      await host.deliverInput('host-voice-run', { text: 'hello' });
      expect(activeTurnId).toEqual(expect.any(String));
      expect(manager.isTurnInFlight('voice-authority')).toBe(true);
      expect(activity).toEqual([true]);
      expect(manager.readCurrentRuntimeAuthority('voice-authority')).toEqual({
        runtimeState: 'active_turn',
        activeTurnId,
      });
      if (!activeTurnId) throw new Error('Native turn was not admitted');
      publishRuntimeEvent?.({ kind: 'turn-complete', turnId: activeTurnId, sessionId: 'session-parent', sequence: sequence++, emittedAtMs: 2 });
      expect(manager.isTurnInFlight('voice-authority')).toBe(false);
      expect(activity).toEqual([true, false]);
      await manager.stop({ voiceAgentId: 'voice-authority' });
      expect(manager.readCurrentRuntimeAuthority('voice-authority')).toBeNull();
      expect(publishRuntimeEvent).toBeUndefined();
    } finally {
      await manager.dispose();
    }
  });

  it('moves active-turn authority to an isolated commit runtime without retiring the Voice Run', async () => {
    let releaseCommit!: () => void;
    let commitStarted!: () => void;
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const commitStartedPromise = new Promise<void>((resolve) => { commitStarted = resolve; });
    let commitTurnId: string | undefined;
    let publishCommitEvent: ((event: AgentSessionRuntimeEvent) => void) | undefined;
    let sequence = 0;
    const chat: AgentRuntime = { sessions: { async open() { return {
      watch() { return { dispose() {} }; },
      async send() { return { status: 'admitted' as const }; },
      async dispose() {},
    }; } } };
    const commit: AgentRuntime = { sessions: { async open() { return {
      watch(listener) { publishCommitEvent = listener; return { dispose() { publishCommitEvent = undefined; } }; },
      async send(request) {
        commitTurnId = request.delivery.turnId;
        const base = { sessionId: 'session-parent', emittedAtMs: 1 };
        publishCommitEvent?.({ ...base, sequence: sequence++, kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
        publishCommitEvent?.({ ...base, sequence: sequence++, kind: 'turn-start', turnId: commitTurnId, startedBy: 'host' });
        commitStarted();
        await commitGate;
        publishCommitEvent?.({ ...base, sequence: sequence++, kind: 'turn-complete', turnId: request.delivery.turnId });
        return { status: 'admitted' as const };
      },
      async dispose() {},
    }; } } };
    const manager = new VoiceAgentManager({
      createRuntime: ({ modelId }) => createVoiceSessionRuntimeThroughNativeFactory({
        runtime: modelId === 'commit-model' ? commit : chat,
        modelId, capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
      }),
    });
    try {
      const started = await manager.start({
        voiceAgentId: 'voice-isolated-commit-authority',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        chatModelId: 'chat-model',
        commitModelId: 'commit-model',
        commitIsolation: true,
        permissionIntent: 'read-only',
        idleTtlSeconds: 60,
        initialContext: 'CTX',
      });
      expect(manager.readCurrentRuntimeAuthority(started.voiceAgentId)).toEqual({ runtimeState: 'idle', activeTurnId: null });
      const committing = manager.commit({ voiceAgentId: started.voiceAgentId });
      await commitStartedPromise;
      expect(commitTurnId).toEqual(expect.any(String));
      expect(manager.readCurrentRuntimeAuthority(started.voiceAgentId)).toEqual({ runtimeState: 'active_turn', activeTurnId: commitTurnId });
      releaseCommit();
      await committing;
      expect(manager.readCurrentRuntimeAuthority(started.voiceAgentId)).toEqual({ runtimeState: 'idle', activeTurnId: null });
      expect(manager.readCurrentRuntimeOccurrence(started.voiceAgentId)?.activeTurnAdmissionWitness).toBeNull();
    } finally {
      releaseCommit();
      await manager.dispose();
    }
  });

  it('claims a voice-agent id before provisioning so concurrent starts cannot double-provision it', async () => {
    let releaseFirstProvision!: () => void;
    let firstProvisionStarted!: () => void;
    const firstProvisionGate = new Promise<void>((resolve) => {
      releaseFirstProvision = resolve;
    });
    const firstProvisionStartedPromise = new Promise<void>((resolve) => {
      firstProvisionStarted = resolve;
    });
    const firstDispose = vi.fn(async () => {});
    let runtimeCount = 0;
    const manager = new VoiceAgentManager({
      createBackend: () => {
        runtimeCount += 1;
        const occurrence = runtimeCount;
        return createDeterministicBackend(`voice-session-${occurrence}`, {
          providerSessionId: `voice-session-${occurrence}`,
          onOpen: async () => {
            if (occurrence !== 1) return;
            firstProvisionStarted();
            await firstProvisionGate;
          },
          ...(occurrence === 1 ? { onDispose: firstDispose } : {}),
        });
      },
    });
    const params = {
      voiceAgentId: 'shared-voice-agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' } as const,
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only' as const,
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    };

    try {
      const lateFirst = manager.start(params);
      await firstProvisionStartedPromise;
      await expect(manager.start(params)).rejects.toMatchObject({ code: 'VOICE_AGENT_START_FAILED' });
      expect(runtimeCount).toBe(1);
      releaseFirstProvision();

      await expect(lateFirst).resolves.toMatchObject({ voiceAgentId: 'shared-voice-agent' });
      expect(firstDispose).not.toHaveBeenCalled();
      expect(manager.getResumeHandle('shared-voice-agent')).toMatchObject({
        kind: 'provider_session.v1',
        providerSessionId: 'voice-session-1',
      });
    } finally {
      releaseFirstProvision();
      await manager.dispose();
    }
  });

  it('does not register a late start after the manager was disposed', async () => {
    let releaseProvision!: () => void;
    let provisionStarted!: () => void;
    const provisionGate = new Promise<void>((resolve) => {
      releaseProvision = resolve;
    });
    const provisionStartedPromise = new Promise<void>((resolve) => {
      provisionStarted = resolve;
    });
    const disposeRuntime = vi.fn(async () => {});
    const activity: boolean[] = [];
    const manager = new VoiceAgentManager({
      onActivityChanged: (voiceAgentId) => activity.push(manager.isTurnInFlight(voiceAgentId)),
      createBackend: () => createDeterministicBackend('late-session', {
        onOpen: async () => {
          provisionStarted();
          await provisionGate;
        },
        onDispose: disposeRuntime,
      }),
    });

    const start = manager.start({
      voiceAgentId: 'late-voice-agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });
    await provisionStartedPromise;
    expect(manager.isTurnInFlight('late-voice-agent')).toBe(true);
    expect(activity).toEqual([true]);
    await manager.dispose();
    expect(manager.isTurnInFlight('late-voice-agent')).toBe(false);
    expect(activity).toEqual([true, false]);
    releaseProvision();

    await expect(start).rejects.toMatchObject({ code: 'VOICE_AGENT_START_FAILED' });
    expect(disposeRuntime).toHaveBeenCalledTimes(1);
    expect(manager.getResumeHandle('late-voice-agent')).toBeNull();
  });

  it('disposes resumed chat and provisional commit runtimes exactly once when stopped during commit provisioning', async () => {
    let commitProvisionStarted!: () => void;
    let releaseCommitProvision!: () => void;
    const commitProvisionStartedPromise = new Promise<void>((resolve) => {
      commitProvisionStarted = resolve;
    });
    const commitProvisionGate = new Promise<void>((resolve) => {
      releaseCommitProvision = resolve;
    });
    const chatDispose = vi.fn(async () => undefined);
    const commitDispose = vi.fn(async () => undefined);
    const chatBackend = createDeterministicBackend('resumed-chat-session', {
      onDispose: chatDispose,
    });
    const commitBackend = createDeterministicBackend('resumed-commit-session', {
      async onOpen() {
        commitProvisionStarted();
        await commitProvisionGate;
      },
      onDispose: commitDispose,
    });
    const createBackend = vi.fn<BackendFactory>()
      .mockReturnValueOnce(chatBackend)
      .mockReturnValueOnce(commitBackend);
    const manager = new VoiceAgentManager({ createBackend });
    const start = manager.start({
      voiceAgentId: 'resumed-stop-during-commit-provision',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
      resumeHandle: {
        kind: 'voice_agent_sessions.v1',
        backendTarget: { kind: 'backend', backendId: 'claude' },
        chatProviderSessionId: 'resumed-chat-session',
        commitProviderSessionId: 'resumed-commit-session',
      },
    });

    try {
      await commitProvisionStartedPromise;
      await expect(manager.stop({
        voiceAgentId: 'resumed-stop-during-commit-provision',
      })).resolves.toEqual({ ok: true });
      let retirementSettled = false;
      const retirement = manager.waitForRetirement('resumed-stop-during-commit-provision').then(() => {
        retirementSettled = true;
      });
      await vi.waitFor(() => {
        expect(chatDispose).toHaveBeenCalledTimes(1);
      });
      expect(commitBackend.getRuntimeLifetimeSignal().aborted).toBe(true);
      expect(commitDispose).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(retirementSettled).toBe(false);

      releaseCommitProvision();
      await expect(start).rejects.toMatchObject({ code: 'VOICE_AGENT_START_FAILED' });
      await retirement;
      expect(retirementSettled).toBe(true);
      expect(chatDispose).toHaveBeenCalledTimes(1);
      expect(commitDispose).toHaveBeenCalledTimes(1);
    } finally {
      releaseCommitProvision();
      await start.catch(() => {});
      await manager.dispose();
    }
  });

  it('keeps an established id retired until its exact runtime cleanup settles', async () => {
    let disposalStarted!: () => void;
    let releaseDisposal!: () => void;
    const disposalStartedPromise = new Promise<void>((resolve) => {
      disposalStarted = resolve;
    });
    const disposalGate = new Promise<void>((resolve) => {
      releaseDisposal = resolve;
    });
    let runtimeCount = 0;
    const manager = new VoiceAgentManager({
      createBackend: () => {
        runtimeCount += 1;
        const occurrence = runtimeCount;
        return createDeterministicBackend(`retiring-established-session-${occurrence}`, {
          async onDispose() {
            if (occurrence !== 1) return;
            disposalStarted();
            await disposalGate;
            throw new Error('provider disposal failed after retirement');
          },
        });
      },
    });
    const params = {
      voiceAgentId: 'retiring-established-agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' } as const,
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only' as const,
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    };

    let stop: Promise<{ ok: true }> | null = null;
    try {
      await manager.start(params);
      stop = manager.stop({ voiceAgentId: params.voiceAgentId });
      await disposalStartedPromise;

      let retirementSettled = false;
      const retirement = manager.waitForRetirement(params.voiceAgentId).then(() => {
        retirementSettled = true;
      });
      await Promise.resolve();
      expect(retirementSettled).toBe(false);
      await expect(manager.start(params)).rejects.toMatchObject({ code: 'VOICE_AGENT_START_FAILED' });

      releaseDisposal();
      await expect(stop).resolves.toEqual({ ok: true });
      await retirement;
      await expect(manager.start(params)).resolves.toMatchObject({ voiceAgentId: params.voiceAgentId });
      expect(runtimeCount).toBe(2);
    } finally {
      releaseDisposal();
      await stop?.catch(() => {});
      await manager.dispose();
    }
  });

  it('owns one deadline per idle instance and releases it with the instance', async () => {
    vi.useFakeTimers();
    const manager = new VoiceAgentManager({
      createBackend: () => createDeterministicBackend('backend'),
    });
    const params = {
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' } as const,
      chatModelId: 'chat-model', commitModelId: 'commit-model',
      permissionIntent: 'read-only' as const, idleTtlSeconds: 60, initialContext: 'CTX',
    };
    try {
      expect(vi.getTimerCount()).toBe(0);
      const first = await manager.start(params);
      const second = await manager.start(params);
      expect(vi.getTimerCount()).toBe(2);
      await manager.stop({ voiceAgentId: first.voiceAgentId });
      expect(vi.getTimerCount()).toBe(1);
      await manager.stop({ voiceAgentId: second.voiceAgentId });
      expect(vi.getTimerCount()).toBe(0);
      await manager.start(params);
      expect(vi.getTimerCount()).toBe(1);
      await manager.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await manager.dispose();
      vi.useRealTimers();
    }
  }, 15_000);

  it('rejects start calls after dispose without creating new backends', async () => {

    const createBackend = vi.fn(() => createDeterministicBackend('backend'));
    const manager = new VoiceAgentManager({ createBackend });

    await manager.dispose();

    await expect(
      manager.start({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        chatModelId: 'chat-model',
        commitModelId: 'commit-model',
        permissionIntent: 'read-only',
        idleTtlSeconds: 60,
        initialContext: 'CTX',
      }),
    ).rejects.toMatchObject({ code: 'VOICE_AGENT_START_FAILED' });

    expect(createBackend).toHaveBeenCalledTimes(0);
  }, 15_000);

  it('surfaces commit backend factory errors without disposing the chat backend', async () => {

    const chatDispose = vi.fn(async () => {});
    const chatBackend = createDeterministicBackend('chat', {
      onDispose: chatDispose,
    });

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') {
        throw new Error('commit backend unavailable');
      }
      return chatBackend;
    };

    const manager = new VoiceAgentManager({ createBackend });

    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    await expect(manager.commit({ voiceAgentId: started.voiceAgentId, maxChars: 10_000 })).rejects.toMatchObject({
      code: 'VOICE_AGENT_START_FAILED',
    });

    expect(chatDispose).toHaveBeenCalledTimes(0);
  });

  it('retains the shared legacy connected-services route for both roles when no commit override is supplied', async () => {

    const capturedOpts: Array<{ connectedServices?: unknown }> = [];
    const createBackend: BackendFactory = (opts) => {
      capturedOpts.push(opts);
      return createDeterministicBackend('backend');
    };
    const manager = new VoiceAgentManager({ createBackend });

    const connectedServices = {
      v: 2 as const,
      bindingsByServiceId: {
        'happier.agent.codex/openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'work' },
      },
    };

    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
      connectedServices,
    });

    await manager.commit({ voiceAgentId: started.voiceAgentId });
    expect(capturedOpts.map((options) => options.connectedServices)).toEqual([connectedServices, connectedServices]);
    await manager.dispose();
  });

  it('retains the connected account owner diagnostic when Voice start requires profile action', async () => {
    const manager = new VoiceAgentManager({ createBackend: () => {
      throw new ConnectedServiceSpawnProfileActionRequiredError({
        serviceId: 'happier.agent.codex/openai-codex', profileId: 'work', status: 'needs_reauth',
      });
    } });
    await expect(manager.start({ backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      chatModelId: 'chat-model', commitModelId: 'commit-model', permissionIntent: 'read-only',
      idleTtlSeconds: 60, initialContext: 'CTX',
    })).rejects.toMatchObject({ code: 'connected_service_credential_reconnect_required', uxDiagnostic: {
      code: 'connected_service_credential_reconnect_required', retryable: false,
      serviceId: 'happier.agent.codex/openai-codex', profileId: 'work',
      suggestedActions: ['reconnect_profile', 'open_connected_accounts'],
    } });
    await manager.dispose();
  });

  it('passes through VoiceAgentError codes thrown by the backend factory', async () => {

    const createBackend: BackendFactory = () => {
      throw new VoiceAgentError('VOICE_AGENT_UNSUPPORTED', 'voice agent not supported');
    };

    const manager = new VoiceAgentManager({ createBackend });

    await expect(
      manager.start({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        chatModelId: 'chat-model',
        commitModelId: 'commit-model',
        permissionIntent: 'read-only',
        idleTtlSeconds: 60,
        initialContext: 'CTX',
      }),
    ).rejects.toMatchObject({ code: 'VOICE_AGENT_UNSUPPORTED' });
  });

  it('removes the voice-agent registry entry when READY bootstrap fails', async () => {

    const dispose = vi.fn(async () => {});
    const backend = createDeterministicBackend('bootstrap-fail', {
      onDispose: dispose,
      onSend(request, publish) {
        publish({ kind: 'message-delta', turnId: request.delivery.turnId, channel: 'assistant', text: 'NOT_READY' });
        publish({ kind: 'turn-complete', turnId: request.delivery.turnId });
      },
    });
    const manager = new VoiceAgentManager({ createBackend: () => backend });

    await expect(manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
      bootstrapMode: 'ready_handshake',
      voiceAgentId: 'voice-agent-bootstrap-fail',
    })).rejects.toMatchObject({ code: 'VOICE_AGENT_START_FAILED' });

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(manager.getResumeHandle('voice-agent-bootstrap-fail')).toBeNull();
  });

  it('passes the canonical backend target, model ids, permission policy, and voice_agent start intent to the backend factory', async () => {

    const seen: Array<{
      backendTarget: Parameters<BackendFactory>[0]['backendTarget'];
      backendId: string;
      modelId: string;
      permissionIntent: Parameters<BackendFactory>[0]['permissionIntent'];
      start?: { intent: 'voice_agent' };
    }> = [];
    const backend = createDeterministicBackend('chat');
    const createBackend: BackendFactory = (opts) => {
      seen.push({
        backendTarget: opts.backendTarget,
        backendId: opts.backendId,
        modelId: opts.modelId,
        permissionIntent: opts.permissionIntent,
        start: opts.start,
      });
      return backend;
    };

    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'external-voice-agent' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    expect(seen).toEqual([{
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'external-voice-agent' },
      backendId: 'external-voice-agent',
      modelId: 'chat-model',
      permissionIntent: 'read-only',
      start: { intent: 'voice_agent' },
    }]);
    expect(manager.getResumeHandle(started.voiceAgentId)?.backendTarget).toMatchObject({
      kind: 'backend',
      backendId: 'external-voice-agent',
      configuredBackendId: 'external-voice-agent',
      sourceKind: 'configured',
    });

    await manager.commit({ voiceAgentId: started.voiceAgentId, maxChars: 10_000 });

    expect(seen).toEqual([
      { backendTarget: { kind: 'configuredAcpBackend', backendId: 'external-voice-agent' }, backendId: 'external-voice-agent', modelId: 'chat-model', permissionIntent: 'read-only', start: { intent: 'voice_agent' } },
      { backendTarget: { kind: 'configuredAcpBackend', backendId: 'external-voice-agent' }, backendId: 'external-voice-agent', modelId: 'commit-model', permissionIntent: 'read-only', start: { intent: 'voice_agent' } },
    ]);
    expect(manager.getResumeHandle(started.voiceAgentId)).toMatchObject({
      kind: 'voice_agent_sessions.v1',
      backendTarget: {
        kind: 'backend',
        backendId: 'external-voice-agent',
        configuredBackendId: 'external-voice-agent',
        sourceKind: 'configured',
      },
    });
  });

  it('routes independent Provider selections and the same non-default temperature to chat and commit', async () => {
    const chatBackend = createDeterministicBackend('chat');
    const commitBackend = createDeterministicBackend('commit');
    const seen: Parameters<BackendFactory>[0][] = [];
    const createBackend: BackendFactory = (options) => {
      seen.push(options);
      return options.modelId === 'commit-model' ? commitBackend : chatBackend;
    };
    const manager = new VoiceAgentManager({ createBackend });
    const canonicalOpenCodeTargetKey = buildBackendTargetKeyV2({
      kind: 'agent',
      identity: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
    });
    const chatModelSelection = ProviderBoundModelRefSchema.parse({
      agentTargetKey: canonicalOpenCodeTargetKey,
      providerConnectionId: 'pc_chat',
      modelId: 'chat-model',
    });
    const commitModelSelection = ProviderBoundModelRefSchema.parse({
      agentTargetKey: canonicalOpenCodeTargetKey,
      providerConnectionId: 'pc_commit',
      modelId: 'commit-model',
    });
    const sessionConfigOptionOverrides = {
      v: 1,
      updatedAt: 0,
      overrides: { temperature: { updatedAt: 0, value: 0.73 } },
    } as const;

    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      chatModelSelection,
      commitModelSelection,
      sessionConfigOptionOverrides,
      connectedServices: null,
      commitConnectedServices: { v: 2, bindingsByServiceId: {
        'happier.agent.opencode/openai': { source: 'connected', selection: 'group', groupId: 'parent-pool' },
      } },
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });
    await manager.commit({ voiceAgentId: started.voiceAgentId, maxChars: 10_000 });

    expect(seen).toEqual([
      expect.objectContaining({
        modelId: 'chat-model',
        modelSelection: chatModelSelection,
        sessionConfigOptionOverrides,
        connectedServices: null,
      }),
      expect.objectContaining({
        modelId: 'commit-model',
        modelSelection: commitModelSelection,
        sessionConfigOptionOverrides,
        connectedServices: { v: 2, bindingsByServiceId: {
          'happier.agent.opencode/openai': { source: 'connected', selection: 'group', groupId: 'parent-pool' },
        } },
      }),
    ]);
  });

  it.each([false, true])('keeps role-specific native versus pool routes distinct with the same native model (native commit: %s)', async (nativeCommit) => {
    const seen: Parameters<BackendFactory>[0][] = [];
    const manager = new VoiceAgentManager({ createBackend: (options) => {
      seen.push(options);
      return createDeterministicBackend(`role-${seen.length}`);
    } });
    const pool = { v: 2 as const, bindingsByServiceId: {
      'happier.agent.codex/openai-codex': { source: 'connected' as const, selection: 'group' as const, groupId: 'parent-pool' },
    } };
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      chatModelId: 'same-model', commitModelId: 'same-model',
      connectedServices: nativeCommit ? pool : null,
      commitConnectedServices: nativeCommit ? null : pool,
      permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: 'CTX',
    });
    await manager.commit({ voiceAgentId: started.voiceAgentId });
    expect(seen.map((options) => options.connectedServices)).toEqual(nativeCommit ? [pool, null] : [null, pool]);
    await manager.dispose();
  });

  it('does not reuse chat for commit when identical model ids belong to different Provider connections', async () => {
    const createBackend = vi.fn<BackendFactory>(() => createDeterministicBackend('provider'));
    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
      chatModelId: 'shared-model',
      commitModelId: 'shared-model',
      chatModelSelection: ProviderBoundModelRefSchema.parse({
        agentTargetKey: 'agent:happier.agent.opencode/opencode',
        providerConnectionId: 'pc_chat',
        modelId: 'shared-model',
      }),
      commitModelSelection: ProviderBoundModelRefSchema.parse({
        agentTargetKey: 'agent:happier.agent.opencode/opencode',
        providerConnectionId: 'pc_commit',
        modelId: 'shared-model',
      }),
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    await manager.commit({ voiceAgentId: started.voiceAgentId, maxChars: 10_000 });

    expect(createBackend).toHaveBeenCalledTimes(2);
    expect(createBackend.mock.calls[1]?.[0]).toMatchObject({
      modelSelection: { providerConnectionId: 'pc_commit', modelId: 'shared-model' },
    });
  });

  it('uses a more detailed prompt when verbosity is balanced', async () => {

    const chatBackend = createDeterministicBackend('chat');
    const commitBackend = createDeterministicBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceAgentManager({ createBackend });

    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
      verbosity: 'balanced',
    });

    await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hi' });
    const [prompt] = chatBackend.getSeenPrompts();
    expect(prompt).toMatch(/be concise but include enough detail to be helpful/i);
  });

  it('keeps multi-turn history and uses the commit backend separately', async () => {

    const chatBackend = createDeterministicBackend('chat');
    const commitBackend = createDeterministicBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceAgentManager({
      createBackend,
    });

    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    const r1 = await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hi' });
    expect(r1.assistantText).toContain('chat:');

    const r2 = await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'more' });
    expect(r2.assistantText).toContain('chat:');

    const prompts = chatBackend.getSeenPrompts();
    expect(prompts[0]).toContain('Initial context:');
    expect(prompts[1]).toBe('User: more\nVoice agent:');

    const committed = await manager.commit({ voiceAgentId: started.voiceAgentId, maxChars: 10_000 });
    expect(committed.commitText).toContain('commit:');

    expect(chatBackend.getSeenPrompts().length).toBe(2);
    expect(commitBackend.getSeenPrompts().length).toBe(1);
  });

  it('admits every Voice input with its own permission ceiling through the native host', async () => {
    const decisions: ReturnType<typeof resolveCausalPermissionMode>[] = [];
    const toolDecisions: ReturnType<ProviderEnforcedPermissionHandler['getImmediateDecision']>[] = [];
    const permissions = new ProviderEnforcedPermissionHandler(createMutableApiSessionClientFixture(), { logPrefix: '[Voice settings]' });
    const backend = createDeterministicBackend('voice-settings-authority', { onSend: (request, publish) => {
      const witness = backend.readActiveTurnAdmissionWitness?.();
      const context = {
        causalPermissionAuthority: witness?.causalPermissionAuthority ?? null,
      };
      decisions.push(resolveCausalPermissionMode({ currentPermissionMode: 'default', context }));
      // Codex's native request must reach the Action approval owner in default
      // mode, while the next input's explicit read-only ceiling still refuses it.
      toolDecisions.push(permissions.getImmediateDecision('settings-call', 'mcp__happier__settings_set',
        { anchor: 'voiceConversations.minSpeechMs', value: 1100 }, context));
      publish({ kind: 'message-delta', turnId: request.delivery.turnId, channel: 'assistant',
        text: request.input.text.includes('reply with exactly READY') ? 'READY' : 'Done.' });
      publish({ kind: 'turn-complete', turnId: request.delivery.turnId });
    } });
    const manager = new VoiceAgentManager({ createRuntime: () => backend });
    try {
      const started = await manager.start({ backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        chatModelId: 'chat-model', commitModelId: 'chat-model', permissionIntent: 'default',
        idleTtlSeconds: 60, initialContext: '', bootstrapMode: 'ready_handshake' });
      await manager.welcome({ voiceAgentId: started.voiceAgentId });
      await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'Read my settings' });
      const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId,
        userText: 'Change my setting', causalPermissionAuthority: {
          kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only',
        } });
      await readVoiceAgentTurnStreamUntilDone({ manager, voiceAgentId: started.voiceAgentId, streamId: stream.streamId });
      expect(decisions).toEqual([
        ...Array.from({ length: 3 }, () => ({ ok: true, authority: 'admittedSessionInputV1', effectiveMode: 'default' })),
        { ok: true, authority: 'admittedSessionInputV1', effectiveMode: 'read-only' },
      ]);
      expect(toolDecisions).toEqual([
        { decision: 'approved' }, { decision: 'approved' }, { decision: 'approved' }, { decision: 'denied' },
      ]);
    } finally { await manager.dispose(); }
  });

  it.each(['ordinary', 'stream', 'narrowed-stream', 'permitted-stream', 'read-stream'] as const)('enforces the admitted permission ceiling for action blocks (%s)', async transport => {
    const action = transport === 'read-stream'
      ? { t: 'settings_get', args: { anchor: 'voiceConversations.minSpeechMs' } }
      : { t: 'settings_set', args: { anchor: 'voiceConversations.minSpeechMs', value: 1100 } };
    const backend = createDeterministicBackend('voice-settings-actions', { onSend: (request, publish) => {
      publish({ kind: 'message-delta', turnId: request.delivery.turnId, channel: 'assistant',
        text: `<voice_actions>${JSON.stringify({ actions: [action] })}</voice_actions>` });
      publish({ kind: 'turn-complete', turnId: request.delivery.turnId });
    } });
    const manager = new VoiceAgentManager({ createRuntime: () => backend });
    try {
      const started = await manager.start({ backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        chatModelId: 'chat-model', commitModelId: 'chat-model',
        permissionIntent: transport === 'narrowed-stream' || transport === 'permitted-stream' ? 'default' : 'read-only',
        idleTtlSeconds: 60, initialContext: '' });
      if (transport === 'ordinary') {
        await expect(manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'Change minimum speech' }))
          .rejects.toMatchObject({ code: 'permission_denied' });
      } else {
        const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'Change minimum speech',
          ...(transport === 'narrowed-stream' ? { causalPermissionAuthority: {
            kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'read-only' as const,
          } } : {}),
        });
        const events = await readVoiceAgentTurnStreamUntilDone({ manager, voiceAgentId: started.voiceAgentId, streamId: stream.streamId });
        if (transport === 'permitted-stream' || transport === 'read-stream') {
          expect(events.some(event => event.t === 'error')).toBe(false);
          expect(events.some(event => event.t === 'voice_output' && event.output.kind === 'side_effect' && event.output.action.t === action.t)).toBe(true);
        } else {
          expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ t: 'error', errorCode: 'permission_denied' })]));
          expect(events.some(event => event.t === 'voice_output' && event.output.kind === 'side_effect')).toBe(false);
        }
      }
    } finally { await manager.dispose(); }
  });

  describe.each([
    { action: { t: 'session_stop', args: { sessionId: 'other-session' } }, read: false },
    { action: { t: 'settings_invoke', args: { anchor: 'voicePrivacy.forgetVoiceAgentMemory' } }, read: false },
    { action: { t: 'approval_request_decide', args: { artifactId: 'voice-pending-approval', decision: 'approve' } }, read: false },
    { action: { t: 'approval_request_decide', args: { artifactId: 'voice-pending-approval', decision: 'reject' } }, read: false },
    { action: { t: 'session_permission_respond', args: { sessionId: 'coding-session', requestId: 'native-permission', turnId: 'native-turn', decision: 'allow' } }, read: false },
    { action: { t: 'session_permission_respond', args: { sessionId: 'coding-session', requestId: 'native-permission', turnId: 'native-turn', decision: 'deny' } }, read: false },
    { action: { t: 'listServers', args: {} }, read: true },
    { action: { t: 'invokeAction', args: { action: { pluginId: 'example.plugin', localId: 'test' }, input: {} } }, read: false },
  ])('semantic Voice Action admission ($action.t)', ({ action, read }) => {
    it.each(['ordinary', 'narrowed-stream', 'default-stream'] as const)('preserves the Action ceiling through %s output', async transport => {
      const backend = createDeterministicBackend('voice-semantic-actions', { onSend: (request, publish) => {
        publish({ kind: 'message-delta', turnId: request.delivery.turnId, channel: 'assistant',
          text: `<voice_actions>${JSON.stringify({ actions: [action] })}</voice_actions>` });
        publish({ kind: 'turn-complete', turnId: request.delivery.turnId });
      } });
      const manager = new VoiceAgentManager({ createRuntime: () => backend });
      try {
        const started = await manager.start({ backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          chatModelId: 'chat-model', commitModelId: 'chat-model',
          permissionIntent: transport === 'ordinary' ? 'read-only' : 'default',
          idleTtlSeconds: 60, initialContext: '' });
        const permitted = read || transport === 'default-stream';
        if (transport === 'ordinary') {
          const result = manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'Use this Action' });
          if (permitted) await expect(result).resolves.toMatchObject({ actions: [action] });
          else await expect(result).rejects.toMatchObject({ code: 'permission_denied' });
        } else {
          const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'Use this Action',
            ...(transport === 'narrowed-stream' ? { causalPermissionAuthority: {
              kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'read-only' as const,
            } } : {}),
          });
          const events = await readVoiceAgentTurnStreamUntilDone({ manager, voiceAgentId: started.voiceAgentId, streamId: stream.streamId });
          if (permitted) {
            expect(events.some(event => event.t === 'error')).toBe(false);
            expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ t: 'voice_output',
              output: expect.objectContaining({ kind: 'side_effect', action: expect.objectContaining(action) }),
            })]));
          } else {
            expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ t: 'error', errorCode: 'permission_denied' })]));
            expect(events.some(event => event.t === 'voice_output' && event.output.kind === 'side_effect')).toBe(false);
          }
        }
      } finally { await manager.dispose(); }
    });
  });

  it.each(['provider_busy', 'context_length_exceeded'])('surfaces the typed runtime refusal %s instead of treating it as delivered', async code => {
    // `deliverInput` reports a refusal as a value rather than a throw. If Voice
    // ignored the status it would fall through to an empty chat buffer and report
    // the generic 'Bootstrap failed', hiding the reason the Agent gave.
    const runtime: AgentRuntime = { sessions: { async open() { return {
      async send() { return {
        status: 'rejected' as const,
        diagnostic: { code, severity: 'error' as const, message: 'Agent refused the prompt' },
        retryable: false,
      }; },
      watch() { return { dispose() {} }; },
      async dispose() {},
    }; } } };
    const refusingBackend = createVoiceSessionRuntimeThroughNativeFactory({
      runtime, modelId: 'refused', capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
    });

    const manager = new VoiceAgentManager({ createBackend: () => refusingBackend });

    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    try {
      // The real native delivery owner throws the provider refusal; Voice must
      // preserve it rather than report a successful, empty response.
      const { streamId } = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'hi' });
      const events: VoiceAgentTurnStreamEvent[] = [];
      let cursor = 0;
      for (;;) {
        const reply = await manager.readTurnStream({ voiceAgentId: started.voiceAgentId, streamId, cursor, waitForEvents: true });
        events.push(...reply.events);
        if (reply.done) break;
        cursor = reply.nextCursor;
      }
      expect(events).toContainEqual({ t: 'error', error: 'Agent refused the prompt', errorCode: code });
      expect(events.some(event => event.t === 'done' || event.t === 'voice_output' && event.output.kind === 'turn_final')).toBe(false);
    } finally {
      await manager.dispose();
    }
  });

  it('keeps Account Voice Follow pending through ambiguous delivery and settles it once for later exact acceptance', async () => {
    const localId = 'voice-user-1';
    const follow = await createAccountVoiceFollowTransportFixture({ localId, userMessageSeq: 17 });
    let request: AgentSessionSendRequest | undefined;
    const backend = createDeterministicBackend('chat-follow-ambiguous', {
      session: follow.session, emitAdmissionEvents: false,
      onSend(input, publish) {
        request = input;
        publish({ kind: 'input-custody-unknown', inputIds: input.inputIds,
          issue: { code: 'provider_response_lost', severity: 'error' } });
      },
    });
    const manager = new VoiceAgentManager({ createBackend: () => backend, prepareFollowContext: follow.prepareFollowContext });
    const outcomes: SessionProviderInputOutcome[] = [];
    try {
      const started = await manager.start({
        voiceAgentId: 'voice-agent', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        chatModelId: 'chat-model', commitModelId: 'commit-model', permissionIntent: 'read-only',
        idleTtlSeconds: 60, initialContext: 'CTX',
      });
      backend.subscribeProviderInputOutcomes?.(outcome => outcomes.push(outcome));
      expect(follow.observeRequests).toEqual([]);
      const stream = await manager.startTurnStream({
        voiceAgentId: started.voiceAgentId, userText: 'what changed?', durableUserTranscriptLocalId: localId,
      });
      await vi.waitFor(() => expect(request).toBeDefined());
      if (!request) throw new Error('SDK input was not delivered');
      expect(request.inputIds).toEqual([localId]);
      expect(request.input.text).toContain('SOURCE FOLLOW UPDATE');
      expect(follow.observeRequests).toEqual(expect.arrayContaining([
        expect.objectContaining({ executionRunId: started.voiceAgentId }),
      ]));
      expect(follow.acknowledgements).toEqual([]);

      backend.publish({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
      backend.publish({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
      backend.publish({ kind: 'turn-start', turnId: request.delivery.turnId, startedBy: 'host' });
      backend.publish({ kind: 'message-delta', turnId: request.delivery.turnId, channel: 'assistant', text: 'accepted response' });
      backend.publish({ kind: 'turn-complete', turnId: request.delivery.turnId });
      await readVoiceAgentTurnStreamUntilDone({ manager, voiceAgentId: started.voiceAgentId, streamId: stream.streamId });
      expect(outcomes).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'accepted', localId, userMessageSeq: 17 }),
      ]));
      await vi.waitFor(() => expect(follow.acknowledgements).toHaveLength(1));
      expect(follow.acknowledgements[0]).toMatchObject({
        executionRunId: started.voiceAgentId, expectedPublisherGeneration: '3',
        expectedExecutionRunOccurrenceId: 'voice-occurrence',
        acceptance: { localInputId: localId, userMessageSeq: 17 },
        consumed: { transcriptSeq: 4 },
      });
    } finally {
      await backend.dispose();
      await manager.dispose();
      await follow.dispose();
    }
  });
  it.each(['source hydration', 'admission observation'] as const)('never delivers a Voice prompt cancelled while Follow %s is pending', async phase => {
    const follow = await createAccountVoiceFollowTransportFixture({
      localId: 'voice-user-cancelled-during-hydration', userMessageSeq: 19,
      holdHydration: phase === 'source hydration', holdAdmission: phase === 'admission observation',
    });
    const backend = createDeterministicBackend('chat-cancel-during-hydration', { session: follow.session });
    const manager = new VoiceAgentManager({ createBackend: () => backend, prepareFollowContext: follow.prepareFollowContext });
    try {
      const started = await manager.start({
        voiceAgentId: 'voice-agent-cancel-during-hydration',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        chatModelId: 'chat-model', commitModelId: 'commit-model', permissionIntent: 'read-only',
        idleTtlSeconds: 60, initialContext: 'CTX',
      });
      const stream = await manager.startTurnStream({
        voiceAgentId: started.voiceAgentId, userText: 'what changed?',
        durableUserTranscriptLocalId: 'voice-user-cancelled-during-hydration',
      });
      await follow.hydrationStarted;
      let cancelled = false;
      const cancelling = manager.cancelTurnStream({ voiceAgentId: started.voiceAgentId, streamId: stream.streamId })
        .then(result => { cancelled = true; return result; });
      await vi.waitFor(() => expect(cancelled).toBe(true));
      await expect(cancelling).resolves.toEqual({ ok: true });
      expect(follow.observeRequests).not.toEqual([]);
      expect(backend.getSeenPrompts()).toEqual([]);
      expect(follow.acknowledgements).toEqual([]);
    } finally {
      follow.releaseHydration();
      await manager.dispose();
      await follow.dispose();
    }
  });
  it('keeps Account Voice Follow pending through retryable pre-effect rejection and accepts a later exact outcome', async () => {
    const localId = 'voice-user-retryable';
    const follow = await createAccountVoiceFollowTransportFixture({ localId, userMessageSeq: 23 });
    const requests: AgentSessionSendRequest[] = [];
    const backend = createDeterministicBackend('chat-retryable-rejection', {
      session: follow.session, emitAdmissionEvents: false,
      onSend(request, publish) {
        requests.push(request);
        if (requests.length === 1) return {
          status: 'rejected', retryable: true, diagnostic: { code: 'provider_unavailable', severity: 'error' },
        };
        publish({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
        publish({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
        publish({ kind: 'turn-start', turnId: request.delivery.turnId, startedBy: 'host' });
        publish({ kind: 'message-delta', turnId: request.delivery.turnId, channel: 'assistant', text: 'accepted retry' });
        publish({ kind: 'turn-complete', turnId: request.delivery.turnId });
        return undefined;
      },
    });
    const manager = new VoiceAgentManager({ createBackend: () => backend, prepareFollowContext: follow.prepareFollowContext });
    const retryOutcomes: SessionProviderInputOutcome[] = [];
    try {
      const started = await manager.start({
        voiceAgentId: 'voice-agent-retryable-rejection',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        chatModelId: 'chat-model', commitModelId: 'commit-model', permissionIntent: 'read-only',
        idleTtlSeconds: 60, initialContext: 'CTX',
      });
      backend.subscribeProviderInputOutcomes?.(outcome => retryOutcomes.push(outcome));
      expect(backend.subscribeProviderInputOutcomes).toBeTypeOf('function');
      const rejected = await manager.startTurnStream({
        voiceAgentId: started.voiceAgentId, userText: 'what changed?', durableUserTranscriptLocalId: localId,
      });
      const rejectedEvents = await readVoiceAgentTurnStreamUntilDone({ manager, voiceAgentId: started.voiceAgentId, streamId: rejected.streamId });
      expect(rejectedEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ t: 'error', error: expect.stringContaining('provider_unavailable') }),
      ]));
      expect(follow.acknowledgements).toEqual([]);
      expect(follow.observeRequests).not.toEqual([]);
      expect(requests[0]?.input.text).toContain('SOURCE FOLLOW UPDATE');
      // The actual caller may retry its durable userTranscript.localId. Native
      // admission replaces only the rejected attempt, never uncertain custody.
      const retry = await manager.startTurnStream({
        voiceAgentId: started.voiceAgentId, userText: 'what changed?', durableUserTranscriptLocalId: localId,
      });
      const retryEvents = await readVoiceAgentTurnStreamUntilDone({ manager, voiceAgentId: started.voiceAgentId, streamId: retry.streamId });
      expect(requests.map((request) => request.inputIds)).toEqual([[localId], [localId]]);
      expect(requests[1]?.delivery.turnId).not.toBe(requests[0]?.delivery.turnId);
      expect(retryEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ t: 'voice_output', output: expect.objectContaining({ kind: 'turn_final', text: 'accepted retry' }) }),
      ]));
      expect(retryOutcomes).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'accepted', localId, userMessageSeq: 23 }),
      ]));
      await vi.waitFor(() => expect(follow.acknowledgements).toHaveLength(1));
      expect(follow.acknowledgements[0]?.acceptance).toEqual({ localInputId: localId, userMessageSeq: 23 });
    } finally {
      await backend.dispose();
      await manager.dispose();
      await follow.dispose();
    }
  });
  it('settles Account Voice Follow without ACK on definitive pre-effect rejection', async () => {
    const localId = 'voice-user-definitive';
    const follow = await createAccountVoiceFollowTransportFixture({ localId, userMessageSeq: 29 });
    let request: AgentSessionSendRequest | undefined;
    const backend = createDeterministicBackend('chat-definitive-rejection', {
      session: follow.session, emitAdmissionEvents: false,
      onSend(input) {
        request = input;
        return { status: 'rejected', retryable: false, diagnostic: { code: 'unsupported_action', severity: 'error' } };
      },
    });
    const manager = new VoiceAgentManager({ createBackend: () => backend, prepareFollowContext: follow.prepareFollowContext });
    try {
      const started = await manager.start({
        voiceAgentId: 'voice-agent-definitive-rejection',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        chatModelId: 'chat-model', commitModelId: 'commit-model', permissionIntent: 'read-only',
        idleTtlSeconds: 60, initialContext: 'CTX',
      });
      const stream = await manager.startTurnStream({
        voiceAgentId: started.voiceAgentId, userText: 'what changed?', durableUserTranscriptLocalId: localId,
      });
      const events = await readVoiceAgentTurnStreamUntilDone({ manager, voiceAgentId: started.voiceAgentId, streamId: stream.streamId });
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ t: 'error', error: expect.stringContaining('unsupported_action') }),
      ]));
      expect(follow.acknowledgements).toEqual([]);
      if (!request) throw new Error('SDK input was not delivered');
      backend.publish({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
      await Promise.resolve();
      expect(follow.acknowledgements).toEqual([]);
      expect(events.some((event) => event.t === 'voice_output' && event.output.kind === 'turn_final')).toBe(false);
    } finally {
      await manager.dispose();
      await follow.dispose();
    }
  });
  it('does not prepare Account Voice Follow without a durable user transcript identity', async () => {
    const follow = await createAccountVoiceFollowTransportFixture({ localId: 'unused-durable-input', userMessageSeq: 29 });
    const backend = createDeterministicBackend('chat', { session: follow.session });
    const manager = new VoiceAgentManager({ createBackend: () => backend, prepareFollowContext: follow.prepareFollowContext });
    try {
      const started = await manager.start({
        voiceAgentId: 'voice-agent-without-durable-transcript',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        chatModelId: 'chat-model', commitModelId: 'commit-model', permissionIntent: 'read-only',
        idleTtlSeconds: 60, initialContext: 'CTX',
      });
      await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'what changed?' });
      expect(follow.observeRequests).toEqual([]);
      expect(follow.acknowledgements).toEqual([]);
      expect(backend.getSeenPrompts()[0]).not.toContain('<session_follow>');
    } finally {
      await manager.dispose();
      await follow.dispose();
    }
  });

  it('normalizes sendSessionMessage preambles when extracting voice tool actions from the assistant response text', async () => {

    const chatBackend = createStaticResponseBackend(
      'chat',
      [
        'Ok, sending that now.',
        '',
        '<voice_actions>',
        JSON.stringify({ actions: [{ t: 'sendSessionMessage', args: { message: 'Please do X.' } }] }),
        '</voice_actions>',
      ].join('\n'),
    );
    const commitBackend = createDeterministicBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'default',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    const result = await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hi' });
    expect(result.assistantText).toBe('I sent that to the coding assistant and am waiting for its update.');
    expect((result as any).actions?.[0]?.t).toBe('sendSessionMessage');
  });

  it('clears delta-only output buffers between operations', async () => {

    const chatBackend = createDeltaOnlyBackend('chat');
    const commitBackend = createDeltaOnlyBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceAgentManager({ createBackend });

    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    const r1 = await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'one' });
    expect(r1.assistantText).toBe('chat:1');

    const r2 = await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'two' });
    expect(r2.assistantText).toBe('chat:2');

    const c1 = await manager.commit({ voiceAgentId: started.voiceAgentId });
    expect(c1.commitText).toBe('commit:1');

    const c2 = await manager.commit({ voiceAgentId: started.voiceAgentId });
    expect(c2.commitText).toBe('commit:2');
  });

  it('waits for backend response completion before returning chat output', async () => {

    const chatBackend = createDelayedCompletionBackend('chat');
    const commitBackend = createDeterministicBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    let resolved = false;
    const sendTurnPromise = manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hello' }).then((result) => {
      resolved = true;
      return result;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    chatBackend.completeCurrentResponse();
    const result = await sendTurnPromise;
    expect(result.assistantText).toContain('chat:');
  });

  it('waits for backend response completion before returning commit output', async () => {

    const chatBackend = createDeterministicBackend('chat');
    const commitBackend = createDelayedCompletionBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    let resolved = false;
    const commitPromise = manager.commit({ voiceAgentId: started.voiceAgentId }).then((result) => {
      resolved = true;
      return result;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    commitBackend.completeCurrentResponse();
    const result = await commitPromise;
    expect(result.commitText).toContain('commit:');
  });

  it('rejects an in-flight Voice send when its runtime is stopped', async () => {

    const deferred: { resolve: () => void } = { resolve: () => {} };
    let resolveWasSet = false;
    const waitForSendPrompt = () =>
      new Promise<void>((r) => {
        deferred.resolve = () => r();
        resolveWasSet = true;
      });

    const chatBackend = createBlockingBackend('chat', { waitForSendPrompt });
    const commitBackend = createDeterministicBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceAgentManager({ createBackend });

    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    const sendP = manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hi' });
    const sendRejected = expect(sendP).rejects.toBeInstanceOf(Error);

    await vi.waitFor(() => expect(resolveWasSet).toBe(true));

    const stopP = manager.stop({ voiceAgentId: started.voiceAgentId });
    await vi.waitFor(() => expect(chatBackend.getRuntimeLifetimeSignal().aborted).toBe(true));
    deferred.resolve();
    await sendRejected;
    await stopP;
  });

  it('retires an active turn stream without creating a replacement when stopping', async () => {

    const chatBackend = createCancelableBlockingBackend('chat');
    const commitBackend = createDeterministicBackend('commit');

    const createBackend = vi.fn<BackendFactory>(({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    });

    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'hi' });
    await vi.waitFor(() => expect(chatBackend.getSeenPrompts()).toHaveLength(1));

    await expect(manager.stop({ voiceAgentId: started.voiceAgentId })).resolves.toEqual({ ok: true });
    expect(chatBackend.getRuntimeLifetimeSignal().aborted).toBe(true);
    expect(createBackend).toHaveBeenCalledTimes(1);
  });

  it('treats late backend completion after cancellation as terminal without done, deltas, actions, or history', async () => {

    const cancelledUserText = 'do not commit this cancelled request';
    const cancelledAssistantText =
      'late text <voice_actions>{"actions":[{"t":"sendSessionMessage","args":{"message":"must not run"}}]}</voice_actions>';
    const chatBackend = createLateResolvingCancellationBackend(cancelledAssistantText);
    const replacementBackend = createStaticResponseBackend('replacement-after-cancel', 'clean');
    const commitBackend = createDeterministicBackend('commit');
    const createBackend = vi.fn<BackendFactory>()
      .mockReturnValueOnce(chatBackend)
      .mockReturnValueOnce(replacementBackend)
      .mockReturnValueOnce(commitBackend);

    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });
    const stream = await manager.startTurnStream({
      voiceAgentId: started.voiceAgentId,
      userText: cancelledUserText,
    });
    await vi.waitFor(() => expect(chatBackend.getSeenPrompts()).toHaveLength(1));

    const cancelPromise = manager.cancelTurnStream({
      voiceAgentId: started.voiceAgentId,
      streamId: stream.streamId,
    });
    const cancelledRead = await manager.readTurnStream({
      voiceAgentId: started.voiceAgentId,
      streamId: stream.streamId,
      cursor: 0,
    });
    await cancelPromise;

    expect(chatBackend.wasCancelled()).toBe(true);
    expect(cancelledRead.done).toBe(true);
    expect(cancelledRead.events).toEqual([{
      t: 'voice_output',
      output: { v: 1, kind: 'turn_cancelled', turnId: stream.streamId, seq: 0 },
    }]);
    expect(cancelledRead.events.some((event) => event.t === 'voice_output' && event.output.kind === 'turn_final')).toBe(false);
    expect(cancelledRead.events.some((event) => event.t === 'voice_output' && event.output.kind === 'speech_segment')).toBe(false);

    await manager.commit({ voiceAgentId: started.voiceAgentId, maxChars: 10_000 });
    const commitPrompt = commitBackend.getSeenPrompts().at(-1) ?? '';
    expect(commitPrompt).not.toContain(cancelledUserText);
    expect(commitPrompt).not.toContain(cancelledAssistantText);
    expect(commitPrompt).not.toContain('must not run');
  });

  it('ignores provider output emitted after a cancelled stream has detached', async () => {
    const cancelledText = 'POST DETACH CANCELLED OUTPUT';
    const cancelledBackend = createPostDetachOutputBackend(cancelledText);
    const replacementBackend = createStaticResponseBackend('replacement', 'clean next response');
    const createBackend = vi.fn()
      .mockReturnValueOnce(cancelledBackend)
      .mockReturnValueOnce(replacementBackend);
    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'chat-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });
    const stream = await manager.startTurnStream({
      voiceAgentId: started.voiceAgentId,
      userText: 'cancel this turn',
    });
    await vi.waitFor(() => expect(cancelledBackend.getSeenPrompts()).toHaveLength(1));

    await manager.cancelTurnStream({ voiceAgentId: started.voiceAgentId, streamId: stream.streamId });
    cancelledBackend.emitLateOutput();
    const next = await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'next turn' });

    expect(createBackend).toHaveBeenCalledTimes(2);
    expect(next.assistantText).toBe('clean next response');
    expect(next.assistantText).not.toContain(cancelledText);
    const commit = await manager.commit({ voiceAgentId: started.voiceAgentId, maxChars: 10_000 });
    expect(commit.commitText).not.toContain(cancelledText);
  });

  it('replays completed textual history when cancellation requires a fresh chat session', async () => {
    let promptCount = 0;
    const cancelledRuntime = createDeterministicBackend('cancelled-mid-conversation', {
      onSend(request, publish) {
        promptCount += 1;
        if (promptCount === 1) {
          publish({ kind: 'message-delta', turnId: request.delivery.turnId, channel: 'assistant', text: 'first response <voice_actions>{"actions":[{"t":"ui.voice_agent.teleport","args":{"sessionId":"prior-effect-session"}}]}</voice_actions>' });
          publish({ kind: 'turn-complete', turnId: request.delivery.turnId });
          return;
        }
      },
      onCancel(turnId, publish) {
        publish({ kind: 'turn-cancelled', turnId, cause: 'user' });
        publish({ kind: 'runtime-ended', cause: 'connectionLost', retryable: true });
      },
    });
    const replacementRuntime = createPromptCaptureBackend([{ responseText: 'replacement response' }]);
    const createBackend = vi.fn<BackendFactory>()
      .mockReturnValueOnce(cancelledRuntime)
      .mockReturnValueOnce(replacementRuntime);
    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'chat-model',
      permissionIntent: 'default',
      idleTtlSeconds: 60,
      initialContext: 'CURRENT VOICE CONTEXT',
    });

    const first = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'first turn' });
    await readVoiceAgentTurnStreamUntilDone({ manager, voiceAgentId: started.voiceAgentId, streamId: first.streamId });
    const cancelled = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'cancel this turn' });
    await vi.waitFor(() => expect(cancelledRuntime.getSeenPrompts()).toHaveLength(2));
    await manager.cancelTurnStream({ voiceAgentId: started.voiceAgentId, streamId: cancelled.streamId });
    const next = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'next turn' });
    await readVoiceAgentTurnStreamUntilDone({ manager, voiceAgentId: started.voiceAgentId, streamId: next.streamId });

    expect(replacementRuntime.prompts).toHaveLength(1);
    expect(replacementRuntime.prompts[0]).toContain('CURRENT VOICE CONTEXT');
    expect(replacementRuntime.prompts[0]).toContain('next turn');
    expect(replacementRuntime.prompts[0]).toContain('first turn');
    expect(replacementRuntime.prompts[0]).toContain('first response');
    expect(replacementRuntime.prompts[0]).not.toContain('cancel this turn');
    expect(replacementRuntime.prompts[0]).not.toContain('prior-effect-session');
  });

  it('retires the complete voice agent cleanly when cancelled-backend replacement creation fails', async () => {
    let chatDisposeCount = 0;
    const chatBackend = createCancelableBlockingBackend('chat', () => { chatDisposeCount += 1; });
    const createBackend = vi.fn<BackendFactory>()
      .mockReturnValueOnce(chatBackend)
      .mockImplementationOnce(() => { throw new Error('replacement factory failed'); });
    const onTerminalFailure = vi.fn(async () => {});
    const manager = new VoiceAgentManager({ createBackend, onTerminalFailure });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'chat-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });
    const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'cancel' });
    await vi.waitFor(() => expect(chatBackend.getSeenPrompts()).toHaveLength(1));

    await expect(manager.cancelTurnStream({
      voiceAgentId: started.voiceAgentId,
      streamId: stream.streamId,
    })).resolves.toEqual({ ok: true });
    await expect(manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'next' })).rejects.toMatchObject({
      code: 'VOICE_AGENT_NOT_FOUND',
    });
    expect(chatDisposeCount).toBe(1);
    expect(onTerminalFailure).toHaveBeenCalledWith(started.voiceAgentId, 'backend_replacement_failed');
  });

  it('makes backend replacement exclusive and never resumes the cancelled provider session', async () => {
    const replacementDeferred: { resolve: () => void } = { resolve: () => {} };
    const replacementBarrier = new Promise<void>((resolve) => { replacementDeferred.resolve = resolve; });
    const provisionArgs: unknown[] = [];
    let replacementStarted!: () => void;
    const startedReplacement = new Promise<void>((resolve) => { replacementStarted = resolve; });
    const activity: boolean[] = [];
    const cancelledBackend = createCancelableBlockingBackend('chat');
    const replacementBackend = createDeterministicBackend('replacement', {
      async onOpen(request) {
        provisionArgs.push(request);
        replacementStarted();
        await replacementBarrier;
      },
      onSend(request, publish) {
        publish({ kind: 'message-delta', turnId: request.delivery.turnId, channel: 'assistant', text: 'replacement reply' });
        publish({ kind: 'turn-complete', turnId: request.delivery.turnId });
      },
    });
    const createBackend = vi.fn<BackendFactory>()
      .mockReturnValueOnce(cancelledBackend)
      .mockReturnValueOnce(replacementBackend);
    const manager = new VoiceAgentManager({
      createBackend,
      onActivityChanged: (voiceAgentId) => activity.push(manager.isTurnInFlight(voiceAgentId)),
    });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'chat-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });
    const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'cancel' });
    await vi.waitFor(() => expect(cancelledBackend.getSeenPrompts()).toHaveLength(1));
    const cancelling = manager.cancelTurnStream({ voiceAgentId: started.voiceAgentId, streamId: stream.streamId });
    await startedReplacement;
    expect(manager.readCurrentRuntimeAuthority(started.voiceAgentId)?.runtimeState).toBe('idle');
    expect(manager.isTurnInFlight(started.voiceAgentId)).toBe(true);
    expect(activity.at(-1)).toBe(true);

    await expect(manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'too early' })).rejects.toMatchObject({
      code: 'VOICE_AGENT_BUSY',
    });
    await expect(manager.commit({ voiceAgentId: started.voiceAgentId })).rejects.toMatchObject({
      code: 'VOICE_AGENT_BUSY',
    });
    const secondCancellation = manager.cancelTurnStream({
      voiceAgentId: started.voiceAgentId,
      streamId: stream.streamId,
    });
    replacementDeferred.resolve();
    await expect(Promise.all([cancelling, secondCancellation])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(provisionArgs).toEqual([expect.objectContaining({ kind: 'create' })]);
    expect(provisionArgs[0]).not.toHaveProperty('providerSessionId');
    expect(manager.isTurnInFlight(started.voiceAgentId)).toBe(false);
    expect(activity.at(-1)).toBe(false);
    await expect(manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'next' })).resolves.toMatchObject({
      assistantText: 'replacement reply',
    });
  });

  it('disposes chat, isolated commit, and failed replacement backends exactly once when replacement provisioning fails', async () => {
    const disposed = { chat: 0, commit: 0, replacement: 0 };
    const chatBackend = createCancelableBlockingBackend('chat', () => { disposed.chat += 1; });
    const commitBackend = createDeterministicBackend('commit', { onDispose() { disposed.commit += 1; } });
    const replacementBackend = createDeterministicBackend('failed-replacement', {
      onOpen() { throw new Error('replacement provision failed'); },
      onDispose() { disposed.replacement += 1; },
    });
    const createBackend = vi.fn<BackendFactory>()
      .mockReturnValueOnce(chatBackend)
      .mockReturnValueOnce(commitBackend)
      .mockReturnValueOnce(replacementBackend);
    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      commitIsolation: true,
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });
    await manager.commit({ voiceAgentId: started.voiceAgentId });
    const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'cancel' });
    await vi.waitFor(() => expect(chatBackend.getSeenPrompts()).toHaveLength(1));

    await expect(manager.cancelTurnStream({
      voiceAgentId: started.voiceAgentId,
      streamId: stream.streamId,
    })).resolves.toEqual({ ok: true });
    expect(replacementBackend.getRuntimeLifetimeSignal().aborted).toBe(true);
    expect(disposed).toEqual({ chat: 1, commit: 1, replacement: 0 });
    await manager.dispose();
    expect(disposed).toEqual({ chat: 1, commit: 1, replacement: 0 });
  });

  it('retires Voice when the replacement SDK watch fails during native provisioning', async () => {
    const disposed = { old: false, replacement: false };
    let replacementScopeSignal: AbortSignal | undefined;
    const oldBackend = createCancelableBlockingBackend('old-sdk-watch-failure', () => { disposed.old = true; });
    const replacementBackend = createDeterministicBackend('replacement-sdk-watch-failure', {
      onOpen(_request, context) { replacementScopeSignal = context.signal; },
      onWatch() { throw new Error('SDK watch failed'); },
      onDispose() { disposed.replacement = true; },
    });
    const createBackend = vi.fn<BackendFactory>()
      .mockReturnValueOnce(oldBackend)
      .mockReturnValueOnce(replacementBackend);
    const onTerminalFailure = vi.fn(async () => {});
    const manager = new VoiceAgentManager({ createBackend, onTerminalFailure });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model', commitModelId: 'chat-model', permissionIntent: 'read-only',
      idleTtlSeconds: 60, initialContext: 'CTX',
    });
    const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'cancel' });
    await vi.waitFor(() => expect(oldBackend.getSeenPrompts()).toHaveLength(1));
    await expect(manager.cancelTurnStream({ voiceAgentId: started.voiceAgentId, streamId: stream.streamId }))
      .resolves.toEqual({ ok: true });
    await expect(manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'next' }))
      .rejects.toMatchObject({ code: 'VOICE_AGENT_NOT_FOUND' });
    expect(oldBackend.getRuntimeLifetimeSignal().aborted).toBe(true);
    expect(replacementBackend.getRuntimeLifetimeSignal().aborted).toBe(true);
    expect(replacementScopeSignal?.aborted).toBe(true);
    expect(replacementBackend.getSeenPrompts()).toEqual([]);
    expect(onTerminalFailure).toHaveBeenCalledWith(started.voiceAgentId, 'backend_replacement_failed');
    expect(disposed).toEqual({ old: true, replacement: true });
    await manager.dispose();
    expect(disposed).toEqual({ old: true, replacement: true });
  });

  it.each([
    { faultyGeneration: 'old', asynchronous: false },
    { faultyGeneration: 'replacement', asynchronous: false },
    { faultyGeneration: 'old', asynchronous: true },
    { faultyGeneration: 'replacement', asynchronous: true },
  ] as const)('contains a throwing $faultyGeneration SDK watch disposer (async=$asynchronous) and retires both native runtimes', async ({ faultyGeneration, asynchronous }) => {
    const disposed = { old: false, replacement: false };
    let oldWatch: ((event: AgentSessionRuntimeEvent) => void) | undefined;
    let replacementWatch: ((event: AgentSessionRuntimeEvent) => void) | undefined;
    let oldTurnId: string | undefined;
    let replacementTurnId: string | undefined;
    const rejectDisposal = () => {
      const error = new Error('SDK watch disposal failed');
      if (asynchronous) return Promise.reject(error);
      throw error;
    };
    const oldBackend = createDeterministicBackend('old-sdk-dispose-failure', {
      onWatch(listener) { oldWatch = listener; },
      onSend(request) { oldTurnId = request.delivery.turnId; },
      onCancel(turnId, publish) {
        publish({ kind: 'turn-cancelled', turnId, cause: 'user' });
        publish({ kind: 'runtime-ended', cause: 'connectionLost', retryable: true });
      },
      onWatchDispose() { if (faultyGeneration === 'old') return rejectDisposal(); return undefined; },
      onDispose() { disposed.old = true; },
    });
    const replacementBackend = createDeterministicBackend('replacement-sdk-dispose-failure', {
      onWatch(listener) { replacementWatch = listener; },
      onSend(request, publish) {
        replacementTurnId = request.delivery.turnId;
        publish({ kind: 'message-delta', turnId: request.delivery.turnId, channel: 'assistant', text: 'replacement survived' });
        publish({ kind: 'turn-complete', turnId: request.delivery.turnId });
      },
      onWatchDispose() { if (faultyGeneration === 'replacement') return rejectDisposal(); return undefined; },
      onDispose() { disposed.replacement = true; },
    });
    const createBackend = vi.fn<BackendFactory>()
      .mockReturnValueOnce(oldBackend)
      .mockReturnValueOnce(replacementBackend);
    const manager = new VoiceAgentManager({ createBackend });
    const unhandledErrors: unknown[] = [];
    const observeUnhandledRejection = (error: unknown) => { unhandledErrors.push(error); };
    process.on('unhandledRejection', observeUnhandledRejection);
    try {
      const started = await manager.start({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        chatModelId: 'chat-model', commitModelId: 'chat-model', permissionIntent: 'read-only',
        idleTtlSeconds: 60, initialContext: 'CTX',
      });
      const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'cancel' });
      await vi.waitFor(() => expect(oldBackend.getSeenPrompts()).toHaveLength(1));
      await expect(manager.cancelTurnStream({ voiceAgentId: started.voiceAgentId, streamId: stream.streamId }))
        .resolves.toEqual({ ok: true });
      if (!oldTurnId || !oldWatch) throw new Error('Original SDK turn was not admitted');
      // An already queued provider callback can arrive even after its disposable
      // failed; native retirement must fence the event, not rely on detachment.
      oldWatch({ kind: 'message-delta', turnId: oldTurnId, channel: 'assistant', text: 'retired old output',
        sessionId: 'session-parent', sequence: 999, emittedAtMs: 1 });
      await expect(manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'next' }))
        .resolves.toMatchObject({ assistantText: 'replacement survived' });
      expect(disposed).toEqual({ old: true, replacement: false });
      await expect(manager.stop({ voiceAgentId: started.voiceAgentId })).resolves.toEqual({ ok: true });
      if (!replacementTurnId || !replacementWatch) throw new Error('Replacement SDK turn was not admitted');
      replacementWatch({ kind: 'message-delta', turnId: replacementTurnId, channel: 'assistant', text: 'retired replacement output',
        sessionId: 'session-parent', sequence: 999, emittedAtMs: 1 });
      await expect(manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'must not resurrect' }))
        .rejects.toMatchObject({ code: 'VOICE_AGENT_NOT_FOUND' });
      expect(oldBackend.getRuntimeLifetimeSignal().aborted).toBe(true);
      expect(replacementBackend.getRuntimeLifetimeSignal().aborted).toBe(true);
      expect(disposed).toEqual({ old: true, replacement: true });
      await manager.dispose();
      expect(disposed).toEqual({ old: true, replacement: true });
      // Let Node report any rejected SDK cleanup after refresh and retirement.
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      expect(unhandledErrors).toEqual([]);
    } finally {
      try { await manager.dispose(); }
      finally { process.off('unhandledRejection', observeUnhandledRejection); }
    }
  });

  it('lets stop own teardown during an in-progress replacement without double-disposing either generation', async () => {
    const replacementDeferred: { resolve: () => void } = { resolve: () => {} };
    const replacementBarrier = new Promise<void>((resolve) => { replacementDeferred.resolve = resolve; });
    let replacementStarted!: () => void;
    const replacementOpening = new Promise<void>((resolve) => { replacementStarted = resolve; });
    const disposed = { old: 0, replacement: 0 };
    const oldBackend = createCancelableBlockingBackend('old', () => { disposed.old += 1; });
    const replacementBackend = createDeterministicBackend('stop-replacement', {
      async onOpen() { replacementStarted(); await replacementBarrier; },
      onDispose() { disposed.replacement += 1; },
    });
    const createBackend = vi.fn<BackendFactory>()
      .mockReturnValueOnce(oldBackend)
      .mockReturnValueOnce(replacementBackend);
    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'chat-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });
    const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'cancel' });
    await vi.waitFor(() => expect(oldBackend.getSeenPrompts()).toHaveLength(1));
    const cancelling = manager.cancelTurnStream({ voiceAgentId: started.voiceAgentId, streamId: stream.streamId });
    await replacementOpening;
    const stopping = manager.stop({ voiceAgentId: started.voiceAgentId });
    try {
      await vi.waitFor(() => expect(oldBackend.getRuntimeLifetimeSignal().aborted).toBe(true));
      expect(replacementBackend.getRuntimeLifetimeSignal().aborted).toBe(true);
    } finally {
      replacementDeferred.resolve();
      await expect(Promise.all([cancelling, stopping])).resolves.toEqual([{ ok: true }, { ok: true }]);
      expect(disposed).toEqual({ old: 1, replacement: 1 });
      await manager.dispose();
      expect(disposed).toEqual({ old: 1, replacement: 1 });
    }
  });

  it('does not suppress same-backend commit output while a naturally completed stream awaits its final read', async () => {

    const backend = createDeltaOnlyBackend('chat');
    const manager = new VoiceAgentManager({ createBackend: () => backend });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'chat-model',
      commitIsolation: false,
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    const stream = await manager.startTurnStream({
      voiceAgentId: started.voiceAgentId,
      userText: 'first turn',
    });
    // Preparation may cross the Account settings boundary before the runtime
    // completes; one timer tick is not evidence that this stream has settled.
    await vi.waitFor(() => expect(manager.isTurnInFlight(started.voiceAgentId)).toBe(false));
    const partialRead = await manager.readTurnStream({
      voiceAgentId: started.voiceAgentId,
      streamId: stream.streamId,
      cursor: 0,
      maxEvents: 1,
    });
    expect(partialRead.done).toBe(false);
    expect(partialRead.events).toEqual([{
      t: 'voice_output',
      output: {
        v: 1,
        kind: 'speech_segment',
        turnId: stream.streamId,
        seq: 0,
        segmentId: `${stream.streamId}:segment:0`,
        text: 'chat:1',
      },
    }]);

    const committed = await manager.commit({ voiceAgentId: started.voiceAgentId });
    expect(committed.commitText).toBe('chat:2');
  });

  it('lets stop retire a naturally completed unread stream without reclassifying it as a cancellation', async () => {
    let disposed = 0;
    const runtime = createDeterministicBackend('completed-unread-stop', {
      onSend(request, publish) {
        publish({ kind: 'message-delta', turnId: request.delivery.turnId, channel: 'assistant', text: 'completed response' });
        publish({ kind: 'turn-complete', turnId: request.delivery.turnId });
      },
      onDispose() {
        disposed += 1;
      },
    });
    const manager = new VoiceAgentManager({ createRuntime: () => runtime });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'chat-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });
    await manager.startTurnStream({
      voiceAgentId: started.voiceAgentId,
      userText: 'completed before stop',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    await expect(manager.stop({ voiceAgentId: started.voiceAgentId })).resolves.toEqual({ ok: true });
    expect(disposed).toBe(1);
    await manager.dispose();
    expect(disposed).toBe(1);
  });

  it('removes voice agents from the registry before awaiting in-flight stop, preventing new operations from starting', async () => {

    const deferred: { resolve: () => void } = { resolve: () => {} };
    let promptStarted = false;
    const waitForSendPrompt = () => new Promise<void>((r) => {
      deferred.resolve = () => r();
      promptStarted = true;
    });

    const chatBackend = createBlockingBackend('chat', { waitForSendPrompt });
    const commitBackend = createDeterministicBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    const sendP = manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hi' });
    const sendRejected = expect(sendP).rejects.toBeInstanceOf(Error);
    await vi.waitFor(() => expect(promptStarted).toBe(true));
    const stopP = manager.stop({ voiceAgentId: started.voiceAgentId });

    await expect(manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'should fail' })).rejects.toMatchObject({
      code: 'VOICE_AGENT_NOT_FOUND',
    });

    deferred.resolve();
    await sendRejected;
    await stopP;
  });

  it('notifies the lifecycle owner before reaping an idle voice agent', async () => {
    let disposed = false;
    const reapedVoiceAgentIds: string[] = [];
    const createBackend: BackendFactory = ({ modelId }) => createDeterministicBackend(modelId, {
      onDispose() {
        disposed = true;
      },
    });

    vi.useFakeTimers();
    try {
      const manager = new VoiceAgentManager({
        createBackend,
        async onIdleReaped(voiceAgentId) {
          expect(disposed).toBe(false);
          reapedVoiceAgentIds.push(voiceAgentId);
        },
      });
      const started = await manager.start({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        chatModelId: 'chat-model',
        commitModelId: 'commit-model',
        permissionIntent: 'read-only',
        idleTtlSeconds: 60,
        initialContext: 'CTX',
      });

      await vi.advanceTimersByTimeAsync(60_000);

      expect(reapedVoiceAgentIds).toEqual([started.voiceAgentId]);
      expect(disposed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      await expect(manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hi' })).rejects.toMatchObject({
        code: 'VOICE_AGENT_NOT_FOUND',
      });

      await manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the canonical idle default for NaN and reaps the idle voice agent', async () => {
    const { VoiceLocalConversationSchema } = await import('@happier-dev/protocol/voice/settings/localConversation');

    let disposedCount = 0;
    const createBackend: BackendFactory = ({ modelId }) => createDeterministicBackend(modelId, {
      onDispose() {
        disposedCount += 1;
      },
    });

    vi.useFakeTimers();
    try {
      const manager = new VoiceAgentManager({
        createBackend,
      });

      const started = await manager.start({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        chatModelId: 'chat-model',
        commitModelId: 'commit-model',
        permissionIntent: 'read-only',
        idleTtlSeconds: Number.NaN,
        initialContext: 'CTX',
      });

      await vi.advanceTimersByTimeAsync(VoiceLocalConversationSchema.parse({}).agent.idleTtlSeconds * 1000);

      expect(disposedCount).toBe(1);
      await expect(manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hi' })).rejects.toMatchObject({
        code: 'VOICE_AGENT_NOT_FOUND',
      });

      await manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([8 * 60 * 60, 30 * 24 * 60 * 60])('honors the configured idle lifetime beyond six hours through the native host runtime (%s seconds)', async idleTtlSeconds => {

    let disposedCount = 0;
    // Agent/native boundary only; the host adapter and manager lifecycle are real.
    const runtime: AgentRuntime = { sessions: { async open() { return {
      watch() { return { dispose() {} }; },
      async send() { return { status: 'admitted' as const }; },
      async dispose() { disposedCount += 1; },
    }; } } };

    vi.useFakeTimers();
    try {
      const manager = new VoiceAgentManager({
        createRuntime: ({ modelId }) => createVoiceSessionRuntimeThroughNativeFactory({ runtime, modelId,
          capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false } }),
      });

      const started = await manager.start({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        chatModelId: 'chat-model',
        commitModelId: 'commit-model',
        permissionIntent: 'read-only',
        idleTtlSeconds,
        initialContext: '',
      });

      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
      expect(disposedCount).toBe(0);

      await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);
      expect(disposedCount).toBe(0);
      expect(manager.readCurrentRuntimeAuthority(started.voiceAgentId)).toMatchObject({ runtimeState: 'idle' });

      await vi.advanceTimersByTimeAsync((idleTtlSeconds - 7 * 60 * 60) * 1000);
      expect(disposedCount).toBe(1);

      await expect(manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hi' })).rejects.toMatchObject({
        code: 'VOICE_AGENT_NOT_FOUND',
      });

      await manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps stored conversation history so prompts do not grow without bound', async () => {

    const chatBackend = createDeterministicBackend('chat');
    const commitBackend = createDeterministicBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    for (let i = 0; i < 30; i += 1) {
      await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: `user-${i}` });
    }

    await manager.commit({ voiceAgentId: started.voiceAgentId, maxChars: 10_000 });

    const prompts = commitBackend.getSeenPrompts();
    const latestPrompt = prompts[prompts.length - 1] ?? '';
    expect(latestPrompt).toContain('user-29');
    expect(latestPrompt).not.toContain('user-0');
  });

  it('streams turn output through read cursors and closes stream when consumed', async () => {

    const chatBackend = createDeltaOnlyBackend('chat');
    const commitBackend = createDeterministicBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'hello' });
    const events = await readVoiceAgentTurnStreamUntilDone({
      manager,
      voiceAgentId: started.voiceAgentId,
      streamId: stream.streamId,
      maxEvents: 32,
    });
    expect(events.some((event) => event.t === 'voice_output' && event.output?.kind === 'speech_segment')).toBe(true);
    expect(events.some((event) => event.t === 'voice_output' && event.output?.kind === 'turn_final')).toBe(true);

    await expect(
      manager.readTurnStream({
        voiceAgentId: started.voiceAgentId,
        streamId: stream.streamId,
        cursor: events.length,
      }),
    ).rejects.toMatchObject({ code: 'VOICE_AGENT_NOT_FOUND' });
  });

  it('uses the admitted speech latency target before provider completion', async () => {
    let releaseProvider: (() => void) | undefined;
    const providerDone = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const runtime = createDeterministicBackend('latency-runtime', {
      async onSend(request, publish) {
        publish({ kind: 'message-delta', turnId: request.delivery.turnId, channel: 'assistant', text: `Sure. ${'word '.repeat(30)}` });
        await providerDone;
        publish({ kind: 'turn-complete', turnId: request.delivery.turnId });
      },
    });
    const manager = new VoiceAgentManager({ createBackend: () => runtime });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model', commitModelId: 'chat-model',
      permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: 'CTX',
    });
    try {
      const stream = await manager.startTurnStream({
        voiceAgentId: started.voiceAgentId, userText: 'hello', speechSegmentTargetChars: 120,
      });
      await vi.waitFor(async () => {
        const read = await manager.readTurnStream({ voiceAgentId: started.voiceAgentId, streamId: stream.streamId, cursor: 0 });
        expect(read.done).toBe(false);
        const speech = read.events.flatMap((event) => event.t === 'voice_output' && event.output.kind === 'speech_segment'
          ? [event.output.text.trim()] : []);
        expect(speech).toEqual(['Sure.', 'word '.repeat(30).trim()]);
      });
    } finally {
      releaseProvider?.();
      await manager.stop({ voiceAgentId: started.voiceAgentId });
    }
  });

  it.each([
    { label: 'multilingual bytes', text: '你好🙂'.repeat(15_000), actionCount: 1, incomplete: true },
    { label: 'multilingual text with normalized action preamble', text: '你好🙂'.repeat(15_000), actionCount: 1, incomplete: true, sendMessage: true },
    { label: 'serialized JSON escaping', text: '\u0001'.repeat(60_000), actionCount: 1, incomplete: true },
    { label: 'valid action event overhead', text: 'word '.repeat(9_000), actionCount: 230, incomplete: false },
    { label: 'action event overflow', text: 'word '.repeat(9_000), actionCount: 300, incomplete: true },
    { label: 'valid near-boundary ASCII', text: 'word '.repeat(12_800), actionCount: 1, incomplete: false },
  ])('keeps $label inside the Protocol budget including actions and the repeated terminal final', async ({ text, actionCount, incomplete, sendMessage }) => {
    const action = sendMessage
      ? { t: 'sendSessionMessage', args: { message: 'Do X.' } }
      : { t: 'teleportVoiceAgentToSessionRoot', args: { sessionId: 's1' } };
    const block = `<voice_actions>${JSON.stringify({ actions: Array.from({ length: actionCount }, () => action) })}</voice_actions>`;
    const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
    let sequence = 0;
    const publish = (event: AgentSessionRuntimeEvent) => { for (const listener of listeners) listener(event); };
    // Only the external Agent SDK is a fixture; factory, host runtime, Voice and Protocol owners are real.
    const runtime: AgentRuntime = { sessions: { async open() { return {
      watch(listener) { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; },
      async send(request) {
        const base = { sessionId: 'session-parent', emittedAtMs: 1 };
        const turnId = request.delivery.turnId;
        publish({ ...base, sequence: sequence++, kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
        publish({ ...base, sequence: sequence++, kind: 'turn-start', turnId, startedBy: 'host' });
        for (const delta of [text, block]) {
          publish({ ...base, sequence: sequence++, kind: 'message-delta', turnId, channel: 'assistant', text: delta });
        }
        publish({ ...base, sequence: sequence++, kind: 'turn-complete', turnId });
        return { status: 'admitted' as const };
      },
      async dispose() { listeners.clear(); },
    }; } } };
    const manager = new VoiceAgentManager({ createRuntime: ({ modelId }) => createVoiceSessionRuntimeThroughNativeFactory({
      runtime, modelId, capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
    }) });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model', commitModelId: 'chat-model', permissionIntent: 'default',
      idleTtlSeconds: 60, initialContext: 'CTX',
    });
    let persistedText = '';
    const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'hello', onTurnFinal: (value) => { persistedText = value; } });
    await vi.waitFor(async () => {
      const page = await manager.readTurnStream({ voiceAgentId: started.voiceAgentId, streamId: stream.streamId, cursor: 0, maxEvents: 1 });
      expect(page.terminalEvent).toBeDefined();
    });
    const firstPage = await manager.readTurnStream({ voiceAgentId: started.voiceAgentId, streamId: stream.streamId, cursor: 0, maxEvents: 1 });
    expect(firstPage.done).toBe(false);
    expect(firstPage.terminalEvent).toMatchObject({ t: 'voice_output', output: { kind: 'turn_final', text: persistedText } });
    const events = await readVoiceAgentTurnStreamUntilDone({ manager, voiceAgentId: started.voiceAgentId, streamId: stream.streamId, maxEvents: 256 });
    let state = createVoiceAgentOutputTurnV1(stream.streamId);
    let spokenText = '';
    let finalText: string | undefined;
    for (const event of events) {
      if (event.t !== 'voice_output') continue;
      const result = ingestVoiceAgentOutputEventV1(state, event.output);
      state = result.state;
      if (event.output.kind === 'speech_segment') spokenText += event.output.text;
      if (event.output.kind === 'turn_final') finalText = event.output.text;
    }
    expect(state.terminal).toBe('final');
    expect(finalText).toBe(persistedText);
    expect(finalText?.startsWith(spokenText.trimEnd())).toBe(true);
    expect(spokenText.length).toBeGreaterThan(text.length / 4);
    expect(text.startsWith(spokenText)).toBe(true);
    expect(spokenText).not.toMatch(/[\uD800-\uDBFF]$/u);
    expect(finalText?.endsWith(VOICE_OUTPUT_INCOMPLETE_TEXT)).toBe(incomplete);
    expect(events.some((event) => event.t === 'error')).toBe(false);
    if (!incomplete) {
      expect(spokenText).toBe(text);
      expect(finalText).toBe(text.trimEnd());
      expect(events.filter((event) => event.t === 'voice_output' && event.output.kind === 'side_effect')).toHaveLength(actionCount);
    }
  });

  it('rejects a cursor beyond produced events without evicting the stream or skipping its final event', async () => {
    const chatBackend = createDeltaOnlyBackend('cursor-ahead');
    const manager = new VoiceAgentManager({ createBackend: () => chatBackend });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'chat-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });
    const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'hello' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    await expect(manager.readTurnStream({
      voiceAgentId: started.voiceAgentId,
      streamId: stream.streamId,
      cursor: 999,
    })).rejects.toMatchObject({ code: 'VOICE_AGENT_INVALID_CURSOR' });

    const events = await readVoiceAgentTurnStreamUntilDone({
      manager,
      voiceAgentId: started.voiceAgentId,
      streamId: stream.streamId,
      maxEvents: 1,
    });
    expect(events.some((event) => event.t === 'voice_output' && event.output.kind === 'turn_final')).toBe(true);
  });

  it('filters voice action blocks out of streamed deltas and normalizes sendSessionMessage preambles', async () => {

    const actionJson = JSON.stringify({ actions: [{ t: 'sendSessionMessage', args: { message: 'Do X.' } }] });
    const chatBackend = createMultiDeltaBackend('chat', [
      'Hello.',
      '\n\n<voice_actions>\n',
      actionJson,
      '\n</voice_actions>',
    ]);
    const commitBackend = createDeterministicBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'default',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'hello' });
    const events = await readVoiceAgentTurnStreamUntilDone({
      manager,
      voiceAgentId: started.voiceAgentId,
      streamId: stream.streamId,
      maxEvents: 64,
    });

    const deltaText = events
      .filter((e) => e.t === 'voice_output' && (e as any).output?.kind === 'speech_segment')
      .map((e) => (e as any).output.text)
      .join('');
    expect(deltaText).toContain('Hello.');
    expect(deltaText).not.toContain('<voice_actions>');

    const final = events.find((e) => e.t === 'voice_output' && (e as any).output?.kind === 'turn_final') as any;
    const effect = events.find((e) => e.t === 'voice_output' && (e as any).output?.kind === 'side_effect') as any;
    expect(final.output.text).toBe('I sent that to the coding assistant and am waiting for its update.');
    expect(effect.output.action.t).toBe('sendSessionMessage');
  });

  it('extracts inline canonical voice action blocks from streamed assistant text', async () => {

    const chatBackend = createMultiDeltaBackend('chat', [
      'Calling the teleport action for that session now. <voice_actions> {"actions":[{"t":"ui.voice_agent.teleport","args":{"sessionId":"s1"}}]} </voice_actions>',
    ]);
    const commitBackend = createDeterministicBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'default',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'teleport now' });
    const events = await readVoiceAgentTurnStreamUntilDone({
      manager,
      voiceAgentId: started.voiceAgentId,
      streamId: stream.streamId,
      maxEvents: 64,
    });

    const deltaText = events
      .filter((e) => e.t === 'voice_output' && (e as any).output?.kind === 'speech_segment')
      .map((e) => (e as any).output.text)
      .join('');
    expect(deltaText).toContain('Calling the teleport action for that session now.');
    expect(deltaText).not.toContain('<voice_actions>');

    const final = events.find((e) => e.t === 'voice_output' && (e as any).output?.kind === 'turn_final') as any;
    const effect = events.find((e) => e.t === 'voice_output' && (e as any).output?.kind === 'side_effect') as any;
    expect(final.output.text).toBe('Calling the teleport action for that session now.');
    expect(effect.output.action).toEqual({ t: 'teleportVoiceAgentToSessionRoot', args: { sessionId: 's1' } });
  });

  it('rejects a second stream start while a stream turn is still in-flight', async () => {

    const chatBackend = createDelayedCompletionBackend('chat');
    const commitBackend = createDeterministicBackend('commit');

    const createBackend: BackendFactory = ({ modelId }) => {
      if (modelId === 'commit-model') return commitBackend;
      return chatBackend;
    };

    const manager = new VoiceAgentManager({ createBackend });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'first' });
    await expect(manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'second' })).rejects.toMatchObject({
      code: 'VOICE_AGENT_BUSY',
    });

    chatBackend.completeCurrentResponse();
    let cursor = 0;
    let done = false;
    for (let i = 0; i < 5 && !done; i += 1) {
      const read = await manager.readTurnStream({
        voiceAgentId: started.voiceAgentId,
        streamId: stream.streamId,
        cursor,
        waitForEvents: true,
      });
      cursor = read.nextCursor;
      done = read.done;
      if (!done) {
        await Promise.resolve();
      }
    }
    expect(done).toBe(true);
  });

  it.each([
    { enabled: false, mode: 'immediate' as const },
    { enabled: true, mode: 'immediate' as const },
    { enabled: true, mode: 'on_first_turn' as const },
  ])('delivers admitted reply and greeting policy to the model on seeded and READY paths: %j', async (welcome) => {
    for (const bootstrapMode of ['none', 'ready_handshake'] as const) {
      const backend = createPromptCaptureBackend([
        ...(bootstrapMode === 'ready_handshake' ? [{ responseText: 'READY' }] : []),
        { responseText: 'Bonjour.' },
      ]);
      const manager = new VoiceAgentManager({ createBackend: () => backend });
      try {
        const start = {
          backendTarget: { kind: 'builtInAgent' as const, agentId: 'claude' },
          chatModelId: 'chat-model', commitModelId: 'commit-model',
          permissionIntent: 'read-only' as const, idleTtlSeconds: 60,
          initialContext: 'CTX', bootstrapMode,
          voicePolicy: { assistantLanguage: 'fr-FR', welcome },
        };
        const started = await manager.start(start);
        await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'What should we do?' });
        const prompt = backend.prompts[0];
        expect(prompt).toContain('Reply in fr-FR.');
        if (!welcome.enabled) expect(prompt).toContain('Do not add greeting filler');
        else if (welcome.mode === 'on_first_turn') expect(prompt).toContain('first reply to the user');
        else expect(prompt).toContain('Do not repeat this startup greeting');
      } finally { await manager.dispose(); }
    }
  });

  it.each(['READY', 'Ready.', '**READY!**', '`ready`'])('bootstraps new sessions with a decorated READY handshake: %s', async (responseText) => {

    const backend = createPromptCaptureBackend([
      { responseText },
      { responseText: 'ok' },
    ]);
    const createBackend: BackendFactory = () => backend;
    const manager = new VoiceAgentManager({ createBackend });

    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
      bootstrapMode: 'ready_handshake',
    } as any);

    expect(backend.prompts.length).toBe(1);
    expect(backend.prompts[0]).toContain('Warm-up step: reply with exactly READY');

    await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: '[hello](happier-ref:session:unbound)' });

    expect(backend.prompts.length).toBe(2);
    expect(backend.prompts[1]).toContain('User: hello');
    expect(backend.prompts[1]).not.toContain('happier-ref:');
    expect(backend.prompts[1]).not.toContain('Initial context:');
  });

  it('can defer initial context until the first user turn while still prewarming with READY', async () => {

    const backend = createPromptCaptureBackend([
      { responseText: 'READY' },
      { responseText: 'ok' },
    ]);
    const manager = new VoiceAgentManager({ createBackend: () => backend });

    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
      bootstrapMode: 'ready_handshake',
      initialContextMode: 'first_turn',
    } as any);

    expect(backend.prompts[0]).toContain('Warm-up step: reply with exactly READY');
    expect(backend.prompts[0]).not.toContain('Initial context:');

    await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hello' });

    expect(backend.prompts[1]).toContain('User: hello');
    expect(backend.prompts[1]).toContain('Initial context:\nCTX');
  });

  it('uses the provided bootstrap timeout for READY handshakes', async () => {
    vi.useFakeTimers();
    let deadline: number | undefined;
    const schedule = globalThis.setTimeout;
    const clock = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      if (delay === 15_000) deadline = Date.now() + delay;
      return schedule(callback, delay, ...args);
    });
    const backend = createDeterministicBackend('bootstrap-timeout', { onSend() {} });
    const manager = new VoiceAgentManager({ createBackend: () => backend });
    try {
      let settled = false;
      const starting = manager.start({
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        chatModelId: 'chat-model',
        commitModelId: 'commit-model',
        permissionIntent: 'read-only',
        idleTtlSeconds: 60,
        initialContext: 'CTX',
        bootstrapMode: 'ready_handshake',
        bootstrapTimeoutMs: 15_000,
      });
      void starting.then(() => { settled = true; }, () => { settled = true; });
      await vi.waitFor(() => expect(backend.getSeenPrompts()).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(0);
      if (deadline === undefined) throw new Error('Bootstrap completion deadline was not armed');
      await vi.advanceTimersByTimeAsync(deadline - Date.now() - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      await expect(starting).rejects.toMatchObject({ code: 'VOICE_AGENT_START_FAILED' });
      expect(backend.getSeenPrompts()).toHaveLength(1);
    } finally {
      await manager.dispose();
      clock.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(['provisioning', 'delivery'] as const)(
    'leaves %s under the runtime lifetime rather than the READY response deadline',
    async (phase) => {
      vi.useFakeTimers();
      let releaseOpen!: () => void;
      let releaseSend!: () => void;
      const opening = new Promise<void>((resolve) => { releaseOpen = resolve; });
      const sending = new Promise<void>((resolve) => { releaseSend = resolve; });
      let opened = false;
      let sent = false;
      const backend = createDeterministicBackend('bootstrap-budget', {
        async onOpen() { opened = true; await opening; },
        async onSend(request, publish) {
          sent = true;
          await sending;
          publish({ kind: 'message-delta', turnId: request.delivery.turnId, channel: 'assistant', text: 'READY' });
          publish({ kind: 'turn-complete', turnId: request.delivery.turnId });
        },
      });
      const manager = new VoiceAgentManager({ createRuntime: () => backend });
      let outcome = 'pending';
      const started = manager.start({
        voiceAgentId: 'bootstrap-budget',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        chatModelId: 'chat-model', commitModelId: 'commit-model',
        permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: '',
        bootstrapMode: 'ready_handshake', bootstrapTimeoutMs: 15_000,
      });
      const observed = started.then(() => { outcome = 'started'; }, () => { outcome = 'failed'; });
      try {
        await vi.waitFor(() => expect(opened).toBe(true));
        if (phase === 'delivery') {
          releaseOpen();
          await vi.waitFor(() => expect(sent).toBe(true));
        }
        // Valid preparation can outlast both the old 60 s UI default and the
        // ordinary response budget. No model response is being awaited yet.
        await vi.advanceTimersByTimeAsync(180_000);
        expect(outcome).toBe('pending');
        expect(manager.isTurnInFlight('bootstrap-budget')).toBe(true);
        releaseOpen();
        releaseSend();
        await expect(started).resolves.toMatchObject({ voiceAgentId: 'bootstrap-budget' });
      } finally {
        releaseOpen();
        releaseSend();
        await manager.dispose();
        await observed;
        vi.useRealTimers();
      }
    },
  );

  it('can bootstrap a new session with a welcome message before the first user turn', async () => {

    const backend = createPromptCaptureBackend([
      { responseText: 'Hello! What are we working on today?' },
      { responseText: 'ok' },
    ]);
    const createBackend: BackendFactory = () => backend;
    const manager = new VoiceAgentManager({ createBackend });

    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    } as any);

    const welcomed = await manager.welcome({ voiceAgentId: started.voiceAgentId });
    expect(welcomed.assistantText).toContain('Hello');
    expect(backend.prompts.length).toBe(1);
    expect(backend.prompts[0]).toContain('Start this session with a short friendly greeting');

    await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hello' });
    expect(backend.prompts.length).toBe(2);
    expect(backend.prompts[1]).toContain('User: hello');
    expect(backend.prompts[1]).not.toContain('Initial context:');
  });

  it('strips malformed action markup from the welcome response', async () => {
    const backend = createPromptCaptureBackend([{
      responseText: 'Hello!\n<voice_actions>\n{"actions": [',
    }]);
    const manager = new VoiceAgentManager({ createBackend: () => backend });
    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    });

    await expect(manager.welcome({ voiceAgentId: started.voiceAgentId }))
      .resolves.toEqual({ assistantText: 'Hello!' });
  });

  it('reuses the chat backend for commits when commitIsolation is false and commitModelId matches chatModelId', async () => {

    const backend = createPromptCaptureBackend([
      { responseText: 'reply' },
      { responseText: 'COMMIT_TEXT' },
    ]);
    const createBackendSpy = vi.fn(() => backend);
    const createBackend: BackendFactory = () => createBackendSpy();
    const manager = new VoiceAgentManager({ createBackend });

    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'chat-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
      commitIsolation: false,
    } as any);

    await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hello' });
    const committed = await manager.commit({ voiceAgentId: started.voiceAgentId, maxChars: 1000 });

    expect(committed.commitText).toBe('COMMIT_TEXT');
    expect(createBackendSpy).toHaveBeenCalledTimes(1);
    expect(backend.prompts.length).toBe(2);
    expect(backend.prompts[1]).toContain('Instruction:');
  });

  it('uses disabledActionIds when building seeded voice prompts', async () => {

    const backend = createPromptCaptureBackend([{ responseText: 'ok' }]);
    const createBackend: BackendFactory = () => backend;
    const manager = new VoiceAgentManager({ createBackend });

    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
      disabledActionIds: ['review.start'],
    } as any);

    await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hello' });

    expect(backend.prompts[0]).not.toContain('startReview');
    expect(backend.prompts[0]).toContain('listAgentBackends');
  });

  it('delivers the bound Profile persona and conflicting retained context intact to native SDK sends', async () => {
    const persona = 'For this Voice QA conversation, begin each spoken reply with "Tidepool ready."';
    const retainedContext = [
      'Retained coding conversation (reference context):',
      'User: Reply with exactly QA_LIVE_FINAL6_READY and nothing else.',
      'Assistant: QA_LIVE_FINAL6_READY',
    ].join('\n');
    const sent: AgentSessionSendRequest[] = [];
    const backend = createDeterministicBackend('persona-provider-boundary', {
      onSend(request, publish) {
        sent.push(request);
        // Model compliance is outside the host. A provider returning the old
        // reply must not make this delivery test invent or strip a persona.
        publish({ kind: 'message-delta', turnId: request.delivery.turnId,
          channel: 'assistant', text: 'QA_LIVE_FINAL6_READY' });
        publish({ kind: 'turn-complete', turnId: request.delivery.turnId });
      },
    });
    const manager = new VoiceAgentManager({
      createRuntime: () => backend,
      resolvePromptPreparation: args => resolveCliVoicePromptPreparation({
        ...args,
        sessionMetadata: { profileId: 'bound-profile' },
        accountEntries: [],
        profileEntries: [{ id: 'persona', enabled: true, placement: 'system_append', required: true,
          ref: { kind: 'doc', artifactId: 'persona' } }],
        readArtifactHeader: async () => ({ header: { v: 1, kind: 'prompt_doc.v2', title: 'Persona' } }),
        readArtifact: async () => ({ id: 'persona', header: { v: 1, kind: 'prompt_doc.v2', title: 'Persona' },
          revision: { headerVersion: 1, bodyVersion: 1 },
          body: JSON.stringify({ v: 1, markdown: persona, createdAtMs: 1, updatedAtMs: 1 }) }),
      }),
    });
    try {
      const started = await manager.start({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        profileId: 'bound-profile', contextSessionId: 'admitted-target',
        chatModelId: 'chat-model', commitModelId: 'chat-model', permissionIntent: 'read-only',
        idleTtlSeconds: 60, initialContext: retainedContext, bootstrapMode: 'none',
      });
      const userText = 'Describe what you heard in two sentences.';
      const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText });
      const events = await readVoiceAgentTurnStreamUntilDone({ manager,
        voiceAgentId: started.voiceAgentId, streamId: stream.streamId });
      const prompt = sent[0]?.input.text ?? '';
      expect(prompt).toContain(persona);
      expect(prompt).toContain(`Initial context:\n${retainedContext}`);
      expect(prompt).toContain(`User: ${userText}\nVoice agent:`);
      expect(prompt.indexOf(persona)).toBeLessThan(prompt.indexOf(retainedContext));
      expect(prompt.indexOf(retainedContext)).toBeLessThan(prompt.indexOf(`User: ${userText}`));
      expect(events).toContainEqual(expect.objectContaining({ t: 'voice_output', output:
        expect.objectContaining({ kind: 'turn_final', text: 'QA_LIVE_FINAL6_READY' }) }));

      // The same provider thread retains its seeded instructions. The next
      // input is the new user turn, without replaying the old coding request.
      await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'What did I say next?' });
      expect(sent[1]?.input.text).toBe('User: What did I say next?\nVoice agent:');
    } finally {
      await manager.dispose();
    }
  });

  it('refreshes target memory availability even when instruction text is unchanged', async () => {
    const savedSettings = await readSettings();
    await updateSettings(current => ({ ...current, memory: { ...DEFAULT_MEMORY_SETTINGS, enabled: true, enabledAtMs: 1 } }));
    const backend = createPromptCaptureBackend([{ responseText: 'READY' }, { responseText: 'off' }, { responseText: 'on' }]);
    let memoryEnabled = true;
    const manager = new VoiceAgentManager({
      createRuntime: () => backend,
      resolvePromptPreparation: async args => await resolveCliVoicePromptPreparation({ ...args,
        sessionMetadata: { work: { memoryEnabled, promptStack: [{ id: 'persona', enabled: true, placement: 'system_append',
          ref: { kind: 'doc', artifactId: 'persona' } }] } },
        readArtifact: async () => ({ id: 'persona', header: { v: 1, kind: 'prompt_doc.v2', title: 'Persona' },
          revision: { headerVersion: 1, bodyVersion: 1 }, body: JSON.stringify({ v: 1, markdown: 'Same bound persona', createdAtMs: 1, updatedAtMs: 1 }) }),
        readArtifactHeader: async () => ({ header: { v: 1, kind: 'prompt_doc.v2', title: 'Persona' } }),
      }),
    });
    try {
      const started = await manager.start({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, contextSessionId: 'admitted-target',
        chatModelId: 'chat-model', commitModelId: 'commit-model', permissionIntent: 'read-only',
        idleTtlSeconds: 60, initialContext: 'CTX', bootstrapMode: 'ready_handshake',
      });
      expect(backend.prompts[0]).toContain(buildMemoryRecallGuidanceBlockV1('voice'));
      memoryEnabled = false;
      await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'memory off' });
      expect(backend.prompts[1]).toContain('Same bound persona');
      expect(backend.prompts[1]).not.toContain(buildMemoryRecallGuidanceBlockV1('voice'));
      memoryEnabled = true;
      await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'memory on' });
      expect(backend.prompts[2]).toContain(buildMemoryRecallGuidanceBlockV1('voice'));
    } finally { await manager.dispose(); await writeSettings(savedSettings); }
  });

  it.each(['turn', 'stream'] as const)('reads current instruction content again before a %s and keeps unchanged text seeded', async (carrier) => {
    const backend = createPromptCaptureBackend([
      { responseText: 'READY' }, { responseText: 'first' }, { responseText: 'second' },
    ]);
    let markdown = 'Current admitted instruction';
    const manager = new VoiceAgentManager({
      createRuntime: () => backend,
      resolvePromptPreparation: createInstructionBlocksResolver(async () => markdown),
    });
    try {
      const started = await manager.start({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        profileId: 'work', contextSessionId: 'admitted-target',
        chatModelId: 'chat-model', commitModelId: 'commit-model', permissionIntent: 'read-only',
        idleTtlSeconds: 60, initialContext: 'CTX', bootstrapMode: 'ready_handshake',
      });
      await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'first' });
      expect(backend.prompts[1]).not.toContain('Current admitted instruction');
      markdown = 'Edited admitted instruction';
      if (carrier === 'turn') {
        await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'second' });
      } else {
        const stream = await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'second' });
        await readVoiceAgentTurnStreamUntilDone({ manager, voiceAgentId: started.voiceAgentId, streamId: stream.streamId });
      }
      expect(backend.prompts[2]).toContain('Edited admitted instruction');
      expect(backend.prompts[2]).not.toContain('Current admitted instruction');
    } finally {
      await manager.dispose();
    }
  });

  it('does not install or dispatch a fresh instruction read after the voice instance stops', async () => {
    const backend = createPromptCaptureBackend([{ responseText: 'unused' }]);
    let completeRead!: () => void;
    const pendingRead = new Promise<void>((resolve) => { completeRead = resolve; });
    let reads = 0;
    const manager = new VoiceAgentManager({
      createRuntime: () => backend,
      resolvePromptPreparation: createInstructionBlocksResolver(async () => {
        reads += 1;
        if (reads > 1) await pendingRead;
        return 'Admitted target instruction';
      }),
    });
    try {
      const started = await manager.start({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        contextSessionId: 'admitted-target', chatModelId: 'chat-model', commitModelId: 'commit-model',
        permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: 'CTX',
      });
      await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'hello' });
      await vi.waitFor(() => expect(reads).toBe(2));
      const stopped = manager.stop({ voiceAgentId: started.voiceAgentId });
      completeRead();
      await stopped;
      expect(backend.prompts).toEqual([]);
    } finally {
      completeRead();
      await manager.dispose();
    }
  });

  it('reads current instruction content before the supported welcome preparation', async () => {
    const backend = createPromptCaptureBackend([{ responseText: 'READY' }, { responseText: 'hello' }]);
    let markdown = 'STARTUP_DOC_PERSONA_OLD';
    const manager = new VoiceAgentManager({
      createRuntime: () => backend,
      resolvePromptPreparation: createInstructionBlocksResolver(async () => markdown),
    });
    try {
      const started = await manager.start({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        contextSessionId: 'admitted-target', chatModelId: 'chat-model', commitModelId: 'commit-model',
        permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: 'CTX', bootstrapMode: 'ready_handshake',
      });
      markdown = 'Current welcome instruction';
      await manager.welcome({ voiceAgentId: started.voiceAgentId });
      expect(backend.prompts[1]).toContain('Current welcome instruction');
      expect(backend.prompts[1]).not.toContain('STARTUP_DOC_PERSONA_OLD');
    } finally {
      await manager.dispose();
    }
  });
  it.each(['  Literal greeting.\n\n', '   ', ''])('admits exact welcome bytes at the execution Action owner %j', async welcomeText => {
    const backend = createPromptCaptureBackend([{ responseText: 'hello' }]);
    const manager = new VoiceAgentManager({ createRuntime: () => backend });
    try {
      const { voiceAgentId } = await manager.start({ backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        chatModelId: 'chat', commitModelId: 'chat', permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: '' });
      const run: ExecutionRunState = { runId: voiceAgentId, callId: 'call', sidechainId: 'sidechain', sessionId: 'control', depth: 0,
        intent: 'voice_agent', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, backendId: 'claude', instructions: '',
        permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming', status: 'running', startedAtMs: 0 };
      const controller: ExecutionRunController = { kind: 'voice_agent', controllerOccurrenceId: 'occurrence', voiceAgentId,
        cancelled: false, lastMarkerWriteAtMs: 0, terminalPromise: Promise.resolve(), resolveTerminal: () => {},
        transcript: { persistenceMode: 'ephemeral', epoch: 1 }, externalStreamIdByInternal: new Map(), internalStreamIdByExternal: new Map(),
        pendingTranscriptTurnByExternalStreamId: new Map(), terminalReadByExternalStreamId: new Map(), readInFlightByExternalStreamId: new Map() };
      const result = await applyExecutionRunAction({ runId: voiceAgentId,
        params: { actionId: 'voice_agent.welcome', input: { welcomeText } }, runs: new Map([[voiceAgentId, run]]),
        controllers: new Map([[voiceAgentId, controller]]), voiceAgentManager: manager, parentProvider: 'claude',
        startRun: async () => { throw new Error('Welcome must not start another Run'); } });
      expect(result).toMatchObject({ ok: true });
      expect(backend.prompts[0]).toContain(`exactly this message:\n${welcomeText}\n\nThen, wait`);
    } finally { await manager.dispose(); }
  });

  it('installs current instruction content on the first supported preparation of a resumed runtime', async () => {
    const backend = createPromptCaptureBackend([{ responseText: 'first' }, { responseText: 'second' }], { resumeSupported: true });
    const manager = new VoiceAgentManager({
      createRuntime: () => backend,
      resolvePromptPreparation: createInstructionBlocksResolver(async () => 'Current resumed instruction'),
    });
    try {
      const started = await manager.start({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        contextSessionId: 'admitted-target', chatModelId: 'chat-model', commitModelId: 'commit-model',
        permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: 'CTX',
        resumeHandle: {
          kind: 'provider_session.v1', backendTarget: { kind: 'backend', backendId: 'claude' },
          providerSessionId: 'previous-provider-session',
        },
      });
      await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'first' });
      expect(backend.prompts[0]).toContain('Current resumed instruction');
      await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'second' });
      expect(backend.prompts[1]).not.toContain('Current resumed instruction');
    } finally {
      await manager.dispose();
    }
  });

  it('keeps an installed voice runtime retryable after fresh instruction transport fails', async () => {
    const backend = createPromptCaptureBackend([{ responseText: 'READY' }, { responseText: 'recovered' }]);
    let failRead = false;
    let markdown = 'Installed instruction';
    // The HTTP artifact reader propagates this boundary failure, including the
    // temporary "Failed to get artifact" server response.
    const unavailable = new ArtifactEncryptionMaterialUnavailableError();
    const manager = new VoiceAgentManager({
      createRuntime: () => backend,
      resolvePromptPreparation: createInstructionBlocksResolver(async () => {
        if (failRead) throw unavailable;
        return markdown;
      }),
    });
    try {
      const started = await manager.start({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        contextSessionId: 'admitted-target', chatModelId: 'chat-model', commitModelId: 'commit-model',
        permissionIntent: 'read-only', idleTtlSeconds: 60, initialContext: 'CTX', bootstrapMode: 'ready_handshake',
      });
      failRead = true;
      await expect(manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'retryable' })).rejects.toMatchObject({
        status: 'attachment_unavailable', reason: 'locked', admittedEntries: [{ entryId: 'instruction', outcome: 'unavailable', reason: 'locked' }],
      });
      expect(backend.prompts).toHaveLength(1);
      expect(manager.readCurrentRuntimeAuthority(started.voiceAgentId)?.runtimeState).toBe('idle');
      failRead = false;
      markdown = 'Recovered current instruction';
      await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'try again' });
      expect(backend.prompts[1]).toContain('Recovered current instruction');
    } finally {
      await manager.dispose();
    }
  });

  it('resolves and forwards voice prompt stack blocks into the READY bootstrap prompt', async () => {

    const backend = createPromptCaptureBackend([
      { responseText: 'READY' },
      { responseText: 'ok' },
    ]);
    const seenArgs: Array<{ profileId?: string | null; sessionId?: string | null; workingDirectory?: string | null }> = [];
    const manager = new VoiceAgentManager({
      createBackend: () => backend,
      resolvePromptPreparation: async (args: ResolveVoicePromptPreparationArgs) => {
        seenArgs.push(args);
        return { systemAppendBlocks: ['Voice stack block'], memoryRecallGuidanceEnabled: false, disabledActionIds: [] };
      },
    } as any);

    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      profileId: 'work',
      contextSessionId: 'session-1',
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
      bootstrapMode: 'ready_handshake',
    } as any);

    expect(backend.prompts[0]).toContain('Voice stack block');
    expect(seenArgs).toEqual([{ profileId: 'work', sessionId: 'session-1', signal: expect.any(AbortSignal) }]);
  });

  it('resolves and forwards voice prompt stack blocks into the first seeded turn when bootstrap is skipped', async () => {

    const backend = createPromptCaptureBackend([{ responseText: 'ok' }]);
    const manager = new VoiceAgentManager({
      createBackend: () => backend,
      resolvePromptPreparation: async () => ({ systemAppendBlocks: ['Voice stack block'], memoryRecallGuidanceEnabled: false, disabledActionIds: [] }),
    } as any);

    const started = await manager.start({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      chatModelId: 'chat-model',
      commitModelId: 'commit-model',
      permissionIntent: 'read-only',
      idleTtlSeconds: 60,
      initialContext: 'CTX',
    } as any);

    await manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hello' });

    expect(backend.prompts[0]).toContain('Voice stack block');
  });

  it.each(['welcome', 'turn', 'commit', 'stream'] as const)('lets a %s complete beyond the former 120-second turn cutoff', async (operation) => {
    vi.useFakeTimers();
    let complete: (() => void) | undefined;
    const backend = createDeterministicBackend(`long-${operation}`, { onSend(request, publish) {
      complete = () => {
        publish({ kind: 'message-delta', turnId: request.delivery.turnId, channel: 'assistant', text: 'Completed after the wait.' });
        publish({ kind: 'turn-complete', turnId: request.delivery.turnId });
      };
    } });
    const manager = new VoiceAgentManager({
      createRuntime: () => backend,
      resolvePromptPreparation: async () => ({ systemAppendBlocks: [], memoryRecallGuidanceEnabled: false, disabledActionIds: [] }),
    });
    try {
      const started = await manager.start({
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        chatModelId: 'chat-model', commitModelId: 'chat-model', permissionIntent: 'read-only',
        idleTtlSeconds: 60, initialContext: 'CTX',
      });
      const stream = operation === 'stream'
        ? await manager.startTurnStream({ voiceAgentId: started.voiceAgentId, userText: 'hello' }) : null;
      const work = stream ? null : operation === 'welcome'
        ? manager.welcome({ voiceAgentId: started.voiceAgentId, welcomeText: 'hi' })
        : operation === 'turn'
          ? manager.sendTurn({ voiceAgentId: started.voiceAgentId, userText: 'hello' })
          : manager.commit({ voiceAgentId: started.voiceAgentId });
      let settled = false;
      void work?.then(() => { settled = true; }, () => { settled = true; });
      await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
      await vi.advanceTimersByTimeAsync(120_001);
      complete!();
      if (stream) {
        const events = await readVoiceAgentTurnStreamUntilDone({ manager, voiceAgentId: started.voiceAgentId, streamId: stream.streamId });
        expect(events.some(event => event.t === 'error')).toBe(false);
        expect(events).toContainEqual(expect.objectContaining({ t: 'voice_output', output: expect.objectContaining({ kind: 'turn_final', text: 'Completed after the wait.' }) }));
      } else {
        expect(settled).toBe(false);
        await expect(work).resolves.toEqual(operation === 'commit'
          ? { commitText: 'Completed after the wait.' } : { assistantText: 'Completed after the wait.' });
      }
    } finally {
      await manager.dispose();
      vi.useRealTimers();
    }
  });
});
