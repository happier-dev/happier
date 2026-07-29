/**
 * Collapse-state key namespacing + read helper for connected-service
 * accounts and pool members.
 *
 * Collapse state is persisted in the dedicated synced account setting
 * `connectedServicesCollapsedItemKeysV1` (a sparse `Record<string, boolean>`).
 * Keys are namespaced so the SAME account rendered as a standalone account and
 * as a pool member never collide:
 *
 *   account     -> `<serviceId>:account:<profileId>`
 *   pool member -> `<serviceId>:pool:<groupId>:<profileId>`
 *
 * Defaults differ by variant: accounts are expanded by default (absent ⇒ not
 * collapsed); pool members are collapsed by default (absent ⇒ collapsed). Only
 * deviations from the default are persisted, keeping the synced map sparse.
 */

export type ConnectedServiceCollapseKeyParams = Readonly<{
    serviceId: string;
    profileId: string;
    /** When present, the key namespaces a pool member; otherwise a standalone account. */
    groupId?: string | null;
}>;

export function resolveConnectedServiceCollapseKey(params: ConnectedServiceCollapseKeyParams): string {
    const { serviceId, profileId, groupId } = params;
    if (groupId != null && groupId !== '') {
        return `${serviceId}:pool:${groupId}:${profileId}`;
    }
    return `${serviceId}:account:${profileId}`;
}

/**
 * Reads collapse state for a key from the sparse persisted map, applying the
 * per-variant default when the key is absent.
 *
 * @param keys              the persisted sparse `Record<string, boolean>`
 * @param key               the namespaced collapse key
 * @param defaultCollapsed  variant default — `false` for accounts (expanded),
 *                          `true` for pool members (collapsed)
 */
export function isConnectedServiceItemCollapsed(
    keys: Readonly<Record<string, boolean>> | null | undefined,
    key: string,
    defaultCollapsed: boolean,
): boolean {
    const stored = keys?.[key];
    return typeof stored === 'boolean' ? stored : defaultCollapsed;
}

/**
 * Produces the next sparse map after toggling/setting a key's collapse state.
 * Persists only deviations from the variant default: a value equal to the
 * default is removed so the synced map stays sparse.
 */
export function setConnectedServiceItemCollapsed(
    keys: Readonly<Record<string, boolean>> | null | undefined,
    key: string,
    collapsed: boolean,
    defaultCollapsed: boolean,
): Record<string, boolean> {
    const next: Record<string, boolean> = { ...(keys ?? {}) };
    if (collapsed === defaultCollapsed) {
        delete next[key];
    } else {
        next[key] = collapsed;
    }
    return next;
}
