/**
 * `@happier-dev/voice-modelpacks` — host-agnostic voice model-pack installer.
 *
 * The installer ALGORITHM home. Protocol owns schema + catalog + path-safety;
 * this package owns the shared install/download/verify/atomic-swap core, the URL
 * policy, the integrity gate, and the canonical manifest-URL resolver. All
 * filesystem/network/digest effects are injected by the host
 * ({@link ModelPackInstallerHost}); nothing here imports `node:*` or Expo FS at
 * module scope.
 */

export {
  deriveModelPackStagingPlan,
  installModelPackWithHost,
  ModelPackInstallError,
  type ModelPackCoreProgress,
  type ModelPackDownloadRequest,
  type ModelPackDownloadStream,
  type ModelPackHasher,
  type ModelPackInstallCoreResult,
  type ModelPackInstallSourceBinding,
  type ModelPackInstallerHost,
  type ModelPackStagingPlan,
  type ModelPackStagingHandle,
  type ModelPackPromotionTransaction,
} from './installerCore.js';
export {
  isLegacyModelPackPromotionIntent,
  MODEL_PACK_PROMOTION_INTENT_MAX_BYTES,
  parseModelPackPromotionIntentV1,
  type ModelPackDurableRecoveryRecord,
  type ModelPackPromotionIntentV1,
  type ModelPackPromotionPriorInstallV1,
} from './promotionRecovery.js';

export {
  assertModelPackUrlAllowed,
  assertManifestUrlsAllowed,
  assertModelPackResolvedAddressesAllowed,
  ModelPackUrlPolicyError,
  type ModelPackUrlPolicy,
} from './urlPolicy.js';

export { assertManifestIntegrityVerifiable, ModelPackIntegrityError } from './integrityGate.js';

export {
  verifyInstalledModelPackWithHost,
  InstalledModelPackIntegrityError,
  type InstalledModelPackIntegrityHost,
} from './installedIntegrity.js';

export { defaultModelPackManifestUrl, resolveModelPackManifestUrl } from './manifestUrl.js';

export { createSha256Hasher } from './sha256.js';

export {
  normalizeVoiceModelPackSha256DigestV1,
  voiceModelPackSha256DigestsEqualV1,
} from './sha256Digest.js';

export {
  parseVoiceModelPackArtifactBindingV1,
  voiceModelPackArtifactBindingsEqualV1,
  type VoiceModelPackArtifactBindingV1,
} from './artifactBinding.js';

export {
  decideInstalledVoiceModelPackLifecycleV1,
  type InstalledVoiceModelPackLifecycleDecisionV1,
  type InstalledVoiceModelPackMetadataV1,
  type InstalledVoiceModelPackSourceStateV1,
} from './lifecycle.js';

export {
  admitVoiceModelPackContributionV1,
  assertVoiceModelPackStoredIdentityV1,
  buildVoiceModelPackInstallUrlPolicyV1,
  deriveVoiceModelPackLicenseTextDigestV1,
  deriveVoiceModelPackManifestDigestV1,
  deriveVoiceModelPackDirectoryKeyV1,
  type EffectiveVoiceModelPackDescriptorV1,
  type InstalledPluginVoiceModelPackSourceV1,
  type VoiceModelPackHostCapabilitiesV1,
  type VoiceModelPackIdentityV1,
  type VoiceModelPackLicenseAcceptanceV1,
  type VoiceModelPackLicenseScopeV1,
} from './publicCatalog.js';

export {
  DEFAULT_VOICE_MODEL_PACK_RESOURCE_POLICY_V1,
  assertVoiceModelPackDeclaredResourcesV1,
  type VoiceModelPackResourcePolicyV1,
} from './resourcePolicy.js';
