import type { NewSessionPresentationModeV1 } from '@/sync/domains/settings/registry/account/accountSessionCreationSettingDefinitions';

type PlatformOs = string;
export type NewSessionRoutePresentation = 'containedModal' | 'modal' | 'transparentModal' | undefined;
export type NewSessionSecretRequirementRoutePresentation = 'containedTransparentModal' | 'modal' | undefined;

/**
 * Which screen `/new` renders. The `useEnhancedSessionWizard` setting is the whole predicate
 * (see `buildNewSessionScreenVariantModel`), and the two screens want different presentations:
 * the wizard is a scrolling form and keeps its sheet; the simple variant is a bare composer.
 */
export type NewSessionScreenVariant = 'simple' | 'wizard';

export function resolveNewSessionRoutePresentation(params: Readonly<{
    mode: NewSessionPresentationModeV1 | null | undefined;
    /**
     * Omitted by the sub-route resolvers below, which are never the floating composer. A missing
     * variant therefore resolves exactly as it did before the floating composer existed.
     */
    variant?: NewSessionScreenVariant;
    platformOs: PlatformOs;
}>): NewSessionRoutePresentation {
    if (params.mode === 'screen') return undefined;
    if (isNewSessionFloatingComposerPresentation({
        mode: params.mode,
        variant: params.variant,
        platformOs: params.platformOs,
    })) {
        // WHY `transparentModal` AND NOT `containedTransparentModal`
        //
        // Both are "Over" presentation styles and both are the only two for which
        // `@react-navigation/native-stack` omits the opaque `contentStyle` background — the
        // precondition for the screen painting its own backdrop at all.
        //
        // The contained one is nevertheless wrong here. `resolvePortalRelativeAnchorRect` exists
        // because CONTAINED react-native-screens presentations report `measureInWindow`
        // coordinates that are ALREADY portal-relative, so the usual `anchor − portalRoot`
        // subtraction double-offsets; its iOS-only arbiter corrects for that. `transparentModal`
        // is a top-level presentation, so the app's most popover-dense screen moves OFF that
        // quirk instead of staying on it, and the window delta becomes authoritative again.
        return 'transparentModal';
    }
    return params.platformOs === 'ios' ? 'containedModal' : 'modal';
}

/**
 * Whether `/new` renders the bare keyboard-docked composer over a backdrop the app paints itself,
 * rather than a sheet with navigator chrome.
 *
 * This is the single predicate behind otherwise-independent decisions — the native presentation,
 * whether the navigator header is shown, whether the composer scaffold paints an opaque surface,
 * and whether the screen owns its own entrance/exit — so they cannot drift apart.
 *
 * It is a new RESOLUTION of the existing `auto`/`modal` setting values, not a new one: the account
 * setting says how the route is presented (screen vs modal), and this says what that modal looks
 * like for the simple composer. No wire or persisted value changes.
 */
export function isNewSessionFloatingComposerPresentation(params: Readonly<{
    mode: NewSessionPresentationModeV1 | null | undefined;
    variant?: NewSessionScreenVariant;
    platformOs: PlatformOs;
}>): boolean {
    if (params.variant !== 'simple') return false;
    // A forced screen presentation is not a modal at all; there is nothing to float over.
    if (params.mode === 'screen') return false;
    // Web keeps Expo Router's modal route, which it renders as a drawer with its own frosted
    // scrim. Nothing to replace there.
    return params.platformOs === 'ios' || params.platformOs === 'android';
}

export function resolveNewSessionShouldBottomAnchor(params: Readonly<{
    mode: NewSessionPresentationModeV1 | null | undefined;
    platformOs: PlatformOs;
    isMobileLayoutWidth: boolean;
}>): boolean {
    if (params.isMobileLayoutWidth) return true;
    return resolveNewSessionRoutePresentation({
        mode: params.mode,
        platformOs: params.platformOs,
    }) === undefined;
}

export function resolveNewSessionPickerRoutePresentation(params: Readonly<{
    mode: NewSessionPresentationModeV1 | null | undefined;
    platformOs: PlatformOs;
}>): NewSessionRoutePresentation {
    return resolveNewSessionRoutePresentation(params);
}

export function resolveNewSessionSecretRequirementRoutePresentation(params: Readonly<{
    mode: NewSessionPresentationModeV1 | null | undefined;
    platformOs: PlatformOs;
}>): NewSessionSecretRequirementRoutePresentation {
    if (params.mode === 'screen') return undefined;
    return params.platformOs === 'ios' ? 'containedTransparentModal' : 'modal';
}
