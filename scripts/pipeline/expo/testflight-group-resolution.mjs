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

  return selections.map((selection) => {
    const normalizedSelection = String(selection ?? '').trim();
    return byId.get(normalizedSelection)
      ?? byName.get(normalizedSelection)
      ?? null;
  });
}
