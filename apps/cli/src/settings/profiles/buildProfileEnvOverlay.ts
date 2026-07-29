import {
  buildBackendTargetKey,
  buildBackendTargetKeyV2,
  isLaunchProfileV2,
  readBackendTargetRefV2,
  validateLaunchProfileV2ReservedEnvironment,
  type AIBackendProfile,
  type LaunchProfileV2,
} from '@happier-dev/protocol';

import { isPermissionMode, type PermissionMode } from '@/api/types';
import { expandEnvironmentVariables } from '@/utils/expandEnvVars';

type SecretPromptFn = (promptLabel: string) => Promise<string>;

export type BuildProfileEnvOverlayResult = Readonly<{
  envOverlayRaw: Record<string, string>;
  foregroundSatisfiedSecretRequirementNames: readonly string[];
  permissionModeSeed: PermissionMode | null;
}>;

function readNonEmptyEnv(processEnv: NodeJS.ProcessEnv, name: string): string | null {
  const raw = processEnv[name];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractTemplateVarNames(value: string): string[] {
  const out: string[] = [];
  const re = /\$\{([^}:]+)(?::[-=][^}]*)?\}/g;
  let match: RegExpExecArray | null = null;
  while ((match = re.exec(value))) {
    const varName = typeof match[1] === 'string' ? match[1].trim() : '';
    if (varName) out.push(varName);
  }
  return out;
}

function resolvePermissionModeSeed(profile: AIBackendProfile | LaunchProfileV2, agentId: string): PermissionMode | null {
  const legacyTarget = { kind: 'builtInAgent' as const, agentId };
  const targetKey = buildBackendTargetKey(legacyTarget);
  const targetKeyV2 = buildBackendTargetKeyV2(
    readBackendTargetRefV2(legacyTarget),
  );
  const raw = profile.defaultPermissionModeByTargetKey?.[targetKeyV2]
    ?? profile.defaultPermissionModeByTargetKey?.[targetKey];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return isPermissionMode(trimmed) ? trimmed : null;
}

export async function buildProfileEnvOverlay(params: Readonly<{
  agentId: string;
  profile: AIBackendProfile | LaunchProfileV2;
  processEnv: NodeJS.ProcessEnv;
  promptSecretFn: SecretPromptFn | null;
  reservedEnvironmentVariableNames: ReadonlySet<string>;
  requiredSecretRequirementNamesMissingBinding: ReadonlySet<string>;
}>): Promise<BuildProfileEnvOverlayResult> {
  const requiredConfigMissing: string[] = [];

  const isSlim = isLaunchProfileV2(params.profile);
  if (isSlim) {
    validateLaunchProfileV2ReservedEnvironment(params.profile, params.reservedEnvironmentVariableNames);
  }
  const overlayRaw: Record<string, string> = Object.fromEntries(
    (isSlim ? params.profile.extraEnvironmentVariables : params.profile.environmentVariables)
      .map((entry) => [entry.name, entry.value]),
  );

  const secretRequirements = (params.profile.envVarRequirements ?? [])
    .filter((r) => (r.kind ?? 'secret') === 'secret');

  const configRequirements = (params.profile.envVarRequirements ?? [])
    .filter((r) => (r.kind ?? 'secret') === 'config');

  for (const req of configRequirements) {
    const value = readNonEmptyEnv(params.processEnv, req.name);
    if (value) {
      overlayRaw[req.name] = value;
      continue;
    }
    if (req.required === true) {
      requiredConfigMissing.push(req.name);
    }
  }

  if (requiredConfigMissing.length > 0) {
    throw new Error(
      `Missing required config environment variables for profile "${params.profile.name}": ${requiredConfigMissing.join(', ')}`,
    );
  }

  const foregroundSatisfiedSecretRequirementNames: string[] = [];

  for (const req of secretRequirements) {
    const fromEnv = readNonEmptyEnv(params.processEnv, req.name);
    if (fromEnv) {
      overlayRaw[req.name] = fromEnv;
      foregroundSatisfiedSecretRequirementNames.push(req.name);
      continue;
    }

    if (
      req.required !== true
      || !params.requiredSecretRequirementNamesMissingBinding.has(req.name)
    ) {
      continue;
    }

    const shouldPrompt = typeof params.promptSecretFn === 'function';
    if (shouldPrompt) {
      const entered = await params.promptSecretFn(`${req.name}: `);
      const normalized = typeof entered === 'string' ? entered.trim() : '';
      if (!normalized) {
        throw new Error(`Missing required secret value for ${req.name}.`);
      }
      overlayRaw[req.name] = normalized;
      foregroundSatisfiedSecretRequirementNames.push(req.name);
      continue;
    }

    if (req.required === true) {
      const guidance = [
        `Missing required secret environment variable ${req.name} for profile "${params.profile.name}".`,
        `Provide it via:`,
        `- shell environment (${req.name}=...), or`,
        `- a saved secret binding in the UI, or`,
        `- rerun in an interactive terminal`,
      ].join(' ');
      throw new Error(guidance);
    }
  }

  return {
    envOverlayRaw: overlayRaw,
    foregroundSatisfiedSecretRequirementNames:
      Object.freeze(foregroundSatisfiedSecretRequirementNames),
    permissionModeSeed: resolvePermissionModeSeed(params.profile, params.agentId),
  };
}

export function expandProfileEnvOverlay(params: Readonly<{
  profile: AIBackendProfile | LaunchProfileV2;
  envOverlayRaw: Readonly<Record<string, string>>;
  processEnv: NodeJS.ProcessEnv;
  resolvedEnvironment: Readonly<Record<string, string>>;
}>): Record<string, string> {
  const sourceEnv: NodeJS.ProcessEnv = {
    ...params.processEnv,
    ...params.resolvedEnvironment,
    ...params.envOverlayRaw,
  };
  const envOverlayExpanded = expandEnvironmentVariables(
    params.envOverlayRaw,
    sourceEnv,
    { warnOnUndefined: false },
  );
  const requiredEnvNames = new Set<string>(
    (params.profile.envVarRequirements ?? [])
      .filter((requirement) => requirement.required === true)
      .map((requirement) => requirement.name),
  );
  const missingRequired = [...requiredEnvNames].filter((name) => {
    const value = sourceEnv[name];
    return typeof value !== 'string' || value.trim().length === 0;
  });
  if (missingRequired.length > 0) {
    throw new Error(
      `Profile "${params.profile.name}" is missing required environment values after daemon admission: ${missingRequired.join(', ')}`,
    );
  }
  const keysDependingOnRequired = new Set<string>();
  for (const [key, value] of Object.entries(params.envOverlayRaw)) {
    if (!value.includes('${')) continue;
    for (const refName of extractTemplateVarNames(value)) {
      if (requiredEnvNames.has(refName)) {
        keysDependingOnRequired.add(key);
      }
    }
  }

  const unresolvedKeys: string[] = [];
  for (const key of keysDependingOnRequired) {
    const value = envOverlayExpanded[key];
    if (typeof value === 'string' && value.includes('${')) {
      unresolvedKeys.push(key);
    }
  }

  if (unresolvedKeys.length > 0) {
    throw new Error(
      `Profile "${params.profile.name}" still contains unresolved environment templates after expansion: ${unresolvedKeys.join(', ')}`,
    );
  }
  return envOverlayExpanded;
}
