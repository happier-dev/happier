import { resolveAgentIdFromFlavor } from '@/agents/registry/registryCore';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useSessionDisplayNameSource } from '@/sync/domains/state/storage';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { t } from '@/text';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';

/**
 * Who another Session is, as a transcript names it: its title and its agent mark. One owner for every
 * row that points at another Session (a returned answer, an Ask record's targets), qualified by the
 * transcript's own Home like the provenance label.
 */
export function useTranscriptSessionIdentity(sessionId: string | null, serverId: string | null) {
  const session = useSessionDisplayNameSource(sessionId ?? '', serverId);
  const isSessionVisible = useSessionRecordingVisibility();
  const visibleSession = sessionId && isSessionVisible({ sessionId, serverId }) ? session : null;
  return {
    name: visibleSession ? getSessionName(visibleSession, serverId) : t('message.provenanceSession'),
    agentId: resolveAgentIdFromFlavor(visibleSession ? readSessionOwnerMetadataView(visibleSession)?.flavor ?? null : null),
  };
}
