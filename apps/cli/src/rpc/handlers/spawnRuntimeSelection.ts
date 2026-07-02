import type { CodexBackendMode } from '@happier-dev/agents';
import {
  readRuntimeDescriptorV1,
  type RuntimeDescriptorV1,
} from '@happier-dev/protocol';

import { resolveCanonicalCodexBackendModeFromCompatInput } from '@happier-dev/plugins-codex/agent/lifecycle/backendMode';

type CanonicalSpawnRuntimeSelectionInput = Readonly<{
  codexBackendMode?: unknown;
  experimentalCodexAcp?: boolean;
  runtimeDescriptorV1?: RuntimeDescriptorV1;
}>;

type SpawnRuntimeSelectionCompatIngress = Readonly<{
  codexBackendMode?: unknown;
  experimentalCodexAcp?: unknown;
  runtimeDescriptorV1?: unknown;
  legacyAgentRuntimeDescriptorV1?: unknown;
}>;

export type CanonicalSpawnRuntimeSelection = Readonly<{
  codexBackendMode?: CodexBackendMode;
  providerRuntimeSelection?: Readonly<Record<string, unknown>>;
  runtimeDescriptorV1?: RuntimeDescriptorV1;
}>;

export function readSpawnRuntimeDescriptorV1(
  options: Readonly<Pick<CanonicalSpawnRuntimeSelectionInput, 'runtimeDescriptorV1'>>,
): RuntimeDescriptorV1 | undefined {
  return readRuntimeDescriptorV1(options.runtimeDescriptorV1) ?? undefined;
}

export function readCanonicalSpawnRuntimeSelection(
  options: CanonicalSpawnRuntimeSelectionInput,
): CanonicalSpawnRuntimeSelection {
  const runtimeDescriptorV1 = readSpawnRuntimeDescriptorV1(options);
  const codexBackendMode = resolveCanonicalCodexBackendModeFromCompatInput({
    codexBackendMode: options.codexBackendMode,
    experimentalCodexAcp: options.experimentalCodexAcp,
    runtimeDescriptorV1,
  });

  return {
    ...(codexBackendMode ? { codexBackendMode } : {}),
    ...(codexBackendMode ? { providerRuntimeSelection: { codexBackendMode } } : {}),
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
    codexBackendMode: options.codexBackendMode,
    experimentalCodexAcp: options.experimentalCodexAcp === true,
    ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
  });
}
