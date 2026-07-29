import { storage } from '@/sync/domains/state/storage';
import {
  resolveSessionListPreferredSessionMetadataFromState,
  type SessionMetadataLike,
} from '@/sync/domains/session/listing/sessionListLookupState';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { ResolvedVoiceContextFormatterPrefs } from '@/voice/context/contextFormatters';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';

import { redactVoicePathLikeString } from '@/voice/shared/redactVoicePathLikeData';

type VoiceSessionLabelPrefs = Readonly<Pick<
  ResolvedVoiceContextFormatterPrefs,
  'voiceShareSessionSummary' | 'voiceShareFilePaths'
>>;

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function redactIfNeeded(value: string, prefs: VoiceSessionLabelPrefs): string {
  return prefs?.voiceShareFilePaths === true ? value : redactVoicePathLikeString(value);
}

function summaryLabelFromMetadata(
  metadata: SessionMetadataLike,
  prefs: VoiceSessionLabelPrefs,
): string | null {
  const summary =
    normalizeNonEmptyString(metadata?.summary?.text)
    ?? normalizeNonEmptyString(metadata?.summaryText);
  if (prefs?.voiceShareSessionSummary === true && summary) {
    return redactIfNeeded(summary, prefs);
  }
  return null;
}

function ownerLabelFromMetadata(
  metadata: SessionMetadataLike,
  prefs: VoiceSessionLabelPrefs,
): string | null {
  const name = normalizeNonEmptyString(metadata?.name);
  if (prefs?.voiceShareSessionSummary === true && name) {
    return redactIfNeeded(name, prefs);
  }

  if (prefs?.voiceShareFilePaths !== true) return null;
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
  const lookupMetadata = resolveSessionListPreferredSessionMetadataFromState(state, sessionId);
  const ownerMetadata = readVoiceSessionOwnerMetadataFromState(state, sessionId);
  const label =
    summaryLabelFromMetadata(lookupMetadata ?? session?.metadata ?? null, prefs)
    ?? summaryLabelFromMetadata(options?.metadata, prefs)
    ?? ownerLabelFromMetadata(ownerMetadata, prefs)
    ?? (!session ? ownerLabelFromMetadata(options?.metadata, prefs) : null);

  if (label === sessionId) {
    return options?.fallbackLabel ?? 'the current session';
  }

  return label ?? options?.fallbackLabel ?? 'the current session';
}
