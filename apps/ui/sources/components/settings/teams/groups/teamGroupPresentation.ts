type TeamGroupIdentity = Readonly<{
    id: string;
}>;

export type TeamGroupPresentation<TGroup extends TeamGroupIdentity> = Readonly<{
    group: TGroup;
    name: string | null;
}>;

/**
 * The server lists Groups by stable ID because their labels can be sealed.
 * Sorting and filtering therefore happen only over the complete client-loaded
 * collection after its recipient-safe labels have been opened.
 */
export function presentTeamGroups<TGroup extends TeamGroupIdentity>(
    groups: readonly TGroup[],
    names: ReadonlyMap<string, string | null>,
    query: string,
): readonly TeamGroupPresentation<TGroup>[] {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return groups
        .map((group) => ({ group, name: names.get(group.id) ?? null }))
        .filter((row) => normalizedQuery === '' || row.name?.toLocaleLowerCase().includes(normalizedQuery))
        .sort((left, right) => {
            if (left.name === null && right.name === null) return left.group.id.localeCompare(right.group.id);
            if (left.name === null) return 1;
            if (right.name === null) return -1;
            return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
                || left.group.id.localeCompare(right.group.id);
        });
}
