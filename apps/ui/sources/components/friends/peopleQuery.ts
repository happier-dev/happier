/**
 * Whether a person on the People page answers its search: any of their names (display name, username) contains the
 * query, ignoring case. A blank query keeps everyone.
 */
export function matchesPeopleQuery(query: string, ...names: readonly (string | null | undefined)[]): boolean {
    const needle = query.trim().toLocaleLowerCase();
    if (needle.length === 0) return true;
    return names.some((name) => typeof name === 'string' && name.toLocaleLowerCase().includes(needle));
}
