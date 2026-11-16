import * as React from 'react';
import { SessionCreationCorrespondenceV1ReadSchema,
  type SessionManagedCreationV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useSessionSelector } from '@/sync/store/hooks';

function placementFromOwnerCorrespondence(correspondence: unknown): SessionManagedCreationV1 | null {
  const parsed = SessionCreationCorrespondenceV1ReadSchema.safeParse(correspondence);
  return parsed.success && parsed.data.recipe.managedCreationOrigin === 'machine_policy'
    ? parsed.data.recipe.managedCreation ?? null : null;
}

/** The retained relationship is display data, never authorization to enter the Sandbox. */
export function readSessionSandboxPlacement(
  session: Parameters<typeof readSessionOwnerMetadataView>[0],
): SessionManagedCreationV1 | null {
  return placementFromOwnerCorrespondence(readSessionOwnerMetadataView(session)?.sessionCreationCorrespondenceV1);
}

/** Only the immutable owner leaf is observed; unrelated Session metadata does not reparse or republish it. */
export function useSessionSandboxPlacement(sessionId: string, serverId?: string | null): SessionManagedCreationV1 | null {
  const correspondence = useSessionSelector(sessionId, serverId,
    session => session ? readSessionOwnerMetadataView(session)?.sessionCreationCorrespondenceV1 : undefined);
  return React.useMemo(() => placementFromOwnerCorrespondence(correspondence), [correspondence]);
}
