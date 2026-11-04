/**
 * How the canonical `/search` route is presented.
 *
 * Native renders universal Search as a transparent full-screen overlay: results scroll above a
 * search plane seated over the software keyboard while the screen the user came from stays visible
 * behind the scrim. `transparentModal` (`UIModalPresentationOverFullScreen`) is one of the two
 * presentations for which `@react-navigation/native-stack` omits its opaque `contentStyle`
 * background — the precondition for the route painting its own ground — and, unlike the contained
 * variant, it is top-level, so popover anchoring inside the overlay keeps window coordinates
 * authoritative.
 *
 * Web/desktop have one Search surface, the modal over the shell: the shortcut and rail open it in place,
 * and a direct link to `/search` hands its query and scope to that modal and leaves the route.
 */
/** The one canonical universal Search route: deep link, native entry and web direct access. */
export const UNIVERSAL_SEARCH_ROUTE = '/search';

export type UniversalSearchRoutePresentation = 'transparentModal' | undefined;

export function resolveUniversalSearchRoutePresentation(params: Readonly<{
    platformOs: string;
}>): UniversalSearchRoutePresentation {
    return params.platformOs === 'ios' || params.platformOs === 'android'
        ? 'transparentModal'
        : undefined;
}
