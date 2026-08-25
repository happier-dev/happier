import {
  DEFAULT_PROVIDER_SETTINGS_V1,
  compareProviderCanonicalStringsV1,
  classifyLegacyProfileMigrationConflictsV1,
  createLegacyProfileMigrationPendingConflictV1,
  migrateProviderAccountSettingsV1,
  readProviderSettingsFromAccountSettingsV1,
  type ProviderAccountSettingsMigrationCandidateV1,
  type ProviderAccountSettingsMigrationContextV1,
} from '@happier-dev/protocol';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import type { ProviderOperationLifetime } from '@/providers/operationLifetime';

import { resolveProviderConnectionForMachine } from '../registry';
import { collectProviderConnectionDnsEvidence } from '../registry/dnsEvidence';

type ConnectionCandidate = Extract<ProviderAccountSettingsMigrationCandidateV1, { kind: 'connection' }>;

/**
 * Re-derives migration authorization from the exact CAS-attempt settings and
 * accepted registry generation. This function resolves DNS only; it never
 * resolves a SavedSecret or performs an HTTP request.
 */
export async function authorizeLegacyProfileMigrationContext(input: Readonly<{
  rawSettings: Readonly<Record<string, unknown>>;
  context: ProviderAccountSettingsMigrationContextV1;
  providersByContributionKey: ReadonlyMap<string, ResolvedProviderContribution>;
  machineId: string;
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  lifetime: ProviderOperationLifetime;
}>): Promise<ProviderAccountSettingsMigrationContextV1> {
  const classifiedContext = classifyLegacyProfileMigrationConflictsV1(input.rawSettings, input.context);
  const preview = migrateProviderAccountSettingsV1(input.rawSettings, classifiedContext);
  if (!preview.ok) return classifiedContext;

  const persistedProviderSettings = readProviderSettingsFromAccountSettingsV1(input.rawSettings).settings;
  const providerSettings = readProviderSettingsFromAccountSettingsV1(preview.settings).settings;
  const registry = { providersByContributionKey: input.providersByContributionKey };
  const outcomeBySourceProfileId = new Map(
    preview.outcomes
      .filter((outcome) => outcome.kind === 'connection')
      .map((outcome) => [outcome.sourceProfileId, outcome] as const),
  );

  const resolveRecord = async (
    accountSettings: Readonly<Record<string, unknown>>,
    settings: typeof providerSettings,
    connectionId: string,
  ) => {
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
      accountSettings,
      registry,
      dnsEvidenceByEndpointUrl,
    });
    return resolution.status === 'resolved' ? resolution.record : null;
  };

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

    if (winningConnection.id !== candidate.connection.id) {
      const persistedWinner = persistedProviderSettings.connections.find(
        (connection) => connection.id === winningConnection.id,
      );
      const expectedSettings = {
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        connections: [candidate.connection],
      };
      const expectedAccountSettings = { providerSettingsV1: expectedSettings };
      const [expectedRecord, winnerRecord] = await Promise.all([
        resolveRecord(expectedAccountSettings, expectedSettings, candidate.connection.id),
        persistedWinner
          ? resolveRecord(input.rawSettings, persistedProviderSettings, persistedWinner.id)
          : Promise.resolve(null),
      ]);
      if (!expectedRecord || !winnerRecord
        || expectedRecord.connectionSecurityFingerprint !== winnerRecord.connectionSecurityFingerprint
        || expectedRecord.endpointSetFingerprint !== winnerRecord.endpointSetFingerprint) {
        // A pre-existing edited default is not an authorization-preserving
        // substitute for the historical profile. Keep the profile and its
        // SavedSecret untouched for explicit guided review.
        const nextConflict = createLegacyProfileMigrationPendingConflictV1({
          candidate,
          kinds: ['edited_default_connection'],
          existingConnectionId: winningConnection.id,
          detectedAt: classifiedContext.migratedAt,
          comparisonFacts: {
            expectedConnectionSecurityFingerprint: expectedRecord?.connectionSecurityFingerprint ?? null,
            expectedEndpointSetFingerprint: expectedRecord?.endpointSetFingerprint ?? null,
            winnerConnectionSecurityFingerprint: winnerRecord?.connectionSecurityFingerprint ?? null,
            winnerEndpointSetFingerprint: winnerRecord?.endpointSetFingerprint ?? null,
          },
        });
        const persistedConflict = persistedProviderSettings.migration?.pendingConflicts.find(
          (entry) => entry.sourceProfileId === candidate.sourceProfileId,
        );
        pendingConflictsBySource.set(
          candidate.sourceProfileId,
          persistedConflict?.candidateFingerprint === nextConflict.candidateFingerprint
            ? persistedConflict
            : nextConflict,
        );
        continue;
      }
    }

    const record = await resolveRecord(preview.settings, providerSettings, winningConnection.id);
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
