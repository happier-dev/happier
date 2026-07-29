import type { ExternalSessionsSource } from '@happier-dev/protocol';

import {
  clonePluginPlainData,
  PLUGIN_RUNTIME_JSON_VALUE_LIMITS,
} from '../../plugins/runtime/plainData';
import type { ResolvedExternalSessionSourceProjection } from '../../plugins/projection/registry/externalSessionSources';
import type { PluginExternalSessionsProviderOps } from './pluginExternalSessionsAdapter';

export type ConfiguredExternalSessionSourceCandidate = Readonly<{
  agentId: string;
  source: unknown;
}>;

export type ConfiguredExternalSessionSourceEntry = Readonly<{
  agentId: string;
  sourceKey: string;
  source: ExternalSessionsSource;
}>;

export type ConfiguredExternalSessionSourceSnapshotBasis = Readonly<{
  contributionGenerationId: string;
  accountSettingsRevision: string;
}>;

export type ConfiguredExternalSessionSourceSnapshot = Readonly<{
  contributionGenerationId: string;
  accountSettingsRevision: string;
  list: (basis: ConfiguredExternalSessionSourceSnapshotBasis) => readonly ConfiguredExternalSessionSourceEntry[];
  resolve: (
    sourceKey: string,
    basis: ConfiguredExternalSessionSourceSnapshotBasis,
  ) => ConfiguredExternalSessionSourceEntry | null;
}>;

export class ConfiguredExternalSessionSourceRegistryError extends Error {
  readonly code:
    | 'invalid_basis'
    | 'malformed_source'
    | 'source_undeclared'
    | 'agent_unavailable'
    | 'agent_source_mismatch'
    | 'provider_ops_unavailable'
    | 'provider_source_invalid'
    | 'malformed_canonical_source'
    | 'duplicate_source_key'
    | 'retired_generation'
    | 'account_settings_drift';

  constructor(
    code: ConfiguredExternalSessionSourceRegistryError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'ConfiguredExternalSessionSourceRegistryError';
    this.code = code;
  }
}

function requireSnapshotBasis(basis: ConfiguredExternalSessionSourceSnapshotBasis): void {
  if (!basis.contributionGenerationId.trim() || !basis.accountSettingsRevision.trim()) {
    throw new ConfiguredExternalSessionSourceRegistryError(
      'invalid_basis',
      'Configured external-session sources require contribution generation and account-settings revision identifiers',
    );
  }
}

function projectionError(
  agentId: string,
  phase: 'configured' | 'canonical',
  result: Extract<ResolvedExternalSessionSourceProjection, { ok: false }>,
): ConfiguredExternalSessionSourceRegistryError {
  if (phase === 'canonical') {
    return new ConfiguredExternalSessionSourceRegistryError(
      'malformed_canonical_source',
      'Provider returned a malformed canonical external-session source',
    );
  }
  if (result.code === 'agent_unavailable') {
    return new ConfiguredExternalSessionSourceRegistryError(
      'agent_unavailable',
      `External-session Agent '${agentId}' is not installed`,
    );
  }
  if (result.code === 'agent_source_mismatch') {
    return new ConfiguredExternalSessionSourceRegistryError(
      'agent_source_mismatch',
      `Agent '${agentId}' does not own the configured external-session source kind`,
    );
  }
  if (result.code === 'source_undeclared') {
    return new ConfiguredExternalSessionSourceRegistryError(
      'source_undeclared',
      `Agent '${agentId}' does not declare the configured external-session source kind`,
    );
  }
  return new ConfiguredExternalSessionSourceRegistryError(
    'malformed_source',
    `Configured external-session source for agent '${agentId}' is malformed`,
  );
}

function cloneConfiguredSourceData<T>(
  value: T,
  code: 'malformed_source' | 'malformed_canonical_source',
  message: string,
): T {
  try {
    return clonePluginPlainData(value, {
      path: 'externalSessionSource',
      limits: PLUGIN_RUNTIME_JSON_VALUE_LIMITS,
      invalid: () => new ConfiguredExternalSessionSourceRegistryError(code, message),
      limitExceeded: () => new ConfiguredExternalSessionSourceRegistryError(code, message),
    });
  } catch {
    throw new ConfiguredExternalSessionSourceRegistryError(code, message);
  }
}

function assertSnapshotCurrent(
  expected: ConfiguredExternalSessionSourceSnapshotBasis,
  actual: ConfiguredExternalSessionSourceSnapshotBasis,
  isCurrent: boolean,
): void {
  requireSnapshotBasis(actual);
  if (!isCurrent || actual.contributionGenerationId !== expected.contributionGenerationId) {
    throw new ConfiguredExternalSessionSourceRegistryError(
      'retired_generation',
      'Configured external-session source snapshot belongs to a retired contribution generation',
    );
  }
  if (actual.accountSettingsRevision !== expected.accountSettingsRevision) {
    throw new ConfiguredExternalSessionSourceRegistryError(
      'account_settings_drift',
      'Configured external-session source snapshot is stale after an account settings update',
    );
  }
}

export async function buildConfiguredExternalSessionSourceSnapshot(params: Readonly<{
  basis: ConfiguredExternalSessionSourceSnapshotBasis;
  candidates: readonly ConfiguredExternalSessionSourceCandidate[];
  readCurrentBasis?: () => ConfiguredExternalSessionSourceSnapshotBasis;
  isCurrent?: () => boolean;
  resolveSource: (
    agentId: string,
    source: unknown,
  ) => ResolvedExternalSessionSourceProjection;
  resolveProviderOps: (agentId: string) => Promise<PluginExternalSessionsProviderOps | null> | PluginExternalSessionsProviderOps | null;
}>): Promise<ConfiguredExternalSessionSourceSnapshot> {
  requireSnapshotBasis(params.basis);
  const assertBuildCurrent = (): void => {
    let currentBasis: ConfiguredExternalSessionSourceSnapshotBasis;
    let current: boolean;
    try {
      currentBasis = params.readCurrentBasis?.() ?? params.basis;
      current = params.isCurrent?.() ?? true;
    } catch {
      throw new ConfiguredExternalSessionSourceRegistryError(
        'retired_generation',
        'Configured external-session source snapshot belongs to a retired contribution generation',
      );
    }
    assertSnapshotCurrent(params.basis, currentBasis, current);
  };
  assertBuildCurrent();
  const entries: ConfiguredExternalSessionSourceEntry[] = [];
  const entriesByKey = new Map<string, ConfiguredExternalSessionSourceEntry>();
  const providerOpsByAgentId = new Map<string, PluginExternalSessionsProviderOps>();

  for (const candidate of params.candidates) {
    assertBuildCurrent();
    const candidateSource = cloneConfiguredSourceData(
      candidate.source,
      'malformed_source',
      `Configured external-session source for agent '${candidate.agentId}' is malformed`,
    );
    const parsed = params.resolveSource(candidate.agentId, candidateSource);
    if (!parsed.ok) throw projectionError(candidate.agentId, 'configured', parsed);
    let providerOps = providerOpsByAgentId.get(candidate.agentId) ?? null;
    if (!providerOps) {
      try {
        providerOps = await params.resolveProviderOps(candidate.agentId);
      } catch {
        assertBuildCurrent();
        throw new ConfiguredExternalSessionSourceRegistryError(
          'provider_ops_unavailable',
          `External-session Agent operations are unavailable for '${candidate.agentId}'`,
        );
      }
      assertBuildCurrent();
    }
    if (!providerOps) {
      throw new ConfiguredExternalSessionSourceRegistryError(
        'provider_ops_unavailable',
        `External-session Agent operations are unavailable for '${candidate.agentId}'`,
      );
    }
    providerOpsByAgentId.set(candidate.agentId, providerOps);
    let validation: Awaited<ReturnType<PluginExternalSessionsProviderOps['validateSource']>>;
    try {
      validation = await providerOps.validateSource({ source: parsed.source });
    } catch {
      assertBuildCurrent();
      throw new ConfiguredExternalSessionSourceRegistryError(
        'provider_source_invalid',
        `Configured external-session source for agent '${candidate.agentId}' was rejected by its provider`,
      );
    }
    assertBuildCurrent();
    const safeValidation = cloneConfiguredSourceData(
      validation,
      'malformed_canonical_source',
      'Provider returned a malformed canonical external-session source',
    );
    if (!safeValidation.ok) {
      throw new ConfiguredExternalSessionSourceRegistryError(
        'provider_source_invalid',
        `Configured external-session source for agent '${candidate.agentId}' was rejected by its provider`,
      );
    }
    const canonical = params.resolveSource(candidate.agentId, safeValidation.source);
    if (!canonical.ok) {
      throw projectionError(candidate.agentId, 'canonical', canonical);
    }
    if (canonical.declaration.sourceKind !== parsed.declaration.sourceKind) {
      throw new ConfiguredExternalSessionSourceRegistryError(
        'malformed_canonical_source',
        'Provider changed the configured external-session source kind',
      );
    }
    const source = cloneConfiguredSourceData(
      canonical.source,
      'malformed_canonical_source',
      'Provider returned a malformed canonical external-session source',
    );
    const sourceKey = canonical.sourceKey;
    if (entriesByKey.has(sourceKey)) {
      throw new ConfiguredExternalSessionSourceRegistryError(
        'duplicate_source_key',
        'Configured external-session sources produced a duplicate opaque source key',
      );
    }
    const entry = Object.freeze({
      agentId: candidate.agentId,
      sourceKey,
      source,
    });
    entries.push(entry);
    entriesByKey.set(sourceKey, entry);
  }

  assertBuildCurrent();

  const immutableEntries = Object.freeze(entries);
  const assertCurrent = (basis: ConfiguredExternalSessionSourceSnapshotBasis): void => {
    assertSnapshotCurrent(params.basis, basis, true);
  };
  return Object.freeze({
    contributionGenerationId: params.basis.contributionGenerationId,
    accountSettingsRevision: params.basis.accountSettingsRevision,
    list: (basis: ConfiguredExternalSessionSourceSnapshotBasis) => {
      assertCurrent(basis);
      return immutableEntries;
    },
    resolve: (sourceKey: string, basis: ConfiguredExternalSessionSourceSnapshotBasis) => {
      assertCurrent(basis);
      return entriesByKey.get(sourceKey) ?? null;
    },
  });
}
