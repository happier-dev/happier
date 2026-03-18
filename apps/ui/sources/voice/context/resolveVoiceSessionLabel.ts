import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { VoiceContextFormatterPrefs } from '@/voice/context/contextFormatters';

import { redactVoicePathLikeString } from '@/voice/shared/redactVoicePathLikeData';

type VoiceSessionLabelPrefs = Readonly<Pick<VoiceContextFormatterPrefs, 'voiceShareSessionSummary' | 'voiceShareFilePaths'>>;

type SessionMetadataLike = Readonly<{
  summary?: Readonly<{ text?: unknown }> | null;
  summaryText?: unknown;
  name?: unknown;
  path?: unknown;
}> | null | undefined;

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function redactIfNeeded(value: string, prefs: VoiceSessionLabelPrefs): string {
  return prefs.voiceShareFilePaths !== false ? value : redactVoicePathLikeString(value);
}

function labelFromMetadata(
  metadata: SessionMetadataLike,
  prefs: VoiceSessionLabelPrefs,
): string | null {
  const summary =
    normalizeNonEmptyString(metadata?.summary?.text)
    ?? normalizeNonEmptyString(metadata?.summaryText);
  if (prefs.voiceShareSessionSummary !== false && summary) {
    return redactIfNeeded(summary, prefs);
  }

  const name = normalizeNonEmptyString(metadata?.name);
  if (name) {
    return redactIfNeeded(name, prefs);
  }

  if (prefs.voiceShareFilePaths === false) return null;
  const path = normalizeNonEmptyString(metadata?.path);
  if (!path) return null;
  const lastSegment = path.split('/').filter(Boolean).at(-1);
  return normalizeNonEmptyString(lastSegment);
}

function findCachedSessionMetadata(state: any, sessionId: string): SessionMetadataLike {
  const visitList = (items: unknown): SessionMetadataLike => {
    if (!Array.isArray(items)) return null;
    for (const item of items) {
      if (!item || typeof item !== 'object' || (item as any).type !== 'session') continue;
      const session = (item as any).session;
      if (!session || typeof session !== 'object' || session.id !== sessionId) continue;
      const metadata = session.metadata;
      return metadata && typeof metadata === 'object' ? (metadata as SessionMetadataLike) : null;
    }
    return null;
  };

  const activeListMatch = visitList(state?.sessionListViewData);
  if (activeListMatch) return activeListMatch;

  const byServer = state?.sessionListViewDataByServerId;
  if (!byServer || typeof byServer !== 'object') return null;
  for (const items of Object.values(byServer)) {
    const match = visitList(items);
    if (match) return match;
  }
  return null;
}

export function resolveVoiceSessionLabel(
  sessionId: string,
  prefs: VoiceSessionLabelPrefs,
  options?: Readonly<{
    metadata?: SessionMetadataLike;
    fallbackLabel?: string;
  }>,
): string {
  const state: any = storage.getState();
  const session = (state?.sessions?.[sessionId] ?? null) as Session | null;
  const cachedMetadata = findCachedSessionMetadata(state, sessionId);
  const label =
    labelFromMetadata(session?.metadata, prefs)
    ?? labelFromMetadata(cachedMetadata, prefs)
    ?? labelFromMetadata(options?.metadata, prefs);

  if (label === sessionId) {
    return options?.fallbackLabel ?? 'the current session';
  }

  return label ?? options?.fallbackLabel ?? 'the current session';
}
