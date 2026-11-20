/**
 * Public surface for the unified-onboarding split shell.
 *
 * Consumers (PreAuthOnboardingWizardEntry in dev/, route files in remote-dev/)
 * import the top-level `UnauthenticatedSplitShell` plus the storage hooks.
 * Other sub-components remain internal to this folder.
 */

export {
    UnauthenticatedSplitShell,
    type UnauthenticatedSplitShellProps,
} from './UnauthenticatedSplitShell';
export { UnauthenticatedRouteShell } from './UnauthenticatedRouteShell';
export { UnauthenticatedStep, UnauthenticatedStepHeading, type UnauthenticatedStepProps } from './UnauthenticatedStep';

export {
    useUnauthShellLayout,
    type UnauthShellLayout,
    MOBILE_MAX_WIDTH_PX,
} from './useUnauthShellLayout';
