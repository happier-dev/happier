import {
  ensureVoiceConversationSessionForSessionRoot,
  ensureVoiceConversationSessionForVoiceHome,
} from '@/voice/sessionBinding/voiceConversationSession';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { recoverUnavailableGlobalVoiceAutoMachine } from '@/voice/agent/recoverUnavailableGlobalVoiceAutoMachine';
import { applyRecoveredGlobalVoiceMachineDecision } from '@/voice/agent/applyRecoveredGlobalVoiceMachineDecision';
import { shouldRecoverUnavailableGlobalVoiceAutoMachine } from '@/voice/agent/shouldRecoverUnavailableGlobalVoiceAutoMachine';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

import type { VoiceConversationBindingResolution } from './voiceSessionBindingTypes';

function resolveLocalConversationTranscriptMode(settings: any): 'native_session' | 'synthetic' | null {
  const config = settings?.voice?.adapters?.local_conversation ?? null;
  if ((config?.conversationMode ?? 'direct_session') !== 'agent') return null;
  return config?.agent?.backend === 'daemon' ? 'native_session' : 'synthetic';
}

function shouldForceVoiceHomeForLocalConversation(settings: any): boolean {
  const config = settings?.voice?.adapters?.local_conversation ?? null;
  return config?.agent?.stayInVoiceHome === true;
}

async function ensureVoiceHomeConversationSessionIdWithRecovery(params: Readonly<{
  providerId: string;
  controlSessionId: string;
  settings: any;
}>): Promise<string> {
  try {
    return await ensureVoiceConversationSessionForVoiceHome();
  } catch (error) {
    const isGlobalLocalDaemonVoiceAgent =
      params.controlSessionId === VOICE_AGENT_GLOBAL_SESSION_ID
      && params.providerId === 'local_conversation'
      && resolveLocalConversationTranscriptMode(params.settings) === 'native_session';
    if (!isGlobalLocalDaemonVoiceAgent) throw error;
    if (!shouldRecoverUnavailableGlobalVoiceAutoMachine(error)) throw error;
    const recoveryDecision = await recoverUnavailableGlobalVoiceAutoMachine();
    if (recoveryDecision.kind !== 'retry' && recoveryDecision.kind !== 'switch') throw error;
    applyRecoveredGlobalVoiceMachineDecision(recoveryDecision);
    return await ensureVoiceConversationSessionForVoiceHome();
  }
}

export async function ensureVoiceConversationBindingResolution(params: Readonly<{
  providerId: string;
  controlSessionId: string;
  requestedTargetSessionId?: string | null;
  settings: any;
}>): Promise<VoiceConversationBindingResolution | null> {
  const controlSessionId = normalizeNonEmptyString(params.controlSessionId);
  if (!controlSessionId) return null;

  const targetSessionId = normalizeNonEmptyString(params.requestedTargetSessionId);
  const rootSessionId =
    controlSessionId === VOICE_AGENT_GLOBAL_SESSION_ID
      ? targetSessionId
      : controlSessionId;

  const resolveConversationSessionId = async () =>
    rootSessionId && !shouldForceVoiceHomeForLocalConversation(params.settings)
      ? await ensureVoiceConversationSessionForSessionRoot({ sessionId: rootSessionId })
      : await ensureVoiceHomeConversationSessionIdWithRecovery(params);

  if (params.providerId === 'realtime_elevenlabs') {
    const conversationSessionId = await resolveConversationSessionId();
    return {
      controlSessionId,
      conversationSessionId,
      transcriptMode: 'synthetic',
      targetSessionId,
    };
  }

  if (params.providerId === 'local_conversation') {
    const transcriptMode = resolveLocalConversationTranscriptMode(params.settings);
    if (!transcriptMode) return null;
    const conversationSessionId = await resolveConversationSessionId();
    return {
      controlSessionId,
      conversationSessionId,
      transcriptMode,
      targetSessionId,
    };
  }

  return null;
}
