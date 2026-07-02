/**
 * Public surface for the unified-onboarding split shell.
 *
 * Consumers (PreAuthOnboardingWizardEntry in dev/, route files in remote-dev/)
 * import only the top-level `UnauthenticatedSplitShell` plus the storage hooks.
 * Sub-components remain internal to this folder.
 */

export {
    UnauthenticatedSplitShell,
    type UnauthenticatedSplitShellProps,
} from './UnauthenticatedSplitShell';

export { useApplyBrandHeroSeen } from './useApplyBrandHeroSeen';
export { useBrandHeroSeenAt } from './useBrandHeroSeenAt';
export {
    useUnauthShellLayout,
    type UnauthShellLayout,
    type UnauthShellLayoutParams,
    MOBILE_MAX_WIDTH_PX,
} from './useUnauthShellLayout';
