import {
  qualifiedPurposeKey,
  type QualifiedConnectedAccountRef,
  type QualifiedConnectedAccountPurposeV1,
} from '@happier-dev/protocol';

import type {
  StablePluginConnectedAccountsOwner,
} from '@/plugins/runtime/invocation/services/connectedAccounts';
import type {
  ManagedServiceCredentialFileCleanup,
  ManagedServiceCredentialFileOwner,
} from '@/plugins/runtime/invocation/services/managedServicesAdapter';
import type {
  AgentSpawnQualifiedPurposeBindingSnapshot,
} from '../requestAuth/prepareConnectedAccountRequestAuthForSpawn';

type CredentialFileScope = Parameters<ManagedServiceCredentialFileOwner['materialize']>[0]['scope'];

/**
 * Host-owned projection of an Agent's qualified Connected Account launch uses.
 * Plugins declare purposes and the environment destinations; account selection,
 * materialization, path custody, and cleanup remain with the canonical host owners.
 */
export async function materializeQualifiedConnectedAccountLaunchUses(input: Readonly<{
  connectedAccountsOwner: Pick<StablePluginConnectedAccountsOwner, 'getBinding' | 'materialize'>;
  credentialFileOwner?: ManagedServiceCredentialFileOwner | null;
  snapshot: AgentSpawnQualifiedPurposeBindingSnapshot;
  exactPurposeBindingSubjectId?: string;
  sessionId?: string;
  signal: AbortSignal;
  isPurposeBound?(purpose: QualifiedConnectedAccountPurposeV1): boolean;
  expectedAccountsByPurposeKey?: ReadonlyMap<string, QualifiedConnectedAccountRef>;
  credentialFileScope?: CredentialFileScope;
  retainCredentialFileCleanup?(cleanup: ManagedServiceCredentialFileCleanup): void;
}>): Promise<Readonly<Record<string, string>>> {
  const materializedEnvironment: Record<string, string> = Object.create(null);
  const expectedAccountsByPurposeKey = new Map(
    input.expectedAccountsByPurposeKey ?? [],
  );
  const isPurposeBound = input.isPurposeBound ?? ((purpose) => (
    input.snapshot.bindings.some((binding) => (
      qualifiedPurposeKey(binding.purpose) === qualifiedPurposeKey(purpose)
    ))
  ));

  const resolveExpectedAccount = async (
    purpose: QualifiedConnectedAccountPurposeV1,
    serviceRefs: Parameters<StablePluginConnectedAccountsOwner['getBinding']>[0]['serviceRefs'],
  ): Promise<QualifiedConnectedAccountRef> => {
    const purposeKey = qualifiedPurposeKey(purpose);
    const retained = expectedAccountsByPurposeKey.get(purposeKey);
    if (retained) return retained;
    const binding = await input.connectedAccountsOwner.getBinding({
      purpose,
      serviceRefs,
      ...(input.exactPurposeBindingSubjectId
        ? { exactPurposeBindingSubjectId: input.exactPurposeBindingSubjectId }
        : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      signal: input.signal,
    });
    if (!binding) {
      throw new Error('Connected Account launch binding is unavailable');
    }
    const expected = Object.freeze({
      service: Object.freeze({ ...binding.account.service }),
      accountId: binding.account.accountId,
    });
    expectedAccountsByPurposeKey.set(purposeKey, expected);
    return expected;
  };

  for (const use of input.snapshot.environmentUses ?? []) {
    if (!isPurposeBound(use.purpose)) continue;
    const expectedAccount = await resolveExpectedAccount(
      use.purpose,
      use.serviceRefs,
    );
    const materialization = await input.connectedAccountsOwner.materialize({
      purpose: use.purpose,
      serviceRefs: use.serviceRefs,
      ...(input.exactPurposeBindingSubjectId
        ? { exactPurposeBindingSubjectId: input.exactPurposeBindingSubjectId }
        : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      expectedAccount,
      request: Object.freeze({
        kind: 'environment' as const,
        keys: Object.freeze([use.environmentKey]),
      }),
      signal: input.signal,
    });
    if (materialization.kind !== 'environment') {
      throw new Error(
        `Connected Account launch environment '${use.environmentKey}' returned the wrong materialization kind`,
      );
    }
    const value = materialization.env[use.environmentKey];
    if (typeof value === 'string' && value.length > 0) {
      materializedEnvironment[use.environmentKey] = value;
    }
  }

  const files: Record<string, Uint8Array> = Object.create(null);
  const environmentKeysByMaterializedId = new Map<string, string>();
  for (const [index, use] of (input.snapshot.fileEnvironmentUses ?? []).entries()) {
    if (!isPurposeBound(use.purpose)) continue;
    const expectedAccount = await resolveExpectedAccount(
      use.purpose,
      use.serviceRefs,
    );
    const materialization = await input.connectedAccountsOwner.materialize({
      purpose: use.purpose,
      serviceRefs: use.serviceRefs,
      ...(input.exactPurposeBindingSubjectId
        ? { exactPurposeBindingSubjectId: input.exactPurposeBindingSubjectId }
        : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      expectedAccount,
      request: Object.freeze({
        kind: 'files' as const,
        fileIds: Object.freeze([use.fileId]),
      }),
      signal: input.signal,
    });
    if (materialization.kind !== 'files') {
      throw new Error(
        `Connected Account launch file '${use.fileId}' returned the wrong materialization kind`,
      );
    }
    if (!Object.prototype.hasOwnProperty.call(materialization.files, use.fileId)) continue;
    const materializedId = String(index);
    files[materializedId] = materialization.files[use.fileId]!;
    environmentKeysByMaterializedId.set(materializedId, use.environmentKey);
  }

  if (environmentKeysByMaterializedId.size > 0) {
    if (
      !input.credentialFileOwner
      || !input.credentialFileScope
      || !input.retainCredentialFileCleanup
    ) {
      throw new Error('Connected Account credential-file authority is unavailable');
    }
    const credentialFiles = await input.credentialFileOwner.materialize({
      scope: input.credentialFileScope,
      files: Object.freeze(files),
      retainCleanup: input.retainCredentialFileCleanup,
    });
    for (const [materializedId, environmentKey] of environmentKeysByMaterializedId) {
      const path = credentialFiles.pathsByFileId[materializedId];
      if (!path) {
        throw new Error(
          `Connected Account launch file '${materializedId}' has no host path`,
        );
      }
      materializedEnvironment[environmentKey] = path;
    }
  }

  return Object.freeze(materializedEnvironment);
}
