import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import { storage } from '@/sync/domains/state/storage';
import {
  resolveSessionListPreferredSessionMetadataFromState,
  type SessionMetadataLike,
} from '@/sync/domains/session/listing/sessionListLookupState';
import type { ResolvedVoiceContextFormatterPrefs } from '@/voice/context/contextFormatters';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

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
  // A no-folder session's private folder is not a name; its label falls back like any unnamed session.
  if (readSessionDirectoryKind(metadata) === 'managed') return null;
  const path = normalizeNonEmptyString(metadata?.path);
  if (!path) return null;
  const lastSegment = path.split('/').filter(Boolean).at(-1);
  return normalizeNonEmptyString(lastSegment);
}

export function resolveVoiceSessionLabel(
  target: SessionAddress | string,
  prefs: VoiceSessionLabelPrefs,
  options?: Readonly<{
    metadata?: SessionMetadataLike;
    fallbackLabel?: string;
  }>,
): string {
  const state = storage.getState();
  const sessionId = typeof target === 'string' ? target : target.sessionId;
  const lookupMetadata = resolveSessionListPreferredSessionMetadataFromState(state, target);
  const ownerMetadata = readVoiceSessionOwnerMetadataFromState(state, target);
  const label =
    summaryLabelFromMetadata(lookupMetadata, prefs)
    ?? summaryLabelFromMetadata(options?.metadata, prefs)
    ?? ownerLabelFromMetadata(ownerMetadata, prefs)
    ?? (!lookupMetadata ? ownerLabelFromMetadata(options?.metadata, prefs) : null);

  if (label === sessionId) {
    return options?.fallbackLabel ?? 'the current session';
  }

  return label ?? options?.fallbackLabel ?? 'the current session';
}
