/**
 * Canonical owner of how the `/new` route is presented.
 *
 * Before this module the decision was an inline `Platform.OS === 'ios' ? 'pageSheet' : 'modal'`
 * ternary in `app/(app)/_layout.tsx`. It moved here for two reasons: the decision now depends on
 * which variant the screen will render, and it is the seam `../dev` already resolves through
 * (`resolveNewSessionRoutePresentation`), so keeping the same module path and function name makes
 * the port a merge rather than a translation.
 *
 * WHY `transparentModal` AND NOT `containedTransparentModal`
 *
 * Both are "Over" presentation styles (`UIModalPresentationOverFullScreen` and
 * `UIModalPresentationOverCurrentContext`), and both are the ONLY two presentations for which
 * `@react-navigation/native-stack` omits the opaque `contentStyle` background — which is what lets
 * the screen paint its own frosted backdrop at all.
 *
 * The contained one is nevertheless the wrong choice here. `resolvePortalRelativeAnchorRect` exists
 * because CONTAINED react-native-screens presentations report `measureInWindow` coordinates that are
 * already portal-relative, so the usual `anchor - portalRoot` subtraction double-offsets; its
 * iOS-only arbiter corrects for that. `pageSheet` (today) and `transparentModal` are both top-level
 * presentations, so the composer's popovers keep taking exactly the branch they take today. Choosing
 * the contained variant would move the app's most popover-dense screen onto a different measurement
 * branch for no visual gain — the two render identically here.
 *
 * The contained styles also carry a documented bookkeeping cost: react-native-screens' own source
 * notes that under `CurrentContext`/`OverCurrentContext` "the system asks top-level (react root) vc
 * to present instead of our stack", forcing it to walk the hierarchy to find the presenter.
 */

export type NewSessionScreenVariant = 'simple' | 'wizard';

export type NewSessionRoutePresentation =
    | 'transparentModal'
    | 'pageSheet'
    | 'modal';

export type NewSessionPresentationInput = Readonly<{
    variant: NewSessionScreenVariant;
    /** Explicit (not read from `Platform`) so this stays a pure, unit-testable helper. */
    platformOs: string;
}>;

/**
 * Whether the route renders the bare keyboard-docked composer over a backdrop the app paints
 * itself, rather than a sheet with navigator chrome.
 *
 * This is the single predicate behind three otherwise-independent decisions — the native
 * presentation, whether the navigator header is shown, and whether the composer scaffold paints an
 * opaque surface — so they cannot drift apart.
 */
export function isNewSessionFloatingComposerPresentation(
    input: NewSessionPresentationInput,
): boolean {
    if (input.variant !== 'simple') return false;
    // Web keeps Expo Router's modal route, which it renders as a Vaul drawer with its own frosted
    // scrim (`[data-vaul-overlay]` in theme.css). Nothing to replace there.
    return input.platformOs === 'ios' || input.platformOs === 'android';
}

export function resolveNewSessionRoutePresentation(
    input: NewSessionPresentationInput,
): NewSessionRoutePresentation {
    if (isNewSessionFloatingComposerPresentation(input)) {
        return 'transparentModal';
    }
    // The wizard is a scrolling form and keeps the native sheet it has today, unchanged.
    return input.platformOs === 'ios' ? 'pageSheet' : 'modal';
}
