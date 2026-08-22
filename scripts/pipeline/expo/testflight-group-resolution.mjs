/**
 * @param {{ groups: any[]; selections: string[] }} input
 * @returns {any[]}
 */
export function resolveExternalGroupSelections(input) {
  const groups = Array.isArray(input?.groups) ? input.groups : [];
  const selections = Array.isArray(input?.selections) ? input.selections : [];

  const externalGroups = groups.filter((group) => group?.attributes?.isInternalGroup !== true);
  const byId = new Map(
    externalGroups
      .map((group) => [String(group?.id ?? '').trim(), group])
      .filter(([id]) => Boolean(id)),
  );
  const byName = new Map(
    externalGroups
      .map((group) => [String(group?.attributes?.name ?? '').trim(), group])
      .filter(([name]) => Boolean(name)),
  );

  const seenGroupIds = new Set();

  return selections.flatMap((selection) => {
    const normalizedSelection = String(selection ?? '').trim();
    const group = byId.get(normalizedSelection)
      ?? byName.get(normalizedSelection)
      ?? null;
    if (!group) return [null];

    const groupId = String(group?.id ?? '').trim();
    if (!groupId || seenGroupIds.has(groupId)) {
      return [];
    }
    seenGroupIds.add(groupId);
    return [group];
  });
}
