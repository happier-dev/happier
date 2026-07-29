import { isPermissionMode, type Metadata, type PermissionMode } from '@/api/types';
import {
  AcpConfigOptionOverridesV1Schema,
  AcpSessionModeOverrideV1Schema,
  ConnectedServiceBindingsV1Schema,
  SessionModelSelectionResolutionError,
  buildBackendTargetKeyV2,
  readSessionMcpSelectionV1FromMetadata,
  sessionModelSelectionIntentRequiresAgentTargetV1,
  type AcpConfigOptionOverridesV1,
  type BackendTargetRefV2,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceMaterializationIdentityV1,
  type SessionMcpSelectionV1,
  type SessionModelSelectionV1,
  type SessionProviderBindingMetadataV1,
} from '@happier-dev/protocol';
import { readPersistedProviderResumeState } from '@/providers/lifecycle/readPersistedResumeSelection';
import {
  readAcpSessionModeIntentFromMetadata,
  readSessionMetadataConnectedServiceBindings,
  resolveModelSelectionIntentFromSessionMetadata,
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
  modelSelection?: SessionModelSelectionV1;
  providerBindingMetadataV1?: SessionProviderBindingMetadataV1;
  sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
  connectedServices?: ConnectedServiceBindingsV1;
  connectedServicesUpdatedAt?: number;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1;
};

type SessionAgentSpawnInheritedSpawnOverrides = ForkInheritedSpawnOverrides & {
  mcpSelection?: SessionMcpSelectionV1;
  profileId?: string;
};

type ForkInheritedMetadataOverrides = Pick<
  Metadata,
  | 'permissionMode'
  | 'permissionModeUpdatedAt'
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
  modelSelectionIntentV1?: unknown;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1;
};

type InheritedSessionMetadataFieldSet = Readonly<{
  displayTitleMetadata: boolean;
  permissionIntent: boolean;
  modelIntent: boolean;
  sessionModeCatalogMetadata: boolean;
  sessionModelCatalogMetadata: boolean;
  sessionConfigCatalogMetadata: boolean;
  agentModeIntent: boolean;
  configOptionIntentMetadata: boolean;
  configOptionIntentSpawn: boolean;
  acpSessionModeCatalogMetadata: boolean;
  acpSessionModelCatalogMetadata: boolean;
  acpConfigCatalogMetadata: boolean;
  connectedServices: boolean;
  mcpSelectionSpawn: boolean;
  profileIdSpawn: boolean;
}>;

const FORK_INHERITED_METADATA_FIELDS: InheritedSessionMetadataFieldSet = {
  displayTitleMetadata: true,
  permissionIntent: true,
  modelIntent: true,
  sessionModeCatalogMetadata: true,
  sessionModelCatalogMetadata: true,
  sessionConfigCatalogMetadata: true,
  agentModeIntent: true,
  configOptionIntentMetadata: true,
  configOptionIntentSpawn: true,
  acpSessionModeCatalogMetadata: true,
  acpSessionModelCatalogMetadata: true,
  acpConfigCatalogMetadata: true,
  connectedServices: true,
  mcpSelectionSpawn: false,
  profileIdSpawn: false,
};

const SESSION_AGENT_SPAWN_INHERITED_METADATA_FIELDS: InheritedSessionMetadataFieldSet = {
  ...FORK_INHERITED_METADATA_FIELDS,
  configOptionIntentSpawn: true,
  mcpSelectionSpawn: true,
  profileIdSpawn: true,
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
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
  const state = value as Metadata['sessionModesV1'] & Readonly<{ provider?: string }>;
  // legacy `provider` state-record read-compat (pre-rename persisted metadata)
  const stateAgentId = state?.agentId ?? state?.provider;
  if (
    state?.v !== 1 ||
    !isNonEmptyString(stateAgentId) ||
    !isFiniteNumber(state.updatedAt) ||
    !isNonEmptyString(state.currentModeId) ||
    !Array.isArray(state.availableModes)
  ) {
    return undefined;
  }
  return {
    v: 1,
    agentId: stateAgentId,
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
  const state = value as Metadata['sessionModelsV1'] & Readonly<{ provider?: string }>;
  // legacy `provider` state-record read-compat (pre-rename persisted metadata)
  const stateAgentId = state?.agentId ?? state?.provider;
  if (
    state?.v !== 1 ||
    !isNonEmptyString(stateAgentId) ||
    !isFiniteNumber(state.updatedAt) ||
    !isNonEmptyString(state.currentModelId) ||
    !Array.isArray(state.availableModels)
  ) {
    return undefined;
  }
  return {
    v: 1,
    agentId: stateAgentId,
    updatedAt: state.updatedAt,
    currentModelId: state.currentModelId,
    availableModels: state.availableModels
      .filter((model) => model && isNonEmptyString(model.id) && isNonEmptyString(model.name))
      .map((model) => {
        const modelOptions = cloneProviderOptionEntries(model.modelOptions);
        return {
          id: model.id,
          name: model.name,
          ...(isNonEmptyString(model.description) ? { description: model.description } : {}),
          ...(modelOptions ? { modelOptions } : {}),
        };
      }),
  };
}

function isAllowedConfigValue(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function cloneProviderOptionEntries(
  value: unknown,
): NonNullable<NonNullable<Metadata['sessionModelsV1']>['availableModels'][number]['modelOptions']> | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = [];
  for (const option of value) {
    if (
      !isRecord(option) ||
      !isNonEmptyString(option.id) ||
      !isNonEmptyString(option.name) ||
      !isNonEmptyString(option.type) ||
      !isAllowedConfigValue(option.currentValue)
    ) {
      continue;
    }
    const choices = [];
    if (Array.isArray(option.options)) {
      for (const choice of option.options) {
        if (!isRecord(choice) || !isNonEmptyString(choice.name) || !isAllowedConfigValue(choice.value)) {
          continue;
        }
        choices.push({
          value: choice.value,
          name: choice.name,
          ...(isNonEmptyString(choice.description) ? { description: choice.description } : {}),
        });
      }
    }
    entries.push({
      id: option.id,
      name: option.name,
      type: option.type,
      currentValue: option.currentValue,
      ...(isNonEmptyString(option.description) ? { description: option.description } : {}),
      ...(Array.isArray(option.options) ? { options: choices } : {}),
    });
  }
  return entries.length > 0 ? entries : undefined;
}

function cloneSessionConfigOptionsState(
  value: unknown,
): Metadata['sessionConfigOptionsV1'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const state = value as Metadata['sessionConfigOptionsV1'] & Readonly<{ provider?: string }>;
  // legacy `provider` state-record read-compat (pre-rename persisted metadata)
  const stateAgentId = state?.agentId ?? state?.provider;
  if (
    state?.v !== 1 ||
    !isNonEmptyString(stateAgentId) ||
    !isFiniteNumber(state.updatedAt) ||
    !Array.isArray(state.configOptions)
  ) {
    return undefined;
  }

  return {
    v: 1,
    agentId: stateAgentId,
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

function buildAcpConfigOptionOverrides(entries: ReadonlyArray<{
  configId: string;
  value: string | number | boolean | null;
  updatedAt: number;
}>): AcpConfigOptionOverridesV1 | null {
  if (entries.length === 0) return null;
  const updatedAt = Math.max(...entries.map((entry) => entry.updatedAt));
  const parsed = AcpConfigOptionOverridesV1Schema.safeParse({
    v: 1,
    updatedAt,
    overrides: Object.fromEntries(entries.map((entry) => [
      entry.configId,
      {
        updatedAt: entry.updatedAt,
        value: entry.value,
      },
    ])),
  });
  return parsed.success ? parsed.data : null;
}

function resolveInheritedConnectedServices(
  metadata: Record<string, unknown> | null | undefined,
  agentTarget: BackendTargetRefV2 | null,
): ConnectedServiceBindingsV1 | null {
  const explicit = ConnectedServiceBindingsV1Schema.safeParse(metadata?.connectedServices);
  if (explicit.success) return explicit.data;

  const legacyAgentId = agentTarget?.sourceKind === 'built_in'
    ? agentTarget.backendId
    : null;
  if (!isNonEmptyString(legacyAgentId)) return null;
  const derivedBindings = readSessionMetadataConnectedServiceBindings(metadata, legacyAgentId);
  if (Object.keys(derivedBindings).length === 0) return null;

  const derived = ConnectedServiceBindingsV1Schema.safeParse({
    v: 1,
    bindingsByServiceId: derivedBindings,
  });
  return derived.success ? derived.data : null;
}

function resolveInheritedOverridesFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  agentTarget: BackendTargetRefV2 | null,
  fields: InheritedSessionMetadataFieldSet,
): {
  spawn: SessionAgentSpawnInheritedSpawnOverrides;
  metadata: ForkInheritedMetadataOverrides;
} {
  const spawn: SessionAgentSpawnInheritedSpawnOverrides = {};
  const metadataOverrides: ForkInheritedMetadataOverrides = {};

  const displayTitle = fields.displayTitleMetadata ? readSummaryTitle(metadata) : null;
  if (fields.displayTitleMetadata && displayTitle?.value) {
    Object.assign(
      metadataOverrides,
      applyDisplayTitleSessionMetadata(metadataOverrides, {
        title: displayTitle.value,
        updatedAt: displayTitle.updatedAt ?? Date.now(),
      }),
    );
  }

  const permission = fields.permissionIntent ? resolvePermissionIntentFromSessionMetadata(metadata) : null;
  if (fields.permissionIntent && permission && isPermissionMode(permission.intent)) {
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

  if (fields.modelIntent && agentTarget === null && sessionModelSelectionIntentRequiresAgentTargetV1({
    canonical: metadata?.modelSelectionIntentV1,
    legacy: metadata?.modelOverrideV1,
  })) {
    throw new SessionModelSelectionResolutionError('model_selection_agent_target_unknown');
  }
  const model = fields.modelIntent && agentTarget
    ? resolveModelSelectionIntentFromSessionMetadata(metadata, buildBackendTargetKeyV2(agentTarget))
    : null;
  if (model?.selection) {
    spawn.modelSelection = { v: 1, ref: model.selection, updatedAt: model.updatedAt };
  }
  const persistedProviderResumeState = fields.modelIntent
    ? readPersistedProviderResumeState(metadata ?? null)
    : { selection: null, binding: null };
  if (persistedProviderResumeState.binding) {
    spawn.providerBindingMetadataV1 = persistedProviderResumeState.binding;
  }
  if (model) {
    Object.assign(
      metadataOverrides,
      applyModelIntentSessionMetadata(metadataOverrides, {
        v: 1,
        selection: model.selection,
        updatedAt: model.updatedAt,
      }),
    );
  }

  const sessionModes = fields.sessionModeCatalogMetadata ? cloneSessionModesState(metadata?.sessionModesV1) : undefined;
  if (fields.sessionModeCatalogMetadata && sessionModes) {
    metadataOverrides.sessionModesV1 = sessionModes;
  }

  const sessionModels = fields.sessionModelCatalogMetadata ? cloneSessionModelsState(metadata?.sessionModelsV1) : undefined;
  if (fields.sessionModelCatalogMetadata && sessionModels) {
    metadataOverrides.sessionModelsV1 = sessionModels;
  }

  const configOptions = fields.sessionConfigCatalogMetadata
    ? cloneSessionConfigOptionsState(metadata?.sessionConfigOptionsV1)
    : undefined;
  if (fields.sessionConfigCatalogMetadata && configOptions) {
    metadataOverrides.sessionConfigOptionsV1 = configOptions;
  }

  const sessionModeOverride = fields.agentModeIntent ? readAcpSessionModeIntentFromMetadata((metadata ?? {}) as Metadata) : null;
  if (fields.agentModeIntent && sessionModeOverride) {
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

  const configOptionOverrides = (fields.configOptionIntentMetadata || fields.configOptionIntentSpawn)
    ? readAcpConfigOptionOverrides(metadata)
    : [];
  if (fields.configOptionIntentSpawn) {
    const spawnConfigOptionOverrides = buildAcpConfigOptionOverrides(configOptionOverrides);
    if (spawnConfigOptionOverrides) {
      spawn.sessionConfigOptionOverrides = spawnConfigOptionOverrides;
    }
  }
  if (fields.configOptionIntentMetadata) {
    for (const entry of configOptionOverrides) {
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
  }

  const acpSessionModes = fields.acpSessionModeCatalogMetadata ? cloneSessionModesState(metadata?.acpSessionModesV1) : undefined;
  if (fields.acpSessionModeCatalogMetadata && acpSessionModes) {
    metadataOverrides.acpSessionModesV1 = acpSessionModes;
  }

  const acpSessionModels = fields.acpSessionModelCatalogMetadata ? cloneSessionModelsState(metadata?.acpSessionModelsV1) : undefined;
  if (fields.acpSessionModelCatalogMetadata && acpSessionModels) {
    metadataOverrides.acpSessionModelsV1 = acpSessionModels;
  }

  const acpConfigOptions = fields.acpConfigCatalogMetadata ? cloneSessionConfigOptionsState(metadata?.acpConfigOptionsV1) : undefined;
  if (fields.acpConfigCatalogMetadata && acpConfigOptions) {
    metadataOverrides.acpConfigOptionsV1 = acpConfigOptions;
  }

  const connectedServices = fields.connectedServices ? resolveInheritedConnectedServices(metadata, agentTarget) : null;
  if (fields.connectedServices && connectedServices) {
    spawn.connectedServices = connectedServices;
    metadataOverrides.connectedServices = connectedServices;

    if (isFiniteNumber(metadata?.connectedServicesUpdatedAt)) {
      spawn.connectedServicesUpdatedAt = metadata.connectedServicesUpdatedAt;
      metadataOverrides.connectedServicesUpdatedAt = metadata.connectedServicesUpdatedAt;
    }
  }

  if (fields.mcpSelectionSpawn) {
    const mcpSelection = readSessionMcpSelectionV1FromMetadata(metadata);
    if (mcpSelection) {
      spawn.mcpSelection = mcpSelection;
    }
  }

  const profileId = metadata?.profileId;
  if (fields.profileIdSpawn && isNonEmptyString(profileId)) {
    spawn.profileId = profileId.trim();
  }

  return { spawn, metadata: metadataOverrides };
}

export function resolveForkInheritedOverridesFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  agentTarget: BackendTargetRefV2 | null,
): {
  spawn: ForkInheritedSpawnOverrides;
  metadata: ForkInheritedMetadataOverrides;
} {
  return resolveInheritedOverridesFromMetadata(metadata, agentTarget, FORK_INHERITED_METADATA_FIELDS);
}

export function resolveSessionAgentSpawnInheritedOverridesFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  agentTarget: BackendTargetRefV2 | null,
): {
  spawn: SessionAgentSpawnInheritedSpawnOverrides;
  metadata: ForkInheritedMetadataOverrides;
} {
  return resolveInheritedOverridesFromMetadata(metadata, agentTarget, SESSION_AGENT_SPAWN_INHERITED_METADATA_FIELDS);
}
