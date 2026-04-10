export {
    buildBackgroundServiceRepairPlan,
    type BackgroundServiceRepairAction,
    type BackgroundServiceRepairMode,
    type BackgroundServiceRepairPlan,
} from './backgroundServiceRepair.js';
export {
    applyCliUninstallPlan,
    buildCliUninstallPlan,
    cliUninstallPlanRequiresRoot,
    parseUnsupportedInstallSourceFromInstallationId,
    resolveManualUninstallCommandForSource,
    type CliUninstallPlan,
    type CliUninstallResult,
    type UnsupportedInstallSource,
} from './cliUninstall.js';
export {
    buildPathInstallationCleanupPlan,
    type PathInstallationCleanupAction,
    type PathInstallationCleanupPlan,
} from './pathInstallationCleanup.js';
export { uninstallHappierService } from './uninstallHappierService.js';
