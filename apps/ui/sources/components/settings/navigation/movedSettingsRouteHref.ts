/**
 * A Settings route that moved (Policies' identity providers and GitHub Apps to Sign-in providers,
 * Delegation into Subagents). A link saved before the move keeps its meaning: the same destination,
 * with any query it carried (a search `setting` anchor, say) and without the path parameters the
 * destination already encodes.
 */
export function movedSettingsRouteHref(
    destination: string,
    params: Readonly<Record<string, string | string[] | undefined>>,
    pathParamNames: readonly string[],
): string {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
        if (pathParamNames.includes(name) || value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) query.append(name, item);
    }
    const search = query.toString();
    return search ? `${destination}?${search}` : destination;
}
