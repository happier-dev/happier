import { isPermissionMode, type Metadata, type PermissionMode } from '@/api/types';
import {
  AcpConfigOptionOverridesV1Schema,
  AcpSessionModeOverrideV1Schema,
  ConnectedServiceBindingsV1Schema,
  ModelOverrideV1Schema,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';
import {
  readAcpSessionModeIntentFromMetadata,
  readSessionMetadataConnectedServiceBindings,
  resolveMetadataStringOverrideV1,
  resolvePermissionIntentFromSessionMetadata,
} from '@happier-dev/agents';
import {
  applyAcpConfigOptionIntentSessionMetadata,
  applyAcpSessionModeIntentSessionMetadata,
  applyDisplayTitleSessionMetadata,
  applyModelIntentSessionMetadata,
  applyPermissionModeIntentSessionMetadata,
} from '@happier-dev/agents/session/state/metadataWriters';

type ForkInheritedSpawnOverrides = {
  permissionMode?: PermissionMode;
  permissionModeUpdatedAt?: number;
  agentModeId?: string;
  agentModeUpdatedAt?: number;
  modelId?: string;
  modelUpdatedAt?: number;
  connectedServices?: ConnectedServiceBindingsV1;
  connectedServicesUpdatedAt?: number;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1;
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
  | 'summary'
  | 'acpSessionModesV1'
  | 'acpSessionModelsV1'
  | 'acpConfigOptionsV1'
  | 'acpSessionModeOverrideV1'
  | 'acpConfigOptionOverridesV1'
  | 'connectedServices'
  | 'connectedServicesUpdatedAt'
> & {
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function readSummaryTitle(metadata: Record<string, unknown> | null | undefined): {
  value: string;
  updatedAt?: number;
} | null {
  const summary = metadata?.summary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null;
  const record = summary as Record<string, unknown>;
  const value = typeof record.text === 'string' ? record.text.trim() : '';
  if (!value) return null;
  return {
    value,
    ...(typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
      ? { updatedAt: record.updatedAt }
      : {}),
  };
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

function readAcpConfigOptionOverrides(metadata: Record<string, unknown> | null | undefined): Array<{
  configId: string;
  value: string | number | boolean | null;
  updatedAt: number;
}> {
  const roots = [
    AcpConfigOptionOverridesV1Schema.safeParse(metadata?.sessionConfigOptionOverridesV1),
    AcpConfigOptionOverridesV1Schema.safeParse(metadata?.acpConfigOptionOverridesV1),
  ].filter((parsed) => parsed.success);
  const latestByConfigId = new Map<string, { configId: string; value: string | number | boolean | null; updatedAt: number }>();
  for (const root of roots) {
    if (!root.success) continue;
    for (const [configIdRaw, entry] of Object.entries(root.data.overrides)) {
      const configId = configIdRaw.trim();
      if (!configId) continue;
      const current = latestByConfigId.get(configId);
      if (current && entry.updatedAt <= current.updatedAt) continue;
      latestByConfigId.set(configId, {
        configId,
        value: entry.value,
        updatedAt: entry.updatedAt,
      });
    }
  }
  return Array.from(latestByConfigId.values());
}

function resolveInheritedConnectedServices(
  metadata: Record<string, unknown> | null | undefined,
  providerId: string | null | undefined,
): ConnectedServiceBindingsV1 | null {
  const explicit = ConnectedServiceBindingsV1Schema.safeParse(metadata?.connectedServices);
  if (explicit.success) return explicit.data;

  if (!isNonEmptyString(providerId)) return null;
  const derivedBindings = readSessionMetadataConnectedServiceBindings(metadata, providerId);
  if (Object.keys(derivedBindings).length === 0) return null;

  const derived = ConnectedServiceBindingsV1Schema.safeParse({
    v: 1,
    bindingsByServiceId: derivedBindings,
  });
  return derived.success ? derived.data : null;
}

export function resolveForkInheritedOverridesFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  providerId?: string | null,
): {
  spawn: ForkInheritedSpawnOverrides;
  metadata: ForkInheritedMetadataOverrides;
} {
  const spawn: ForkInheritedSpawnOverrides = {};
  const metadataOverrides: ForkInheritedMetadataOverrides = {};

  const displayTitle = readSummaryTitle(metadata);
  if (displayTitle?.value) {
    Object.assign(
      metadataOverrides,
      applyDisplayTitleSessionMetadata(metadataOverrides, {
        title: displayTitle.value,
        updatedAt: displayTitle.updatedAt ?? Date.now(),
      }),
    );
  }

  const permission = resolvePermissionIntentFromSessionMetadata(metadata);
  if (permission && isPermissionMode(permission.intent)) {
    spawn.permissionMode = permission.intent;
    spawn.permissionModeUpdatedAt = permission.updatedAt;
    Object.assign(
      metadataOverrides,
      applyPermissionModeIntentSessionMetadata(metadataOverrides, {
        v: 1,
        permissionMode: permission.intent,
        updatedAt: permission.updatedAt,
      }),
    );
  }

  const model = resolveMetadataStringOverrideV1(metadata, 'modelOverrideV1', 'modelId');
  if (model && model.value !== 'default') {
    spawn.modelId = model.value;
    spawn.modelUpdatedAt = model.updatedAt;
  }

  const modelOverrideRaw = ModelOverrideV1Schema.safeParse(metadata?.modelOverrideV1);
  if (modelOverrideRaw.success) {
    Object.assign(
      metadataOverrides,
      applyModelIntentSessionMetadata(metadataOverrides, {
        v: 1,
        modelId: modelOverrideRaw.data.modelId,
        updatedAt: modelOverrideRaw.data.updatedAt,
      }),
    );
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

  const sessionModeOverride = readAcpSessionModeIntentFromMetadata((metadata ?? {}) as Metadata);
  if (sessionModeOverride) {
    Object.assign(
      metadataOverrides,
      applyAcpSessionModeIntentSessionMetadata(metadataOverrides, {
        v: 1,
        modeId: sessionModeOverride.modeId,
        updatedAt: sessionModeOverride.updatedAt,
      }),
    );
    if (isNonEmptyString(sessionModeOverride.modeId)) {
      spawn.agentModeId = sessionModeOverride.modeId;
      spawn.agentModeUpdatedAt = sessionModeOverride.updatedAt;
    }
  }

  for (const entry of readAcpConfigOptionOverrides(metadata)) {
    Object.assign(
      metadataOverrides,
      applyAcpConfigOptionIntentSessionMetadata(metadataOverrides, {
        v: 1,
        configId: entry.configId,
        value: entry.value,
        updatedAt: entry.updatedAt,
      }),
    );
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

  const connectedServices = resolveInheritedConnectedServices(metadata, providerId);
  if (connectedServices) {
    spawn.connectedServices = connectedServices;
    metadataOverrides.connectedServices = connectedServices;

    if (isFiniteNumber(metadata?.connectedServicesUpdatedAt)) {
      spawn.connectedServicesUpdatedAt = metadata.connectedServicesUpdatedAt;
      metadataOverrides.connectedServicesUpdatedAt = metadata.connectedServicesUpdatedAt;
    }
  }

  return { spawn, metadata: metadataOverrides };
}
