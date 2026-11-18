/**
 * Environment rows by their Project, in the read's own order: the first Environment of each Project places its group.
 * The name is the admitted Source name the read carries; Environments whose Project name is unavailable or withdrawn
 * are kept apart (`unnamed`) so one placeholder is never repeated. The Services page and the Services column both
 * group through here, so the two never disagree about which Project an Environment belongs to.
 */
export type DeploymentProjectGroup<Row> = Readonly<{
  key: string;
  title: string;
  rows: Row[];
}>;

export function groupDeploymentRowsByProject<
  Row extends Readonly<{ projectSourceId: string; projectName: string | null }>,
>(
  rows: readonly Row[],
): Readonly<{ named: DeploymentProjectGroup<Row>[]; unnamed: Row[] }> {
  const named = new Map<string, { key: string; title: string; rows: Row[] }>();
  const unnamed: Row[] = [];
  for (const row of rows) {
    if (!row.projectName) {
      unnamed.push(row);
      continue;
    }
    const group = named.get(row.projectSourceId);
    if (group) group.rows.push(row);
    else
      named.set(row.projectSourceId, {
        key: row.projectSourceId,
        title: row.projectName,
        rows: [row],
      });
  }
  return { named: [...named.values()], unnamed };
}

/** The unbanded group a view's rows share when it lists one Project (no heading). */
export const DEPLOYMENT_UNBANDED_GROUP = 'all';
/** The last band: rows whose Project name the read could not carry. */
export const DEPLOYMENT_OTHER_PROJECT_GROUP = 'other';

/**
 * The one band rule of every Services view (Apps, Databases, Domains; UI refinements 2026-11-18): a view bands its rows by
 * Project only when it lists more than one Project. Then every Project gets its band, in the read's order, and rows whose
 * Project name is unavailable share one last band titled `otherTitle`; a view of one Project stands unbanded.
 */
export function deploymentProjectBands<
  Row extends Readonly<{ projectSourceId: string; projectName: string | null }>,
>(rows: readonly Row[], otherTitle: string): Readonly<{
  banded: boolean;
  groups: readonly DeploymentProjectGroup<Row>[];
  groupOf: (row: Row) => string;
}> {
  const { named, unnamed } = groupDeploymentRowsByProject(rows);
  const groups: DeploymentProjectGroup<Row>[] = [...named];
  if (unnamed.length > 0) groups.push({ key: DEPLOYMENT_OTHER_PROJECT_GROUP, title: otherTitle, rows: unnamed });
  if (groups.length <= 1) {
    return { banded: false, groups: [{ key: DEPLOYMENT_UNBANDED_GROUP, title: '', rows: [...rows] }], groupOf: () => DEPLOYMENT_UNBANDED_GROUP };
  }
  return { banded: true, groups, groupOf: (row) => row.projectName ? row.projectSourceId : DEPLOYMENT_OTHER_PROJECT_GROUP };
}
