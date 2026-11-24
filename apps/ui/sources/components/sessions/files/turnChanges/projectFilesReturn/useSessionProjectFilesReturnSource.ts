import * as React from 'react';
import { SessionCreationCorrespondenceV1ReadSchema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { resolveWorkspaceSyncExecutionMachineIdV1 } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';

import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useSessionSelector } from '@/sync/store/hooks';

export type SessionProjectFilesReturnSource = Readonly<{
  serverId: string;
  machineId: string;
  rootPath: string;
}>;

/**
 * Use the recorded copy origin (`recipe.projectFilesOrigin`) to locate the original folder and its execution Machine.
 * Managed origins are reached through their recorded controller.
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
          machineId: resolveWorkspaceSyncExecutionMachineIdV1(source),
          rootPath: source.rootPath,
        }
      : null;
  }, [raw]);
}
