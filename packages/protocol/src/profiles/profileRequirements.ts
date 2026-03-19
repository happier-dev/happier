import type { AIBackendProfile } from './backendProfileSchema.js';

export function getRequiredSecretEnvVarNames(profile: Pick<AIBackendProfile, 'envVarRequirements'>): string[] {
  const reqs = profile.envVarRequirements ?? [];
  return reqs
    .filter((r) => (r.kind ?? 'secret') === 'secret' && r.required === true)
    .map((r) => r.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

export function getRequiredConfigEnvVarNames(profile: Pick<AIBackendProfile, 'envVarRequirements'>): string[] {
  const reqs = profile.envVarRequirements ?? [];
  return reqs
    .filter((r) => (r.kind ?? 'secret') === 'config' && r.required === true)
    .map((r) => r.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

export function getMissingRequiredConfigEnvVarNames(
  profile: Pick<AIBackendProfile, 'envVarRequirements'> | null | undefined,
  machineEnvReadyByName: Record<string, boolean | null | undefined> | null | undefined,
): string[] {
  if (!profile) return [];
  return getRequiredConfigEnvVarNames(profile)
    .filter((name) => machineEnvReadyByName?.[name] !== true);
}
