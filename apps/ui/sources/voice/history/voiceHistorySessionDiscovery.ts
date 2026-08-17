import type { Session } from '@/sync/domains/state/storageTypes';
import {
  isVoiceTranscriptHistorySession,
  VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG,
} from '@/voice/persistence/voiceTranscriptHistorySession';

export type VoiceHistorySessionDiscoveryDeps = Readonly<{
  prepareLookup(): Promise<void>;
  lookupByTags(tags: readonly string[]): Promise<readonly Readonly<{ id: string }>[]>;
  hydrateSession(sessionId: string): Promise<Readonly<{
    kind: string;
    sessionId?: string;
  }>>;
  readHydratedSession(sessionId: string): Session | null;
}>;

export async function discoverVoiceHistorySession(
  deps: VoiceHistorySessionDiscoveryDeps,
): Promise<string | null> {
  await deps.prepareLookup();
  const candidates = await deps.lookupByTags([
    VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG,
  ]);
  for (const candidate of candidates) {
    const sessionId = String(candidate.id ?? '').trim();
    if (!sessionId) continue;
    const hydration = await deps.hydrateSession(sessionId);
    if (
      hydration.kind !== 'available'
      || hydration.sessionId !== sessionId
    ) {
      continue;
    }
    const session = deps.readHydratedSession(sessionId);
    if (isVoiceTranscriptHistorySession(session)) return sessionId;
  }
  return null;
}
