export {
  FIRST_PARTY_RUNTIME_KINDS,
  isFirstPartyRuntimeKind,
} from './runtimeKinds.js';
export type { FirstPartyRuntimeKind } from './runtimeKinds.js';

export {
  FIRST_PARTY_COMPONENT_IDS,
  firstPartyComponentCatalog,
  getFirstPartyComponentCatalogEntry,
  listFirstPartyComponentCatalogEntries,
  resolveFirstPartyComponentPublicReleaseVariant,
} from './componentCatalog.js';
export type {
  FirstPartyComponentCatalogEntry,
  FirstPartyComponentId,
  FirstPartyComponentPublicReleaseVariant,
} from './componentCatalog.js';

export {
  assertValidFirstPartyVersionId,
  FIRST_PARTY_INSTALL_HOME_ENV_KEY,
  InvalidFirstPartyVersionIdError,
  resolveFirstPartyInstallHomeDir,
  resolveFirstPartyInstallLayout,
  resolveFirstPartyVersionInstallPath,
} from './installLayout.js';
export type { FirstPartyInstallLayout } from './installLayout.js';

export { resolveRetainedVersionIds } from './retentionPolicy.js';
export type { FirstPartyRetentionResolution } from './retentionPolicy.js';

export { resolveInstalledFirstPartyComponentPaths } from './resolveInstalledComponentPaths.js';
export type { InstalledFirstPartyComponentPaths } from './resolveInstalledComponentPaths.js';
export { ensureInstalledFirstPartyComponent } from './ensureInstalledFirstPartyComponent.js';
export { resolveJunctionFreeCurrentPath } from './resolveJunctionFreeCurrentPath.js';
export {
  FirstPartyVersionRootIdentityError,
  resolveFirstPartyVersionRootIdentity,
} from './resolveVersionRootIdentity.js';
export type {
  FirstPartyVersionRootIdentity,
  FirstPartyVersionRootIdentityErrorCode,
} from './resolveVersionRootIdentity.js';
export {
  readInstalledVersionMarkers,
  readInstalledVersionMarkersSync,
  writeInstalledVersionMarker,
} from './versionMarkers.js';
export {
  readDefaultManagedReleaseChannel,
  readDefaultManagedReleaseChannelSync,
  resolveDefaultManagedReleaseChannelStatePath,
  writeDefaultManagedReleaseChannel,
} from './defaultReleaseChannelState.js';
export {
  readHappierCliChoiceSync,
  resolveHappierCliChoiceStatePath,
  writeHappierCliChoice,
} from './happierCliChoice.js';
export type { HappierCliChoice } from './happierCliChoice.js';
export { describeHappierCliOrigin } from './happierCliOrigin.js';
export type { HappierCliOrigin } from './happierCliOrigin.js';
export {
  DAEMON_SERVICE_MANAGED_CLI_RELEASE_CHANNEL_ENV_KEYS,
  resolveManagedCliReleaseChannel,
  resolveManagedCliReleaseChannelSync,
  resolveManagedCliToolNameForRing,
  STANDARD_MANAGED_CLI_RELEASE_CHANNEL_ENV_KEYS,
} from './resolveManagedCliReleaseChannel.js';
export type {
  ManagedCliReleaseChannelMarkerFallback,
  ManagedCliReleaseChannelSource,
  ManagedCliToolName,
  ResolvedManagedCliReleaseChannel,
} from './resolveManagedCliReleaseChannel.js';
export {
  prepareFirstPartyComponentPayloadFromGitHubRelease,
  resolveFirstPartyComponentRelease,
} from './prepareFirstPartyComponentPayloadFromGitHubRelease.js';
export type { ResolvedFirstPartyComponentRelease } from './prepareFirstPartyComponentPayloadFromGitHubRelease.js';
export type {
  FirstPartyReleaseArtifactSource,
  PreparedFirstPartyComponentPayload,
} from './prepareFirstPartyComponentPayloadFromGitHubRelease.js';
export { prepareMutagenEnginePayloadFromGitHubRelease } from './prepareMutagenEnginePayloadFromGitHubRelease.js';
export {
  MUTAGEN_ENGINE_ARTIFACT_FORMAT,
  MUTAGEN_ENGINE_ARTIFACT_SCHEMA_VERSION,
  MUTAGEN_ENGINE_CONTENT_HASH_ALGORITHM,
  MUTAGEN_ENGINE_FORK_BRANCH,
  MUTAGEN_ENGINE_FORK_RELEASE_COMMIT,
  MUTAGEN_ENGINE_FORK_REMOTE,
  MUTAGEN_ENGINE_FORK_SOURCE_BASE_COMMIT,
  MUTAGEN_ENGINE_GO_DISTRIBUTION_SHA256,
  MUTAGEN_ENGINE_GO_VERSION,
  MUTAGEN_ENGINE_PROTOCOL_EPOCH,
  MUTAGEN_ENGINE_SUPPORTED_TARGETS,
  MUTAGEN_ENGINE_TRANSPORT_SPIKE_COMMIT,
  MUTAGEN_ENGINE_UPSTREAM_COMMIT,
  MUTAGEN_ENGINE_UPSTREAM_TAG,
  MUTAGEN_ENGINE_VERSION,
  MutagenEngineArtifactError,
  assertMutagenEngineArtifactManifest,
  assertMutagenEngineArtifactPayload,
  resolveMutagenEngineArtifactPaths,
  resolveMutagenEngineArtifactTarget,
  resolveMutagenEngineDataLayout,
  resolveMutagenEngineReleaseAssetBundle,
  resolveMutagenEngineReleaseTag,
} from './mutagenEngineArtifact.js';
export type {
  MutagenEngineArtifactErrorCode,
  MutagenEngineArtifactManifest,
  MutagenEngineArtifactPaths,
  MutagenEngineArtifactTarget,
  MutagenEngineDataLayout,
  MutagenEngineReleaseAsset,
  MutagenEngineReleaseAssetBundle,
  MutagenEngineWatcher,
} from './mutagenEngineArtifact.js';
export { extractReleasePayloadRootFromArchive } from './extractReleasePayloadRootFromArchive.js';
export { removeRuntimePayloadPath } from './copyRuntimePayloadTree.js';
export {
  readEmbeddedPublicReleaseRingFromPath,
  writeEmbeddedPublicReleaseRingMarker,
} from './embeddedPublicReleaseRingMarker.js';

export { listInstalledVersionIdsNewestFirst } from './listInstalledVersionIdsNewestFirst.js';
export { installVersionedPayload } from './installVersionedPayload.js';
export { promoteVersionedPayload } from './promoteVersionedPayload.js';
export type { FirstPartyPayloadPromotionResult } from './promoteVersionedPayload.js';
export { FirstPartyPayloadStateRestoreIncompleteError } from './restoreInstalledPayloadState.js';
export {
  FirstPartyPayloadMutationLockError,
  withFirstPartyActivationLock,
  withFirstPartyPayloadMutationLock,
} from './withFirstPartyPayloadMutationLock.js';
export {
  ManagedCliUpdateError,
  readLastCliUpdateResult,
  runManagedCliUpdate,
  watchLastCliUpdateResult,
} from './runManagedCliUpdate.js';
export type {
  ManagedCliUpdateParams,
  ManagedCliUpdateRestart,
  ManagedCliUpdateResult,
} from './runManagedCliUpdate.js';
export {
  formatPinnedDaemonServiceRestartCommand,
  planServiceDaemonsRestartAfterCliUpdate,
} from './serviceDaemonsToRestartAfterCliUpdate.js';
export type {
  ServiceDaemonBeforeCliUpdate,
  ServiceDaemonsRestartAfterCliUpdatePlan,
} from './serviceDaemonsToRestartAfterCliUpdate.js';
export { FirstPartyVersionIdConflictError } from './copyRuntimePayloadTree.js';

export { pruneRetainedVersions } from './pruneRetainedVersions.js';
export type { FirstPartyPruneRetainedVersionsResult } from './pruneRetainedVersions.js';

export { uninstallManagedFirstPartyComponent } from './uninstallManagedFirstPartyComponent.js';
export type { UninstallManagedFirstPartyComponentResult } from './uninstallManagedFirstPartyComponent.js';

export { syncInstalledFirstPartyShims } from './syncInstalledFirstPartyShims.js';
export type { SyncInstalledFirstPartyShimsResult } from './syncInstalledFirstPartyShims.js';
export { resolveDesiredShimTargets } from './resolveDesiredShimTargets.js';
export type { DesiredFirstPartyShimTarget } from './resolveDesiredShimTargets.js';
export {
  checkRelayRuntimeHealth,
  normalizeRelayRuntimeStatus,
  resolveRelayRuntimeDefaults,
} from './relayRuntime.js';
export type {
  RelayRuntimeDefaults,
  RelayRuntimeHealthResult,
  RelayRuntimeNormalizedStatus,
} from './relayRuntime.js';

export {
  applyEnvOverridesToEnvText,
  appendPrismaSqliteConnectionParams,
  DEFAULT_PRISMA_SQLITE_BUSY_TIMEOUT_MS,
  DEFAULT_SERVER_LIGHT_SQLITE_CONNECTION_LIMIT,
  parseEnvText,
  renderPrismaCompatibleSqliteDatabaseUrl,
  renderSelfHostServerEnvText,
  mergeSelfHostServerEnvText,
  resolveSelfHostServerMigrationPlan,
  resolveServerMigrationsEnabled,
  resolvePrismaSqliteDatabaseUrlOptionsFromEnv,
  resolveServerLightSqliteDatabaseUrlOptionsFromEnv,
} from './selfHostServerEnv.js';
export type { PrismaSqliteDatabaseUrlOptions, SelfHostServerMigrationPlan } from './selfHostServerEnv.js';

export {
  SERVER_RUNTIME_DIRECTORY_ENTRY_NAMES,
  assertPackagedServerRuntimeClosure,
  relocateServerRuntimeArtifactClosure,
  resolveManagedServerRuntimePaths,
  resolveServerRuntimeExecutableNames,
  resolveServerRuntimePrismaEngineFileName,
  resolveServerRuntimePayloadRootFromBinaryPath,
} from './serverRuntimeArtifactLayout.js';
export { readSqliteMigrationCatalog } from './sqliteMigrationCatalog.js';
export type { SqliteMigrationCatalogEntry } from './sqliteMigrationCatalog.js';
export {
  inspectPersonalHomeSqliteMigrationFrontier,
  migrateStagedPersonalHomeSqliteDatabase,
  PersonalHomeSqliteMigrationFrontierError,
  resolveInstalledPersonalHomeSqliteMigrationPaths,
} from './personalHome/stagedMigrationFrontier.js';
export type {
  PersonalHomeMigrationProcessRunner,
  PersonalHomeSqliteMigrationFrontierErrorCode,
  PersonalHomeSqliteMigrationFrontierFacts,
  PersonalHomeSqliteMigrationRecord,
} from './personalHome/stagedMigrationFrontier.js';

export {
  installOrUpdateRelayRuntimeLocal,
  PERSONAL_HOME_UPDATER_FORWARD_RECOVERY_CAPABILITY,
  PERSONAL_HOME_UPDATER_FORWARD_RECOVERY_CAPABILITY_ENV,
  RELAY_RUNTIME_IRREVERSIBLE_MIGRATIONS,
  uninstallRelayRuntimePayloadLocal,
  waitForRelayRuntimeStartupReceipt,
} from './relayRuntimeInstall.js';

export {
  PERSONAL_HOME_SIGNUP_POLICY_ENV_KEY,
  PERSONAL_HOME_SIGNUP_CLOSURE_ENV,
  PersonalHomeSignupClosureError,
  readEffectivePersonalHomeSignupPolicy,
  applyPersonalHomeSignupClosure,
  assertPersonalHomeSignupClosed,
  applyAndVerifyPersonalHomeSignupClosure,
} from './personalHomeSignupPolicy.js';
export type { PersonalHomeSignupPolicyState } from './personalHomeSignupPolicy.js';

export { resolvePersonalHomeRuntimeLayout, resolvePersonalHomeRuntimeArtifactPaths, assertLayoutPath } from './personalHome/layout.js';
export type { PersonalHomeRuntimeLayout, PersonalHomeRuntimeArtifactPaths } from './personalHome/layout.js';
export { replacePersonalHomeFileDurably } from './personalHome/durableFile.js';
export {
  assertPersonalHomeBootAdmission,
  PersonalHomeBootAdmissionError,
} from './personalHome/bootAdmission.js';
export type { PersonalHomeBootAdmissionBlockReason } from './personalHome/bootAdmission.js';
export {
  DEFAULT_PERSONAL_HOME_PORT,
  DEFAULT_PERSONAL_HOME_TEAM_NAME,
  assertPersonalHomeEnvironmentKeys,
  createPersonalHomeRuntimeSpec,
  parsePersonalHomeRuntimePurpose,
  renderPersonalHomeRuntimeEnv,
  resolvePersonalHomeRuntimeSpec,
} from './personalHome/personalHomeRuntimeSpec.js';
export type {
  ManagedRelayPurpose,
  PersonalHomeRuntimeEnvironment,
  PersonalHomeRuntimeLayoutFacts,
  PersonalHomeRuntimeSpec,
} from './personalHome/personalHomeRuntimeSpec.js';
export {
  resolveManagedServerLightPathEnvValue,
  resolvePersonalHomePrivateFilesDir,
  resolvePersonalHomeSqliteDatabasePath,
} from './personalHome/pathResolvers.js';
export { runPersonalHomeBootstrap } from './personalHome/bootstrap.js';
export type { PersonalHomeBootstrapDeps, PersonalHomeBootstrapResult } from './personalHome/bootstrap.js';
export { PersonalHomeCredentialsUnverifiedError } from './personalHome/bootstrap.js';
export {
  runPersonalHomeBootstrapFromSystemTasks,
  PersonalHomeDescriptorUnverifiedError,
  PersonalHomeExistingRuntimeConflictError,
} from './personalHome/bootstrapSystemTasks.js';
export type {
  PersonalHomeBootstrapSystemTaskDeps,
  PersonalHomeBootstrapTaskKind,
  PersonalHomeBootstrapTaskOptions,
  PersonalHomeEndpointSnapshot,
  PersonalHomeExistingRuntimeDisposition,
} from './personalHome/bootstrapSystemTasks.js';
export {
  PERSONAL_HOME_SERVER_ARTIFACT_CAPABILITY_FILE,
  PersonalHomeArtifactAdmissionError,
  assertPersonalHomeServerArtifactCapability,
  writePersonalHomeServerArtifactCapability,
} from './personalHome/artifactContract.js';
export { PersonalHomeOperationsError } from './personalHome/operations.js';
export {
  assertPersonalHomeRelocationDestinationAllowsMaintenance,
  createPersonalHomeRelocationDestinationOwner,
  parsePersonalHomeRelocationDestinationFacts,
  PersonalHomeRelocationDestinationError,
} from './personalHome/relocationDestination.js';
export type { PersonalHomeRelocationDestinationMaintenanceAdmission } from './personalHome/relocationDestination.js';
export { PersonalHomeArchiveError } from './personalHome/archive.js';
export { PersonalHomeRestoreError } from './personalHome/restore.js';
export {
  parsePersonalHomeAuthenticatedReadiness,
  readPersonalHomeStartupReadiness,
  removePersonalHomeStartupReadiness,
} from './personalHome/readiness.js';
export type { PersonalHomeAuthenticatedReadiness } from './personalHome/readiness.js';
export {
  attestPersonalHomeRelocationDestinationWithServerCommand,
  createCanonicalPersonalHomeOperations,
  createCanonicalPersonalHomeRelocationDestinationOwner,
  materializePersonalHomeRelocationEndpointWithServerCommand,
} from './personalHome/productionAdapters.js';
export type {
  PersonalHomeOperations,
  PersonalHomeOperationContext,
  PersonalHomeIdentityFacts,
  PersonalHomeInspection,
  PersonalHomeBackupOperationInput,
  PersonalHomeBackupVerification,
  PersonalHomeRestoreOperationInput,
  PersonalHomeEraseOperationInput,
  PersonalHomeEraseOperationResult,
  PersonalHomeEraseConfirmationFacts,
  PersonalHomeRelocateInput,
  PersonalHomeBackupOperationResult,
  PersonalHomeRestoreOperationResult,
  PersonalHomeRelocateOperationResult,
} from './personalHome/operations.js';
export type { PersonalHomeRestoreRecoveryFacts, PersonalHomeRestoreRecoveryResult, PersonalHomeRestoreFinalizationResult } from './personalHome/restore.js';
export type {
  PersonalHomeRelocationDestinationOwner,
  PersonalHomeRelocationDestinationDeps,
  PersonalHomeRelocationDestinationFacts,
  PersonalHomeRelocationDestinationAbsence,
  PersonalHomeRelocationDestinationStatus,
  PersonalHomeRelocationDestinationStageInput,
  PersonalHomeRelocationDestinationCommitInput,
} from './personalHome/relocationDestination.js';
export {
  coordinatePersonalHomeRelocation,
  PersonalHomeRelocationTransferCleanupError,
} from './personalHome/relocationCoordinator.js';
export {
  cleanupPersonalHomeRelocationUpload,
  consumePersonalHomeRelocationUpload,
  hasPersonalHomeRelocationUploadReservation,
  preparePersonalHomeRelocationUpload,
} from './personalHome/relocationTransfer.js';
export type { PersonalHomeRelocationUpload } from './personalHome/relocationTransfer.js';
export type {
  PersonalHomeRelocationSourceCoordinatorParams,
  PersonalHomeRelocationSourceResult,
} from './personalHome/relocationCoordinator.js';
export {
  HAPPIER_DESKTOP_PATH_MARKER_LINE,
  HAPPIER_DESKTOP_WINDOWS_PATH_MOVES_VARIABLE,
  HAPPIER_DESKTOP_WINDOWS_PATH_PROVENANCE_VARIABLE,
  ensureHappierCliPathExposure,
  parseWindowsUserEnvironmentSnapshot,
  planWindowsUserPathExposure,
  planWindowsUserPathRemoval,
  removeHappierCliPathExposure,
  renderHappierCliPathExportLine,
  resolveForeignHappierCli,
  resolveHappierCliSearchPath,
  resolveHappierCliShellProfilePlan,
  resolveTerminalHappierCli,
} from './ensureHappierCliPathExposure.js';
export type {
  HappierCliPathExposureResult,
  HappierCliPathRemovalResult,
  TerminalHappierCli,
} from './ensureHappierCliPathExposure.js';
export { FirstPartyAcquisitionError, readAcquisitionFailureCause, redactAcquisitionDiagnostic } from './acquisitionProgress.js';
export type { FirstPartyAcquisitionOptions } from './acquisitionProgress.js';
export * from './resolveSelfContainedCliRuntimeRoot.js';
export * from './runtimePaths.js';
