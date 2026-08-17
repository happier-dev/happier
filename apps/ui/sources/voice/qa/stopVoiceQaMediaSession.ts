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
    // Finishing the local turn drains STT and commits its transcript, but the
    // hands-free owner may already have rearmed capture by the time that
    // operation settles. Media QA is terminal after Stop, so release whichever
    // current local capture owns the session through the canonical manager.
    await params.stopSession(params.sessionId);
    return;
  }
  await params.stopSession(params.sessionId);
}
