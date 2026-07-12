import type { AgentBackend } from '@/agent';
import type { AcpReplayHistorySessionClient } from '@/agent/acp/sessionClient';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { importAcpReplayHistoryV1 } from '@/agent/acp/history/importAcpReplayHistory';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/ProviderEnforcedPermissionHandler';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { logger } from '@/ui/logger';
import { validateAcpOpenedSessionIdentity } from '@/agent/acp/runtime/sessionIdentityBinding';

function normalizeCurrentPromptBoundary(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

function createReplayImportSession(params: {
  session: ApiSessionClient;
  currentPromptText?: string | null;
}): AcpReplayHistorySessionClient {
  const currentPromptText = typeof params.currentPromptText === 'string'
    ? normalizeCurrentPromptBoundary(params.currentPromptText)
    : '';

  return {
    fetchRecentTranscriptTextItemsForAcpImport: async (opts) => {
      const items = await params.session.fetchRecentTranscriptTextItemsForAcpImport(opts);
      if (!currentPromptText || items.length === 0) return items;

      const last = items[items.length - 1];
      if (
        last?.role === 'user'
        && normalizeCurrentPromptBoundary(last.text) === currentPromptText
      ) {
        return items.slice(0, -1);
      }
      return items;
    },
    sendUserTextMessageCommitted: (...args) => params.session.sendUserTextMessageCommitted(...args),
    sendAgentMessageCommitted: (...args) => params.session.sendAgentMessageCommitted(...args),
    updateMetadata: (updater) => params.session.updateMetadata(updater),
  };
}

export async function importGeminiAcpSessionReplay(params: Readonly<{
  session: ApiSessionClient;
  permissionHandler: ProviderEnforcedPermissionHandler;
  remoteSessionId: string;
  replay: ReadonlyArray<unknown>;
  currentPromptText?: string | null;
}>): Promise<void> {
  const replayImportSession = typeof params.currentPromptText === 'string' && params.currentPromptText.trim()
    ? createReplayImportSession({
        session: params.session,
        currentPromptText: params.currentPromptText,
      })
    : params.session;
  await importAcpReplayHistoryV1({
    session: replayImportSession,
    provider: 'gemini',
    remoteSessionId: params.remoteSessionId,
    replay: [...params.replay],
    permissionHandler: params.permissionHandler,
  });
}

export async function ensureGeminiAcpSession(params: {
  backend: AgentBackend;
  session: ApiSessionClient;
  permissionHandler: ProviderEnforcedPermissionHandler;
  messageBuffer: MessageBuffer;
  storedResumeId: string | null;
  currentPromptText?: string | null;
  deferReplayImport?: boolean;
  onDebug: (message: string) => void;
}): Promise<{
  acpSessionId: string;
  storedResumeId: string | null;
  startedFreshSession: boolean;
  deferredReplay?: ReadonlyArray<unknown>;
}> {
  const resumeId = params.storedResumeId;
  if (resumeId) {
    const loadWithReplay = params.backend.loadSessionWithReplayCapture?.bind(params.backend);
    const loadSession = params.backend.loadSession?.bind(params.backend);
    if (!loadWithReplay && !loadSession) {
      throw new Error('Gemini ACP backend does not support loading sessions');
    }

    const nextStoredResumeId = null; // consume once
    params.messageBuffer.addMessage('Resuming previous context…', 'status');
    let replay: any[] | null = null;
    let acpSessionId = resumeId;

    if (loadWithReplay) {
      const loaded = await loadWithReplay(resumeId);
      replay = Array.isArray(loaded.replay) ? loaded.replay : null;
      acpSessionId = validateAcpOpenedSessionIdentity(
        { kind: 'resume', expectedVendorSessionId: resumeId },
        loaded.sessionId,
      );
    } else if (loadSession) {
      const loadExistingSession = loadSession;
      const loaded = await loadExistingSession(resumeId);
      acpSessionId = validateAcpOpenedSessionIdentity(
        { kind: 'resume', expectedVendorSessionId: resumeId },
        loaded.sessionId,
      );
    }

    params.onDebug(`[gemini] ACP session loaded: ${acpSessionId}`);

    if (replay) {
      if (params.deferReplayImport === true) {
        return {
          acpSessionId,
          storedResumeId: nextStoredResumeId,
          startedFreshSession: false,
          deferredReplay: replay,
        };
      }
      try {
        await importGeminiAcpSessionReplay({
          session: params.session,
          permissionHandler: params.permissionHandler,
          remoteSessionId: acpSessionId,
          replay,
          currentPromptText: params.currentPromptText,
        });
      } catch (error) {
        logger.debug('[gemini] Failed to import ACP replay history (non-fatal)', { error });
      }
    }

    return { acpSessionId, storedResumeId: nextStoredResumeId, startedFreshSession: false };
  }

  const { sessionId } = await params.backend.startSession();
  params.onDebug(`[gemini] ACP session started: ${sessionId}`);
  return { acpSessionId: sessionId, storedResumeId: params.storedResumeId, startedFreshSession: true };
}
