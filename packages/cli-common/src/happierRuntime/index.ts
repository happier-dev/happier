export { discoverHappierInstallations } from './installations/discoverHappierInstallations.js';
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
export {
  isHappierRuntimePathWithinRoot,
  normalizeHappierRuntimePath,
} from './runtimePathMatching.js';
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
  HappierServiceVerification,
  HappierWarningSeverity,
} from './types.js';
