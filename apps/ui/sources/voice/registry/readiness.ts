import type {
  VoiceReadinessRequirement,
  VoiceReadinessRole,
  VoiceRuntimePlatform,
} from '@happier-dev/protocol';

import type { VoiceProviderRegistry, VoiceProviderRegistryEntry } from './providerRegistry';

export type VoiceReadinessFact = 'ready' | 'missing' | 'installing' | 'incompatible' | 'unknown';
export type VoiceCredentialReadinessFact = VoiceReadinessFact | 'approval_required';
export type VoiceSettingsReadinessFact =
  | 'ready'
  | 'missing_required_setting'
  | 'needs_migration'
  | 'invalid'
  | 'unsupported_version'
  | 'unknown';

export type VoiceRoleReadinessFacts = Readonly<{
  settings: VoiceSettingsReadinessFact;
  serverFeature?: VoiceReadinessFact;
  executionMachine?: VoiceReadinessFact;
  credential?: VoiceCredentialReadinessFact;
  /** Canonical endpoint-policy fact, including exact-origin + selected-machine-bound consent. */
  endpoint?: VoiceReadinessFact;
  runtime?: VoiceReadinessFact;
  model?: VoiceReadinessFact;
}>;

export type VoiceRoleReadiness = Readonly<{
  role: VoiceReadinessRole;
  providerId: string | null;
  status: 'ready' | 'needs_setup' | 'unavailable' | 'installing' | 'incompatible';
  code: string;
  reasonKey: string;
  recoveryAction: 'none' | 'select_provider' | 'open_provider_settings' | 'select_execution_machine' | 'configure_credential' | 'review_credential_access' | 'configure_endpoint' | 'install_model' | 'switch_provider';
}>;

export function isVoiceRoleSelectableForConfiguration(input: Readonly<{
  readiness: VoiceRoleReadiness;
  credentialConfigurationAvailable: boolean;
}>): boolean {
  if (input.readiness.status === 'ready' || input.readiness.status === 'needs_setup') return true;
  return input.readiness.status === 'unavailable'
    && input.readiness.recoveryAction === 'configure_credential'
    && input.credentialConfigurationAvailable;
}

function result(
  role: VoiceReadinessRole,
  providerId: string | null,
  status: VoiceRoleReadiness['status'],
  code: string,
  recoveryAction: VoiceRoleReadiness['recoveryAction'],
): VoiceRoleReadiness {
  return Object.freeze({
    role,
    providerId,
    status,
    code,
    reasonKey: `voice.readiness.${code}`,
    recoveryAction,
  });
}

const FACT_FIELD_BY_REQUIREMENT = {
  server_feature: 'serverFeature',
  execution_machine: 'executionMachine',
  credential: 'credential',
  endpoint: 'endpoint',
  runtime: 'runtime',
  model: 'model',
} as const satisfies Record<VoiceReadinessRequirement, keyof VoiceRoleReadinessFacts>;

const RECOVERY_BY_REQUIREMENT = {
  server_feature: 'switch_provider',
  execution_machine: 'select_execution_machine',
  credential: 'configure_credential',
  endpoint: 'configure_endpoint',
  runtime: 'switch_provider',
  model: 'install_model',
} as const satisfies Record<VoiceReadinessRequirement, VoiceRoleReadiness['recoveryAction']>;

function projectRequirement(
  role: VoiceReadinessRole,
  providerId: string,
  requirement: VoiceReadinessRequirement,
  fact: VoiceCredentialReadinessFact | undefined,
): VoiceRoleReadiness | null {
  if (fact === 'ready') return null;
  if (requirement === 'credential' && fact === 'approval_required') {
    return result(role, providerId, 'needs_setup', 'credential_approval_required', 'review_credential_access');
  }
  if (fact === 'installing') {
    return result(role, providerId, 'installing', `${requirement}_installing`, RECOVERY_BY_REQUIREMENT[requirement]);
  }
  if (fact === 'missing') {
    if (requirement === 'server_feature') {
      return result(role, providerId, 'unavailable', 'server_feature_disabled', RECOVERY_BY_REQUIREMENT[requirement]);
    }
    return result(role, providerId, 'needs_setup', `${requirement}_missing`, RECOVERY_BY_REQUIREMENT[requirement]);
  }
  if (fact === 'incompatible') {
    return result(role, providerId, 'incompatible', `${requirement}_incompatible`, RECOVERY_BY_REQUIREMENT[requirement]);
  }
  return result(role, providerId, 'unavailable', `${requirement}_unknown`, RECOVERY_BY_REQUIREMENT[requirement]);
}

/** Sole owner for descriptor and selected-mode requirement projection. */
export function projectVoiceProviderRequirements(
  entry: Pick<VoiceProviderRegistryEntry, 'requirements' | 'requirementsByMode'>,
  modeId: string | null | undefined,
): readonly VoiceReadinessRequirement[] | null {
  if (!entry.requirementsByMode) return entry.requirements;
  if (!modeId || !Object.prototype.hasOwnProperty.call(entry.requirementsByMode, modeId)) return null;
  return entry.requirementsByMode[modeId] ?? null;
}

export function resolveVoiceRoleReadiness(input: Readonly<{
  registry: VoiceProviderRegistry;
  role: VoiceReadinessRole;
  providerId: string | null;
  platform: VoiceRuntimePlatform | 'unknown';
  modeId?: string | null;
  facts: VoiceRoleReadinessFacts;
}>): VoiceRoleReadiness {
  if (!input.providerId) {
    return result(input.role, null, 'needs_setup', 'provider_unselected', 'select_provider');
  }
  const entry = input.registry.get(input.providerId);
  if (!entry) {
    return result(input.role, input.providerId, 'unavailable', 'contribution_unavailable', 'select_provider');
  }
  if (!entry.roles.includes(input.role)) {
    return result(input.role, input.providerId, 'incompatible', 'role_unsupported', 'switch_provider');
  }
  if (input.platform === 'unknown'
    || (entry.supportedPlatforms && !entry.supportedPlatforms.includes(input.platform))) {
    return result(input.role, input.providerId, 'incompatible', 'platform_unsupported', 'switch_provider');
  }
  if (input.facts.settings !== 'ready') {
    if (input.facts.settings === 'unsupported_version') {
      return result(input.role, input.providerId, 'incompatible', 'settings_unsupported_version', 'open_provider_settings');
    }
    if (input.facts.settings === 'unknown') {
      return result(input.role, input.providerId, 'unavailable', 'settings_unknown', 'open_provider_settings');
    }
    return result(input.role, input.providerId, 'needs_setup', `settings_${input.facts.settings}`, 'open_provider_settings');
  }
  const requirements = projectVoiceProviderRequirements(entry, input.modeId);
  if (!requirements) {
    return result(input.role, input.providerId, 'needs_setup', 'provider_mode_unknown', 'open_provider_settings');
  }
  for (const requirement of requirements) {
    const projected = projectRequirement(
      input.role,
      input.providerId,
      requirement,
      input.facts[FACT_FIELD_BY_REQUIREMENT[requirement]] as VoiceCredentialReadinessFact | undefined,
    );
    if (projected) return projected;
  }
  return result(input.role, input.providerId, 'ready', 'ready', 'none');
}
