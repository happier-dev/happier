import { findSessionListLookupSession } from '@/sync/domains/session/listing/sessionListLookupState';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

/**
 * Voice execution facts need the hydrated owner view in layout v1. Layout v0
 * keeps the existing preference for the fresher session-list projection.
 */
export function readVoiceSessionOwnerMetadataFromState(
  state: any,
  sessionId: string,
): ReturnType<typeof readSessionOwnerMetadataView> {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!normalizedSessionId) return null;
  const directSession = state?.sessions?.[normalizedSessionId] ?? null;
  if (directSession && (
    directSession.metadataLayoutVersion !== undefined
    && directSession.metadataLayoutVersion !== 0
  )) {
    return readSessionOwnerMetadataView(directSession);
  }

  const directMetadata = directSession ? readSessionOwnerMetadataView(directSession) : null;
  const preferredSession = findSessionListLookupSession(state, normalizedSessionId)?.session ?? null;
  const preferredMetadata = preferredSession ? readSessionOwnerMetadataView(preferredSession) : null;
  if (directMetadata && preferredMetadata) {
    return {
      ...directMetadata,
      ...preferredMetadata,
    };
  }
  return preferredMetadata ?? directMetadata;
}
