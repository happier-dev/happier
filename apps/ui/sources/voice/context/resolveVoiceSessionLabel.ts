import { readSessionTitleInMetadata } from '@happier-dev/protocol/sessions/metadata/sessionTitle';
import { storage } from '@/sync/domains/state/storage';
import type { SessionMetadataLike } from '@/sync/domains/session/listing/sessionListLookupState';
import type { ResolvedVoiceContextFormatterPrefs } from '@/voice/context/contextFormatters';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

import { redactVoicePathLikeString } from '@/voice/shared/redactVoicePathLikeData';

type VoiceSessionLabelPrefs = Readonly<Pick<
  ResolvedVoiceContextFormatterPrefs,
  'voiceShareSessionSummary' | 'voiceShareFilePaths'
>>;

function redactIfNeeded(value: string, prefs: VoiceSessionLabelPrefs): string {
  return prefs?.voiceShareFilePaths === true ? value : redactVoicePathLikeString(value);
}

/** Speech names authored Sessions, never a list row's transient first-message title. */
export function resolveVoiceSessionAuthoredLabel(
  metadata: SessionMetadataLike,
  prefs: VoiceSessionLabelPrefs,
): string | null {
  if (prefs?.voiceShareSessionSummary !== true) return null;
  const title = readSessionTitleInMetadata(metadata);
  return title ? redactIfNeeded(title, prefs) : null;
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
  const ownerMetadata = readVoiceSessionOwnerMetadataFromState(state, target);
  const label =
    resolveVoiceSessionAuthoredLabel(ownerMetadata, prefs)
    ?? resolveVoiceSessionAuthoredLabel(options?.metadata, prefs);

  if (label === sessionId) {
    return options?.fallbackLabel ?? 'the current session';
  }

  return label ?? options?.fallbackLabel ?? 'the current session';
}
