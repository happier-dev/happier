import { isPermissionMode, type Metadata, type PermissionMode } from '@/api/types';
import {
  AcpConfigOptionOverridesV1Schema,
  AcpSessionModeOverrideV1Schema,
  ModelOverrideV1Schema,
} from '@happier-dev/protocol';
import { resolveMetadataStringOverrideV1, resolvePermissionIntentFromSessionMetadata } from '@happier-dev/agents';

type ForkInheritedSpawnOverrides = {
  permissionMode?: PermissionMode;
  permissionModeUpdatedAt?: number;
  agentModeId?: string;
  agentModeUpdatedAt?: number;
  modelId?: string;
  modelUpdatedAt?: number;
};

type ForkInheritedMetadataOverrides = Pick<
  Metadata,
  | 'permissionMode'
  | 'permissionModeUpdatedAt'
  | 'modelOverrideV1'
  | 'sessionModesV1'
  | 'sessionModelsV1'
  | 'sessionConfigOptionsV1'
  | 'sessionModeOverrideV1'
  | 'sessionConfigOptionOverridesV1'
  | 'acpSessionModesV1'
  | 'acpSessionModelsV1'
  | 'acpConfigOptionsV1'
  | 'acpSessionModeOverrideV1'
  | 'acpConfigOptionOverridesV1'
>;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function cloneSessionModesState(
  value: unknown,
): Metadata['sessionModesV1'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const state = value as Metadata['sessionModesV1'];
  if (
    state?.v !== 1 ||
    !isNonEmptyString(state.provider) ||
    !isFiniteNumber(state.updatedAt) ||
    !isNonEmptyString(state.currentModeId) ||
    !Array.isArray(state.availableModes)
  ) {
    return undefined;
  }
  return {
    v: 1,
    provider: state.provider,
    updatedAt: state.updatedAt,
    currentModeId: state.currentModeId,
    availableModes: state.availableModes
      .filter((mode) => mode && isNonEmptyString(mode.id) && isNonEmptyString(mode.name))
      .map((mode) => ({
        id: mode.id,
        name: mode.name,
        ...(isNonEmptyString(mode.description) ? { description: mode.description } : {}),
      })),
  };
}

function cloneSessionModelsState(
  value: unknown,
): Metadata['sessionModelsV1'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const state = value as Metadata['sessionModelsV1'];
  if (
    state?.v !== 1 ||
    !isNonEmptyString(state.provider) ||
    !isFiniteNumber(state.updatedAt) ||
    !isNonEmptyString(state.currentModelId) ||
    !Array.isArray(state.availableModels)
  ) {
    return undefined;
  }
  return {
    v: 1,
    provider: state.provider,
    updatedAt: state.updatedAt,
    currentModelId: state.currentModelId,
    availableModels: state.availableModels
      .filter((model) => model && isNonEmptyString(model.id) && isNonEmptyString(model.name))
      .map((model) => ({
        id: model.id,
        name: model.name,
        ...(isNonEmptyString(model.description) ? { description: model.description } : {}),
      })),
  };
}

function isAllowedConfigValue(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function cloneSessionConfigOptionsState(
  value: unknown,
): Metadata['sessionConfigOptionsV1'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const state = value as Metadata['sessionConfigOptionsV1'];
  if (
    state?.v !== 1 ||
    !isNonEmptyString(state.provider) ||
    !isFiniteNumber(state.updatedAt) ||
    !Array.isArray(state.configOptions)
  ) {
    return undefined;
  }

  return {
    v: 1,
    provider: state.provider,
    updatedAt: state.updatedAt,
    configOptions: state.configOptions
      .filter((option) =>
        option &&
        isNonEmptyString(option.id) &&
        isNonEmptyString(option.name) &&
        isNonEmptyString(option.type) &&
        isAllowedConfigValue(option.currentValue),
      )
      .map((option) => ({
        id: option.id,
        name: option.name,
        type: option.type,
        currentValue: option.currentValue,
        ...(isNonEmptyString(option.description) ? { description: option.description } : {}),
        ...(Array.isArray(option.options)
          ? {
            options: option.options
              .filter((choice) => choice && isNonEmptyString(choice.name) && isAllowedConfigValue(choice.value))
              .map((choice) => ({
                value: choice.value,
                name: choice.name,
                ...(isNonEmptyString(choice.description) ? { description: choice.description } : {}),
              })),
          }
          : {}),
      })),
  };
}

export function resolveForkInheritedOverridesFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): {
  spawn: ForkInheritedSpawnOverrides;
  metadata: ForkInheritedMetadataOverrides;
} {
  const spawn: ForkInheritedSpawnOverrides = {};
  const metadataOverrides: ForkInheritedMetadataOverrides = {};

  const permission = resolvePermissionIntentFromSessionMetadata(metadata);
  if (permission && isPermissionMode(permission.intent)) {
    spawn.permissionMode = permission.intent;
    spawn.permissionModeUpdatedAt = permission.updatedAt;
    metadataOverrides.permissionMode = permission.intent;
    metadataOverrides.permissionModeUpdatedAt = permission.updatedAt;
  }

  const model = resolveMetadataStringOverrideV1(metadata, 'modelOverrideV1', 'modelId');
  if (model && model.value !== 'default') {
    spawn.modelId = model.value;
    spawn.modelUpdatedAt = model.updatedAt;
  }

  const modelOverrideRaw = ModelOverrideV1Schema.safeParse(metadata?.modelOverrideV1);
  if (modelOverrideRaw.success) {
    metadataOverrides.modelOverrideV1 = modelOverrideRaw.data;
  }

  const sessionModes = cloneSessionModesState(metadata?.sessionModesV1);
  if (sessionModes) {
    metadataOverrides.sessionModesV1 = sessionModes;
  }

  const sessionModels = cloneSessionModelsState(metadata?.sessionModelsV1);
  if (sessionModels) {
    metadataOverrides.sessionModelsV1 = sessionModels;
  }

  const configOptions = cloneSessionConfigOptionsState(metadata?.sessionConfigOptionsV1);
  if (configOptions) {
    metadataOverrides.sessionConfigOptionsV1 = configOptions;
  }

  const sessionModeOverrideRaw = AcpSessionModeOverrideV1Schema.safeParse(metadata?.sessionModeOverrideV1);
  if (sessionModeOverrideRaw.success) {
    metadataOverrides.sessionModeOverrideV1 = sessionModeOverrideRaw.data;
    if (isNonEmptyString(sessionModeOverrideRaw.data.modeId)) {
      spawn.agentModeId = sessionModeOverrideRaw.data.modeId;
      spawn.agentModeUpdatedAt = sessionModeOverrideRaw.data.updatedAt;
    }
  }

  const sessionConfigOverridesRaw = AcpConfigOptionOverridesV1Schema.safeParse(metadata?.sessionConfigOptionOverridesV1);
  if (sessionConfigOverridesRaw.success) {
    metadataOverrides.sessionConfigOptionOverridesV1 = sessionConfigOverridesRaw.data;
  }

  const acpSessionModes = cloneSessionModesState(metadata?.acpSessionModesV1);
  if (acpSessionModes) {
    metadataOverrides.acpSessionModesV1 = acpSessionModes;
  }

  const acpSessionModels = cloneSessionModelsState(metadata?.acpSessionModelsV1);
  if (acpSessionModels) {
    metadataOverrides.acpSessionModelsV1 = acpSessionModels;
  }

  const acpConfigOptions = cloneSessionConfigOptionsState(metadata?.acpConfigOptionsV1);
  if (acpConfigOptions) {
    metadataOverrides.acpConfigOptionsV1 = acpConfigOptions;
  }

  const acpModeOverrideRaw = AcpSessionModeOverrideV1Schema.safeParse(metadata?.acpSessionModeOverrideV1);
  if (acpModeOverrideRaw.success) {
    metadataOverrides.acpSessionModeOverrideV1 = acpModeOverrideRaw.data;
    if (!spawn.agentModeId && isNonEmptyString(acpModeOverrideRaw.data.modeId)) {
      spawn.agentModeId = acpModeOverrideRaw.data.modeId;
      spawn.agentModeUpdatedAt = acpModeOverrideRaw.data.updatedAt;
    }
  }

  const acpConfigOverridesRaw = AcpConfigOptionOverridesV1Schema.safeParse(metadata?.acpConfigOptionOverridesV1);
  if (acpConfigOverridesRaw.success) {
    metadataOverrides.acpConfigOptionOverridesV1 = acpConfigOverridesRaw.data;
  }

  return { spawn, metadata: metadataOverrides };
}
