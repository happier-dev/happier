import { QualifiedConnectedAccountCredentialSnapshotV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { QualifiedConnectedAccountCredentialSnapshotV4, QualifiedConnectedAccountRef } from '@happier-dev/protocol';
import type {
  ConnectedAccountHealthResult as PluginConnectedAccountHealthResult,
  ConnectedAccountRuntime as PluginConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';

import {
  acquireQualifiedConnectedAccountRefreshLeaseV4,
  mutateQualifiedConnectedAccountCredentialV4,
  QualifiedConnectedAccountCompatibilityError,
} from '@/api/client/qualifiedConnectedAccountApi';

import type {
  QualifiedConnectedAccountEstablishedInvocationBasis,
  QualifiedConnectedAccountEstablishedRuntimeOwner,
} from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import type {
  QualifiedConnectedAccountV4Support,
} from '../qualifiedConnectedAccountV4Support';

type RefreshLeaseClient =
  typeof acquireQualifiedConnectedAccountRefreshLeaseV4;
type CredentialMutationClient =
  typeof mutateQualifiedConnectedAccountCredentialV4;
type PluginConnectedAccountCredentialStore =
  Parameters<PluginConnectedAccountRuntime['refresh']>[0]['stagedCredentials'];
type PluginConnectedAccountRefreshResult = Awaited<
  ReturnType<PluginConnectedAccountRuntime['refresh']>
>;

export class QualifiedConnectedAccountRefreshLeaseError extends Error {
  constructor(readonly code:
    | 'connected_account_refresh_lease_not_acquired'
    | 'connected_account_refresh_lease_owner_mismatch'
    | 'connected_account_refresh_lease_revision_mismatch',
  ) {
    super('Qualified Connected Account refresh lease was not acquired for the exact credential revision');
    this.name = 'QualifiedConnectedAccountRefreshLeaseError';
  }
}

/** The provider returned a replacement; a later failure must not look like a rejected exchange. */
export class QualifiedConnectedAccountRefreshSettlementError extends Error {
  readonly providerExchange = 'succeeded';

  constructor(
    readonly persistenceOutcome: 'not_attempted' | 'unknown' | 'confirmed',
    cause: unknown,
  ) {
    super(`Provider refresh succeeded but credential settlement failed (persistence: ${persistenceOutcome})`, { cause });
    this.name = 'QualifiedConnectedAccountRefreshSettlementError';
  }
}

export type QualifiedConnectedAccountRefreshSettlement =
  | Readonly<{
      status: 'refreshed';
      credentialRevision: string;
      metadata: QualifiedConnectedAccountCredentialSnapshotV4['metadata'];
      result: PluginConnectedAccountHealthResult;
      basis: QualifiedConnectedAccountEstablishedInvocationBasis;
    }>
  | Readonly<{
      status: 'unchanged';
      result: PluginConnectedAccountHealthResult;
      basis: QualifiedConnectedAccountEstablishedInvocationBasis;
    }>
  | Readonly<{
      status: 'not_connected';
      result: PluginConnectedAccountHealthResult;
      basis: QualifiedConnectedAccountEstablishedInvocationBasis;
    }>
  | Readonly<{
      status: 'outcome_unknown';
      result: PluginConnectedAccountRefreshResult & Readonly<{
        status: 'outcomeUnknown';
      }>;
      basis: QualifiedConnectedAccountEstablishedInvocationBasis;
    }>;

function createStagedCredentialStore(): Readonly<{
  store: PluginConnectedAccountCredentialStore;
  readMutation(): Readonly<{
    set: Readonly<Record<string, string>>;
    delete: readonly string[];
  }>;
}> {
  const set = new Map<string, string>();
  const deleted = new Set<string>();
  const store: PluginConnectedAccountCredentialStore = Object.freeze({
    async get(
      key: string,
      options?: Readonly<{ signal?: AbortSignal }>,
    ) {
      options?.signal?.throwIfAborted();
      return deleted.has(key) ? null : set.get(key) ?? null;
    },
    async set(
      key: string,
      value: string,
      options?: Readonly<{ signal?: AbortSignal }>,
    ) {
      options?.signal?.throwIfAborted();
      deleted.delete(key);
      set.set(key, value);
    },
    async delete(
      key: string,
      options?: Readonly<{ signal?: AbortSignal }>,
    ) {
      options?.signal?.throwIfAborted();
      set.delete(key);
      deleted.add(key);
    },
  });
  return Object.freeze({
    store,
    readMutation() {
      return Object.freeze({
        set: Object.freeze(Object.fromEntries(set)),
        delete: Object.freeze([...deleted].sort()),
      });
    },
  });
}

export async function refreshQualifiedConnectedAccount(input: Readonly<{
  account: QualifiedConnectedAccountRef;
  token: string;
  ownerId: string;
  leaseMs: number;
  operationId: string;
  reason?: 'provider_context';
  expectedCredential: QualifiedConnectedAccountCredentialSnapshotV4;
  signal?: AbortSignal;
  establishedRuntimeOwner: Pick<
    QualifiedConnectedAccountEstablishedRuntimeOwner,
    'invokeWithReceipt'
  >;
  resolveV4Support: () => QualifiedConnectedAccountV4Support;
  acquireRefreshLease?: RefreshLeaseClient;
  mutateCredential?: CredentialMutationClient;
}>): Promise<QualifiedConnectedAccountRefreshSettlement> {
  const support = input.resolveV4Support();
  if (support !== 'advertised') {
    throw new QualifiedConnectedAccountCompatibilityError(
      support === 'indeterminate'
        ? 'connected_account_capability_indeterminate'
        : 'connected_account_legacy_operation_unsupported',
    );
  }
  const expectedCredential =
    createStoredReadSchema(QualifiedConnectedAccountCredentialSnapshotV4Schema).parse(
      input.expectedCredential,
    );
  if (!sameQualifiedConnectedAccountRef(input.account, expectedCredential.ref)) {
    throw new Error(
      'Qualified Connected Account refresh snapshot does not match the exact account',
    );
  }
  if (expectedCredential.revisionSemantics !== 'revisioned') {
    throw new Error(
      'Qualified Connected Account refresh requires a revisioned credential snapshot',
    );
  }
  const ownerId = input.ownerId.trim();
  if (!ownerId) {
    throw new Error(
      'Qualified Connected Account refresh lease owner is unavailable',
    );
  }
  const operationId = input.operationId.trim();
  if (!operationId) {
    throw new Error(
      'Qualified Connected Account refresh operation id is unavailable',
    );
  }
  const acquireRefreshLease =
    input.acquireRefreshLease
    ?? acquireQualifiedConnectedAccountRefreshLeaseV4;
  const lease = await acquireRefreshLease({
    token: input.token,
    lease: Object.freeze({
      ref: input.account,
      expectedCredentialRevision:
        expectedCredential.credentialRevision,
      ownerId,
      ttlMs: input.leaseMs,
    }),
  });
  if (
    !lease.acquired
    || lease.ownerId !== ownerId
    || lease.credentialRevision !== expectedCredential.credentialRevision
  ) {
    throw new QualifiedConnectedAccountRefreshLeaseError(
      lease.credentialRevision !== expectedCredential.credentialRevision
        ? 'connected_account_refresh_lease_revision_mismatch'
        : lease.ownerId !== ownerId
          ? 'connected_account_refresh_lease_owner_mismatch'
          : 'connected_account_refresh_lease_not_acquired',
    );
  }

  let leaseCurrent = true;
  let renewalInFlight: Promise<void> = Promise.resolve();
  const renewalEveryMs = Math.max(
    1_000,
    Math.trunc(input.leaseMs / 2),
  );
  const renewalTimer = setInterval(() => {
    renewalInFlight = renewalInFlight.then(async () => {
      const renewed = await acquireRefreshLease({
        token: input.token,
        lease: Object.freeze({
          ref: input.account,
          expectedCredentialRevision:
            expectedCredential.credentialRevision,
          ownerId,
          ttlMs: input.leaseMs,
        }),
      });
      if (
        !renewed.acquired
        || renewed.ownerId !== ownerId
        || renewed.credentialRevision
          !== expectedCredential.credentialRevision
      ) {
        leaseCurrent = false;
      }
    }).catch(() => {
      leaseCurrent = false;
    });
  }, renewalEveryMs);
  (renewalTimer as unknown as { unref?: () => void }).unref?.();

  const staged = createStagedCredentialStore();
  let invocation: Readonly<{
    result: PluginConnectedAccountRefreshResult;
    basis: QualifiedConnectedAccountEstablishedInvocationBasis;
  }>;
  try {
    invocation =
      await input.establishedRuntimeOwner.invokeWithReceipt({
        account: input.account,
        expectedCredentialRevision: expectedCredential.credentialRevision,
        operation: Object.freeze({
          kind: input.reason === 'provider_context' ? 'enrichCredentialContext' as const : 'refresh' as const,
          operationId,
          stagedCredentials: staged.store,
        }),
        ...(input.signal ? { signal: input.signal } : {}),
      });
  } finally {
    clearInterval(renewalTimer);
    await renewalInFlight;
  }
  const mutation = staged.readMutation();
  const hasCredentialMutation = Object.keys(mutation.set).length > 0 || mutation.delete.length > 0;
  // A completed refresh can consume a single-use token; finish its replacement
  // even if the caller no longer needs the result.
  const settlementSignal = input.reason === 'provider_context' ? input.signal : undefined;
  let persistenceOutcome: QualifiedConnectedAccountRefreshSettlementError['persistenceOutcome'] = 'not_attempted';
  try {
    settlementSignal?.throwIfAborted();
    const configurationRevision =
      invocation.basis.credentialConfigurationRevision;
    if (
      !leaseCurrent
      || invocation.basis.credentialRevision
        !== expectedCredential.credentialRevision
      || configurationRevision
        !== expectedCredential.configurationRevision
      || (input.reason === 'provider_context' && !invocation.basis.isCurrent())
    ) {
      throw new Error(
        'Qualified Connected Account refresh invocation no longer matches its exact lease and snapshot basis',
      );
    }

    if (invocation.result.status === 'outcomeUnknown') {
      return Object.freeze({
        status: 'outcome_unknown' as const,
        result: invocation.result,
        basis: invocation.basis,
      });
    }
    if (invocation.result.status !== 'connected') {
      return Object.freeze({
        status: 'not_connected' as const,
        result: invocation.result,
        basis: invocation.basis,
      });
    }

    if (!hasCredentialMutation) {
      return Object.freeze({
        status: 'unchanged' as const,
        result: invocation.result,
        basis: invocation.basis,
      });
    }
    const replacement =
      await invocation.basis.prepareCredentialReplacement({
        ...mutation,
        metadata: {
          ...(invocation.result.providerIdentity
            ? { providerIdentity: invocation.result.providerIdentity }
            : {}),
          ...(invocation.result.displayName
            ? { displayName: invocation.result.displayName }
            : {}),
          ...(invocation.result.scopes
            ? { scopes: invocation.result.scopes }
            : {}),
        },
      });
    settlementSignal?.throwIfAborted();
    if ((input.reason === 'provider_context' && !invocation.basis.isCurrent()) || !leaseCurrent) {
      throw new Error(
        'Qualified Connected Account refresh generation or lease changed before credential settlement',
      );
    }
    const mutateCredential =
      input.mutateCredential
      ?? mutateQualifiedConnectedAccountCredentialV4;
    persistenceOutcome = 'unknown';
    const settled = await mutateCredential({
      token: input.token,
      ...(settlementSignal ? { signal: settlementSignal } : {}),
      mutation: Object.freeze({
        ref: input.account,
        authenticationModeId: replacement.authenticationModeId,
        content: replacement.content,
        metadata: replacement.metadata,
        expectedCredentialRevision:
          invocation.basis.credentialRevision,
        expectedConfigurationRevision: configurationRevision,
        refreshLeaseOwnerId: ownerId,
      }),
    });
    persistenceOutcome = 'confirmed';
    if (
      settled.credentialRevision === invocation.basis.credentialRevision
      || settled.configurationRevision !== configurationRevision
      || (input.reason === 'provider_context' && !invocation.basis.isCurrent())
      || !leaseCurrent
    ) {
      throw new Error(
        'Qualified Connected Account refresh mutation did not settle against the exact current invocation basis',
      );
    }
    return Object.freeze({
      status: 'refreshed' as const,
      credentialRevision: settled.credentialRevision,
      metadata: replacement.metadata,
      result: invocation.result,
      basis: invocation.basis,
    });
  } catch (error) {
    if (input.reason !== 'provider_context' && invocation.result.status === 'connected' && hasCredentialMutation) {
      throw new QualifiedConnectedAccountRefreshSettlementError(persistenceOutcome, error);
    }
    throw error;
  }
}
