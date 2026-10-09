import { DEFAULT_PROVIDER_SETTINGS_V1 } from '@happier-dev/protocol/providers/settings/v1';
import { compareProviderCanonicalStringsV1 } from '@happier-dev/protocol/providers/canonicalOrderV1';
import {
  applyReviewedLegacyProfileMigrationConflictV1,
  classifyLegacyProfileMigrationConflictsV1,
  type LegacyProfileMigrationConnectionSecurityComparisonV1,
  type LegacyProfileMigrationConflictResolutionV1,
  type ResolveLegacyProfileMigrationConflictResultV1,
} from '@happier-dev/protocol/providers/migrations/conflictsV1';
import { migrateProviderAccountSettingsV1 } from '@happier-dev/protocol/providers/migrations/accountSettingsV1';
import { areProviderContributionKeysEqualV1 } from '@happier-dev/protocol/providers/contribution-identity';
import type { ProviderAccountSettingsMigrationCandidateV1, ProviderAccountSettingsMigrationContextV1, ProviderSettingsV1 } from '@happier-dev/protocol';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import type { ProviderOperationLifetime } from '@/providers/operationLifetime';

import { resolveProviderConnectionForMachine } from '../registry';
import { collectProviderConnectionDnsEvidence } from '../registry/dnsEvidence';

type ConnectionCandidate = Extract<ProviderAccountSettingsMigrationCandidateV1, { kind: 'connection' }>;

type LegacyProfileMigrationAuthorizationInput = Readonly<{
  rawSettings: Readonly<Record<string, unknown>>;
  providerSettings: ProviderSettingsV1;
  context: ProviderAccountSettingsMigrationContextV1;
  providersByContributionKey: ReadonlyMap<string, ResolvedProviderContribution>;
  machineId: string;
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  lifetime: ProviderOperationLifetime;
}>;

/**
 * Re-derives migration authorization from the exact CAS-attempt settings and
 * accepted registry generation. This function resolves DNS only; it never
 * resolves a SavedSecret or performs an HTTP request.
 */
export async function authorizeLegacyProfileMigrationContext(
  input: LegacyProfileMigrationAuthorizationInput,
): Promise<ProviderAccountSettingsMigrationContextV1> {
  const securityComparisons = new Map<string, LegacyProfileMigrationConnectionSecurityComparisonV1>();
  for (const candidate of input.context.candidates) {
    if (candidate.kind !== 'connection' || candidate.connection.role !== 'default'
      || candidate.connection.source.kind !== 'contribution') continue;
    const contributionKey = candidate.connection.source.contributionKey;
    const winner = input.providerSettings.connections.find(connection => connection.role === 'default'
      && connection.source.kind === 'contribution'
      && areProviderContributionKeysEqualV1(connection.source.contributionKey, contributionKey));
    if (!winner) continue;
    const [expectedRecord, winnerRecord] = await Promise.all([
      resolveLegacyProfileMigrationConnectionRecord(input, {
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        connections: [candidate.connection],
      }, candidate.connection.id),
      resolveLegacyProfileMigrationConnectionRecord(input, input.providerSettings, winner.id),
    ]);
    securityComparisons.set(candidate.sourceProfileId, {
      winnerConnectionId: winner.id,
      expectedConnectionSecurityFingerprint: expectedRecord?.connectionSecurityFingerprint ?? null,
      expectedEndpointSetFingerprint: expectedRecord?.endpointSetFingerprint ?? null,
      winnerConnectionSecurityFingerprint: winnerRecord?.connectionSecurityFingerprint ?? null,
      winnerEndpointSetFingerprint: winnerRecord?.endpointSetFingerprint ?? null,
    });
  }
  return authorizeClassifiedLegacyProfileMigrationContext(
    input,
    classifyLegacyProfileMigrationConflictsV1(input.providerSettings, input.context, securityComparisons),
  );
}

/** Exact current review admits intent, not an Account grant or a DNS decision. */
export async function authorizeReviewedLegacyProfileMigrationContext(
  input: LegacyProfileMigrationAuthorizationInput & Readonly<{
    resolution: LegacyProfileMigrationConflictResolutionV1;
  }>,
): Promise<ResolveLegacyProfileMigrationConflictResultV1> {
  const authoritativeContext = await authorizeLegacyProfileMigrationContext(input);
  const resolved = applyReviewedLegacyProfileMigrationConflictV1(
    input.providerSettings,
    input.context,
    authoritativeContext,
    input.resolution,
  );
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    context: await authorizeClassifiedLegacyProfileMigrationContext(input, resolved.context),
  };
}

async function resolveLegacyProfileMigrationConnectionRecord(
  input: LegacyProfileMigrationAuthorizationInput,
  settings: ProviderSettingsV1,
  connectionId: string,
) {
  const registry = { providersByContributionKey: input.providersByContributionKey };
  const dnsEvidenceByEndpointUrl = await collectProviderConnectionDnsEvidence({
    connectionId,
    machineId: input.machineId,
    providerSettings: settings,
    registry,
    ...(input.resolveAddresses ? { resolveAddresses: input.resolveAddresses } : {}),
    lifetime: input.lifetime,
  });
  const resolution = resolveProviderConnectionForMachine({
    connectionId,
    machineId: input.machineId,
    providerSettings: settings,
    registry,
    dnsEvidenceByEndpointUrl,
  });
  return resolution.status === 'resolved' ? resolution.record : null;
}

async function authorizeClassifiedLegacyProfileMigrationContext(
  input: LegacyProfileMigrationAuthorizationInput,
  classifiedContext: ProviderAccountSettingsMigrationContextV1,
): Promise<ProviderAccountSettingsMigrationContextV1> {
  const preview = migrateProviderAccountSettingsV1(input.providerSettings, classifiedContext);
  if (!preview.ok) return classifiedContext;

  const providerSettings = preview.providerSettings;
  const outcomeBySourceProfileId = new Map(
    preview.outcomes
      .filter((outcome) => outcome.kind === 'connection')
      .map((outcome) => [outcome.sourceProfileId, outcome] as const),
  );

  const candidates: ProviderAccountSettingsMigrationCandidateV1[] = [];
  const pendingConflictsBySource = new Map(
    (classifiedContext.pendingConflicts ?? []).map((entry) => [entry.sourceProfileId, entry] as const),
  );
  for (const candidate of classifiedContext.candidates) {
    if (candidate.kind !== 'connection') {
      candidates.push(candidate);
      continue;
    }
    const outcome = outcomeBySourceProfileId.get(candidate.sourceProfileId);
    if (!outcome || outcome.kind !== 'connection') {
      candidates.push(candidate);
      continue;
    }
    const winningConnection = providerSettings.connections.find(
      (connection) => connection.id === outcome.connectionId,
    );
    if (!winningConnection) {
      candidates.push(candidate);
      continue;
    }

    const record = await resolveLegacyProfileMigrationConnectionRecord(input, providerSettings, winningConnection.id);
    if (!record
      || record.deployment.kind !== 'external'
      || record.scope !== 'account'
      || record.endpoints.length === 0
      || !record.endpoints.every((endpoint) =>
        endpoint.locality === 'public' && endpoint.resolvedAddresses.length > 0)) {
      const { accountGrant: _discardedGrant, ...candidateWithoutGrant } = candidate;
      candidates.push({ ...candidateWithoutGrant, connection: winningConnection } satisfies ConnectionCandidate);
      continue;
    }

    candidates.push({
      ...candidate,
      connection: winningConnection,
      accountGrant: {
        v: 1,
        connectionId: winningConnection.id,
        connectionSecurityFingerprint: record.connectionSecurityFingerprint,
        confirmedAt: classifiedContext.migratedAt,
      },
    } satisfies ConnectionCandidate);
  }

  return {
    ...classifiedContext,
    candidates,
    pendingConflicts: [...pendingConflictsBySource.values()]
      .sort((left, right) => compareProviderCanonicalStringsV1(left.sourceProfileId, right.sourceProfileId)),
  };
}
