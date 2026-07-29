import type { VoiceAdapterEngineKind, VoiceSessionSnapshot } from '@/voice/session/types';

export async function stopVoiceQaMediaSession(params: Readonly<{
  sessionId: string;
  snapshot: Readonly<{ adapterId: string | null }>;
  getSnapshot: () => VoiceSessionSnapshot;
  resolveEngineKind: (adapterId: string) => VoiceAdapterEngineKind | null;
  toggleLocalTurn: (sessionId: string) => Promise<void>;
  stopSession: (sessionId: string) => Promise<void>;
}>): Promise<void> {
  const adapterId = params.snapshot.adapterId?.trim() ?? '';
  const engineKind = adapterId ? params.resolveEngineKind(adapterId) : null;
  if (engineKind === 'local') {
    await params.toggleLocalTurn(params.sessionId);
    const settled = params.getSnapshot();
    const failureReason = settled.errorMessage?.trim() || settled.errorCode?.trim() || null;
    if (settled.status === 'error' || (settled.status === 'disconnected' && failureReason)) {
      throw new Error(`voice_qa_media_stop_failed:${failureReason ?? 'unknown'}`);
    }
    if (
      settled.sessionId === params.sessionId
      && settled.status === 'connected'
      && settled.mode === 'listening'
    ) {
      throw new Error('voice_qa_media_stop_unsettled');
    }
    // Finishing the local turn drains STT and commits its transcript, but the
    // connected Voice session intentionally keeps its mic lease for a possible
    // next turn. Media QA is terminal after Stop, so release that owner through
    // the canonical session manager once turn finalization has settled.
    await params.stopSession(params.sessionId);
    return;
  }
  await params.stopSession(params.sessionId);
}
