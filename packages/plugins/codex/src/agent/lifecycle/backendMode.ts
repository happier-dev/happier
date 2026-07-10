import {
  readRuntimeDescriptorV1FromMetadata,
} from '@happier-dev/plugin-sdk/experimental/runtime/session';
import {
  type CodexBackendMode,
  normalizeCodexBackendMode,
} from '../../protocol/runtimeDescriptorV1.js';

import {
  readCanonicalCodexRuntimeDescriptorV1,
  resolvePersistedCodexRuntimeIdentity,
} from '../identity/runtimeDescriptor.js';

export function resolveCanonicalCodexBackendMode(params: Readonly<{
  backendMode?: unknown;
  codexBackendMode?: unknown;
  runtimeDescriptorV1?: unknown;
}>): CodexBackendMode | undefined {
  const runtimeDescriptor = readCanonicalCodexRuntimeDescriptorV1(
    readRuntimeDescriptorV1FromMetadata({
      runtimeDescriptorV1: params.runtimeDescriptorV1,
    }),
  );
  const runtimeBackendMode = normalizeCodexBackendMode(runtimeDescriptor?.backendMode);
  if (runtimeBackendMode) {
    return runtimeBackendMode;
  }

  const requestedBackendMode =
    normalizeCodexBackendMode(params.backendMode)
    ?? normalizeCodexBackendMode(params.codexBackendMode);
  if (requestedBackendMode) {
    return requestedBackendMode;
  }

  return undefined;
}

export function resolveCanonicalCodexBackendModeFromCompatInput(params: Readonly<{
  backendMode?: unknown;
  codexBackendMode?: unknown;
  experimentalCodexAcp?: boolean;
  runtimeDescriptorV1?: unknown;
}>): CodexBackendMode | undefined {
  return resolveCanonicalCodexBackendMode({
    backendMode: params.backendMode,
    codexBackendMode: params.codexBackendMode ?? (params.experimentalCodexAcp === true ? 'acp' : undefined),
    runtimeDescriptorV1: params.runtimeDescriptorV1,
  });
}

export function resolveCodexBackendModeForRun(opts: Readonly<{
  backendMode?: unknown;
  codexBackendMode?: unknown;
  defaultBackendMode?: unknown;
}>): CodexBackendMode {
  const explicitMode =
    normalizeCodexBackendMode(opts.backendMode)
    ?? normalizeCodexBackendMode(opts.codexBackendMode);
  if (explicitMode) return explicitMode;

  const defaultMode = normalizeCodexBackendMode(opts.defaultBackendMode);
  return defaultMode ?? 'appServer';
}

export function resolveCodexSessionBackendMode(params: Readonly<{
  metadata: unknown;
  accountSettings?: Readonly<Record<string, unknown>> | null;
}>): CodexBackendMode | null {
  const persistedMode = resolvePersistedCodexRuntimeIdentity(params.metadata);
  if (persistedMode) {
    return persistedMode.backendMode === 'acp' || persistedMode.backendMode === 'appServer'
      ? persistedMode.backendMode
      : null;
  }

  const settings = params.accountSettings ?? {};
  return resolveCodexBackendModeForRun({
    codexBackendMode: settings.codexBackendMode,
    defaultBackendMode: settings.experimentalCodexAcp === true ? 'acp' : 'appServer',
  });
}
