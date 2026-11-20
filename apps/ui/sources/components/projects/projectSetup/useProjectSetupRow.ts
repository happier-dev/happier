import * as React from 'react';
import { projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { ProjectAccountOrganizationV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { ProjectSetupSetInputV1 } from '@happier-dev/protocol/projects/projectSetupSetV1';
import {
  useProjectAccountRows,
  useProjectAccountWorkspaceRef,
} from '@/sync/domains/workspaces/projectAccountRows';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

export type ProjectSetupRow = Readonly<{
  projectRef: ProjectSetupSetInputV1['projectRef'];
  expectedRevision: ProjectSetupSetInputV1['expectedRevision'];
  /** The selected Account's organization body; an absent row has none yet. */
  organization: ProjectAccountOrganizationV1;
}>;

const NO_ORGANIZATION: ProjectAccountOrganizationV1 = Object.freeze({});

/** The Project row a setup choice is written to: this checkout's Project, that row's revision and body. */
export function useProjectSetupRow(
  workspace: WorkspaceAddressV1,
): ProjectSetupRow | null {
  const workspaceRef = useProjectAccountWorkspaceRef(
    workspace.workspaceId,
    workspace.serverId,
  );
  const projectKey = workspaceRef
    ? projectWorkspaceRefV1(workspaceRef).projectKey
    : null;
  // The store retains unchanged rows, so the selected row keeps its identity across unrelated pushes.
  const row = useProjectAccountRows((rows) =>
    projectKey
      ? (rows?.organizations.find(
          (entry) =>
            entry.key.projectKey === projectKey &&
            areServerProfileIdentifiersEquivalent(
              entry.key.serverId,
              workspace.serverId,
            ),
        ) ?? 'absent')
      : null,
  );
  return React.useMemo(
    () =>
      projectKey && row !== null
        ? {
            projectRef: { serverId: workspace.serverId, projectKey },
            expectedRevision: row === 'absent' ? 'absent' : row.revision,
            organization: row === 'absent' ? NO_ORGANIZATION : row.value,
          }
        : null,
    [projectKey, row, workspace.serverId],
  );
}
