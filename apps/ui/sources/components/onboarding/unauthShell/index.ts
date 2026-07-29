/**
 * Public surface for the unified-onboarding split shell.
 *
 * Consumers (PreAuthOnboardingWizardEntry in dev/, route files in remote-dev/)
 * import the top-level `UnauthenticatedSplitShell` plus the storage hooks.
 * StagePane is exported as the explicit right-pane host contract for the
 * journey work; other sub-components remain internal to this folder.
 */

export {
    UnauthenticatedSplitShell,
    type UnauthenticatedSplitShellProps,
} from './UnauthenticatedSplitShell';
export {
    StagePane,
    type StagePanePlanetRecedeProps,
    type StagePaneProps,
} from './StagePane';

export { useApplyBrandHeroSeen } from './useApplyBrandHeroSeen';
export { useBrandHeroSeenAt } from './useBrandHeroSeenAt';
export {
    useUnauthShellLayout,
    type UnauthShellLayout,
    type UnauthShellLayoutParams,
    MOBILE_MAX_WIDTH_PX,
} from './useUnauthShellLayout';
