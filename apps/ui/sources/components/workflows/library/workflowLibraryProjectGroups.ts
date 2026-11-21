import * as React from 'react';
import { isManagedWorkspaceRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { useMachineDisplayNamesById } from '@/sync/domains/state/storage';
import type { ProjectAccountRowsSnapshot } from '@/sync/domains/workspaces/projectAccountRows';
import { buildProjectGroupDisplayIndex } from '@/sync/domains/workspaces/projectGroupDisplay';
import { t } from '@/text';

export type WorkflowProjectGroup = Readonly<{ key: string; title: string }>;

/** The library and Runs use the Project owner over the same held Home census and Machine names. */
export function useWorkflowProjectGroupDisplay(census: ProjectAccountRowsSnapshot | null, presented: boolean) {
  const refs = census?.workspaceRefs;
  const organizations = census?.organizations;
  const machineIds = React.useMemo(() => {
    const ids: string[] = [];
    for (const ref of refs ?? []) {
      if (!isManagedWorkspaceRefV2(ref)) ids.push(ref.machineId);
    }
    return ids;
  }, [refs]);
  const machineNames = useMachineDisplayNamesById(machineIds, { serverId: census?.scope.serverId, presented });
  return React.useMemo(() => refs ? buildProjectGroupDisplayIndex(refs, organizations, machineNames) : null,
    [refs, organizations, machineNames]);
}

/**
 * Group by Project for workflows (scene 8 D1/D3): the projects by name, then "No project" for the rest. The one
 * axis the index and the sidebar both read, so the two places group the same rows the same way.
 */
export function workflowLibraryProjectAxis(
  projects: ReadonlyMap<string, WorkflowProjectGroup>,
) {
  const noProject: WorkflowProjectGroup = {
    key: 'noProject',
    title: t('workflows.destination.sections.noProject'),
  };
  const byProject = new Map(
    [...projects.values()].map((project) => [project.key, project]),
  );
  return {
    axis: [...byProject.values()]
      .sort((left, right) => left.title.localeCompare(right.title))
      .concat(noProject),
    groupOf: (row: Readonly<{ key: string }>) =>
      projects.get(row.key)?.key ?? noProject.key,
  };
}

/** The rows a list shows, in the project axis's order, leaving out empty groups. */
export function groupWorkflowRowsByProject<
  Row extends Readonly<{ key: string }>,
>(
  rows: readonly Row[],
  projects: ReadonlyMap<string, WorkflowProjectGroup>,
): readonly Readonly<{ key: string; title: string; rows: readonly Row[] }>[] {
  const { axis, groupOf } = workflowLibraryProjectAxis(projects);
  const byGroup = new Map<string, Row[]>();
  for (const row of rows) {
    const key = groupOf(row);
    const members = byGroup.get(key);
    if (members) members.push(row);
    else byGroup.set(key, [row]);
  }
  return axis.flatMap((group) => {
    const members = byGroup.get(group.key);
    return members
      ? [{ key: group.key, title: group.title, rows: members }]
      : [];
  });
}
