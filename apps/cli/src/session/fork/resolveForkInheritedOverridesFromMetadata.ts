import { isPermissionMode, type Metadata, type PermissionMode } from '@/api/types';
import { AcpConfigOptionOverridesV1Schema, AcpSessionModeOverrideV1Schema } from '@happier-dev/protocol/sessions/metadata/overrides';
import { AgentModelOptionOverrideRuleReadSchema } from '@happier-dev/protocol/models/descriptor';
import { ConnectedServiceBindingsV2IngressSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { SessionModelSelectionResolutionError, sessionModelSelectionIntentRequiresAgentTargetV1 } from '@happier-dev/protocol/providers/model-selection';
import { readSessionModesMetadata, projectSessionModesV1Compatibility } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { AcpConfigOptionOverridesV1, BackendTargetRefV2, ConnectedServiceBindingsV2, ConnectedServiceMaterializationIdentityV1, SessionModelSelectionV1, SessionProviderBindingMetadataV1 } from '@happier-dev/protocol';
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
  connectedServices?: ConnectedServiceBindingsV2;
  connectedServicesUpdatedAt?: number;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1;
};

type ForkInheritedMetadataOverrides = Pick<
  Metadata,
  | 'permissionMode'
  | 'permissionModeUpdatedAt'
  | 'sessionModesV1'
  | 'sessionModesV2'
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const FORK_TITLE_SUFFIX_PATTERN = /^(.*) \(fork ([1-9]\d*)\)$/i;

function resolveInheritedDisplayTitle(
  metadata: Record<string, unknown> | null | undefined,
): {
  value: string;
  updatedAt?: number;
} | null {
  const summary = metadata?.summary;
  const record = summary && typeof summary === 'object' && !Array.isArray(summary)
    ? summary as Record<string, unknown>
    : null;
  const summaryValue = typeof record?.text === 'string' ? record.text.trim() : '';
  // Read compatibility for children created by the earlier name-only fork implementation.
  const legacyName = typeof metadata?.name === 'string' ? metadata.name.trim() : '';
  const value = summaryValue || legacyName;
  if (!value) return null;
  const suffix = value.match(FORK_TITLE_SUFFIX_PATTERN);
  const previousForkNumber = suffix ? Number(suffix[2]) : 0;
  const canIncrementSuffix = suffix !== null && Number.isSafeInteger(previousForkNumber);
  const baseTitle = canIncrementSuffix ? suffix[1].trimEnd() : value;
  return {
    value: `${baseTitle} (fork ${canIncrementSuffix ? previousForkNumber + 1 : 1})`,
    ...(typeof record?.updatedAt === 'number' && Number.isFinite(record.updatedAt)
      ? { updatedAt: record.updatedAt }
      : {}),
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
        const modelOptions = cloneCatalogOptionEntries(model.modelOptions);
        return {
          id: model.id,
          name: model.name,
          ...(isNonEmptyString(model.description) ? { description: model.description } : {}),
          ...(modelOptions.length > 0 ? { modelOptions } : {}),
        };
      }),
  };
}

function isAllowedConfigValue(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

type InheritedCatalogOption = NonNullable<
  NonNullable<Metadata['sessionModelsV1']>['availableModels'][number]['modelOptions']
>[number];

/**
 * The ONLY field-by-field reconstruction of an inherited catalog option.
 *
 * Canonical model/config catalogs and their released legacy ACP reader shapes
 * carry the same option entries. A producer-declared field added to one
 * reconstruction and forgotten in the other disappears on fork, so the
 * canonical writer and compatibility readers share this mapper.
 */
function cloneCatalogOptionEntry(option: unknown): InheritedCatalogOption | null {
  if (
    !isRecord(option) ||
    !isNonEmptyString(option.id) ||
    !isNonEmptyString(option.name) ||
    !isNonEmptyString(option.type) ||
    !isAllowedConfigValue(option.currentValue)
  ) {
    return null;
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
  // Producer-declared (see AgentModelOptionOverrideRule). A fork READS an already-persisted
  // catalog, so it uses the canonical read-side schema: same bounds as the producer contract — a
  // fork never forwards a rule the strict owner-metadata envelope would reject — but an
  // unrecognized nested field from a newer producer is stripped rather than costing the whole rule.
  const overridesWhenOn = AgentModelOptionOverrideRuleReadSchema.safeParse(option.overridesWhenOn);
  return {
    id: option.id,
    name: option.name,
    type: option.type,
    currentValue: option.currentValue,
    ...(isNonEmptyString(option.description) ? { description: option.description } : {}),
    ...(Array.isArray(option.options) ? { options: choices } : {}),
    ...(overridesWhenOn.success ? { overridesWhenOn: overridesWhenOn.data } : {}),
  };
}

function cloneCatalogOptionEntries(value: unknown): InheritedCatalogOption[] {
  if (!Array.isArray(value)) return [];
  const entries: InheritedCatalogOption[] = [];
  for (const option of value) {
    const cloned = cloneCatalogOptionEntry(option);
    if (cloned) entries.push(cloned);
  }
  return entries;
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
    configOptions: cloneCatalogOptionEntries(state.configOptions),
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
): ConnectedServiceBindingsV2 | null {
  const explicit = ConnectedServiceBindingsV2IngressSchema.safeParse(metadata?.connectedServices);
  if (explicit.success) return explicit.data;

  const legacyAgentId = agentTarget?.sourceKind === 'built_in'
    ? agentTarget.backendId
    : null;
  if (!isNonEmptyString(legacyAgentId)) return null;
  const derivedBindings = readSessionMetadataConnectedServiceBindings(metadata, legacyAgentId);
  if (Object.keys(derivedBindings).length === 0) return null;

  const derived = ConnectedServiceBindingsV2IngressSchema.safeParse({
    v: 1,
    bindingsByServiceId: derivedBindings,
  });
  return derived.success ? derived.data : null;
}

export function resolveForkInheritedOverridesFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  agentTarget: BackendTargetRefV2 | null,
): {
  spawn: ForkInheritedSpawnOverrides;
  metadata: ForkInheritedMetadataOverrides;
} {
  const spawn: ForkInheritedSpawnOverrides = {};
  const metadataOverrides: ForkInheritedMetadataOverrides = {};

  const displayTitle = resolveInheritedDisplayTitle(metadata);
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

  if (agentTarget === null && sessionModelSelectionIntentRequiresAgentTargetV1({
    canonical: metadata?.modelSelectionIntentV1,
    legacy: metadata?.modelOverrideV1,
  })) {
    throw new SessionModelSelectionResolutionError('model_selection_agent_target_unknown');
  }
  const model = agentTarget
    ? resolveModelSelectionIntentFromSessionMetadata(metadata, buildBackendTargetKeyV2(agentTarget))
    : null;
  if (model?.selection) {
    spawn.modelSelection = { v: 1, ref: model.selection, updatedAt: model.updatedAt };
  }
  const persistedProviderResumeState = readPersistedProviderResumeState(metadata ?? null);
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

  const canonicalModes = readSessionModesMetadata(metadata);
  if (canonicalModes) metadataOverrides.sessionModesV2 = canonicalModes;
  const sessionModes = canonicalModes ? projectSessionModesV1Compatibility(canonicalModes) : undefined;
  if (sessionModes) {
    metadataOverrides.sessionModesV1 = sessionModes;
  }

  const sessionModels = cloneSessionModelsState(metadata?.sessionModelsV1 ?? metadata?.acpSessionModelsV1);
  if (sessionModels) {
    metadataOverrides.sessionModelsV1 = sessionModels;
  }

  const configOptions = cloneSessionConfigOptionsState(metadata?.sessionConfigOptionsV1 ?? metadata?.acpConfigOptionsV1);
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

  const configOptionOverrides = readAcpConfigOptionOverrides(metadata);
  const spawnConfigOptionOverrides = buildAcpConfigOptionOverrides(configOptionOverrides);
  if (spawnConfigOptionOverrides) {
    spawn.sessionConfigOptionOverrides = spawnConfigOptionOverrides;
  }
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

  const connectedServices = resolveInheritedConnectedServices(metadata, agentTarget);
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
