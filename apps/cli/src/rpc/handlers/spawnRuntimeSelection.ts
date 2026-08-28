import {
  normalizeCodexBackendMode,
  readRuntimeDescriptorV1,
  type RuntimeDescriptorV1,
} from '@happier-dev/protocol';

type CanonicalSpawnRuntimeSelectionInput = Readonly<{
  /** Resolved current catalog identity, used only to bind the opaque descriptor. */
  agentId?: string;
  runtimeDescriptorV1?: RuntimeDescriptorV1;
}>;

type SpawnRuntimeSelectionCompatIngress = Readonly<{
  agentId?: string;
  codexBackendMode?: unknown;
  experimentalCodexAcp?: unknown;
  runtimeDescriptorV1?: unknown;
  legacyAgentRuntimeDescriptorV1?: unknown;
}>;

export type CanonicalSpawnRuntimeSelection = Readonly<{
  /** Opaque Agent-owned runtime state carried to the selected plugin. */
  runtimeDescriptorV1?: RuntimeDescriptorV1;
}>;

export function readSpawnRuntimeDescriptorV1(
  options: Readonly<Pick<CanonicalSpawnRuntimeSelectionInput, 'agentId' | 'runtimeDescriptorV1'>>,
): RuntimeDescriptorV1 | undefined {
  const descriptor = readRuntimeDescriptorV1(options.runtimeDescriptorV1) ?? undefined;
  if (descriptor && options.agentId && descriptor.agentId !== options.agentId) {
    throw new Error('runtimeDescriptorV1 agentId must match the selected Agent');
  }
  return descriptor;
}

export function readCanonicalSpawnRuntimeSelection(
  options: CanonicalSpawnRuntimeSelectionInput,
): CanonicalSpawnRuntimeSelection {
  const runtimeDescriptorV1 = readSpawnRuntimeDescriptorV1(options);

  return {
    ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
  };
}

export function readCanonicalSpawnRuntimeSelectionFromCompatIngress(
  options: SpawnRuntimeSelectionCompatIngress,
): CanonicalSpawnRuntimeSelection {
  const runtimeDescriptorV1 =
    readRuntimeDescriptorV1(options.runtimeDescriptorV1)
    ?? readRuntimeDescriptorV1(options.legacyAgentRuntimeDescriptorV1);
  const codexBackendMode =
    normalizeCodexBackendMode(options.codexBackendMode)
    ?? (options.experimentalCodexAcp === true ? 'acp' : undefined);
  const selectedAgentId = options.agentId ?? runtimeDescriptorV1?.agentId;
  if (codexBackendMode && selectedAgentId && selectedAgentId !== 'codex') {
    throw new Error('Legacy Codex runtime selection cannot target another Agent');
  }
  // A current descriptor's `agent` payload is interpreted only by its Agent.
  // Released flat Codex hints remain an ingress fallback when no descriptor is
  // present, but they cannot inspect or veto an already admitted descriptor.
  const normalizedRuntimeDescriptorV1 = runtimeDescriptorV1 ?? (codexBackendMode
    ? readRuntimeDescriptorV1({
        v: 1,
        agentId: 'codex',
        agent: { backendMode: codexBackendMode },
      }) ?? undefined
    : undefined);

  return readCanonicalSpawnRuntimeSelection({
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(normalizedRuntimeDescriptorV1 ? { runtimeDescriptorV1: normalizedRuntimeDescriptorV1 } : {}),
  });
}
