import type {
  VoiceReadinessRequirement,
  VoiceReadinessRole,
  VoiceRuntimePlatform,
} from '@happier-dev/protocol';

import { resolveVoiceDeviceSpeechRolePath } from '@/voice/settings/resolveVoiceProviderAvailability';
import type { VoiceProviderLocalAvailability } from '@/voice/settings/voiceProviderLocalAvailability';

import {
  type VoiceProviderRegistry,
  type VoiceProviderRegistryEntry,
} from './providerRegistry';

export type VoiceReadinessFact = 'ready' | 'missing' | 'installing' | 'incompatible' | 'unknown';
export type VoiceCredentialReadinessFact = VoiceReadinessFact | 'approval_required';
export type VoiceProviderCredentialSourceKind = 'none' | 'savedSecret' | 'connectedAccount';
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
  passiveRuntimeCheckAvailable: boolean;
}>): boolean {
  if (input.readiness.status === 'ready' || input.readiness.status === 'needs_setup') return true;
  if (input.readiness.status === 'unavailable'
    && input.readiness.code === 'runtime_unknown'
    && input.passiveRuntimeCheckAvailable) {
    // Selection is required to expose the passive setup check that can refine
    // this unknown fact; runnable readiness remains unavailable until then.
    return true;
  }
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
  credentialSourceKind?: VoiceProviderCredentialSourceKind | null,
): readonly VoiceReadinessRequirement[] | null {
  const declaredRequirements = !entry.requirementsByMode
    ? entry.requirements
    : !modeId || !Object.prototype.hasOwnProperty.call(entry.requirementsByMode, modeId)
      ? null
      : entry.requirementsByMode[modeId] ?? null;
  if (!declaredRequirements || credentialSourceKind !== 'connectedAccount') {
    return declaredRequirements;
  }
  return declaredRequirements.includes('execution_machine')
    ? declaredRequirements
    : Object.freeze([...declaredRequirements, 'execution_machine']);
}

type ResolveVoiceRoleReadinessInput = Readonly<{
  registry: VoiceProviderRegistry;
  role: VoiceReadinessRole;
  providerId: string | null;
  platform: VoiceRuntimePlatform | 'unknown';
  modeId?: string | null;
  settingsRequirements?: readonly VoiceReadinessRequirement[];
  credentialSourceKind?: VoiceProviderCredentialSourceKind | null;
  localAvailability?: VoiceProviderLocalAvailability;
  passiveSetupUnavailable?: boolean;
  facts: VoiceRoleReadinessFacts;
}>;

function resolveVoiceRoleReadinessInternal(
  input: ResolveVoiceRoleReadinessInput,
  includePassiveSetupRequirements: boolean,
): VoiceRoleReadiness {
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
  const declaredRequirements = input.settingsRequirements
    ? input.credentialSourceKind === 'connectedAccount'
      && !input.settingsRequirements.includes('execution_machine')
      ? Object.freeze([...input.settingsRequirements, 'execution_machine' as const])
      : input.settingsRequirements
    : projectVoiceProviderRequirements(entry, input.modeId, input.credentialSourceKind);
  if (!declaredRequirements) {
    return result(input.role, input.providerId, 'needs_setup', 'provider_mode_unknown', 'open_provider_settings');
  }
  const requirements = includePassiveSetupRequirements
    ? Object.freeze(Array.from(new Set<VoiceReadinessRequirement>([
        ...declaredRequirements,
        ...(entry.providerSettings?.connectedServicesBinding ? ['credential'] as const : []),
      ])))
    : declaredRequirements;
  for (const requirement of requirements) {
    const projected = projectRequirement(
      input.role,
      input.providerId,
      requirement,
      input.facts[FACT_FIELD_BY_REQUIREMENT[requirement]] as VoiceCredentialReadinessFact | undefined,
    );
    if (projected) return projected;
  }
  if (entry.localReadiness?.kind === 'device_speech') {
    const path = resolveVoiceDeviceSpeechRolePath({
      role: input.role,
      platformOs: input.platform,
      local: input.localAvailability,
    });
    if (path && !path.runnable) {
      const code = path.readiness === 'unknown'
        ? 'device_stt_availability_unknown'
        : 'device_stt_unavailable';
      return result(input.role, input.providerId, 'unavailable', code, 'switch_provider');
    }
  }
  return result(input.role, input.providerId, 'ready', 'ready', 'none');
}

export function resolveVoiceRoleReadiness(
  input: ResolveVoiceRoleReadinessInput,
): VoiceRoleReadiness {
  return resolveVoiceRoleReadinessInternal(input, false);
}

export function resolveVoicePassiveSetupReadiness(
  input: ResolveVoiceRoleReadinessInput,
): VoiceRoleReadiness {
  const readiness = resolveVoiceRoleReadinessInternal(input, true);
  return input.passiveSetupUnavailable
    && readiness.code === 'runtime_unknown'
    && readiness.recoveryAction === 'switch_provider'
    ? Object.freeze({ ...readiness, recoveryAction: 'none' as const })
    : readiness;
}
