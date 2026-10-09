export {
  AIBackendProfileSchema,
  SAVED_SECRET_COLLECTION_MAX_ENTRIES,
  SavedSecretSchema,
  getProfileEnvironmentVariables,
  type AIBackendProfile,
  type SavedSecret,
} from './backendProfileSchema.js';

export {
  EnvVarRequirementSchema,
  EnvironmentVariableSchema,
  type EnvVarRequirement,
  type EnvironmentVariable,
} from './environmentVariables.js';

export {
  SavedSecretReferenceV1Schema,
  SecretReferenceOverlayV1Schema,
  listSecretReferenceOverlayV1BindingNames,
  readSecretReferenceOverlayV1Reference,
  type SavedSecretReferenceV1,
  type SecretReferenceOverlayV1,
} from './secretReferenceOverlayV1.js';

export * from './read.js';
export * from '../launchProfiles/launchProfileArtifactV1.js';
export * from '../launchProfiles/publishLaunchProfile.js';
export * from './v2/schema.js';
export * from './visibilityV1.js';

export {
  DEFAULT_BUILT_IN_BACKEND_PROFILES,
  getBuiltInBackendProfile,
  PROVIDER_MIGRATION_SOURCE_PROFILE_IDS,
} from './builtInBackendProfiles.js';

export { isProfileCompatibleWithAgent, isProfileCompatibleWithBackendTarget } from './profileCompatibility.js';

export {
  LaunchProfileListItemV1Schema,
  mapAiLaunchProfileToListItemV1,
  projectLaunchProfileListV1,
  type LaunchProfileListItemV1,
  type LaunchProfileListProjectionV1,
} from './listProjection.js';

export {
  getRequiredConfigEnvVarNames,
  getMissingRequiredConfigEnvVarNames,
  getRequiredSecretEnvVarNames,
} from './profileRequirements.js';

export {
  getSecretSatisfaction,
  type SecretSatisfactionItem,
  type SecretSatisfactionParams,
  type SecretSatisfactionResult,
  type SecretSatisfactionSource,
} from './secretSatisfaction.js';

export {
  resolveBackendProfile,
  type BackendProfileRefCandidate,
  type ResolveBackendProfileResult,
} from './resolveBackendProfile.js';
