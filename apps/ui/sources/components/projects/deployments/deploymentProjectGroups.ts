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
