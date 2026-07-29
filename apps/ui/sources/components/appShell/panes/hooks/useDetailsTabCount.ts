import { useAppPaneContext } from '../AppPaneProvider';

/**
 * Number of open detail tabs for a pane scope (e.g. `session:<id>`).
 *
 * Must be used within an `AppPaneProvider`; the cockpit chrome bridge reads this
 * from inside the session subtree and publishes it up to the global bottom chrome
 * so the cockpit "Tabs" tab can show an open-tab count.
 *
 * Note: dev's details workspace stores tabs as `tabsByKey` (a record keyed by
 * tab key, shared across split groups), so the open-tab count is the number of
 * keys — not the length of a per-group array.
 */
export function useDetailsTabCount(scopeId: string): number {
    const { state } = useAppPaneContext();
    const details = state.scopes[scopeId]?.details;
    return details ? Object.keys(details.tabsByKey).length : 0;
}
