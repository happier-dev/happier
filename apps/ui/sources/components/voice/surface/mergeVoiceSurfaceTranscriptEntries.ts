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

function mergedEntries(
  persisted: readonly (VoiceTranscriptEntry | VoiceSurfaceTranscriptEntry)[],
  canonical: readonly CanonicalVoiceTranscriptItem[],
): ReadonlyMap<string, VoiceTranscriptEntry | VoiceSurfaceTranscriptEntry> {
  const entries = new Map<string, VoiceTranscriptEntry | VoiceSurfaceTranscriptEntry>();
  let latestCreatedAt = 0;
  for (const entry of persisted) {
    latestCreatedAt = Math.max(latestCreatedAt, entry.createdAt);
    entries.set(entry.id, entry);
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
  return entries;
}

function compareEntries(left: VoiceTranscriptEntry, right: VoiceTranscriptEntry): number {
  return left.createdAt === right.createdAt
    ? left.id.localeCompare(right.id)
    : left.createdAt - right.createdAt;
}

export function mergeVoiceSurfaceTranscriptEntries(
  persisted: readonly (VoiceTranscriptEntry | VoiceSurfaceTranscriptEntry)[],
  canonical: readonly CanonicalVoiceTranscriptItem[],
): readonly VoiceSurfaceTranscriptEntry[] {
  const entries = [...mergedEntries(persisted, canonical).values()].map((entry): VoiceSurfaceTranscriptEntry => ({
    ...entry,
    transcriptState: 'transcriptState' in entry ? entry.transcriptState : entry.interrupted ? 'interrupted' : 'final',
    announce: 'announce' in entry ? entry.announce : false,
    announcementId: 'announcementId' in entry ? entry.announcementId : `voice-persisted:${entry.id}`,
  }));
  return Object.freeze(entries.sort(compareEntries));
}

/** Same overlay/order semantics as the detail feed, without sorting or building a detail array. */
export function resolveVoiceSurfaceLatestTranscriptText(
  persisted: readonly (VoiceTranscriptEntry | VoiceSurfaceTranscriptEntry)[],
  canonical: readonly CanonicalVoiceTranscriptItem[],
): string | null {
  let latest: VoiceTranscriptEntry | null = null;
  for (const entry of mergedEntries(persisted, canonical).values()) {
    if (!latest || compareEntries(latest, entry) < 0) latest = entry;
  }
  return latest?.text ?? null;
}
