export {
  AIBackendProfileSchema,
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

export * from './read.js';
export * from './v2/schema.js';
export * from './visibilityV1.js';

export {
  DEFAULT_BUILT_IN_BACKEND_PROFILES,
  getBuiltInBackendProfile,
  PROVIDER_MIGRATION_SOURCE_PROFILE_IDS,
} from './builtInBackendProfiles.js';

export { isProfileCompatibleWithAgent, isProfileCompatibleWithBackendTarget } from './profileCompatibility.js';

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
