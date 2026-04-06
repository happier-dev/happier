import { storage } from '@/sync/domains/state/storage';
import {
  resolveSessionListPreferredSessionMetadataFromState,
  type SessionMetadataLike,
} from '@/sync/domains/session/listing/sessionListCacheState';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { VoiceContextFormatterPrefs } from '@/voice/context/contextFormatters';

import { redactVoicePathLikeString } from '@/voice/shared/redactVoicePathLikeData';

type VoiceSessionLabelPrefs = Readonly<Pick<VoiceContextFormatterPrefs, 'voiceShareSessionSummary' | 'voiceShareFilePaths'>>;

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
  const cachedMetadata = resolveSessionListPreferredSessionMetadataFromState(state, sessionId);
  const label =
    labelFromMetadata(cachedMetadata, prefs)
    ?? labelFromMetadata(session?.metadata, prefs)
    ?? labelFromMetadata(options?.metadata, prefs);

  if (label === sessionId) {
    return options?.fallbackLabel ?? 'the current session';
  }

  return label ?? options?.fallbackLabel ?? 'the current session';
}
