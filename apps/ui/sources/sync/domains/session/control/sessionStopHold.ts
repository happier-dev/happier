import { resolveSessionAutoResumeAdmissionV1 } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';

import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { Session } from '@/sync/domains/state/storageTypes';

/**
 * A person's Stop holds this Session: nothing automatic wakes it, and an explicit resume clears the hold.
 * The protocol admission owner decides; this only reads the Session's own facts for it.
 */
export function isSessionHeldByPersonStop(
  session: Pick<
    Session,
    'archivedAt' | 'metadata' | 'metadataLayoutVersion' | 'ownerMetadataView'
  >,
): boolean {
  return (
    resolveSessionAutoResumeAdmissionV1({
      metadata: readSessionOwnerMetadataView(session),
      archivedAt: session.archivedAt,
      machineAvailable: true,
      authorityAvailable: true,
    }) === 'held_by_person'
  );
}
