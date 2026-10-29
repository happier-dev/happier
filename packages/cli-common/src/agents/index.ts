export type {
  AgentInstallProgressEvent,
  AgentInstallProgressCallback,
  InstallAgentCliResult,
  AgentCliInstallCommand,
  AgentCliInstallIntent,
  AgentCliInstallMode,
  AgentCliInstallPlan,
  AgentCliInstallPlanResult,
  AgentCliUpdateTarget,
} from './install.js';
export type {
  AgentCliInstallSource,
  AgentCliLatestVersionFacts,
  AgentCliLatestVersionSource,
  AgentCliUpdateFacts,
} from './update.js';
export {
  classifyAgentCliInstall,
  fetchAgentCliLatestVersion,
  resolveAgentCliLatestVersionSource,
  resolveAgentCliNpmPackageName,
} from './update.js';
export {
  installAgentCli,
  installAgentCliForRuntime,
  planAgentCliInstall,
  planAgentCliInstallForRuntime,
  resolvePlatformFromNodePlatform,
} from './install.js';
export type {
  AgentCliJavaScriptRuntimeKind,
  AgentCliCommandResolution,
  AgentCliCommandResolutionOptions,
  AgentCliResolutionSource,
  AgentCliRuntimeDescriptor,
  AgentCliSourcePolicy,
} from './resolution.js';
export type {
  ManagedAgentCliPreparation,
  ManagedAgentCliPreparationErrorCode,
  ManagedAgentCliResolution,
} from './prepareForRuntime.js';
export { prepareAgentCliForRuntime } from './prepareForRuntime.js';
export { resolveManagedToolsRoot } from './managedToolsRoot.js';
export {
  isAgentCliPathRunnable,
  readBackendCliSourcePreferenceForAgent,
  agentCliPathRequiresJavaScriptRuntime,
  readBackendCliSourcePreference,
  readAgentCliOverride,
  readAgentCliOverrideForRuntime,
  resolveAgentCliJavaScriptRuntimeCommand,
  resolveAgentCliJavaScriptRuntimeKind,
  resolveAgentCliCommand,
  resolveAgentCliCommandForRuntime,
  resolveAgentCliManagedCommandPath,
  resolveAgentCliManagedCommandPathForRuntime,
  resolveAgentCliManagedInstallRootForRuntime,
} from './resolution.js';
export { hasAgentCliManagedInstallForRuntime, readManagedAgentCliInstallMetadata, removeAgentCliManagedInstallForRuntime, type ManagedAgentCliAcpMetadata } from './removeManagedInstall.js';
export { managedAcpAccountNamespace, managedAcpInstallId, readManagedAcpInstallNamespace } from './managedAcpInstallIdentity.js';
export { buildManagedUvEnvironment, ensureManagedUvCommand, managedUvInstallDir, managedUvBinPath,
  resolveExistingManagedUvCommand } from './managedUv.js';
export { buildManagedUvAgentEnvironment, installManagedUvAgent, resolveManagedUvAgentCommand,
  readManagedUvAgentMetadata, uninstallManagedUvAgent, type ManagedUvAgentSpec } from './install/managedUvInstall.js';
export {
  ensureManagedJavaScriptRuntimeCommand,
  managedJavaScriptRuntimeBinPath,
  managedJavaScriptRuntimeInstallDir,
  readExplicitJavaScriptRuntimeCommand,
  resolveJavaScriptRuntimePathEntries,
  resolveJavaScriptRuntimeCommand,
  resolveExplicitJavaScriptRuntimeCommand,
  resolveExistingManagedJavaScriptRuntimeCommand,
} from './managedJavaScriptRuntime.js';
export { AgentCliDownloadError, downloadGitHubReleaseAsset } from './downloadGitHubReleaseAsset.js';
export { extractGitHubReleaseAsset } from './extractGitHubReleaseAsset.js';
export { createManagedToolScratchDir } from './createManagedToolScratchDir.js';
export { promoteManagedCurrentInstall } from './promoteManagedCurrentInstall.js';
export {
  extractExactWheelAsset,
  installPypiWheelAsset,
  isPypiWheelAssetVersionSatisfied,
  normalizePypiProjectName,
  PypiWheelAssetError,
  readInstalledPypiWheelAsset,
  resolvePypiWheelAsset,
  resolvePypiWheelAssetHostCompatibility,
  type InstalledPypiWheelAsset,
  type InstalledPypiWheelAssetMetadata,
  type PypiWheelAssetCompatibilityProbe,
  type PypiWheelAssetDiagnosticCode,
  type PypiWheelAssetFetchJson,
  type PypiWheelAssetFetchWheel,
  type PypiWheelAssetHostCompatibility,
  type PypiWheelAssetHostPlatform,
  type PypiWheelAssetLinuxLibc,
  type PypiWheelAssetPlatformMap,
  type PypiWheelAssetResolution,
  type PypiWheelAssetSimpleIndex,
  type PypiWheelAssetSimpleIndexFile,
  type PypiWheelAssetSupportedPlatform,
  type ResolvedPypiWheelAsset,
} from './pypiWheelAsset/index.js';
export {
  buildManagedPnpmEnvironment,
  ensureManagedPnpmCommand,
  managedPnpmBinPath,
  managedPnpmInstallDir,
  readManagedPnpmMinimumReleaseAgeMs,
  resolveExistingPnpmCommand,
} from './managedPnpm.js';
export { resolveHappyHomeDirFromEnvironment } from './resolveHappyHomeDir.js';
export { resolveInstalledJavaScriptTool, type InstalledJavaScriptTool } from './installedJavaScriptTool.js';
export { resolveManagedDependencyCommand, validateManagedDependencyCommand } from './managedDependencyCommand.js';
export type { ManagedDependencyCommand, ManagedDependencyLaunchDeclaration } from './managedDependencyCommand.js';
export { selectManagedDependencyReleaseAsset } from './managedDependencyRelease.js';
export type { ManagedDependencyReleaseDeclaration, ManagedDependencyReleaseAsset } from './managedDependencyRelease.js';
export {
  expandHomeDirPath,
  resolveHomeDirFromEnvironment,
} from '../path/expandHomeDirPath.js';
