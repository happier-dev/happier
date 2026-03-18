import {
  appendLocalVoiceAgentContextUpdate,
  abortLocalVoiceTurn,
  getLocalVoiceState,
  subscribeLocalVoiceState,
  stopLocalVoiceSession,
  toggleLocalVoiceTurn,
} from '@/voice/local/localVoiceEngine';
import { sendVoiceTextTurn } from '@/voice/local/sendVoiceTextTurn';
import { storage } from '@/sync/domains/state/storage';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { voiceAgentSessions } from '@/voice/agent/voiceAgentSessions';
import type { VoiceAdapterController, VoiceSessionMode, VoiceSessionSnapshot, VoiceSessionStatus } from '@/voice/session/types';
import { voiceSessionBindingManager } from '@/voice/sessionBinding/voiceSessionBindingRuntime';
import { createVoicePlaybackController } from '@/voice/runtime/VoicePlaybackController';

function mapLocalStatus(status: any): { status: VoiceSessionStatus; mode: VoiceSessionMode } {
  switch (status) {
    case 'recording':
      return { status: 'connected', mode: 'listening' };
    case 'transcribing':
      return { status: 'connected', mode: 'transcribing' };
    case 'sending':
      return { status: 'connected', mode: 'thinking' };
    case 'speaking':
      return { status: 'connected', mode: 'speaking' };
    case 'error':
      return { status: 'error', mode: 'idle' };
    case 'idle':
    default:
      return { status: 'disconnected', mode: 'idle' };
  }
}

export function createLocalConversationVoiceAdapter(): VoiceAdapterController {
  const id = 'local_conversation';

  const resolveConversationSessionId = (sessionId: string): string => {
    const settings: any = storage.getState().settings;
    const mode = settings?.voice?.adapters?.local_conversation?.conversationMode ?? 'direct_session';
    return mode === 'agent' ? VOICE_AGENT_GLOBAL_SESSION_ID : sessionId;
  };

  const getSnapshot = (): VoiceSessionSnapshot => {
    const local = getLocalVoiceState();
    const mapped = (() => {
      // Local voice keeps the sessionId set while the "call" is active, even when idle.
      if (local.status === 'idle' && local.sessionId) {
        return { status: 'connected' as const, mode: 'idle' as const };
      }
      return mapLocalStatus(local.status);
    })();
    return {
      adapterId: id,
      sessionId: local.sessionId,
      status: mapped.status,
      mode: mapped.mode,
      canStop: mapped.status !== 'disconnected',
      ...(local.error ? { errorCode: local.error, errorMessage: local.error } : {}),
    };
  };

  const toggle = async (opts: Readonly<{ sessionId: string }>) => {
    const settings: any = storage.getState().settings;
    const mode = settings?.voice?.adapters?.local_conversation?.conversationMode ?? 'direct_session';
    const startSessionId = String(opts.sessionId ?? '').trim();

    const resolvedSessionId = mode === 'agent' ? VOICE_AGENT_GLOBAL_SESSION_ID : opts.sessionId;
    if (mode === 'agent') {
      await voiceSessionBindingManager.ensureBound({
        adapterId: id,
        controlSessionId: resolvedSessionId,
        requestedTargetSessionId: startSessionId || null,
      });
    }
    const snap = getSnapshot();
    if (snap.sessionId && snap.sessionId !== resolvedSessionId && snap.status !== 'disconnected') {
      await stopLocalVoiceSession();
    }
    await toggleLocalVoiceTurn(resolvedSessionId);
  };

  const start = async (opts: Readonly<{ sessionId: string; initialContext?: string }>) => {
    const snap = getSnapshot();
    if (snap.status !== 'disconnected') return;
    await toggle({ sessionId: opts.sessionId });
  };

  const stop = async (_opts: Readonly<{ sessionId: string }>) => {
    await stopLocalVoiceSession();
  };

  const interrupt = async (opts: Readonly<{ sessionId: string }>) => {
    await abortLocalVoiceTurn(resolveConversationSessionId(opts.sessionId));
  };

  const sendContextUpdate = (opts: Readonly<{ sessionId: string; update: string }>) => {
    appendLocalVoiceAgentContextUpdate(resolveConversationSessionId(opts.sessionId), opts.update);
  };

  const sendTextTurn = async (opts: Readonly<{ controlSessionId: string; conversationSessionId: string; text: string }>) => {
    const settings: any = storage.getState().settings;
    const config = settings?.voice?.adapters?.local_conversation ?? {};
    if ((config?.conversationMode ?? 'direct_session') !== 'agent') {
      throw new Error('voice_session_native_send_only');
    }

    await sendVoiceTextTurn({
      sessionId: opts.controlSessionId,
      settings,
      userText: opts.text,
      playbackController: createVoicePlaybackController(),
      voiceAgentSessions,
    });
  };

  return {
    id,
    start,
    stop,
    toggle,
    interrupt,
    sendContextUpdate,
    sendTextTurn,
    getSnapshot,
    subscribe: (listener) => subscribeLocalVoiceState(listener),
  };
}
