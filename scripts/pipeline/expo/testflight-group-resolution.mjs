const ASC_RESOURCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAscResourceId(value) {
  return ASC_RESOURCE_ID_PATTERN.test(String(value ?? '').trim());
}

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
      ?? (isAscResourceId(normalizedSelection) ? { id: normalizedSelection, attributes: {} } : null);
    if (!group) return [null];

    const groupId = String(group?.id ?? '').trim();
    if (!groupId || seenGroupIds.has(groupId)) {
      return [];
    }
    seenGroupIds.add(groupId);
    return [group];
  });
}
