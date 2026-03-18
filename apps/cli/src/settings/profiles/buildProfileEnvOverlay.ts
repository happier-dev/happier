import { buildBackendTargetKey, decryptSecretValueWithKeysV1, getProfileEnvironmentVariables, type AIBackendProfile } from '@happier-dev/protocol';

import { isPermissionMode, type PermissionMode } from '@/api/types';
import { expandEnvironmentVariables } from '@/utils/expandEnvVars';
import type { Credentials } from '@/persistence';
import { readProfilesFromAccountSettings } from '@/settings/profiles/readProfilesFromAccountSettings';
import { deriveSettingsSecretsReadKeysForCredentials } from '@/settings/secrets/settingsSecretsKey';
import { indexSavedSecretsByIdFromAccountSettings } from '@/settings/secrets/indexSavedSecretsById';

type SecretPromptFn = (promptLabel: string) => Promise<string>;

export type BuildProfileEnvOverlayResult = Readonly<{
  profileId: string;
  envOverlayExpanded: Record<string, string>;
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

function readSecretBindingId(params: Readonly<{
  secretBindingsByProfileId: Record<string, Record<string, string>>;
  profileId: string;
  envVarName: string;
}>): string | null {
  const raw = params.secretBindingsByProfileId[params.profileId]?.[params.envVarName];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolvePermissionModeSeed(profile: AIBackendProfile, agentId: string): PermissionMode | null {
  const targetKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId });
  const raw = profile.defaultPermissionModeByTargetKey?.[targetKey];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return isPermissionMode(trimmed) ? trimmed : null;
}

export async function buildProfileEnvOverlay(params: Readonly<{
  agentId: string;
  profile: AIBackendProfile;
  accountSettings: Readonly<Record<string, unknown>>;
  credentials: Credentials;
  processEnv: NodeJS.ProcessEnv;
  promptSecretFn: SecretPromptFn | null;
  startedBy: 'terminal' | 'daemon' | undefined;
}>): Promise<BuildProfileEnvOverlayResult> {
  const requiredConfigMissing: string[] = [];

  const overlayRaw: Record<string, string> = {
    ...getProfileEnvironmentVariables(params.profile),
  };

  const requiredEnvNames = new Set<string>(
    (params.profile.envVarRequirements ?? []).filter((r) => r.required === true).map((r) => r.name),
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

  const { secretBindingsByProfileId } = readProfilesFromAccountSettings(params.accountSettings);
  const savedSecretsById = indexSavedSecretsByIdFromAccountSettings(params.accountSettings);
  const settingsSecretsReadKeys = deriveSettingsSecretsReadKeysForCredentials(params.credentials);

  for (const req of secretRequirements) {
    const fromEnv = readNonEmptyEnv(params.processEnv, req.name);
    if (fromEnv) {
      overlayRaw[req.name] = fromEnv;
      continue;
    }

    const bindingId = readSecretBindingId({
      secretBindingsByProfileId,
      profileId: params.profile.id,
      envVarName: req.name,
    });

    if (bindingId) {
      const container = savedSecretsById.get(bindingId) ?? null;
      const plaintext = decryptSecretValueWithKeysV1(container, settingsSecretsReadKeys);
      if (typeof plaintext === 'string' && plaintext.trim().length > 0) {
        overlayRaw[req.name] = plaintext.trim();
        continue;
      }
    }

    const shouldPrompt = req.required === true && typeof params.promptSecretFn === 'function';
    if (shouldPrompt) {
      const entered = await params.promptSecretFn(`${req.name}: `);
      const normalized = typeof entered === 'string' ? entered.trim() : '';
      if (!normalized) {
        throw new Error(`Missing required secret value for ${req.name}.`);
      }
      overlayRaw[req.name] = normalized;
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

  const sourceEnv: NodeJS.ProcessEnv = { ...params.processEnv, ...overlayRaw };
  const envOverlayExpanded = expandEnvironmentVariables(overlayRaw, sourceEnv, { warnOnUndefined: false });

  const keysDependingOnRequired = new Set<string>();
  for (const [key, value] of Object.entries(overlayRaw)) {
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

  return {
    profileId: params.profile.id,
    envOverlayExpanded,
    permissionModeSeed: resolvePermissionModeSeed(params.profile, params.agentId),
  };
}
