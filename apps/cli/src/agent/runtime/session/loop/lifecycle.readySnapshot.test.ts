import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readTurnChangeToolMetadata, extractCanonicalDiffFiles } from '@happier-dev/protocol/sessions/messages/canonicalTurnDiffTool';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { AgentSessionRuntime, AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventV1Schema, SessionTurnMutationV1Schema,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowCheckpointStoredEnvelopeV1,
  sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1,
  type WorkflowDefinitionV1 } from '@happier-dev/protocol';
import { observeWorkflowSessionInputResult, classifyWorkflowSessionInputResult, type WorkflowSessionInputObservation } from '@/daemon/workflows/stepExecution';
import { createWorkflowRunStorageTestkit } from '@/daemon/workflows/workflowRunStorage.testkit';
import { createWorkflowInvocationRecoveryFactWriter } from '@/daemon/workflows/recovery';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { buildAcpAgentMessageEnvelope } from '@/api/session/acpMessageEnvelope';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createSessionProviderInputOutcomeBinding } from '@/agent/runtime/session/input/providerInputOutcome';

import { withHostSessionRuntimeIdentityPublication } from '@/agent/runtime/identity/publication/withHostSession';
import { subscribeSessionRuntimePublicationToMetadata } from '@/agent/runtime/identity/metadata/subscription';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt, type PermissionModeQueuedPromptMode } from '@/agent/runtime/permissions/queuedPrompt';
import { runPermissionModePromptLoop } from '@/agent/runtime/runPermissionModePromptLoop';
import { createUnsettledReplaySeedRetirement } from '@/agent/runtime/replaySeed/unsettledReplaySeedRetirement';
import { createTurnAssistantTextSnapshotStore } from '@/api/session/turns/assistantTextSnapshotStore';
import { extractAssistantTextSnapshotFromAcpMessage } from '@/api/session/turns/extractAssistantTextSnapshot';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { createNotificationAccountSnapshotFixture } from '@/testkit/notificationAccountSnapshot';
import { clearActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { sendReadyWithPushNotification } from '@/agent/runtime/notifications/sendReadyWithPushNotification';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/builtIn/snapshot';

import { HOST_SESSION_RUNTIME_PLAN_KIND, runSessionLoopLifecycle, type SessionLoopLifecycleParams } from './lifecycle';

vi.mock('@/api/session/sockets', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/session/sockets')>(),
  createSessionScopedSocketConnection: () => {
    const socket = createApiSessionSocketStub({ connected: false });
    return { socket, transport: createSocketTransportAdapter(socket) };
  },
}));

describe('host ready after a provider successor starts', () => {
  it.each([
    { hostAnswer: 'HOST_ANSWER', eagerStartup: false, retirePreview: false, omitReceipt: false, combinedCard: false, rejectDiff: false },
    { hostAnswer: null, eagerStartup: false, retirePreview: false, omitReceipt: false, combinedCard: false, rejectDiff: false },
    { hostAnswer: 'HOST_ANSWER', eagerStartup: true, retirePreview: false, omitReceipt: false, combinedCard: false, rejectDiff: false },
    { hostAnswer: 'HOST_ANSWER', eagerStartup: false, retirePreview: true, omitReceipt: false, combinedCard: false, rejectDiff: false },
    { hostAnswer: 'HOST_ANSWER', eagerStartup: false, retirePreview: false, omitReceipt: true, combinedCard: false, rejectDiff: false },
    { hostAnswer: 'HOST_ANSWER', eagerStartup: false, retirePreview: false, omitReceipt: false, combinedCard: true, rejectDiff: false },
    { hostAnswer: 'HOST_ANSWER', eagerStartup: false, retirePreview: false, omitReceipt: false, combinedCard: true, rejectDiff: true },
    { hostAnswer: null, eagerStartup: false, retirePreview: false, omitReceipt: false, combinedCard: false, rejectDiff: false, failure: 'native' },
    { hostAnswer: null, eagerStartup: false, retirePreview: false, omitReceipt: false, combinedCard: false, rejectDiff: false, failure: 'prompt' },
    { hostAnswer: null, eagerStartup: false, retirePreview: false, omitReceipt: false, combinedCard: false, rejectDiff: false, failure: 'strict_resume' },
  ])('preserves host results across preview retirement=$retirePreview, receipt omission=$omitReceipt and eager startup=$eagerStartup/$hostAnswer (combined card=$combinedCard, reject Diff=$rejectDiff, failure=$failure)', async (scenario) => {
    const { hostAnswer, eagerStartup, retirePreview, omitReceipt, combinedCard, rejectDiff } = scenario;
    const failure = 'failure' in scenario && scenario.failure;
    const checkpointRoot = combinedCard ? await mkdtemp(join(tmpdir(), 'happier-host-turn-card-')) : null;
    if (checkpointRoot) {
      const git = promisify(execFileCallback);
      await git('git', ['init'], { cwd: checkpointRoot });
      await git('git', ['config', 'user.email', 'test@example.com'], { cwd: checkpointRoot });
      await git('git', ['config', 'user.name', 'Happier Test'], { cwd: checkpointRoot });
      await writeFile(join(checkpointRoot, 'tracked.txt'), 'initial\n');
      await git('git', ['add', 'tracked.txt'], { cwd: checkpointRoot });
      await git('git', ['commit', '-m', 'initial'], { cwd: checkpointRoot });
    }
    const accountRequests: string[] = [];
    // Account HTTP is outside the host. The real project resolver receives a
    // current empty association census; unexpected network reads still fail.
    const accountGet = vi.spyOn(axios, 'get').mockImplementation(async url => {
      accountRequests.push(`GET ${String(url)}`);
      if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: {
        mode: 'plain', updatedAt: 1,
      } };
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
      } };
      if (String(url).endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session:
        createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', active: true, metadata: '{}' }) } };
      if (String(url).endsWith('/reply')) return { status: 200, data: { v: 1, status: 'none' } };
      if (String(url).includes('/messages/by-local-id/')) return { status: 200, data: { message: {
        id: 'original-input', localId: 'host-input', seq: 1, createdAt: 1, updatedAt: 1,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'host input' } } },
      } } };
      if (String(url).endsWith('/turns')) return { status: 200, data: { v: 1, sessionId, updatedAt: 100, turns:
        terminalMutations.filter(m => m.turnId === hostTurnIds[0]).map(m => ({ turnId: m.turnId,
          status: m.action === 'complete' ? 'completed' : 'failed', startedAt: 1, updatedAt: 100,
          transcriptAnchors: m.action === 'complete' ? m.transcriptAnchors : inputAnchors.get(m.turnId),
          ...(m.action === 'fail' ? { lastRuntimeIssue: m.issue } : {}),
        })) } };
      if (String(url).includes('/messages?')) return { status: 200, data: { messages: transcriptRows } };
      throw new Error(`Unexpected account GET: ${String(url)}`);
    });
    const accountPost = vi.spyOn(axios, 'post').mockImplementation(async url => {
      accountRequests.push(`POST ${String(url)}`);
      if (String(url).endsWith('/v1/account/project-rows/list')) return { status: 200,
        data: { status: 'listed', rows: [], coverage: 'complete' } };
      throw new Error(`Unexpected account POST: ${String(url)}`);
    });
    const lease = await pluginReloadController.acquireRuntimeRegistry({
      resolveRuntimeRegistry: async () => await resolveExecutablePluginRuntimeRegistry({
        contributes: getResolvedContributionRegistry(), pluginIds: [],
      }),
    });
    const sessionId = 'c' + 'a'.repeat(24);
    const hostTurnIds: string[] = [];
    const readyOriginals: Array<{ localId: string; seq: number }> = [];
    const readyEvents: unknown[] = [];
    const sentNotifications: unknown[][] = [];
    setActiveAccountSettingsSnapshot(createNotificationAccountSnapshotFixture());
    let providerDispatchCount = 0;
    const secondHostAnswer = hostAnswer === null ? 'SECOND_HOST_ANSWER' : null;
    const committedMessages: unknown[] = [];
    const agentMessages: ACPMessageData[] = [];
    const terminalMutations: Array<Extract<ReturnType<typeof SessionTurnMutationV1Schema.parse>, { action: 'complete' | 'fail' }>> = [];
    const inputAnchors = new Map<string, Extract<ReturnType<typeof SessionTurnMutationV1Schema.parse>, { action: 'append_transcript_anchors' }>['transcriptAnchors']>();
    const transcriptRows: Array<{ id: string; localId: string; seq: number; createdAt: number; updatedAt: number;
      content: { t: 'plain'; v: ReturnType<typeof buildAcpAgentMessageEnvelope> } }> = [];
    const committedAssistantSeqs = new Map<string, number>();
    const failureMarkerSeqs = new Map<string, number>();
    const acceptedUserSeqs = new Map<string, number>();
    const pendingReceipts = new Map<string, () => void>();
    const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
    let sequence = 0;
    const emit = (input: Readonly<Record<string, unknown>>) => {
      const event = AgentSessionRuntimeEventV1Schema.parse({ ...input, sessionId, sequence: ++sequence, emittedAtMs: sequence });
      for (const listener of listeners) listener(event);
    };
    const startupEvents = eagerStartup ? [
      { kind: 'transcript-message-committed', messageId: 'startup-input', role: 'user', text: 'EXTENSION_STARTUP_INPUT' },
      { kind: 'turn-start', turnId: 'startup-turn', startedBy: 'provider' },
      { kind: 'message-delta', turnId: 'startup-turn', channel: 'assistant', text: 'EXTENSION_STARTUP_ANSWER' },
      { kind: 'turn-complete', turnId: 'startup-turn' },
      { kind: 'provider-session-id', providerSessionId: 'startup-native-session' },
    ].map(input => AgentSessionRuntimeEventV1Schema.parse({ ...input, sessionId, sequence: ++sequence, emittedAtMs: sequence })) : [];
    // The vendor runtime is the external boundary. Native admission, transcript
    // projection, snapshot ownership, the prompt loop and ready dispatch are real.
    const provider: AgentSessionRuntime = {
      async send(request) {
        providerDispatchCount += 1;
        hostTurnIds.push(request.delivery.turnId);
        if (failure === 'prompt') throw new Error('Prompt dispatch failed before a native turn');
        const answer = providerDispatchCount === 1 ? hostAnswer : secondHostAnswer;
        emit({ kind: 'input-accepted', inputIds: request.inputIds, delivery: request.delivery });
        emit({ kind: 'turn-start', turnId: request.delivery.turnId, startedBy: 'host' });
        if (checkpointRoot && providerDispatchCount === 1) {
          emit({ kind: 'tool-call', turnId: request.delivery.turnId, toolCallId: 'edit', toolName: 'Edit',
            input: { file_path: 'tracked.txt', old_string: 'initial\n', new_string: 'changed\n' } });
          await writeFile(join(checkpointRoot, 'tracked.txt'), 'changed\n');
          emit({ kind: 'tool-result', turnId: request.delivery.turnId, toolCallId: 'edit', output: { status: 'completed' } });
        }
        if (answer) emit({ kind: 'message-delta', turnId: request.delivery.turnId, channel: 'assistant', text: answer });
        emit(failure ? { kind: 'turn-failed', turnId: request.delivery.turnId,
          diagnostic: { code: 'empty_failure', severity: 'error', message: 'Failed before any assistant output' } }
          : { kind: 'turn-complete', turnId: request.delivery.turnId });
        const successorTurnId = `provider-successor-${providerDispatchCount}`;
        emit({ kind: 'turn-start', turnId: successorTurnId, startedBy: 'provider' });
        emit({ kind: 'transcript-message-committed', turnId: successorTurnId, messageId: `successor-answer-${providerDispatchCount}`,
          role: 'assistant', text: 'SUCCESSOR_ANSWER' });
        return { status: 'admitted' };
      },
      watch(listener) {
        listeners.add(listener);
        for (const event of startupEvents.splice(0)) listener(event);
        return { dispose() { listeners.delete(listener); } };
      },
      dispose() {},
    };
    const runtime = createNativeAgentSessionOperations(provider, sessionId, undefined, undefined, undefined, undefined, undefined, {
      context: {} as AgentSessionRuntimeContext, cwd: '/tmp/ready-handoff', connectedAccounts: [],
      capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
      cancellation: { declared: false }, configuration: { declared: false }, manualCompaction: { declared: false },
    });
    const metadata = createTestMetadata({ path: checkpointRoot ?? '/tmp/ready-handoff', permissionMode: 'default' });
    const snapshots = createTurnAssistantTextSnapshotStore();
    let observedSeq = 1;
    let secondHostSeq: number | null = null;
    const fixture = createMutableApiSessionClientFixture({ sessionId, metadata });
    const session = Object.assign(fixture, {
      enqueueSessionEventCommitted: async (event: Parameters<NonNullable<typeof fixture.enqueueSessionEventCommitted>>[0]) => {
        if (event.type !== 'ready') return { persisted: true, delivered: true };
        readyEvents.push(event);
        const sourceMessage = { localId: `ready-original-${readyOriginals.length + 1}`, seq: ++observedSeq };
        readyOriginals.push(sourceMessage);
        return { persisted: true, delivered: true, localId: sourceMessage.localId, committedSequence: sourceMessage.seq,
          personalFollow: { sourceSessionId: sessionId, sourceMessage: { ...sourceMessage, policies: [{ preset: 'everything' as const }] } } };
      },
      turnAssistantTextSnapshotStore: snapshots,
      getTurnAssistantTextSnapshotStore: () => snapshots,
      getLastObservedMessageSeq: () => observedSeq,
      enqueueUserTextMessageCommitted: async (text: string) => {
        committedMessages.push({ role: 'user', text });
        observedSeq += 1;
        return { persisted: true as const, delivered: true as const };
      },
      getCommittedUserMessageSeq: (localId: string) => acceptedUserSeqs.get(localId) ?? null,
      enqueueSessionTurnMutation: async (mutation: unknown) => {
        const parsed = SessionTurnMutationV1Schema.parse(mutation);
        if (parsed.action === 'append_transcript_anchors') inputAnchors.set(parsed.turnId, parsed.transcriptAnchors);
        if (parsed.action === 'complete' || parsed.action === 'fail') terminalMutations.push(parsed);
      },
      enqueueAgentMessageCommitted: async (
        providerId: Parameters<NonNullable<typeof fixture.enqueueAgentMessageCommitted>>[0],
        body: Parameters<NonNullable<typeof fixture.enqueueAgentMessageCommitted>>[1],
        options: Parameters<NonNullable<typeof fixture.enqueueAgentMessageCommitted>>[2],
      ) => {
        committedMessages.push(body);
        agentMessages.push(body);
        if (rejectDiff && body.type === 'tool-call' && body.name === 'Diff') return { persisted: false as const, delivered: false as const };
        const extracted = extractAssistantTextSnapshotFromAcpMessage(providerId, body);
        if (body.type === 'turn_failed') {
          const seq = ++observedSeq;
          failureMarkerSeqs.set(body.id, seq);
          return { persisted: true as const, delivered: true as const, committedSequence: seq };
        }
        if (extracted) {
          const seq = ++observedSeq;
          transcriptRows.push({ id: `reply-${seq}`, localId: options.localId, seq, createdAt: seq, updatedAt: seq,
            content: { t: 'plain', v: buildAcpAgentMessageEnvelope({ provider: providerId, body, meta: options.meta }) } });
          if (!omitReceipt) snapshots.observe({ ...extracted, localId: options.localId, seq, source: 'committed' });
          if (retirePreview) snapshots.clearSnapshot({ reason: 'clear' });
          committedAssistantSeqs.set(extracted.text, seq);
          // The external Pending receipt can arrive after a successor's first
          // assistant row. Native acceptance itself is not this Home ACK.
          if (extracted.text === 'SUCCESSOR_ANSWER') {
            for (const settle of pendingReceipts.values()) settle();
            pendingReceipts.clear();
          }
        }
        return { persisted: true as const, delivered: true as const,
          ...(!omitReceipt && extracted ? { committedSequence: committedAssistantSeqs.get(extracted.text) } : {}) };
      },
    });
    const inputBinding = createSessionProviderInputOutcomeBinding({ getTarget: () => ({ sessionId,
      hasPendingProviderInput: () => true,
      observeProviderInputSettlement: outcome => new Promise<void>(resolve => {
        pendingReceipts.set(outcome.localId, () => {
          const seq = outcome.localId === 'host-input' ? 1 : secondHostSeq;
          if (seq !== null) acceptedUserSeqs.set(outcome.localId, seq);
          resolve();
        });
      }),
    }) });
    // These are the real host launch owners, installed before the Session loop.
    runtime.setOnPromptDeliveryOutcome(inputBinding.observeProviderInputOutcome);
    let metadataPublication: ReturnType<typeof subscribeSessionRuntimePublicationToMetadata> | null = null;
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
      mode => mode.permissionMode, { batcher: combinePermissionModeQueuedPrompts });
    queue.push({ text: 'host input', localId: 'host-input', userMessageSeq: 1 }, { permissionMode: 'default' });
    const runtimeState = { thinking: false };
    let ready = false;
    const controller = new AbortController();
    const readyPreviews: Array<string | null | undefined> = [];
    const thinkingAtReady: boolean[] = [];
    const params: SessionLoopLifecycleParams = {
      opts: { credentials: { token: `header.${Buffer.from(JSON.stringify({ sub: 'ready-account' })).toString('base64url')}.signature`, encryption: null } },
      config: {
        flavor: 'default', policyAgentId: 'codex', backendDisplayName: 'Test Agent', uiLogPrefix: '[ReadyTest]',
        providerName: 'Test Agent', waitingForCommandLabel: 'Test Agent', agentMessageType: 'codex',
        runtimeActivityApplicability: 'not_applicable', machineMetadata: { host: 'test', platform: 'linux', happyCliVersion: '0.0.0-test', homeDir: '/tmp', happyHomeDir: '/tmp/happier', happyLibDir: '/tmp/happier/lib' },
        loadTerminalDisplay: async () => () => null, shouldRenderTerminalDisplay: () => false, formatPromptErrorMessage: String,
        ...(combinedCard ? {} : { lifecycleHooks: { createCheckpointLifecycle: () => ({}) } }),
        ...(failure === 'strict_resume' ? { onAfterStart: () => { throw new Error('Native resume startup failed'); } } : {}),
        publishHostRuntimeEvent: event => metadataPublication?.observeRuntimeEvent(event),
      },
      api: { push: () => ({
        fetchSessionNotificationContext: async (id: string) => {
          const source = createSessionNotificationContextFixture(id);
          return { ...source, viewer: { ...source.viewer!, follow: { follows: true, notificationLevel: 'important' as const,
            policy: { preset: 'quiet' as const } } } };
        }, readAccountSessionDeliveryMutedScopes: async () => [],
        async sendToAllDevicesAsync(...args: unknown[]) { sentNotifications.push(args); return true; },
        sendToAllDevices(...args: unknown[]) { sentNotifications.push(args); },
      }) },
      // The canonical Session fixture substitutes the server/persistence boundary.
      session: session as unknown as SessionLoopLifecycleParams['session'],
      runtime, hookRuntime: runtime, registerProviderAcceptedEffect: inputBinding.registerProviderAcceptedEffect, messageBuffer: new MessageBuffer(),
      permissionHandler: { reset() {}, setPermissionMode() {} },
      permissionModeState: {
        rebindSession() {}, releaseRejectedBeforeProviderPromptIdentity() {}, getCurrentPermissionMode: () => 'default',
        getCurrentPermissionModeUpdatedAt: () => 0, setCurrentPermissionMode() {}, setCurrentPermissionModeUpdatedAt() {},
        messageQueue: queue, replaySeedRetirement: createUnsettledReplaySeedRetirement(),
      },
      sessionSwapStrategy: { async requestSessionSwap() {} }, runtimeDirectory: metadata.path, runtimeMetadata: metadata,
      machineId: 'machine', memoryRecallGuidanceEnabled: false, policyAgentId: 'codex',
      setActiveAgentCompositionToolSelection() {}, happyMcpServerStop() {}, reconnectionHandle: null, startupCoordinator: null,
      runtimeState, setAbortRequestedCallback() {},
      transitionModelSelection: async selection => ({ ok: true, status: 'already_active', activeSelection: selection }),
      initialResumeId: failure === 'strict_resume' ? 'unavailable-native-session' : '',
      deps: {
        runPermissionModePromptLoopFn: input => runPermissionModePromptLoop({ ...input, shouldExit: () => ready, getAbortSignal: () => controller.signal }),
        sendReadyWithPushNotificationFn: async input => {
          readyPreviews.push(input.assistantPreviewText);
          expect(input.completedTurn).toEqual(failure || ((omitReceipt || rejectDiff) && readyPreviews.length === 1) ? undefined
            : { turnId: hostTurnIds[readyPreviews.length - 1] });
          await sendReadyWithPushNotification(input);
          thinkingAtReady.push(runtimeState.thinking);
          if (providerDispatchCount > 0) emit({ kind: 'turn-complete', turnId: `provider-successor-${providerDispatchCount}` });
          if (failure) {
            ready = true;
            controller.abort();
            return;
          }
          if (readyPreviews.length === 1) {
            secondHostSeq = ++observedSeq;
            queue.push({ text: 'second host input', localId: 'host-input-2', userMessageSeq: secondHostSeq }, { permissionMode: 'default' });
          } else {
            ready = true;
            controller.abort();
          }
        },
      },
    };
    let runtimeForLoop: SessionLoopLifecycleParams['runtime'] = runtime;
    if (eagerStartup) {
      const wrapped = withHostSessionRuntimeIdentityPublication({
        plan: { kind: HOST_SESSION_RUNTIME_PLAN_KIND, agentId: 'codex', opts: params.opts,
          config: { ...params.config, createSessionRuntime: () => ({ operations: runtime, nativeRuntime: runtime }) } },
        identity: { runtimeDescriptor: null, runtimeCapabilities: null, runtimeFacets: null },
      });
      // This native factory consumes no launch fields; the real host wrapper
      // and publication hub still execute, matching the canonical wrapper testkit.
      const created = await wrapped.config.createSessionRuntime?.({} as never);
      if (!created) throw new Error('Missing host runtime factory');
      runtimeForLoop = created.operations;
      metadataPublication = subscribeSessionRuntimePublicationToMetadata({
        session, sessionState: { writeHappierField: async () => ({ ok: true as const, version: 1 }) }, runtime: created.operations,
      });
    }
    try {
      const running = runSessionLoopLifecycle({ ...params, runtime: runtimeForLoop });
      if (failure === 'strict_resume') await expect(running).rejects.toThrow('Native resume startup failed');
      else await running;
      if (failure) {
        const failed = terminalMutations.find(mutation => mutation.action === 'fail');
        expect(failed).toBeDefined();
        const turnId = failed!.turnId;
        const failureSeq = failureMarkerSeqs.get(turnId);
        expect(failureSeq).toBeTypeOf('number');
        expect(terminalMutations).toContainEqual(expect.objectContaining({ action: 'fail', turnId }));
        expect(inputAnchors.get(turnId)).toMatchObject({ endSeqInclusive: failureSeq, finalAssistantMessageSeq: null });
        expect(agentMessages.filter(body => body.type === 'turn_failed')).toHaveLength(1);
        if (failure === 'native') {
          expect(inputAnchors.get(turnId)).toMatchObject({ startUserMessageSeq: 1 });
          expect(failureSeq).toBeLessThan(committedAssistantSeqs.get('SUCCESSOR_ANSWER')!);
        } else expect(inputAnchors.get(turnId)).toMatchObject({ startSeqInclusive: failureSeq });
        return;
      }
      if (rejectDiff) {
        expect(terminalMutations).toContainEqual(expect.objectContaining({ action: 'fail', turnId: hostTurnIds[0],
          issue: expect.objectContaining({ code: 'runtime_transcript_required_admission_failed' }) }));
        expect(terminalMutations).not.toContainEqual(expect.objectContaining({ action: 'complete', turnId: hostTurnIds[0] }));
        return;
      }
      if (combinedCard) {
        const cards = agentMessages.filter(message => message.type === 'tool-call' && message.name === 'Diff');
        expect(cards).toHaveLength(1);
        const card = cards[0];
        if (!card || card.type !== 'tool-call') throw new Error('Missing combined host card');
        const meta = readTurnChangeToolMetadata(card.input);
        expect(meta).toMatchObject({ turnId: hostTurnIds[0], repositoryCheckpoint: { contentConfidence: 'exact' } });
        expect(extractCanonicalDiffFiles(card.input, meta!)).toEqual(expect.arrayContaining([
          expect.objectContaining({ source: 'provider_tool', filePath: 'tracked.txt' }),
          expect.objectContaining({ source: 'scm_checkpoint', filePath: 'tracked.txt' }),
        ]));
      }
      expect(providerDispatchCount, JSON.stringify({ committedMessages, accountRequests })).toBe(2);
      for (const [index, answer] of [hostAnswer, secondHostAnswer].entries()) {
        if (omitReceipt && answer) {
          expect(terminalMutations).toContainEqual(expect.objectContaining({ action: 'fail', turnId: hostTurnIds[index],
            issue: expect.objectContaining({ code: 'runtime_transcript_required_admission_failed' }) }));
          continue;
        }
        expect(terminalMutations).toContainEqual(expect.objectContaining({ turnId: hostTurnIds[index],
          transcriptAnchors: expect.objectContaining({ startUserMessageSeq: index === 0 ? 1 : secondHostSeq,
            userMessageSeqs: [index === 0 ? 1 : secondHostSeq],
            finalAssistantMessageSeq: answer ? committedAssistantSeqs.get(answer) : null }) }));
      }
      const observed = await observeWorkflowSessionInputResult({ credentials: { token: 'token', encryption: null },
        sessionId, localId: 'host-input', deadlineMs: 0 });
      expect(observed.ok).toBe(true);
      if (!observed.ok) throw new Error('Missing original input observation');
      const classified = classifyWorkflowSessionInputResult(observed.result);
      if (omitReceipt) expect(classified).toMatchObject({ kind: 'failed', code: 'session_input_failed' });
      else if (hostAnswer) {
        expect(classified).toMatchObject({ kind: 'completed', result: hostAnswer });
        if (classified.kind !== 'completed') throw new Error('Missing committed reply');
        const stored = await persistHostReply(classified, sessionId);
        expect(stored?.index.lifecycle).toBe('completed');
        expect(stored?.progress.result).toBe(hostAnswer);
      } else expect(classified).toMatchObject({ kind: 'needs_attention', code: 'session_input_result_unavailable' });
      expect.soft(readyPreviews).toEqual(retirePreview || omitReceipt ? [null, null] : [hostAnswer, secondHostAnswer]);
      await vi.waitFor(() => expect(sentNotifications).toHaveLength(omitReceipt ? 1 : 2));
      expect(readyEvents).toEqual(hostTurnIds.map((completedTurnId, index) => ({ type: 'ready', ownerActivityDelivery: 'rich_sender',
        ...(omitReceipt && index === 0 ? {} : { completedTurnId }) })));
      const notifiedOriginals = omitReceipt ? readyOriginals.slice(1) : readyOriginals;
      expect(sentNotifications.map(notification => notification[2])).toEqual(notifiedOriginals.map(original => ({
        sessionId, activityEventLocalId: original.localId,
        activityEvent: { type: 'ready', sequenceDomain: 'session_transcript', messageSeq: original.seq },
      })));
      expect.soft(thinkingAtReady).toEqual([true, true]);
      expect(runtimeState.thinking).toBe(false);
      expect(listeners.size).toBe(0);
      if (eagerStartup) {
        expect.soft(JSON.stringify(committedMessages)).toContain('EXTENSION_STARTUP_INPUT');
        expect.soft(JSON.stringify(committedMessages)).toContain('EXTENSION_STARTUP_ANSWER');
      }
    } finally {
      metadataPublication?.();
      await lease.release();
      accountGet.mockRestore();
      accountPost.mockRestore();
      clearActiveAccountSettingsSnapshot();
      if (checkpointRoot) await rm(checkpointRoot, { recursive: true, force: true });
    }
  });
});

async function persistHostReply(observation: Extract<WorkflowSessionInputObservation, { kind: 'completed' }>, sessionId: string) {
  const runId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
  const rootId = '33333333-3333-4333-8333-333333333333';
  const childId = '44444444-4444-4444-8444-444444444444';
  const accountId = 'account-1';
  const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'step', id: 'first',
    document: { text: 'host input', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] };
  const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
    binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId },
    acceptedSnapshot: { startedBy: 'user', definition, authoredDefinition: definition, workDepth: 0, metadata: null, frozenChildren: {},
      materializedLeaves: [{ sourceKey: '$root', blockId: 'first', kind: 'step', authoredWorkspace: { kind: 'inherit' },
        selection: {}, executionTarget: { kind: 'session' } }], source: { kind: 'inline' }, inputs: {}, machineId: 'machine-1',
      executionTarget: { kind: 'session' },
      workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
      origin: { kind: 'direct', originSessionId: sessionId },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      resultDelivery: { kind: 'originating_session', originSessionId: sessionId },
    },
  }));
  // Only opaque Home storage is substituted. The result codec, fact writer,
  // row revision, sealed producer and stored-content opener remain real.
  const storage = createWorkflowRunStorageTestkit({ runId, machineId: 'machine-1', origin: { kind: 'direct' }, acceptedEnvelope });
  const seal = (root: boolean) => serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
    binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: root ? rootId : childId,
      sequence: root ? '0' : '1', parentRecordId: root ? null : rootId, memberOrdinal: '0', attempt: '0' },
    progress: { kind: 'happier.workflow-progress.v1', blockKind: root ? 'root' : 'step',
      invocationPath: { blockId: root ? '$root' : 'first', scope: [] }, attempt: '0', logicalInvocationRecordId: root ? rootId : childId,
      ...(root ? {} : { execution: { kind: 'session', sessionId, localInputId: 'host-input' } }),
    },
  }));
  const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
    binding: { v: 1, purpose: 'checkpoint', accountId, runId },
    checkpoint: { kind: 'happier.workflow-checkpoint.v1', rootRecordId: rootId, nextSequence: '2',
      frontier: { nextBlockOrdinal: 1, paused: false } },
  }));
  await storage.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope,
    rootInvocation: { id: rootId, contentEnvelope: seal(true) } });
  await storage.execute({ operation: 'invocations.admit', runId, expectedRevision: 1, checkpointEnvelope,
    invocations: [{ id: childId, sequence: '1', parentRecordId: rootId, memberOrdinal: '0', lifecycle: 'running', contentEnvelope: seal(false) }] });
  const writer = createWorkflowInvocationRecoveryFactWriter({ accountId, run: storage.run(), parentAttempt: 0, storage,
    encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } } });
  const invocation = await writer.readInvocation(childId);
  if (!invocation) throw new Error('Missing stored host invocation');
  await writer.commitObservation(invocation, observation);
  return await writer.readInvocation(childId);
}
