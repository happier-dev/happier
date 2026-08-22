import {
  ExternalSessionAgentIdSchema,
  ExternalSessionSourceIdSchema,
  type ExternalSessionAgentId,
  type ExternalSessionSourceId,
  type ExternalSessionsSource,
} from '@happier-dev/protocol';

import { clonePluginPlainData } from '../../plugins/runtime/plainData';
import type { ResolvedExternalSessionSourceProjection } from '../../plugins/projection/registry/externalSessionSources';
import type { ExternalSessionProviderOps } from './providerOps';

export type ConfiguredExternalSessionSourceCandidate = Readonly<{
  agentId: string;
  source: unknown;
}>;

export type ConfiguredExternalSessionSourceEntry = Readonly<{
  agentId: ExternalSessionAgentId;
  sourceKey: ExternalSessionSourceId;
  source: ExternalSessionsSource;
}>;

export type ConfiguredExternalSessionSourceSnapshotBasis = Readonly<{
  contributionGenerationId: string;
  accountSettingsRevision: string;
}>;

/**
 * One configured candidate that its own Agent's provider leaf refused.
 *
 * These three codes are decided entirely inside one participant — the Agent's
 * `validateSource` leaf, its execution surface, or the canonical source that
 * leaf returned. One misbehaving or transiently failing Agent must not remove
 * every other Agent's configured sources, so the candidate is dropped and named
 * here instead of aborting the whole snapshot. Every host-decided failure
 * (`invalid_basis`, `malformed_source`, `source_undeclared`,
 * `agent_source_mismatch`, `agent_unavailable`, `duplicate_source_key`,
 * `retired_generation`, `account_settings_drift`) still fails the snapshot
 * closed: those mean the host's own basis, settings bytes, declaration index, or
 * key identity is untrustworthy, and a partial snapshot built on one of them
 * would silently publish an incomplete or order-dependent view of the user's
 * configuration as if it were complete.
 */
export type ConfiguredExternalSessionSourceRefusalCode =
  | 'provider_ops_unavailable'
  | 'provider_source_invalid'
  | 'malformed_canonical_source';

export type ConfiguredExternalSessionSourceRefusal = Readonly<{
  agentId: string;
  code: ConfiguredExternalSessionSourceRefusalCode;
  message: string;
}>;

export type ConfiguredExternalSessionSourceSnapshot = Readonly<{
  contributionGenerationId: string;
  accountSettingsRevision: string;
  /** Candidates refused by their own Agent; see the type doc for the line drawn. */
  refusals: readonly ConfiguredExternalSessionSourceRefusal[];
  list: (basis: ConfiguredExternalSessionSourceSnapshotBasis) => readonly ConfiguredExternalSessionSourceEntry[];
  resolve: (
    agentId: ExternalSessionAgentId,
    sourceKey: ExternalSessionSourceId,
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
      invalid: () => new ConfiguredExternalSessionSourceRegistryError(code, message),
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

function configuredSourceIdentityKey(
  agentId: ExternalSessionAgentId,
  sourceKey: ExternalSessionSourceId,
): string {
  return JSON.stringify([agentId, sourceKey]);
}

const PARTICIPANT_REFUSAL_CODES: ReadonlySet<string> = new Set<
  ConfiguredExternalSessionSourceRefusalCode
>(['provider_ops_unavailable', 'provider_source_invalid', 'malformed_canonical_source']);

/**
 * Classifies a build failure as one participant's refusal, or as a host-integrity
 * failure that must still fail the whole snapshot closed.
 */
function readParticipantRefusal(
  agentId: ExternalSessionAgentId,
  error: unknown,
): ConfiguredExternalSessionSourceRefusal | null {
  if (!(error instanceof ConfiguredExternalSessionSourceRegistryError)) return null;
  if (!PARTICIPANT_REFUSAL_CODES.has(error.code)) return null;
  return Object.freeze({
    agentId,
    code: error.code as ConfiguredExternalSessionSourceRefusalCode,
    message: error.message,
  });
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
  resolveProviderOps: (agentId: string) => Promise<Pick<ExternalSessionProviderOps, 'validateSource'> | null> | Pick<ExternalSessionProviderOps, 'validateSource'> | null;
  /** Private follow-admission cancellation propagated to provider validation. */
  signal?: AbortSignal;
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
  const refusals: ConfiguredExternalSessionSourceRefusal[] = [];
  const entriesByIdentity = new Map<string, ConfiguredExternalSessionSourceEntry>();
  const providerOpsByAgentId = new Map<ExternalSessionAgentId, Pick<ExternalSessionProviderOps, 'validateSource'>>();

  /**
   * Canonicalizes one already-declared candidate through its own Agent's provider
   * leaf. Every failure raised here is decided inside that one participant, so
   * the caller converts it into a refusal instead of aborting the snapshot.
   * Generation retirement still escapes as `retired_generation`.
   */
  const admitThroughProviderLeaf = async (
    agentId: ExternalSessionAgentId,
    parsed: Extract<ResolvedExternalSessionSourceProjection, { ok: true }>,
  ): Promise<Readonly<{ sourceKey: ExternalSessionSourceId; source: ExternalSessionsSource }>> => {
    let providerOps = providerOpsByAgentId.get(agentId) ?? null;
    if (!providerOps) {
      try {
        providerOps = await params.resolveProviderOps(agentId);
      } catch {
        assertBuildCurrent();
        throw new ConfiguredExternalSessionSourceRegistryError(
          'provider_ops_unavailable',
          `External-session Agent operations are unavailable for '${agentId}'`,
        );
      }
      assertBuildCurrent();
    }
    if (!providerOps) {
      throw new ConfiguredExternalSessionSourceRegistryError(
        'provider_ops_unavailable',
        `External-session Agent operations are unavailable for '${agentId}'`,
      );
    }
    providerOpsByAgentId.set(agentId, providerOps);
    let validation: Awaited<ReturnType<ExternalSessionProviderOps['validateSource']>>;
    try {
      validation = await providerOps.validateSource({
        source: parsed.source,
        ...(params.signal ? { signal: params.signal } : {}),
      });
    } catch {
      assertBuildCurrent();
      throw new ConfiguredExternalSessionSourceRegistryError(
        'provider_source_invalid',
        `Configured external-session source for agent '${agentId}' was rejected by its provider`,
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
        `Configured external-session source for agent '${agentId}' was rejected by its provider`,
      );
    }
    const canonical = params.resolveSource(agentId, safeValidation.source);
    if (!canonical.ok) {
      throw projectionError(agentId, 'canonical', canonical);
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
    const parsedSourceKey = ExternalSessionSourceIdSchema.safeParse(canonical.sourceKey);
    if (!parsedSourceKey.success) {
      throw new ConfiguredExternalSessionSourceRegistryError(
        'malformed_canonical_source',
        'Provider returned a malformed canonical external-session source identity',
      );
    }
    return Object.freeze({ sourceKey: parsedSourceKey.data, source });
  };

  for (const candidate of params.candidates) {
    assertBuildCurrent();
    const parsedAgentId = ExternalSessionAgentIdSchema.safeParse(candidate.agentId);
    if (!parsedAgentId.success) {
      throw new ConfiguredExternalSessionSourceRegistryError(
        'malformed_source',
        'Configured external-session source has a malformed Agent identifier',
      );
    }
    const agentId = parsedAgentId.data;
    const candidateSource = cloneConfiguredSourceData(
      candidate.source,
      'malformed_source',
      `Configured external-session source for agent '${agentId}' is malformed`,
    );
    const parsed = params.resolveSource(agentId, candidateSource);
    if (!parsed.ok) throw projectionError(agentId, 'configured', parsed);
    let admitted: Readonly<{ sourceKey: ExternalSessionSourceId; source: ExternalSessionsSource }>;
    try {
      admitted = await admitThroughProviderLeaf(agentId, parsed);
    } catch (error) {
      const refusal = readParticipantRefusal(agentId, error);
      if (!refusal) throw error;
      if (!refusals.some((existing) => (
        existing.agentId === refusal.agentId
        && existing.code === refusal.code
        && existing.message === refusal.message
      ))) {
        refusals.push(refusal);
      }
      continue;
    }
    const identityKey = configuredSourceIdentityKey(agentId, admitted.sourceKey);
    if (entriesByIdentity.has(identityKey)) {
      throw new ConfiguredExternalSessionSourceRegistryError(
        'duplicate_source_key',
        'Configured external-session sources produced a duplicate Agent-scoped opaque source key',
      );
    }
    const entry = Object.freeze({
      agentId,
      sourceKey: admitted.sourceKey,
      source: admitted.source,
    });
    entries.push(entry);
    entriesByIdentity.set(identityKey, entry);
  }

  assertBuildCurrent();

  const immutableEntries = Object.freeze(entries);
  const assertCurrent = (basis: ConfiguredExternalSessionSourceSnapshotBasis): void => {
    assertSnapshotCurrent(params.basis, basis, true);
  };
  return Object.freeze({
    contributionGenerationId: params.basis.contributionGenerationId,
    accountSettingsRevision: params.basis.accountSettingsRevision,
    refusals: Object.freeze(refusals),
    list: (basis: ConfiguredExternalSessionSourceSnapshotBasis) => {
      assertCurrent(basis);
      return immutableEntries;
    },
    resolve: (
      agentId: ExternalSessionAgentId,
      sourceKey: ExternalSessionSourceId,
      basis: ConfiguredExternalSessionSourceSnapshotBasis,
    ) => {
      assertCurrent(basis);
      return entriesByIdentity.get(configuredSourceIdentityKey(agentId, sourceKey)) ?? null;
    },
  });
}
