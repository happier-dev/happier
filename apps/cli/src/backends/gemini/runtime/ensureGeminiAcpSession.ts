import type { AgentBackend } from '@/agent';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { importAcpReplayHistoryV1 } from '@/agent/acp/history/importAcpReplayHistory';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/ProviderEnforcedPermissionHandler';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

export async function ensureGeminiAcpSession(params: {
  backend: AgentBackend;
  session: ApiSessionClient;
  permissionHandler: ProviderEnforcedPermissionHandler;
  messageBuffer: MessageBuffer;
  storedResumeId: string | null;
  onDebug: (message: string) => void;
}): Promise<{
  acpSessionId: string;
  storedResumeId: string | null;
}> {
  const resumeId = params.storedResumeId;
  if (resumeId) {
    if (!params.backend.loadSession) {
      throw new Error('Gemini ACP backend does not support loading sessions');
    }

    const nextStoredResumeId = null; // consume once
    params.messageBuffer.addMessage('Resuming previous context…', 'status');
    const loadWithReplay = (params.backend as any).loadSessionWithReplayCapture as
      | undefined
      | ((id: string) => Promise<{ sessionId: string; replay: any[] }>);
    let replay: any[] | null = null;
    let acpSessionId: string;

    if (loadWithReplay) {
      const loaded = await loadWithReplay(resumeId);
      replay = Array.isArray(loaded.replay) ? loaded.replay : null;
      acpSessionId =
        typeof loaded.sessionId === 'string' && loaded.sessionId.trim().length > 0
          ? loaded.sessionId.trim()
          : resumeId;
    } else {
      await params.backend.loadSession(resumeId);
      acpSessionId = resumeId;
    }

    params.onDebug(`[gemini] ACP session loaded: ${acpSessionId}`);

    if (replay) {
      void importAcpReplayHistoryV1({
        session: params.session,
        provider: 'gemini',
        remoteSessionId: acpSessionId,
        replay,
        permissionHandler: params.permissionHandler,
      });
    }

    return { acpSessionId, storedResumeId: nextStoredResumeId };
  }

  const { sessionId } = await params.backend.startSession();
  params.onDebug(`[gemini] ACP session started: ${sessionId}`);
  return { acpSessionId: sessionId, storedResumeId: params.storedResumeId };
}
