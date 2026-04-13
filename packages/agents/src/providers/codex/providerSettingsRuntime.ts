import { resolveDefaultAgentRuntimeKind, type AgentRuntimeKind } from '../../runtimeKinds.js';
import { readSessionMetadataRuntimeDescriptor } from '../readSessionMetadataRuntimeDescriptor.js';
import { resolvePersistedCodexRuntimeIdentity } from './runtimeIdentity.js';
import { normalizeCodexBackendMode } from '@happier-dev/protocol';

export function resolveCodexRuntimeBackendMode(params: Readonly<{
  codexBackendMode?: unknown;
  experimentalCodexAcp?: boolean;
  defaultBackendMode?: AgentRuntimeKind | null;
}>): AgentRuntimeKind | null {
  const explicitMode = normalizeCodexBackendMode(params.codexBackendMode);
  if (explicitMode) return explicitMode;
  const fallback = normalizeCodexBackendMode(params.defaultBackendMode);
  if (fallback) return fallback;
  if (params.experimentalCodexAcp === true) return 'acp';
  return null;
}

export function resolveCodexSpawnExtrasFromSettings(settings: Readonly<Record<string, unknown>>): Readonly<{
  codexBackendMode?: AgentRuntimeKind;
  experimentalCodexAcp?: boolean;
}> {
  const mode = resolveCodexRuntimeBackendMode({ codexBackendMode: settings.codexBackendMode });
  if (!mode) return {};
  if (mode === 'acp') return { codexBackendMode: 'acp', experimentalCodexAcp: true };
  return { codexBackendMode: mode };
}

export function isCodexVendorResumeBackendEnabled(settings: Readonly<Record<string, unknown>>): boolean {
  const mode = resolveCodexRuntimeBackendMode({
    codexBackendMode: settings.codexBackendMode,
    experimentalCodexAcp: settings.experimentalCodexAcp === true,
  });
  return mode === 'acp' || mode === 'appServer';
}

export const CODEX_SESSION_CONTROL_ADAPTER_RUNTIME_HELPERS = Object.freeze({
  resolveConfiguredRuntimeKind(accountSettings?: Record<string, unknown> | null): AgentRuntimeKind | null {
    return resolveCodexRuntimeBackendMode({
      codexBackendMode: accountSettings?.codexBackendMode,
      experimentalCodexAcp: accountSettings?.experimentalCodexAcp === true,
      defaultBackendMode: resolveDefaultAgentRuntimeKind('codex'),
    });
  },
  resolvePersistedSessionRuntimeKind(metadata: unknown): AgentRuntimeKind | null {
    return resolvePersistedCodexRuntimeIdentity(metadata)?.backendMode ?? null;
  },
  resolveVendorResumeId(metadata: unknown): string | null {
    return readSessionMetadataRuntimeDescriptor(metadata, 'codex')?.vendorSessionId ?? null;
  },
  isExperimentalVendorResumeEnabled(input: Readonly<{
    metadata: unknown;
    accountSettings: Record<string, unknown> | null;
  }>): boolean {
    const runtimeKind = resolvePersistedCodexRuntimeIdentity(input.metadata)?.backendMode
      ?? resolveCodexRuntimeBackendMode({
        codexBackendMode: input.accountSettings?.codexBackendMode,
        experimentalCodexAcp: input.accountSettings?.experimentalCodexAcp === true,
        defaultBackendMode: resolveDefaultAgentRuntimeKind('codex'),
      });
    return isCodexVendorResumeBackendEnabled(runtimeKind ? { codexBackendMode: runtimeKind } : {});
  },
  isExperimentalVendorHandoffEnabled(input: Readonly<{
    metadata: unknown;
    accountSettings: Record<string, unknown> | null;
  }>): boolean {
    const runtimeIdentity = resolvePersistedCodexRuntimeIdentity(input.metadata);
    if (runtimeIdentity?.backendMode === 'acp' || runtimeIdentity?.backendMode === 'appServer') {
      return true;
    }
    return isCodexVendorResumeBackendEnabled(input.accountSettings ?? {});
  },
});
