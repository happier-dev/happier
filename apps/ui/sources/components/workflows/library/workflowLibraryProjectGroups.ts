import { t } from '@/text';

export type WorkflowProjectGroup = Readonly<{ key: string; title: string }>;

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
