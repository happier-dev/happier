export {
  AIBackendProfileSchema,
  EnvVarRequirementSchema,
  EnvironmentVariableSchema,
  SavedSecretSchema,
  getProfileEnvironmentVariables,
  type AIBackendProfile,
  type EnvVarRequirement,
  type EnvironmentVariable,
  type SavedSecret,
} from './backendProfileSchema.js';

export {
  DEFAULT_BUILT_IN_BACKEND_PROFILES,
  getBuiltInBackendProfile,
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
