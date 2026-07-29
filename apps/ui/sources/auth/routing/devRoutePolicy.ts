/**
 * Single route-level authority for every `/dev/*` screen.
 *
 * Palette/menu visibility is only discoverability; production access is
 * denied here even for authenticated users.
 */
export function isDevRouteEnabled(): boolean {
    return (typeof __DEV__ !== 'undefined' && __DEV__ === true)
        || process.env.EXPO_PUBLIC_DEBUG === '1';
}
