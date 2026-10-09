import * as React from 'react';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { ProjectScriptsBody } from '@/components/projects/projectSetup/ProjectScriptsBody';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { findWorkspaceRefByScope } from '@/sync/domains/workspaces/workspaceRefs';
import { useWorkspaceRefs } from '@/sync/store/hooks';

type SessionLike = Parameters<typeof readSessionOwnerMetadataView>[0];

/**
 * The accepted Project checkout a Session works in (its Machine and folder), when it is one: the same
 * qualified workspace the Project page addresses, never a checkout manufactured from the folder.
 */
export function useSessionProjectCheckout(
  session: SessionLike | null | undefined,
  serverId: string | null | undefined,
): WorkspaceAddressV1 | null {
  const workspaceRefs = useWorkspaceRefs();
  const metadata = session ? readSessionOwnerMetadataView(session) : null;
  const machineId = metadata?.machineId ?? null;
  const rootPath = metadata?.path ?? null;
  const scopeServerId = serverId
    ? resolveServerProfileScopeIdForIdentifier(serverId)
    : null;
  return React.useMemo(() => {
    if (!scopeServerId || !machineId || !rootPath) return null;
    const ref = findWorkspaceRefByScope(workspaceRefs, {
      serverId: scopeServerId,
      machineId,
      rootPath,
    });
    return ref
      ? {
          serverId: scopeServerId,
          workspaceId: ref.id,
          machineId: ref.machineId,
          rootPath: ref.rootPath,
        }
      : null;
  }, [machineId, rootPath, scopeServerId, workspaceRefs]);
}

/**
 * Scripts beside a Session (lab `s-agent` PANE): the Project's own compact Scripts body for the
 * Session's checkout, so a run the agent started reads the same live row as on the Project page.
 */
export const SessionRightPanelScriptsView = React.memo(
  function SessionRightPanelScriptsView(
    props: Readonly<{
      checkout: WorkspaceAddressV1;
      /** The Session pane whose bottom terminal shows script output. */
      outputScopeId?: string;
    }>,
  ) {
    return (
      <ProjectScriptsBody
        workspace={props.checkout}
        presentation="widget"
        outputScopeId={props.outputScopeId}
        testID="session-rightpanel-scripts"
      />
    );
  },
);
