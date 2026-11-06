export type ForgeCiLogGroupV1 = Readonly<{
  id: string; title: string; parentId: string | null; startLine: number; endLine: number | null; closed: boolean;
}>;

type GroupState = Readonly<{
  groups: readonly ForgeCiLogGroupV1[]; stack: readonly number[]; issues: readonly string[]; previousLine: number | undefined;
}>;

/** Group markers are display hints. Unmatched markers remain original, linkable lines. */
export function buildForgeCiLogGroupsV1(
  lines: readonly Readonly<{ id: string; number: number; plainText: string }>[],
  baseline?: readonly ForgeCiLogGroupV1[],
  resume?: GroupState,
): Readonly<{ groups: readonly ForgeCiLogGroupV1[]; lineGroups: ReadonlyMap<string, readonly string[]>; issues: readonly string[];
  state: GroupState; beforeLast: GroupState }> {
  let groups = resume?.groups ?? [];
  let stack = resume?.stack ?? [];
  const lineGroups = new Map<string, readonly string[]>();
  let issues = resume?.issues ?? [];
  let previousLine = resume?.previousLine;
  let writableGroups: ForgeCiLogGroupV1[] | undefined;
  let writableIssues: string[] | undefined;
  const editGroups = () => {
    if (!writableGroups) { writableGroups = groups.slice(); groups = writableGroups; }
    return writableGroups;
  };
  const editIssues = () => {
    if (!writableIssues) { writableIssues = issues.slice(); issues = writableIssues; }
    return writableIssues;
  };
  let beforeLast: GroupState = { groups, stack, issues, previousLine };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (i === lines.length - 1) {
      // A later carrier can extend this partial line, replacing its marker effects.
      beforeLast = { groups, stack, issues, previousLine };
      writableGroups = undefined;
      writableIssues = undefined;
    }
    if (previousLine !== undefined && line.number !== previousLine + 1 && stack.length > 0) {
      for (const index of stack) editIssues().push(`unclosed_group:${groups[index]!.startLine}`);
      editIssues().push(`group_coverage_gap:${line.number}`);
      stack = [];
    }
    if (line.plainText.startsWith('##[group]')) {
      const parent = stack.at(-1);
      const group = { id: line.id + ':group', title: line.plainText.slice('##[group]'.length), parentId: parent === undefined ? null : groups[parent]!.id, startLine: line.number, endLine: null, closed: false };
      stack = [...stack, groups.length];
      editGroups().push(group);
    }
    lineGroups.set(line.id, stack.map(index => groups[index]!.id));
    if (line.plainText === '##[endgroup]') {
      const index = stack.at(-1);
      stack = stack.slice(0, -1);
      if (index !== undefined) {
        editGroups()[index] = { ...groups[index]!, endLine: line.number, closed: true };
      } else editIssues().push(`unmatched_group_end:${line.number}`);
    }
    previousLine = line.number;
  }
  if (!resume && baseline) {
    const previous = new Map(baseline.map(group => [group.id, group]));
    const retained = groups.map(group => {
      const old = previous.get(group.id);
      return old && old.title === group.title && old.parentId === group.parentId && old.startLine === group.startLine
        && old.endLine === group.endLine && old.closed === group.closed ? old : group;
    });
    groups = retained.length === baseline.length && retained.every((group, i) => group === baseline[i]) ? baseline : retained;
  }
  return { groups, lineGroups, issues: [...issues, ...stack.map(index => `unclosed_group:${groups[index]!.startLine}`)],
    state: { groups, stack, issues, previousLine }, beforeLast };
}
