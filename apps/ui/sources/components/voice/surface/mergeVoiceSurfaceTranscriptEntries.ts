import {
  deriveCanonicalVoiceTranscriptEntryId,
  type CanonicalVoiceTranscriptItem,
} from '@/voice/transcript/canonicalProjector';
import type { VoiceTranscriptEntry } from '@/voice/transcript/voiceTranscriptSelectors';

export type VoiceSurfaceTranscriptEntry = VoiceTranscriptEntry & Readonly<{
  transcriptState: 'partial' | 'final' | 'corrected' | 'interrupted';
  announce: boolean;
  announcementId: string;
}>;

function canonicalEntryId(item: CanonicalVoiceTranscriptItem): string {
  return deriveCanonicalVoiceTranscriptEntryId({
    attemptIdentity: item.attemptIdentity,
    itemId: item.itemId,
    role: item.role,
  });
}

export function mergeVoiceSurfaceTranscriptEntries(
  persisted: readonly (VoiceTranscriptEntry | VoiceSurfaceTranscriptEntry)[],
  canonical: readonly CanonicalVoiceTranscriptItem[],
): readonly VoiceSurfaceTranscriptEntry[] {
  const entries = new Map<string, VoiceSurfaceTranscriptEntry>();
  let latestCreatedAt = 0;
  for (const entry of persisted) {
    latestCreatedAt = Math.max(latestCreatedAt, entry.createdAt);
    entries.set(entry.id, {
      ...entry,
      transcriptState: 'transcriptState' in entry
        ? entry.transcriptState
        : entry.interrupted
          ? 'interrupted'
          : 'final',
      announce: 'announce' in entry ? entry.announce : false,
      announcementId: 'announcementId' in entry ? entry.announcementId : `voice-persisted:${entry.id}`,
    });
  }
  for (const item of canonical) {
    const id = canonicalEntryId(item);
    const previous = entries.get(id);
    entries.set(id, {
      id,
      createdAt: previous?.createdAt ?? latestCreatedAt + item.firstSequence + 1,
      kind: item.role,
      text: item.text,
      interrupted: false,
      transcriptState: item.corrected ? 'corrected' : item.final ? 'final' : 'partial',
      announce: item.announce === 'polite',
      announcementId: `${id}:${item.revision}`,
    });
  }
  return Object.freeze([...entries.values()].sort((left, right) => (
    left.createdAt === right.createdAt
      ? left.id.localeCompare(right.id)
      : left.createdAt - right.createdAt
  )));
}
