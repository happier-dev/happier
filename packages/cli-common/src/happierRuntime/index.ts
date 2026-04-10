export { discoverHappierInstallations } from './installations/discoverHappierInstallations.js';
export { resolvePreferredHappierCliInstallation } from './installations/resolvePreferredHappierCliInstallation.js';
export { discoverHappierServices } from './services/discoverHappierServices.js';
export {
  resolveDaemonServiceInstallConflictPlan,
} from './daemonInstallConflict.js';
export type {
  DaemonServiceInstallConflictPlan,
  DaemonServiceInstallStrategy,
  DaemonServiceInstallTarget,
} from './daemonInstallConflict.js';
export { buildHappierRuntimeWarnings } from './warnings/buildHappierRuntimeWarnings.js';
export { deriveManagedReleaseChannelInventory } from './deriveManagedReleaseChannelInventory.js';
export { describeBackgroundServiceTargetMode } from './describeBackgroundServiceTargetMode.js';
export type {
  ManagedReleaseChannelInventory,
  ManagedReleaseChannelInventoryEntry,
} from './deriveManagedReleaseChannelInventory.js';
export {
  isHappierRuntimePathWithinRoot,
  normalizeHappierRuntimePath,
} from './runtimePathMatching.js';
export { resolveHappierServiceRuntimeTarget } from './resolveServiceRuntimeTarget.js';
export {
  buildBackgroundServiceRepairPlan,
  buildPathInstallationCleanupPlan,
  buildCliUninstallPlan,
  applyCliUninstallPlan,
  cliUninstallPlanRequiresRoot,
  parseUnsupportedInstallSourceFromInstallationId,
  resolveManualUninstallCommandForSource,
  uninstallHappierService,
} from './maintenance/index.js';
export type {
  BackgroundServiceRepairAction,
  BackgroundServiceRepairMode,
  BackgroundServiceRepairPlan,
  PathInstallationCleanupAction,
  PathInstallationCleanupPlan,
  CliUninstallPlan,
  CliUninstallResult,
  UnsupportedInstallSource,
} from './maintenance/index.js';
export {
  resolveApplicableHappierRuntimeMigrations,
  hasApplicableHappierRuntimeMigrations,
} from './migrations/resolveApplicableHappierRuntimeMigrations.js';
export type {
  HappierRuntimeMigrationEntry,
} from './migrations/catalog.js';
export type {
  HappierActiveInvocation,
  HappierInstallation,
  HappierInstallationInventory,
  HappierInstallationSource,
  HappierRuntimeWarning,
  HappierService,
  HappierServiceBackend,
  HappierServiceInventory,
  HappierServicePlatform,
  HappierServiceRuntimeTarget,
  HappierServiceRuntimeTargetKind,
  HappierServiceTargetMode,
  HappierServiceVerification,
  HappierWarningSeverity,
} from './types.js';
