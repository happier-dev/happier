import * as React from 'react';
import { SessionCreationCorrespondenceV1ReadSchema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';

import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useSessionSelector } from '@/sync/store/hooks';

export type SessionProjectFilesReturnSource = Readonly<{
  serverId: string;
  machineId: string;
  rootPath: string;
}>;

/**
 * Where a copied Session's files came from: the recorded copy origin (`recipe.projectFilesOrigin`), never the
 * Session's execution Machine or managed controller. No origin means there is no Bring back path.
 */
export function useSessionProjectFilesReturnSource(
  sessionId: string,
  serverId: string | null | undefined,
): SessionProjectFilesReturnSource | null {
  // The raw record keeps its identity until a metadata push replaces it; it is parsed only then.
  const raw = useSessionSelector(sessionId, serverId, (session) =>
    session
      ? ((
          readSessionOwnerMetadataView(session) as Readonly<{
            sessionCreationCorrespondenceV1?: unknown;
          }> | null
        )?.sessionCreationCorrespondenceV1 ?? null)
      : null,
  );
  return React.useMemo(() => {
    if (!raw) return null;
    const parsed = SessionCreationCorrespondenceV1ReadSchema.safeParse(raw);
    const source = parsed.success
      ? parsed.data.recipe.projectFilesOrigin?.sourceWorkspace
      : undefined;
    return source
      ? {
          serverId: source.serverId,
          machineId: source.machineId,
          rootPath: source.rootPath,
        }
      : null;
  }, [raw]);
}
