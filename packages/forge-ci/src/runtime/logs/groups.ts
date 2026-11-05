export type ForgeCiLogGroupV1 = Readonly<{
  id: string; title: string; parentId: string | null; startLine: number; endLine: number | null; closed: boolean;
}>;

/** Group markers are display hints. Unmatched markers remain original, linkable lines. */
export function buildForgeCiLogGroupsV1(
  lines: readonly Readonly<{ id: string; number: number; plainText: string }>[],
  baseline?: readonly ForgeCiLogGroupV1[],
): Readonly<{ groups: readonly ForgeCiLogGroupV1[]; lineGroups: ReadonlyMap<string, readonly string[]>; issues: readonly string[] }> {
  const groups: Array<{ id: string; title: string; parentId: string | null; startLine: number; endLine: number | null; closed: boolean }> = [];
  const stack: typeof groups = [];
  const lineGroups = new Map<string, readonly string[]>();
  const issues: string[] = [];
  let previousLine: number | undefined;
  for (const line of lines) {
    if (previousLine !== undefined && line.number !== previousLine + 1 && stack.length > 0) {
      for (const group of stack) issues.push(`unclosed_group:${group.startLine}`);
      issues.push(`group_coverage_gap:${line.number}`);
      stack.length = 0;
    }
    if (line.plainText.startsWith('##[group]')) {
      const group = { id: line.id + ':group', title: line.plainText.slice('##[group]'.length), parentId: stack.at(-1)?.id ?? null, startLine: line.number, endLine: null, closed: false };
      groups.push(group);
      stack.push(group);
    }
    lineGroups.set(line.id, stack.map(group => group.id));
    if (line.plainText === '##[endgroup]') {
      const group = stack.pop();
      if (group) { group.endLine = line.number; group.closed = true; }
      else issues.push(`unmatched_group_end:${line.number}`);
    }
    previousLine = line.number;
  }
  for (const group of stack) issues.push(`unclosed_group:${group.startLine}`);
  const previous = new Map(baseline?.map(group => [group.id, group]));
  const retained = groups.map(group => {
    const old = previous.get(group.id);
    return old && old.title === group.title && old.parentId === group.parentId && old.startLine === group.startLine
      && old.endLine === group.endLine && old.closed === group.closed ? old : group;
  });
  return { groups: baseline && retained.length === baseline.length && retained.every((group, i) => group === baseline[i]) ? baseline : retained, lineGroups, issues };
}
