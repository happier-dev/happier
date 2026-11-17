import { readLocalConversationVoiceSettings, readLocalDirectVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { afterAll } from 'vitest';
import { warmLocalVoiceEngineHarnessGraph } from './localVoiceEngine.testHarness';
import { describe, expect, it, vi } from 'vitest';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createDeferred, waitForTestEvent } from '@/dev/testkit';

import {
  localVoiceAgentRpc,
  emitSpeechRecEvent,
  expoSpeechSpeak,
  expoSpeechStop,
  fileDelete,
  getStorage,
  loadLocalVoiceEngineWithCompatState,
  localVoicePendingEnqueue,
  localVoiceSpeechTranscription,
  localVoiceSpeechOutputBoundary,
  publishLocalVoiceSubmittedUserMessage,
  publishLocalVoiceAssistantMessage,
  acknowledgeLocalVoicePendingEnqueue,
  registerLocalVoiceEngineHarnessHooks,
  speechRecStart,
  speechRecStop,
  setLocalVoiceHttpResponder,
  waitForLocalVoiceBoundaryEvent,
} from './localVoiceEngine.testHarness';

const restoreHarnessModuleLoader = await warmLocalVoiceEngineHarnessGraph();
afterAll(() => restoreHarnessModuleLoader());

describe('local voice engine stop', () => {
  registerLocalVoiceEngineHarnessHooks();

  it('refuses a second public commit while Thinking and Cancel reply keeps the conversation connected', async () => {
    const storage = await getStorage();
    const local = readLocalConversationVoiceSettings(storage.getState().settings.voice);
    storage.__setState({ settings: { ...storage.getState().settings, voice: {
      ...storage.getState().settings.voice, providerId: 'local_conversation',
      providers: { ...storage.getState().settings.voice.providers,
        local_conversation: { schemaVersion: 1, config: { ...local, conversationMode: 'direct_session',
          tts: { ...local.tts, autoSpeakReplies: false },
        } },
      },
    } } });
    localVoiceSpeechTranscription.mockResolvedValueOnce('Read the project instructions.');
    const { createLocalConversationVoiceAdapter } = await import('@/voice/adapters/localConversation/localConversationAdapter');
    const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
    const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
    const { acknowledgeVoiceSessionRuntimeReady, setVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleControllerStore');
    const { getVoiceSessionPresentedAttemptId, setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    const { executeVoiceConversationAction } = await import('@/sync/ops/actions/voiceConversationAction');
    const { localVoiceHomeId } = await import('./localVoiceEngine.testHarness');
    registerVoiceAdapters([createLocalConversationVoiceAdapter()]);
    const lifecycle = createVoiceSessionLifecycleController();
    setVoiceSessionLifecycleController(lifecycle);
    acknowledgeVoiceSessionRuntimeReady(true);
    const unsubscribe = lifecycle.subscribe(() => setVoiceSessionSnapshot(lifecycle.getSnapshot()));
    lifecycle.setConfiguredProviderId('local_conversation');
    const target = { serverId: localVoiceHomeId, sessionId: 's1' };
    try {
      await lifecycle.toggle(target);
      expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', mode: 'listening', canCommitInput: true });
      const expectedAttempt = getVoiceSessionPresentedAttemptId();
      const submitted = executeVoiceConversationAction('ui.voice_global.turn_control', {
        expectedAttempt, control: 'commit_input',
      }, { navigate() {} });
      await waitForTestEvent(lifecycle.subscribe, lifecycle.getSnapshot, snapshot => snapshot.mode === 'thinking');
      const refused = await executeVoiceConversationAction('ui.voice_global.turn_control', {
        expectedAttempt, control: 'commit_input',
      }, { navigate() {} });
      expect(refused).toMatchObject({ status: 'unavailable', code: 'voice_commit_unavailable', voice: { mode: 'thinking', canCommitInput: false } });
      const { resolveVoiceCompactLine } = await import('@/components/voice/presence/resolveVoicePresenceCaption');
      const { t } = await import('@/text');
      const thinking = refused.voice;
      expect(resolveVoiceCompactLine({
        live: thinking.status === 'connected', muted: thinking.muted,
        surfaceState: thinking.mode, canCommitInput: thinking.canCommitInput, captionLabel: '',
      }, 'Earlier reply.')).toEqual({ kind: 'caption', text: t('voicePresence.captions.thinkingInputUnavailable') });
      expect(await executeVoiceConversationAction('ui.voice_global.turn_control', {
        expectedAttempt, control: 'cancel',
      }, { navigate() {} })).toMatchObject({ status: 'completed' });
      await submitted;
      expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', mode: 'idle' });
    } finally {
      await lifecycle.stop(target.sessionId);
      unsubscribe();
    }
  });

  it.each(['terminal_run', 'inactive_terminal_carrier', 'inactive_carrier', 'unreachable', 'running',
    'terminal_with_duplicate', 'terminal_inventory_unreachable', 'sweep_terminal_member', 'unreachable_with_duplicate'] as const)('completes public End locally after target_unavailable and admits Start (%s)', async (targetState) => {
    const storage = await getStorage();
    const local = readLocalConversationVoiceSettings(storage.getState().settings.voice);
    storage.__setState({ settings: { ...storage.getState().settings, voice: {
      ...storage.getState().settings.voice, providerId: 'local_conversation',
      welcome: { ...storage.getState().settings.voice.welcome, enabled: false },
      providers: { ...storage.getState().settings.voice.providers,
        local_conversation: { schemaVersion: 1, config: { ...local, conversationMode: 'agent',
          agent: { ...local.agent, prewarmOnConnect: false },
          tts: { ...local.tts, autoSpeakReplies: false },
        } },
      },
    } } });
    const { createLocalConversationVoiceAdapter } = await import('@/voice/adapters/localConversation/localConversationAdapter');
    const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
    const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
    const { acknowledgeVoiceSessionRuntimeReady, setVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleControllerStore');
    const { getVoiceSessionPresentedAttemptId, setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    const { executeVoiceConversationAction } = await import('@/sync/ops/actions/voiceConversationAction');
    const { voiceAgentSessions } = await import('@/voice/agent/voiceAgentSessions');
    const { readPersistedVoiceConversationRuntimeState } = await import('@/voice/binding/voiceConversationBindingPersistence');
    const { readVoiceAgentRunMetadataFromSession } = await import('@/voice/persistence/voiceAgentRunMetadata');
    const { sessionRpcWithServerScope, localVoiceHomeId } = await import('./localVoiceEngine.testHarness');
    const { createRetainedVoiceAgentRpcBoundary } = await import('@/dev/testkit/harness/voiceAgentRpcBoundary');
    const responder = sessionRpcWithServerScope.getMockImplementation()!;
    const freshDaemon = await createRetainedVoiceAgentRpcBoundary({ runId: 'after-unavailable-end',
      handleOtherRpc: (method, payload) => responder({ sessionId: 's1', serverId: localVoiceHomeId, method, payload }),
    });
    registerVoiceAdapters([createLocalConversationVoiceAdapter()]);
    const lifecycle = createVoiceSessionLifecycleController();
    setVoiceSessionLifecycleController(lifecycle);
    acknowledgeVoiceSessionRuntimeReady(true);
    const unsubscribe = lifecycle.subscribe(() => setVoiceSessionSnapshot(lifecycle.getSnapshot()));
    lifecycle.setConfiguredProviderId('local_conversation');
    const target = { serverId: localVoiceHomeId, sessionId: 's1' };
    const refusedRequests: string[] = [];
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await lifecycle.toggle(target);
      await voiceAgentSessions.ensureRunning(VOICE_AGENT_GLOBAL_SESSION_ID);
      const previousRun = localVoiceAgentRpc.readRetainedRun();
      const retained = readPersistedVoiceConversationRuntimeState({ managedSessionId: VOICE_AGENT_GLOBAL_SESSION_ID });
      if (!previousRun || !retained) throw new Error('Expected admitted Voice Run and carrier');
      const primaryTerminal = ['terminal_run', 'inactive_terminal_carrier', 'terminal_with_duplicate', 'terminal_inventory_unreachable'].includes(targetState);
      if (primaryTerminal) previousRun.status = 'failed';
      if (targetState === 'inactive_carrier' || targetState === 'inactive_terminal_carrier') {
        const carrier = storage.getState().sessions[retained.metadataSessionId];
        if (!carrier) throw new Error('Expected hydrated carrier');
        storage.__setState({ sessions: { ...storage.getState().sessions,
          [carrier.id]: { ...carrier, active: false },
        } });
      }
      const duplicateRuns = targetState === 'terminal_with_duplicate' || targetState === 'sweep_terminal_member' || targetState === 'unreachable_with_duplicate'
        ? [1, 2].map(index => ({ ...previousRun, runId: `duplicate-${index}`, status: 'running' as typeof previousRun.status }))
        : [];
      sessionRpcWithServerScope.mockImplementation(async request => {
        const payload = request.payload as { runId?: string };
        const duplicate = duplicateRuns.find(run => run.runId === payload.runId);
        if (duplicate && request.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) return { run: duplicate };
        if (duplicate && request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP) {
          if (targetState === 'sweep_terminal_member' && duplicate.runId === 'duplicate-1') {
            duplicate.status = 'failed';
            return { ok: false, errorCode: 'target_unavailable', error: 'Target unavailable' };
          }
          duplicate.status = 'cancelled';
          return { ok: true };
        }
        if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST && duplicateRuns.length) {
          return { runs: [previousRun, ...duplicateRuns] };
        }
        if ((request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP && targetState !== 'sweep_terminal_member')
          || (targetState === 'terminal_inventory_unreachable' && request.method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST)
          || ((targetState === 'unreachable' || targetState === 'inactive_carrier' || targetState === 'unreachable_with_duplicate') && request.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET)
          || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2) {
          refusedRequests.push(request.method);
          return { ok: false, errorCode: 'target_unavailable', error: 'Target unavailable' };
        }
        return responder(request);
      });
      if (targetState !== 'running') {
        // Real turn failure releases local media before the person presses End.
        const { sendLocalVoiceAgentTextTurn } = await import('./localVoiceEngine');
        await expect(sendLocalVoiceAgentTextTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'Question', {
          localId: 'unavailable-target-turn', deliveryCommand: 'interrupt_and_send',
        })).rejects.toMatchObject({ rpcErrorCode: 'target_unavailable' });
        expect(lifecycle.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false });
      } else {
        expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
      }
      const failureBeforeEnd = lifecycle.getSnapshot();
      const callsBeforeEnd = sessionRpcWithServerScope.mock.calls.length;
      const end = await executeVoiceConversationAction('ui.voice_global.end', {
        expectedAttempt: getVoiceSessionPresentedAttemptId(),
      }, { navigate() {} });
      expect(end.status).toBe('completed');
      expect(lifecycle.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false });
      expect(voiceAgentSessions.isActive(VOICE_AGENT_GLOBAL_SESSION_ID)).toBe(false);
      expect(refusedRequests.filter(method => method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toHaveLength(targetState === 'sweep_terminal_member' ? 0 : 1);
      const endRequests = sessionRpcWithServerScope.mock.calls.slice(callsBeforeEnd).map(([request]) => request);
      // Only a refused primary Stop needs its exact Run observation. A lost
      // Session read retries that same observation through the retained Action.
      const readRouteUnavailable = targetState === 'inactive_carrier' || targetState === 'unreachable'
        || targetState === 'unreachable_with_duplicate';
      const endReads = endRequests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET);
      expect(endReads).toHaveLength(targetState === 'sweep_terminal_member' ? 0 : readRouteUnavailable ? 2 : 1);
      expect(endReads.every(request => (request.payload as { runId?: string }).runId === previousRun.runId)).toBe(true);
      if (duplicateRuns.length) expect(duplicateRuns.map(run => run.status)).toEqual(
        targetState === 'sweep_terminal_member' ? ['failed', 'cancelled'] : ['cancelled', 'cancelled'],
      );
      const metadata = readVoiceAgentRunMetadataFromSession({ sessionId: retained.metadataSessionId, serverId: localVoiceHomeId });
      if (targetState === 'unreachable' || targetState === 'running' || targetState === 'inactive_carrier' || targetState === 'unreachable_with_duplicate') {
        expect(metadata?.runId).toBe(previousRun.runId);
        expect(lifecycle.getAttemptTargetSessionAddress()).toEqual(target);
        expect(lifecycle.getSnapshot()).toMatchObject({ errorCode: 'provider_error', errorRecoveryAction: 'retry' });
        expect(previousRun.status).toBe(primaryTerminal ? 'failed' : 'running');
      } else {
        expect(metadata).toBeNull();
      }
      if (targetState === 'terminal_inventory_unreachable') {
        // Both the live Session route and its retained Action read report the
        // daemon's unavailability; the primary Stop remains authoritative.
        expect(warnings).toHaveBeenCalledWith(expect.stringContaining('[voiceRunRecovery]'),
          expect.objectContaining({ errorCode: 'target_unavailable' }));
        // Ending preserves the earlier genuine turn failure; optional cleanup
        // must not replace it with a new unconfirmed-Stop failure.
        expect(lifecycle.getSnapshot().errorCode).toBe(failureBeforeEnd.errorCode);
        expect(lifecycle.getSnapshot().errorMessage).toBe(failureBeforeEnd.errorMessage);
      }
      // Restore the same daemon for the unresolved-primary/duplicate case:
      // readmission must adopt its retained Run rather than require a new daemon.
      sessionRpcWithServerScope.mockImplementation(targetState === 'unreachable_with_duplicate'
        ? responder : request => freshDaemon.dispatch(request.method, request.payload));
      const start = targetState === 'running'
        ? await executeVoiceConversationAction('ui.voice_global.recover', { expectedAttempt: getVoiceSessionPresentedAttemptId() }, { navigate() {} })
        : await executeVoiceConversationAction('ui.voice_global.start', {
          target: { kind: 'session', sessionAddress: target }, expectedAttempt: null,
        }, { navigate() {} });
      expect(start.status, start.status === 'unavailable' ? start.code : undefined).toBe('completed');
      expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
      await expect(voiceAgentSessions.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'Fresh question', {
        userTranscript: { mode: 'suppress' },
      })).resolves.toMatchObject({ assistantText: 'Daemon reply' });
      if (targetState === 'unreachable_with_duplicate') expect(localVoiceAgentRpc.readRetainedRun()).toBe(previousRun);
      else expect(freshDaemon.readRetainedRun()?.runId).toBe('after-unavailable-end');
      expect(freshDaemon.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toHaveLength(0);
      expect(previousRun.status).toBe(primaryTerminal ? 'failed' : 'running');
      expect(refusedRequests.filter(method => method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toHaveLength(targetState === 'sweep_terminal_member' ? 0 : 1);
    } finally {
      warnings.mockRestore();
      sessionRpcWithServerScope.mockImplementation(targetState === 'unreachable_with_duplicate'
        ? responder : request => freshDaemon.dispatch(request.method, request.payload));
      await lifecycle.dispose();
      unsubscribe();
      setVoiceSessionLifecycleController(null);
    }
  });

  it.each([
    { prewarmOnConnect: true, freshStartup: 'ready', fixedGlobalAgent: false },
    { prewarmOnConnect: false, freshStartup: 'ready', fixedGlobalAgent: false },
    { prewarmOnConnect: false, freshStartup: 'failed', fixedGlobalAgent: false },
    { prewarmOnConnect: false, freshStartup: 'ready', fixedGlobalAgent: true },
  ] as const)('retires a terminal Run through public End and uses the actual fresh startup outcome (prewarm=$prewarmOnConnect, startup=$freshStartup, fixedGlobalAgent=$fixedGlobalAgent)', async ({ prewarmOnConnect, freshStartup, fixedGlobalAgent }) => {
    const storage = await getStorage();
    const local = readLocalConversationVoiceSettings(storage.getState().settings.voice);
    storage.__setState({ settings: { ...storage.getState().settings, voice: {
      ...storage.getState().settings.voice, providerId: 'local_conversation',
      welcome: { ...storage.getState().settings.voice.welcome, enabled: false },
      providers: { ...storage.getState().settings.voice.providers,
        local_conversation: { schemaVersion: 1, config: { ...local, conversationMode: 'agent',
          agent: { ...local.agent, prewarmOnConnect, ...(fixedGlobalAgent ? {
            agentSource: 'agent', agentId: 'codex', agentTargetKey: 'agent:happier.agent.codex/codex', agentIdentity: null,
          } : {}) },
          tts: { ...local.tts, autoSpeakReplies: false },
        } },
      },
    } } });
    const { createLocalConversationVoiceAdapter } = await import('@/voice/adapters/localConversation/localConversationAdapter');
    const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
    const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
    const { voiceAgentSessions } = await import('@/voice/agent/voiceAgentSessions');
    const { sessionRpcWithServerScope, localVoiceHomeId } = await import('./localVoiceEngine.testHarness');
    registerVoiceAdapters([createLocalConversationVoiceAdapter()]);
    const lifecycle = createVoiceSessionLifecycleController();
    const { acknowledgeVoiceSessionRuntimeReady, setVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleControllerStore');
    const { getVoiceSessionPresentedAttemptId, setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    const { executeVoiceConversationAction } = await import('@/sync/ops/actions/voiceConversationAction');
    setVoiceSessionLifecycleController(lifecycle);
    acknowledgeVoiceSessionRuntimeReady(true);
    const unsubscribe = lifecycle.subscribe(() => setVoiceSessionSnapshot(lifecycle.getSnapshot()));
    lifecycle.setConfiguredProviderId('local_conversation');
    const target = fixedGlobalAgent ? null : { serverId: localVoiceHomeId, sessionId: 's1' };
    const responder = sessionRpcWithServerScope.getMockImplementation()!;
    const { createRetainedVoiceAgentRpcBoundary } = await import('@/dev/testkit/harness/voiceAgentRpcBoundary');
    const freshDaemon = await createRetainedVoiceAgentRpcBoundary({ runId: 'fresh-recovered-run',
      async handleOtherRpc(method, payload) {
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START || method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2) {
          const { ExecutionRunTurnStreamStartRequestSchema, ExecutionRunTurnStreamStartV2RequestSchema } = await import('@happier-dev/protocol/execution/runs/streaming');
          const input = (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2
            ? ExecutionRunTurnStreamStartV2RequestSchema : ExecutionRunTurnStreamStartRequestSchema).parse(payload);
          expect(input.runId).toBe('fresh-recovered-run');
          if (freshDaemon.readRetainedRun()?.status !== 'running') {
            return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
          }
        }
        return responder({ sessionId: 's1', serverId: localVoiceHomeId, method, payload });
      },
    });
    let recovered = false;
    // The external daemon rejects input and Stop against its terminal Run.
    sessionRpcWithServerScope.mockImplementation(async request => {
      if (recovered) return freshDaemon.dispatch(request.method, request.payload);
      if (localVoiceAgentRpc.readRetainedRun()?.status === 'cancelled'
        && (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START
          || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1)) {
        recovered = true;
        const response = await freshDaemon.dispatch(request.method, request.payload);
        if (freshStartup === 'failed') {
          const run = freshDaemon.readRetainedRun();
          if (!run) throw new Error('Expected acknowledged fresh Voice Run');
          // Row7 retains this failed startup outcome but not its Get payload.
          // Exercise the reachable case where initialization observes it.
          run.status = 'failed';
          run.error = { code: 'VOICE_AGENT_START_FAILED', message: 'preparation_pending: unavailable' };
        }
        return response;
      }
      if (localVoiceAgentRpc.readRetainedRun()?.status === 'cancelled'
        && (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP
          || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START
          || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2)) {
        return { ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' };
      }
      return responder(request);
    });
    try {
      await expect(lifecycle.toggle(target), 'initial Start with a ready catalog').resolves.toBeUndefined();
      await voiceAgentSessions.ensureRunning(VOICE_AGENT_GLOBAL_SESSION_ID);
      const stopped = localVoiceAgentRpc.readRetainedRun();
      if (!stopped) throw new Error('Expected admitted Voice Run');
      stopped.status = 'cancelled';
      const admissions = localVoiceAgentRpc.requests.filter(request => request.method.includes('ensure')).length;
      const { sendLocalVoiceAgentTextTurn } = await import('./localVoiceEngine');
      const ordinary = { localId: 'ordinary-terminal-input', deliveryCommand: 'interrupt_and_send' as const };
      await expect(sendLocalVoiceAgentTextTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'Ordinary input', ordinary))
        .rejects.toMatchObject({ rpcErrorCode: 'execution_run_not_allowed' });
      expect(localVoiceAgentRpc.requests.filter(request => request.method.includes('ensure'))).toHaveLength(admissions);
      expect(stopped.status).toBe('cancelled');
      expect(lifecycle.getSnapshot()).toMatchObject({ status: 'disconnected', errorMessage: 'execution_run_not_allowed' });
      const expectedAttempt = getVoiceSessionPresentedAttemptId();
      expect(expectedAttempt).toEqual(expect.any(String));
      await expect(executeVoiceConversationAction('ui.voice_global.end', { expectedAttempt: 'stale-attempt' }, { navigate() {} }))
        .resolves.toMatchObject({ status: 'unavailable', code: 'stale_voice_attempt' });
      await expect(executeVoiceConversationAction('ui.voice_global.end', { expectedAttempt }, { navigate() {} }))
        .resolves.toMatchObject({ status: 'completed' });
      expect(lifecycle.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false });
      expect(voiceAgentSessions.isActive(VOICE_AGENT_GLOBAL_SESSION_ID)).toBe(false);
      let acpReads = 0;
      if (fixedGlobalAgent) {
        const { ACP_CATALOG_ROWS_ROUTE_V1 } = await import('@happier-dev/protocol/acp/catalog/catalogRowsV1');
        const { refreshAcpCatalog } = await import('@/sync/engine/settings/acpCatalogEngine');
        const { getAcpCatalogSnapshot } = await import('@/sync/store/settings/acpCatalogSnapshot');
        setLocalVoiceHttpResponder(request => {
          if (request.path !== ACP_CATALOG_ROWS_ROUTE_V1) return undefined;
          acpReads += 1;
          return new Response(null, { status: 503 });
        });
        const scope = storage.getState().settingsScope!;
        await refreshAcpCatalog(scope);
        expect(getAcpCatalogSnapshot(scope)?.catalog.status).toBe('unavailable');
        acpReads = 0;
      }
      if (fixedGlobalAgent) {
        await expect(executeVoiceConversationAction('ui.voice_global.start', {
          target: { kind: 'global' }, expectedAttempt: null,
        }, { navigate() {} }), 'public Global Start after public End').resolves.toMatchObject({ status: 'completed' });
      } else {
        await expect(lifecycle.toggle(target), 'restart after public End with the unchanged configured Agent').resolves.toBeUndefined();
      }
      expect(lifecycle.getSnapshot().status).toBe('connected');
      const freshQuestion = voiceAgentSessions.sendTurn(VOICE_AGENT_GLOBAL_SESSION_ID, 'Fresh question', {
        userTranscript: { mode: 'suppress' },
      });
      if (freshStartup === 'failed') {
        await expect(freshQuestion).rejects.toMatchObject({ rpcErrorCode: 'VOICE_AGENT_START_FAILED',
          message: 'preparation_pending: unavailable' });
        expect(freshDaemon.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START
          || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2)).toHaveLength(0);
      } else {
        await expect(freshQuestion).resolves.toMatchObject({ assistantText: 'Daemon reply' });
        expect(freshDaemon.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2))
          .toHaveLength(1);
      }
      expect(stopped.status).toBe('cancelled');
      expect(freshDaemon.readRetainedRun()).toMatchObject({ runId: 'fresh-recovered-run',
        status: freshStartup === 'failed' ? 'failed' : 'running' });
      if (fixedGlobalAgent) {
        expect(freshDaemon.readRetainedRun()?.backendTarget).toMatchObject({ kind: 'builtInAgent', agentId: 'codex' });
        expect(readLocalConversationVoiceSettings(storage.getState().settings.voice).agent).toMatchObject({
          agentSource: 'agent', agentId: 'codex', agentTargetKey: 'agent:happier.agent.codex/codex', agentIdentity: null,
        });
        // Run admission reads one complete Machine inventory. Unavailable
        // configured-ACP rows cannot block this selected bundled Agent.
        expect(acpReads).toBe(1);
      }
    } finally {
      await lifecycle.dispose();
      unsubscribe();
      setVoiceSessionLifecycleController(null);
    }
  });

  it.each(['end', 'close', 'provider', 'remount', 'account', 'dismiss'] as const)('cancels a pending Start waiting for an unanswered Stop on %s, then retries cleanup before Start', async (cancel) => {
    const storage = await getStorage();
    const local = readLocalConversationVoiceSettings(storage.getState().settings.voice);
    storage.__setState({ settings: { ...storage.getState().settings, voice: {
      ...storage.getState().settings.voice, providerId: 'local_conversation',
      providers: { ...storage.getState().settings.voice.providers,
        local_conversation: { schemaVersion: 1, config: { ...local, conversationMode: 'agent',
          agent: { ...local.agent, prewarmOnConnect: true },
          tts: { ...local.tts, autoSpeakReplies: false },
        } },
      },
    } } });
    const { isLocalVoiceAgentActive } = await loadLocalVoiceEngineWithCompatState();
    const { createLocalConversationVoiceAdapter } = await import('@/voice/adapters/localConversation/localConversationAdapter');
    const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
    const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
    const { sessionRpcWithServerScope, localVoiceHomeId } = await import('./localVoiceEngine.testHarness');
    registerVoiceAdapters([createLocalConversationVoiceAdapter()]);
    let lifecycle = createVoiceSessionLifecycleController();
    lifecycle.setConfiguredProviderId('local_conversation');
    const target = { serverId: localVoiceHomeId, sessionId: 's1' };
    const responder = sessionRpcWithServerScope.getMockImplementation()!;
    let stalled = true;
    let entered!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const acknowledgement = new Promise<void>(resolve => { release = resolve; });
    let releaseInitializationRead!: () => void;
    const initializationRead = new Promise<void>(resolve => { releaseInitializationRead = resolve; });
    let heldInitializationRead = false;
    const initializationReadEntered = createDeferred<void>();
    sessionRpcWithServerScope.mockImplementation(async request => {
      if (cancel === 'provider' && !heldInitializationRead
        && request.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET && localVoiceAgentRpc.readRetainedRun()) {
        heldInitializationRead = true;
        initializationReadEntered.resolve();
        // Keep the acknowledged Run in prewarm initialization. Its cleanup
        // must borrow retirement's live signal when preparation is cancelled.
        await initializationRead;
      }
      if (stalled && request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP) {
        entered();
        await acknowledgement;
      }
      return responder(request);
    });
    try {
      await lifecycle.toggle(target);
      await waitForLocalVoiceBoundaryEvent('agent-start');
      // This case retires an established Agent; daemon admission alone can
      // precede the client's post-start metadata/policy initialization.
      if (cancel === 'provider') {
        await initializationReadEntered.promise;
        expect(heldInitializationRead).toBe(true);
      } else {
        const { voiceAgentSessions } = await import('@/voice/agent/voiceAgentSessions');
        await voiceAgentSessions.ensureRunning(VOICE_AGENT_GLOBAL_SESSION_ID);
        expect(isLocalVoiceAgentActive(VOICE_AGENT_GLOBAL_SESSION_ID)).toBe(true);
      }
      expect(localVoiceAgentRpc.readRetainedRun()?.status).toBe('running');
      let stopSettled = false;
      const stopping = lifecycle.stop(VOICE_AGENT_GLOBAL_SESSION_ID).catch(() => undefined).finally(() => { stopSettled = true; });
      await entering;
      if (cancel === 'remount') {
        const retiring = new AbortController();
        const retiringAttempt = lifecycle.dispose(retiring.signal);
        lifecycle = createVoiceSessionLifecycleController({ retiringAttempt, cancelRetiringAttempt: () => retiring.abort() });
        lifecycle.setConfiguredProviderId('local_conversation');
      }
      let settled = false;
      const starting = lifecycle.toggle(target).finally(() => { settled = true; });
      expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connecting', canStop: true });
      const cancelled = cancel === 'close' ? lifecycle.dispose()
        : cancel === 'provider' ? Promise.resolve(lifecycle.setConfiguredProviderId('off'))
        : lifecycle.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
      await Promise.all([stopping, starting, cancelled]);
      expect(settled).toBe(true);
      expect(stopSettled).toBe(true);
      if (cancel === 'close') {
        // A disposed controller no longer republishes snapshots. Observe the
        // owned recording release rather than its frozen pre-disposal controls.
        expect(localVoiceSpeechOutputBoundary.fileRecording.stop).toHaveBeenCalled();
      } else {
        expect(lifecycle.getSnapshot()).toMatchObject({ mode: 'idle', canStop: false });
      }
      if (cancel === 'end' || cancel === 'account' || cancel === 'dismiss') expect(lifecycle.getSnapshot()).toMatchObject({
        status: 'error', errorCode: 'service_temporarily_unavailable', errorMessage: 'voice_previous_session_stop_failed',
        errorRecoveryAction: 'retry',
      });
      expect(localVoiceAgentRpc.readRetainedRun()?.status).toBe('running');
      stalled = false;
      if (cancel === 'account' || cancel === 'dismiss') {
        const failedSessionId = lifecycle.getSnapshot().sessionId ?? null;
        if (cancel === 'account') {
          lifecycle.rearmAfterCredentialAuthorityChange();
          expect(lifecycle.getSnapshot().status).toBe('error');
          lifecycle.rearmAfterCredentialAuthorityChange({ exactSessionAccountScopeChanged: true });
        } else {
          await lifecycle.dismissFailedAttempt('another-session');
          expect(lifecycle.getSnapshot().status).toBe('error');
          await lifecycle.dismissFailedAttempt(failedSessionId);
        }
        expect(lifecycle.getSnapshot()).toMatchObject({ status: 'disconnected', mode: 'idle', canStop: false });
        expect(lifecycle.getSnapshot().errorCode).toBeUndefined();
        await lifecycle.retry(failedSessionId ?? VOICE_AGENT_GLOBAL_SESSION_ID);
        expect(lifecycle.getSnapshot().status).toBe('disconnected');
      }
      if (cancel === 'close') lifecycle = createVoiceSessionLifecycleController();
      lifecycle.setConfiguredProviderId('local_conversation');
      if (cancel === 'end') await lifecycle.retry(VOICE_AGENT_GLOBAL_SESSION_ID);
      else await lifecycle.toggle(target);
      await waitForTestEvent(lifecycle.subscribe, lifecycle.getSnapshot,
        snapshot => snapshot.status === 'connected' && snapshot.canStop === true);
      expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
      await waitForLocalVoiceBoundaryEvent('agent-start', 2);
      const { voiceAgentSessions } = await import('@/voice/agent/voiceAgentSessions');
      await voiceAgentSessions.ensureRunning(VOICE_AGENT_GLOBAL_SESSION_ID);
      expect(isLocalVoiceAgentActive(VOICE_AGENT_GLOBAL_SESSION_ID)).toBe(true);
    } finally {
      stalled = false;
      releaseInitializationRead();
      release();
      await lifecycle.dispose();
    }
  });

  it('stops Say before acquiring a fresh conversation microphone', async () => {
    const localVoiceEngine = await loadLocalVoiceEngineWithCompatState();
    const storage = await getStorage();
    const local = readLocalConversationVoiceSettings(storage.getState().settings.voice);
    storage.__setState({ settings: { ...storage.getState().settings, voice: {
      ...storage.getState().settings.voice, providerId: 'local_conversation',
      providers: { ...storage.getState().settings.voice.providers,
        local_conversation: { schemaVersion: 1, config: { ...local, conversationMode: 'direct_session',
          tts: { ...local.tts, provider: 'device', autoSpeakReplies: false },
        } },
      },
    } } });
    const { executeVoiceSpeechAction } = await import('@/sync/ops/actions/voiceSpeechAction');
    const { localVoiceTtsController } = await import('@/voice/backends/tts/localVoiceTtsController');
    const sayPlayback = localVoiceSpeechOutputBoundary.holdNextPlayback('device');
    const saying = executeVoiceSpeechAction('ui.voice_global.say.start', { text: 'Keep reading until I start the microphone.' }, storage.getState().settings);
    try {
      await sayPlayback.started;
      let phaseAtCapture: string | null = null;
      const record = localVoiceSpeechOutputBoundary.fileRecording.start.getMockImplementation();
      localVoiceSpeechOutputBoundary.fileRecording.start.mockImplementationOnce(async (...args) => {
        phaseAtCapture = localVoiceTtsController.readSay();
        if (!record) throw new Error('Recording OS boundary unavailable');
        return await record(...args);
      });
      await localVoiceEngine.toggleLocalVoiceTurn('s1');
      expect(phaseAtCapture).toBe('idle');
      expect(await saying).toEqual({ status: 'cancelled' });
      expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
    } finally {
      sayPlayback(); localVoiceTtsController.stopSay(); await saying;
      await localVoiceEngine.stopLocalVoiceSession();
    }
  });

  it.each(['recorded', 'device', 'device-committed', 'recorded-starting', 'recorded-starting-replace', 'recorded-stop-failed', 'recorded-starting-stop-failed', 'recorded-muted'] as const)('discards %s conversation input before Say and keeps the conversation idle', async capture => {
    const storage = await getStorage();
    const local = readLocalConversationVoiceSettings(storage.getState().settings.voice);
    storage.__setState({ settings: { ...storage.getState().settings, voice: {
      ...storage.getState().settings.voice, providerId: 'local_conversation',
      providers: { ...storage.getState().settings.voice.providers,
        local_conversation: { schemaVersion: 1, config: { ...local, conversationMode: 'direct_session',
          stt: capture.startsWith('device') ? { ...local.stt, provider: 'device' } : local.stt,
          handsFree: { ...local.handsFree, enabled: capture === 'device' },
          tts: { ...local.tts, provider: 'device', autoSpeakReplies: false },
        } },
      },
    } } });
    speechRecStart.mockImplementation(() => { emitSpeechRecEvent('start'); emitSpeechRecEvent('audiostart'); });
    speechRecStop.mockImplementation(() => emitSpeechRecEvent('end'));
    const { createLocalConversationVoiceAdapter } = await import('@/voice/adapters/localConversation/localConversationAdapter');
    const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
    const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
    const { acknowledgeVoiceSessionRuntimeReady, setVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleControllerStore');
    const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    const { executeVoiceSpeechAction } = await import('@/sync/ops/actions/voiceSpeechAction');
    const { localVoiceTtsController } = await import('@/voice/backends/tts/localVoiceTtsController');
    const { localVoiceHomeId } = await import('./localVoiceEngine.testHarness');
    registerVoiceAdapters([createLocalConversationVoiceAdapter()]);
    const lifecycle = createVoiceSessionLifecycleController();
    setVoiceSessionLifecycleController(lifecycle);
    acknowledgeVoiceSessionRuntimeReady(true);
    const unsubscribe = lifecycle.subscribe(() => setVoiceSessionSnapshot(lifecycle.getSnapshot()));
    lifecycle.setConfiguredProviderId('local_conversation');
    const target = { serverId: localVoiceHomeId, sessionId: 's1' };
    const recorderStarting = createDeferred<void>();
    const admitRecorder = createDeferred<{ recordingId: string }>();
    if (capture === 'recorded-starting' || capture === 'recorded-starting-replace' || capture === 'recorded-starting-stop-failed') {
      localVoiceSpeechOutputBoundary.fileRecording.start.mockImplementationOnce(async () => {
        recorderStarting.resolve(); return await admitRecorder.promise;
      });
    }
    const starting = lifecycle.toggle(target);
    try {
      if (capture === 'recorded-starting-stop-failed') {
        await recorderStarting.promise;
        const saying = executeVoiceSpeechAction('ui.voice_global.say.start', { text: 'Do not speak after a failed late native stop.' },
          storage.getState().settings);
        localVoiceSpeechOutputBoundary.fileRecording.stop.mockRejectedValueOnce(new Error('file_recording_stop_failed'));
        admitRecorder.resolve({ recordingId: 'local-engine-recording' });
        await starting;
        expect(await saying).toMatchObject({ status: 'unavailable' });
        expect(expoSpeechSpeak).not.toHaveBeenCalled();
        expect(localVoiceTtsController.readSay()).toBe('idle');
        expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
        return;
      }
      if (capture === 'recorded-starting-replace') {
        await recorderStarting.promise;
        // Only the clock is synthetic. Native start remains genuinely pending;
        // Say must not borrow End's existing 1s terminal-abandonment shortcut.
        vi.useFakeTimers();
        const first = executeVoiceSpeechAction('ui.voice_global.say.start', { text: 'Superseded answer.' }, storage.getState().settings);
        let replacement = first;
        try {
          await vi.advanceTimersByTimeAsync(1_001);
          expect(localVoiceTtsController.readSay()).toBe('preparing');
          expect(expoSpeechSpeak).not.toHaveBeenCalled();
          replacement = executeVoiceSpeechAction('ui.voice_global.say.start', { text: 'Current answer.' }, storage.getState().settings);
          await vi.advanceTimersByTimeAsync(1_001);
          expect(localVoiceTtsController.readSay()).toBe('preparing');
          expect(expoSpeechSpeak).not.toHaveBeenCalled();
        } finally {
          admitRecorder.resolve({ recordingId: 'local-engine-recording' });
          await starting;
          await Promise.all([first, replacement]);
          vi.useRealTimers();
        }
        expect(await first).toEqual({ status: 'cancelled' });
        expect(await replacement).toEqual({ status: 'completed' });
        expect(expoSpeechSpeak.mock.calls.map(([text]) => text)).toEqual(['Current answer.']);
        expect(localVoiceSpeechOutputBoundary.fileRecording.stop).toHaveBeenCalled();
        return;
      }
      if (capture === 'recorded-starting') {
        await recorderStarting.promise;
        const saying = executeVoiceSpeechAction('ui.voice_global.say.start', { text: 'Read this answer.' },
          storage.getState().settings);
        expect(localVoiceTtsController.readSay()).toBe('preparing');
        await waitForTestEvent(lifecycle.subscribe, lifecycle.getSnapshot,
          snapshot => snapshot.status === 'connected' && snapshot.mode === 'idle');
        localVoiceTtsController.stopSay();
        admitRecorder.resolve({ recordingId: 'local-engine-recording' });
        await starting;
        expect(await saying).toEqual({ status: 'cancelled' });
        expect(expoSpeechSpeak).not.toHaveBeenCalled();
        expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', mode: 'idle' });
        expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
        expect(localVoiceSpeechTranscription).not.toHaveBeenCalled();
        expect(localVoiceSpeechOutputBoundary.fileRecording.stop).toHaveBeenCalled();
        return;
      }
      await starting;
      expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', mode: 'listening' });
      if (capture === 'device-committed') {
        const enqueueEntered = createDeferred<void>();
        const acknowledgeEnqueue = createDeferred<void>();
        const enqueue = localVoicePendingEnqueue.getMockImplementation();
        if (!enqueue) throw new Error('Missing pending-message HTTP boundary');
        localVoicePendingEnqueue.mockImplementationOnce(async (...args) => {
          enqueueEntered.resolve();
          await acknowledgeEnqueue.promise;
          return await enqueue(...args);
        });
        emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'Preserve this committed input', confidence: 0.9 }] });
        const committed = lifecycle.commitInput(target.sessionId);
        try {
          await enqueueEntered.promise;
          expect(await executeVoiceSpeechAction('ui.voice_global.say.start', { text: 'Read while the committed input settles.' },
            storage.getState().settings)).toEqual({ status: 'completed' });
          acknowledgeEnqueue.resolve();
          await committed;
          expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', mode: 'idle' });
          expect(localVoicePendingEnqueue).toHaveBeenCalledOnce();
          // Only a new explicit mic action may admit fresh hands-free input.
          await lifecycle.bargeIn(target.sessionId);
          expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', mode: 'listening' });
        } finally {
          acknowledgeEnqueue.resolve();
          await committed;
        }
        return;
      }
      if (capture === 'recorded-muted') {
        const { setLocalVoiceMuted } = await import('./localVoiceEngine');
        await setLocalVoiceMuted(target.sessionId, true);
      }
      if (capture === 'recorded-stop-failed') {
        // Only a successful native SDK acknowledgement closes this physical
        // recorder. A failed first Say must retain enough ownership to retry.
        const stop = localVoiceSpeechOutputBoundary.fileRecording.stop.getMockImplementation();
        if (!stop) throw new Error('Missing native recording stop boundary');
        let stopRefused = true;
        let recordingOpen = true;
        localVoiceSpeechOutputBoundary.fileRecording.stop.mockImplementation(async (...args) => {
          if (stopRefused) throw new Error('file_recording_stop_failed');
          const result = await stop(...args);
          recordingOpen = false;
          return result;
        });
        expect(await executeVoiceSpeechAction('ui.voice_global.say.start', { text: 'Do not speak over a failed microphone stop.' },
          storage.getState().settings)).toMatchObject({ status: 'unavailable' });
        expect(expoSpeechSpeak).not.toHaveBeenCalled();
        expect(localVoiceTtsController.readSay()).toBe('idle');
        expect(recordingOpen).toBe(true);
        stopRefused = false;
        let recordingOpenAtSpeech: boolean | null = null;
        expoSpeechSpeak.mockImplementation((_text, options) => {
          recordingOpenAtSpeech = recordingOpen;
          options?.onStart?.(); options?.onDone?.();
        });
        expect(await executeVoiceSpeechAction('ui.voice_global.say.start', { text: 'Retry after the recorder really stops.' },
          storage.getState().settings)).toMatchObject({ status: 'completed' });
        expect(recordingOpenAtSpeech).toBe(false);
        expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
        expect(localVoiceSpeechTranscription).not.toHaveBeenCalled();
        return;
      }
      if (capture === 'device') emitSpeechRecEvent('result', { isFinal: false, results: [{ transcript: 'Discard this input', confidence: 0.9 }] });
      let captureModeAtSpeech: string | null = null;
      expoSpeechSpeak.mockImplementation((_text, options) => {
        captureModeAtSpeech = lifecycle.getSnapshot().mode;
        options?.onStart?.(); options?.onDone?.();
      });
      expect(await executeVoiceSpeechAction('ui.voice_global.say.start', { text: 'Read this answer.' },
        storage.getState().settings)).toEqual({ status: 'completed' });
      expect(captureModeAtSpeech).toBe('idle');
      localVoiceTtsController.stopSay();
      if (capture === 'recorded-muted') {
        const { getVoiceConversationRuntimeSnapshot } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
        const { toggleLocalVoiceTurn, setLocalVoiceMuted } = await import('./localVoiceEngine');
        expect(getVoiceConversationRuntimeSnapshot().micMuted).toBe(true);
        await toggleLocalVoiceTurn(target.sessionId);
        expect(localVoiceSpeechOutputBoundary.fileRecording.setMuted).toHaveBeenLastCalledWith({
          recordingId: 'local-engine-recording', muted: true,
        });
        // Existing unmute control changes the preference; Say never does.
        await setLocalVoiceMuted(target.sessionId, false);
        expect(getVoiceConversationRuntimeSnapshot().micMuted).toBe(false);
        return;
      }
      emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'Discard this input', confidence: 0.9 }] });
      emitSpeechRecEvent('end');
      expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', mode: 'idle' });
      expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
      expect(localVoiceSpeechTranscription).not.toHaveBeenCalled();
    } finally {
      admitRecorder.resolve({ recordingId: 'local-engine-recording' });
      await starting;
      localVoiceTtsController.stopSay();
      await lifecycle.stop(target.sessionId);
      unsubscribe();
    }
  }, 180_000);

  it('stops an in-progress recording turn without sending', async () => {
    const { toggleLocalVoiceTurn, getLocalVoiceState, stopLocalVoiceSession } = await loadLocalVoiceEngineWithCompatState();

    await toggleLocalVoiceTurn('s1');
    expect(getLocalVoiceState().status).toBe('recording');

    await stopLocalVoiceSession();
    expect(getLocalVoiceState()).toMatchObject({
      status: 'idle',
      error: null,
    });
    expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
    expect(localVoiceSpeechTranscription.mock.calls.length).toBe(0);
  });

  it('does not send a recorded-audio transcript that resolves after End Voice', async () => {
    const storage = await getStorage();
    let resolveTranscription!: (text: string) => void;
    localVoiceSpeechTranscription.mockImplementationOnce(() => new Promise((resolve) => {
      resolveTranscription = resolve;
    }));

    const { toggleLocalVoiceTurn, stopLocalVoiceSession } = await loadLocalVoiceEngineWithCompatState();

    await toggleLocalVoiceTurn('s1');
    const stopAndTranscribe = toggleLocalVoiceTurn('s1');
    const { getVoiceConversationRuntimeSnapshot } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
    await waitForLocalVoiceBoundaryEvent('transcription');
    expect(localVoiceSpeechTranscription, JSON.stringify({
      snapshot: getVoiceConversationRuntimeSnapshot(),
      providerId: storage.getState().settings.voice.providerId,
    })).toHaveBeenCalledOnce();

    await stopLocalVoiceSession();
    resolveTranscription('late transcript');
    await stopAndTranscribe;

    expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
  });

  it.each(['top_bar', 'island'] as const)('retains global Read aloud Stop in %s after Voice is disabled', async container => {
    const storage = await getStorage();
    const config = readLocalConversationVoiceSettings(storage.getState().settings.voice);
    storage.__setState({ settings: { ...storage.getState().settings, voice: {
      ...storage.getState().settings.voice, providerId: 'local_conversation',
      providers: { ...storage.getState().settings.voice.providers,
        local_conversation: { schemaVersion: 1, config: { ...config, tts: { ...config.tts, provider: 'device' } } },
      },
    } }, localSettings: { ...storage.getState().localSettings, voicePresenceContainer: container } });
    const React = await import('react');
    const { act } = await import('react-test-renderer');
    const { Dimensions } = await import('react-native');
    // Device/window dimensions are the external input; container selection stays real.
    const dimensions = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 1440, height: 900, scale: 1, fontScale: 1 });
    const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
    const { SessionCockpitChromeRegistryProvider } = await import('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry');
    const { VoiceTopBarPresenceMount } = await import('@/components/voice/presence/VoiceTopBarPresence');
    const { VoicePresenceAppShellMount } = await import('@/components/voice/presence/VoicePresenceAppShellMount');
    const { executeVoiceSpeechAction } = await import('@/sync/ops/actions/voiceSpeechAction');
    const { localVoiceTtsController } = await import('@/voice/backends/tts/localVoiceTtsController');
    const playback = localVoiceSpeechOutputBoundary.holdNextPlayback('device');
    const saying = executeVoiceSpeechAction('ui.voice_global.say.start', { text: 'Keep Stop reachable.' }, storage.getState().settings);
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
      await playback.started;
      screen = await renderScreen(React.createElement(SessionCockpitChromeRegistryProvider, null,
        React.createElement(VoiceTopBarPresenceMount), React.createElement(VoicePresenceAppShellMount)));
      if (container === 'island') {
        await act(async () => {
          screen!.findByTestId('voice-presence-float-host')!.props.onLayout({
            nativeEvent: { layout: { x: 0, y: 0, width: 1440, height: 900 } },
          });
        });
      }
      const stopId = container === 'top_bar' ? 'voice-top-bar-read-aloud-stop' : 'voice-island-read-aloud-stop';
      expect(screen.findByTestId(stopId)).not.toBeNull();
      await act(() => storage.__setState({ settings: { ...storage.getState().settings,
        featureToggles: { ...storage.getState().settings.featureToggles, voice: false },
        voice: { ...storage.getState().settings.voice, providerId: 'off' },
      } }));
      expect(localVoiceTtsController.readSay()).toBe('speaking');
      expect(screen.findByTestId(stopId)).not.toBeNull();
      screen.pressByTestId(stopId);
      expect(await saying).toEqual({ status: 'cancelled' });
    } finally {
      playback(); localVoiceTtsController.stopSay(); await saying;
      await screen?.unmount(); dimensions.mockRestore();
    }
  });

  it('preserves an already committed recorded transcript while Say takes output', async () => {
    const storage = await getStorage();
    const local = readLocalConversationVoiceSettings(storage.getState().settings.voice);
    storage.__setState({ settings: { ...storage.getState().settings, voice: {
      ...storage.getState().settings.voice,
      providers: { ...storage.getState().settings.voice.providers,
        local_conversation: { schemaVersion: 1, config: { ...local,
          tts: { ...local.tts, provider: 'device', autoSpeakReplies: true },
        } },
      },
    } } });
    const transcription = createDeferred<string>();
    localVoiceSpeechTranscription.mockImplementationOnce(() => transcription.promise);
    const accepted = createDeferred<void>();
    localVoicePendingEnqueue.mockImplementationOnce(async request => {
      await publishLocalVoiceSubmittedUserMessage(request);
      const result = acknowledgeLocalVoicePendingEnqueue(request);
      accepted.resolve();
      return result;
    });
    const { toggleLocalVoiceTurn, stopLocalVoiceSession, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
    const { executeVoiceSpeechAction } = await import('@/sync/ops/actions/voiceSpeechAction');
    const { localVoiceTtsController } = await import('@/voice/backends/tts/localVoiceTtsController');
    const playback = localVoiceSpeechOutputBoundary.holdNextPlayback('device');
    let saying: ReturnType<typeof executeVoiceSpeechAction> | undefined;
    await toggleLocalVoiceTurn('s1');
    const committed = toggleLocalVoiceTurn('s1');
    try {
      await waitForLocalVoiceBoundaryEvent('transcription');
      saying = executeVoiceSpeechAction('ui.voice_global.say.start', { text: 'Read another answer.' }, storage.getState().settings);
      await playback.started;
      const submitted = Promise.race([accepted.promise.then(() => true), committed.then(() => false)]);
      transcription.resolve('Keep this already committed utterance.');
      expect(await submitted).toBe(true);
      await publishLocalVoiceAssistantMessage({ sessionId: 's1', id: 'committed-stt-after-say', text: 'The committed reply stays in the transcript.' });
      await committed;
      expect(expoSpeechSpeak.mock.calls.map(([text]) => text)).toEqual(['Read another answer.']);
      expect(localVoiceTtsController.readSay()).toBe('speaking');
      expect(getLocalVoiceState().status).toBe('idle');
      playback();
      expect(await saying).toEqual({ status: 'completed' });
    } finally {
      playback(); localVoiceTtsController.stopSay(); await saying;
      transcription.resolve('Keep this already committed utterance.');
      await stopLocalVoiceSession();
      await committed;
    }
  });

  it('retires recorded capture when native Unmute fails without publishing unmuted input', async () => {
    const { toggleLocalVoiceTurn, setLocalVoiceMuted, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
    const { getVoiceConversationRuntimeSnapshot } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
    await toggleLocalVoiceTurn('recorded-unmute');
    expect(getLocalVoiceState().status).toBe('recording');
    await setLocalVoiceMuted('recorded-unmute', true);
    expect(getVoiceConversationRuntimeSnapshot().micMuted).toBe(true);
    localVoiceSpeechOutputBoundary.fileRecording.setMuted.mockRejectedValueOnce(new Error('file_recording_resume_failed'));
    await expect(setLocalVoiceMuted('recorded-unmute', false)).rejects.toThrow('file_recording_resume_failed');
    expect(getLocalVoiceState().status).toBe('idle');
    expect(getVoiceConversationRuntimeSnapshot()).toMatchObject({ state: 'disconnected', micMuted: true });
    expect(localVoiceSpeechOutputBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
    expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
  });

  it.each(['acknowledges', 'rejects'] as const)('ignores a retired native Unmute that %s after the same target starts again', async outcome => {
    const { toggleLocalVoiceTurn, setLocalVoiceMuted, stopLocalVoiceSession, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
    const { getVoiceConversationRuntimeSnapshot } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
    await toggleLocalVoiceTurn('recorded-retry');
    await setLocalVoiceMuted('recorded-retry', true);
    let resolveResume!: () => void;
    let rejectResume!: (error: Error) => void;
    const resume = new Promise<void>((resolve, reject) => { resolveResume = resolve; rejectResume = reject; });
    const resumeEntered = createDeferred<void>();
    localVoiceSpeechOutputBoundary.fileRecording.setMuted.mockImplementationOnce(async () => { resumeEntered.resolve(); await resume; });
    const unmuting = setLocalVoiceMuted('recorded-retry', false).catch(error => error);
    await resumeEntered.promise;
    expect(localVoiceSpeechOutputBoundary.fileRecording.setMuted).toHaveBeenLastCalledWith({
      recordingId: 'local-engine-recording', muted: false,
    });
    try {
      await stopLocalVoiceSession();
      await toggleLocalVoiceTurn('recorded-retry');
      await setLocalVoiceMuted('recorded-retry', true);
      expect(getLocalVoiceState().status).toBe('recording');
      expect(localVoiceSpeechOutputBoundary.fileRecording.setMuted).toHaveBeenLastCalledWith({
        recordingId: 'local-engine-recording', muted: true,
      });
    } finally {
      if (outcome === 'rejects') rejectResume(new Error('file_recording_resume_failed'));
      else resolveResume();
    }
    await unmuting;
    expect(getLocalVoiceState().status).toBe('recording');
    expect(getVoiceConversationRuntimeSnapshot().micMuted).toBe(true);
  });

  it('still releases Local Agent execution and effect custody when finalized-recording cleanup fails during End Voice', async () => {
    const cleanupFailure = new Error('recording_delete_failed');
    const storage = await getStorage();
    storage.__setState({
      settings: {
        ...storage.getState().settings,
        voice: {
          ...storage.getState().settings.voice,
          providerId: 'local_conversation',
          providers: {
            ...storage.getState().settings.voice.providers,
            local_conversation: { schemaVersion: 1, config: {
              ...readLocalConversationVoiceSettings(storage.getState().settings.voice),
              conversationMode: 'agent',
              stt: {
                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).stt,
                baseUrl: 'http://localhost:8000',
              },
              agent: {
                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).agent,
                prewarmOnConnect: true,
              },
              tts: {
                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).tts,
                autoSpeakReplies: false,
              },
            } },
          },
        },
      },
      sessions: {
        ...storage.getState().sessions,
        s1: {
          id: 's1',
          active: true,
          presence: 'online',
          modelMode: 'default',
          metadata: { flavor: 'claude' },
        },
      },
    });
    const { getVoiceConversationRuntimeSnapshot } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
    const { voiceCaptureAdmissionController } = await import(
      '@/voice/runtime/input/VoiceCaptureAdmissionController'
    );
    const { voiceRuntimeLevelStore } = await import('@/voice/runtime/levels/voiceRuntimeLevelStore');
    const { getRetainedLocalVoiceEffectOutcomes } = await import(
      '@/voice/tools/localVoiceEffectOutcomeCustody'
    );
    const {
      getLocalVoiceState,
      isLocalVoiceAgentActive,
      stopLocalVoiceSession,
      toggleLocalVoiceTurn,
    } = await loadLocalVoiceEngineWithCompatState();

    await toggleLocalVoiceTurn('s1');
    await waitForLocalVoiceBoundaryEvent('agent-start');
    const { voiceAgentSessions } = await import('@/voice/agent/voiceAgentSessions');
    await voiceAgentSessions.ensureRunning(VOICE_AGENT_GLOBAL_SESSION_ID);
    expect(localVoiceAgentRpc.readRetainedRun(), JSON.stringify(getVoiceConversationRuntimeSnapshot())).toMatchObject({ status: 'running', intent: 'voice_agent' });
    expect(isLocalVoiceAgentActive(VOICE_AGENT_GLOBAL_SESSION_ID)).toBe(true);
    expect(voiceRuntimeLevelStore.getSnapshot().inputSourceActive).toBe(true);
    getRetainedLocalVoiceEffectOutcomes(VOICE_AGENT_GLOBAL_SESSION_ID).set('effect-1', {
      fingerprint: 'effect-fingerprint',
      outcome: Promise.resolve({ t: 'sendSessionMessage', args: {}, result: { ok: true } }),
    });

    fileDelete.mockImplementationOnce(() => { throw cleanupFailure; });
    await expect(stopLocalVoiceSession()).rejects.toBe(cleanupFailure);

    expect(fileDelete).toHaveBeenCalledOnce();
    expect(localVoiceAgentRpc.readRetainedRun()).toBeNull();
    expect(isLocalVoiceAgentActive(VOICE_AGENT_GLOBAL_SESSION_ID)).toBe(false);
    expect(getRetainedLocalVoiceEffectOutcomes(VOICE_AGENT_GLOBAL_SESSION_ID).size).toBe(0);
    expect(voiceRuntimeLevelStore.getSnapshot()).toMatchObject({
      inputLevel: 0,
      inputSourceActive: false,
    });
    const dictation = voiceCaptureAdmissionController.acquire('dictation');
    expect(dictation.status).toBe('acquired');
    if (dictation.status === 'acquired') {
      dictation.lease.release();
    }
    expect(getVoiceConversationRuntimeSnapshot()).toMatchObject({
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      state: 'disconnected',
      micMuted: false,
      error: {
        reason: 'recording_cleanup_failed',
      },
    });
    expect(getLocalVoiceState()).toMatchObject({
      status: 'idle',
      error: 'recording_cleanup_failed',
    });
    expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
  });

  it('stops device STT recording without sending', async () => {
    const storage = await getStorage();
    storage.__setState({
      settings: {
        ...storage.getState().settings,
        voice: {
          ...storage.getState().settings.voice,
          providerId: 'local_direct',
          providers: {
            ...storage.getState().settings.voice.providers,
            local_direct: { schemaVersion: 1, config: {
              ...readLocalDirectVoiceSettings(storage.getState().settings.voice),
              stt: {
                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).stt,
                provider: 'device',
              },
              tts: {
                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).tts,
                autoSpeakReplies: false,
              },
            } },
          },
        },
      },
    });

    const { getVoiceConversationRuntimeSnapshot } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
    const { toggleLocalVoiceTurn, stopLocalVoiceSession } = await import('./localVoiceEngine');

    await toggleLocalVoiceTurn('s1');
    expect(speechRecStart).toHaveBeenCalledTimes(1);

    const stopPromise = stopLocalVoiceSession();
    expect(speechRecStop).toHaveBeenCalledTimes(1);
    expect(getVoiceConversationRuntimeSnapshot()).toMatchObject({
      controlSessionId: 's1',
      state: 'ending',
      error: null,
    });
    emitSpeechRecEvent('end', {});
    await stopPromise;

    expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
    expect(getVoiceConversationRuntimeSnapshot()).toMatchObject({
      controlSessionId: 's1',
      state: 'disconnected',
      error: null,
    });
  });

  it('cancels an in-flight turn while keeping the conversation connected', async () => {
    const storage = await getStorage();
    storage.__setState({
      settings: {
        ...storage.getState().settings,
        voice: {
          ...storage.getState().settings.voice,
          providerId: 'local_direct',
          providers: {
            ...storage.getState().settings.voice.providers,
            local_direct: { schemaVersion: 1, config: {
              ...readLocalDirectVoiceSettings(storage.getState().settings.voice),
              tts: {
                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).tts,
                autoSpeakReplies: true,
                provider: 'device',
              },
            } },
          },
        },
      },
    });

    localVoiceSpeechTranscription.mockResolvedValueOnce('hello world');

    const { getVoiceConversationRuntimeSnapshot, useVoiceConversationRuntimeStore } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
    const { abortLocalVoiceTurn, toggleLocalVoiceTurn } = await import('./localVoiceEngine');

    await toggleLocalVoiceTurn('s1');
    const stopPromise = toggleLocalVoiceTurn('s1');

    await waitForTestEvent(useVoiceConversationRuntimeStore.subscribe, getVoiceConversationRuntimeSnapshot,
      snapshot => snapshot.controlSessionId === 's1' && snapshot.state === 'thinking' && snapshot.error === null);
    expect(getVoiceConversationRuntimeSnapshot(), JSON.stringify({ providerId: storage.getState().settings.voice.providerId })).toMatchObject({
        controlSessionId: 's1',
        state: 'thinking',
        error: null,
    });
    // This admitted turn proves that the same real outbound boundary observed
    // by the End negatives actually receives direct-session submissions.
    await waitForLocalVoiceBoundaryEvent('pending-enqueue');
    expect(localVoicePendingEnqueue).toHaveBeenCalledOnce();

    const observedStates: string[] = [];
    const unsubscribe = useVoiceConversationRuntimeStore.subscribe(({ snapshot }) => observedStates.push(snapshot.state));
    try {
      const abortPromise = abortLocalVoiceTurn('s1');
      expect(getVoiceConversationRuntimeSnapshot()).toMatchObject({
        controlSessionId: 's1',
        state: 'connected',
        error: null,
      });

      await abortPromise;
      await stopPromise;

      expect(getVoiceConversationRuntimeSnapshot()).toMatchObject({
        controlSessionId: 's1',
        state: 'connected',
        error: null,
      });
      expect(observedStates).not.toContain('ending');
      expect(observedStates).not.toContain('disconnected');
    } finally {
      unsubscribe();
    }
  });


});
