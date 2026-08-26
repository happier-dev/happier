import {
  normalizeCodexBackendMode,
  readRuntimeDescriptorV1,
  type CodexBackendMode,
  type RuntimeDescriptorV1,
} from '@happier-dev/protocol';
import {
  applyAgentRuntimeKindOverrideToAccountSettings,
  resolveProviderSessionBackendMode,
} from '@happier-dev/agents';

type CanonicalSpawnRuntimeSelectionInput = Readonly<{
  backendMode?: unknown;
  codexBackendMode?: unknown;
  experimentalCodexAcp?: boolean;
  runtimeDescriptorV1?: RuntimeDescriptorV1;
}>;

type SpawnRuntimeSelectionCompatIngress = Readonly<{
  backendMode?: unknown;
  codexBackendMode?: unknown;
  experimentalCodexAcp?: unknown;
  runtimeDescriptorV1?: unknown;
  legacyAgentRuntimeDescriptorV1?: unknown;
}>;

export type CanonicalSpawnRuntimeSelection = Readonly<{
  codexBackendMode?: CodexBackendMode;
  agentBackendMode?: string;
  agentRuntimeSelection?: Readonly<Record<string, unknown>>;
  runtimeDescriptorV1?: RuntimeDescriptorV1;
}>;

function readAgentRuntimeSelectionFromDescriptor(
  runtimeDescriptorV1: RuntimeDescriptorV1 | undefined,
): Readonly<{
  agentBackendMode?: string;
  agentRuntimeSelection?: Readonly<Record<string, unknown>>;
}> {
  if (!runtimeDescriptorV1) {
    return {};
  }

  const runtimeKind = resolveProviderSessionBackendMode({
    agentId: runtimeDescriptorV1.agentId,
    metadata: { runtimeDescriptorV1 },
  });
  if (!runtimeKind) {
    return {};
  }

  const accountSettings = applyAgentRuntimeKindOverrideToAccountSettings({
    agentId: runtimeDescriptorV1.agentId,
    accountSettings: {},
    runtimeKindOverride: runtimeKind,
  });
  return {
    agentBackendMode: runtimeKind,
    ...(accountSettings && Object.keys(accountSettings).length > 0 ? { agentRuntimeSelection: accountSettings } : {}),
  };
}

function readLegacyCodexBackendModeFromAgentRuntimeSelection(
  agentRuntimeSelection: Readonly<Record<string, unknown>> | undefined,
): CodexBackendMode | undefined {
  return normalizeCodexBackendMode(agentRuntimeSelection?.codexBackendMode) ?? undefined;
}

export function readSpawnRuntimeDescriptorV1(
  options: Readonly<Pick<CanonicalSpawnRuntimeSelectionInput, 'runtimeDescriptorV1'>>,
): RuntimeDescriptorV1 | undefined {
  return readRuntimeDescriptorV1(options.runtimeDescriptorV1) ?? undefined;
}

export function readCanonicalSpawnRuntimeSelection(
  options: CanonicalSpawnRuntimeSelectionInput,
): CanonicalSpawnRuntimeSelection {
  const runtimeDescriptorV1 = readSpawnRuntimeDescriptorV1(options);
  const {
    agentBackendMode,
    agentRuntimeSelection: descriptorRuntimeSelection,
  } = readAgentRuntimeSelectionFromDescriptor(runtimeDescriptorV1);
  const codexCompatRuntimeKindOverride =
    normalizeCodexBackendMode(options.backendMode)
    ?? normalizeCodexBackendMode(options.codexBackendMode)
    ?? (options.experimentalCodexAcp === true ? 'acp' : undefined);
  const codexCompatRuntimeSelection = applyAgentRuntimeKindOverrideToAccountSettings({
    agentId: 'codex',
    accountSettings: null,
    runtimeKindOverride: codexCompatRuntimeKindOverride,
  }) ?? undefined;
  const agentRuntimeSelection = descriptorRuntimeSelection ?? codexCompatRuntimeSelection;
  const codexBackendMode = readLegacyCodexBackendModeFromAgentRuntimeSelection(agentRuntimeSelection);

  return {
    ...(codexBackendMode ? { codexBackendMode } : {}),
    ...(agentBackendMode ? { agentBackendMode } : {}),
    ...(agentRuntimeSelection ? { agentRuntimeSelection } : {}),
    ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
  };
}

export function readCanonicalSpawnRuntimeSelectionFromCompatIngress(
  options: SpawnRuntimeSelectionCompatIngress,
): CanonicalSpawnRuntimeSelection {
  const runtimeDescriptorV1 =
    readRuntimeDescriptorV1(options.runtimeDescriptorV1)
    ?? readRuntimeDescriptorV1(options.legacyAgentRuntimeDescriptorV1);

  return readCanonicalSpawnRuntimeSelection({
    backendMode: options.backendMode,
    codexBackendMode: options.codexBackendMode,
    experimentalCodexAcp: options.experimentalCodexAcp === true,
    ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
  });
}
