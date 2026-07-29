import {
  QualifiedConnectedAccountCredentialSnapshotV4Schema,
  type QualifiedConnectedAccountCredentialSnapshotV4,
  type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';
import type {
  PluginConnectedAccountHealthResult,
  PluginConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/runtime';

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

export type QualifiedConnectedAccountRefreshSettlement =
  | Readonly<{
      status: 'refreshed';
      credentialRevision: string;
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

function sameAccount(
  left: QualifiedConnectedAccountRef,
  right: QualifiedConnectedAccountRef,
): boolean {
  return left.service.pluginId === right.service.pluginId
    && left.service.localId === right.service.localId
    && left.accountId === right.accountId;
}

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
    QualifiedConnectedAccountCredentialSnapshotV4Schema.parse(
      input.expectedCredential,
    );
  if (!sameAccount(input.account, expectedCredential.ref)) {
    throw new Error(
      'Qualified Connected Account refresh snapshot does not match the exact account',
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
    throw new Error(
      'Qualified Connected Account refresh lease was not acquired for the exact credential revision',
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
        operation: Object.freeze({
          kind: 'refresh' as const,
          operationId,
          stagedCredentials: staged.store,
        }),
        ...(input.signal ? { signal: input.signal } : {}),
      });
  } finally {
    clearInterval(renewalTimer);
    await renewalInFlight;
  }
  const configurationRevision =
    invocation.basis.credentialConfigurationRevision;
  if (
    !leaseCurrent
    || invocation.basis.credentialRevision
      !== expectedCredential.credentialRevision
    || configurationRevision
      !== expectedCredential.configurationRevision
    || !invocation.basis.isCurrent()
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

  const mutation = staged.readMutation();
  if (
    Object.keys(mutation.set).length === 0
    && mutation.delete.length === 0
  ) {
    return Object.freeze({
      status: 'unchanged' as const,
      result: invocation.result,
      basis: invocation.basis,
    });
  }
  const replacement =
    invocation.basis.prepareCredentialReplacement({
      ...mutation,
      metadata: {
        ...(invocation.result.displayName
          ? { displayName: invocation.result.displayName }
          : {}),
        ...(invocation.result.scopes
          ? { scopes: invocation.result.scopes }
          : {}),
      },
    });
  if (!invocation.basis.isCurrent() || !leaseCurrent) {
    throw new Error(
      'Qualified Connected Account refresh generation or lease changed before credential settlement',
    );
  }
  const mutateCredential =
    input.mutateCredential
    ?? mutateQualifiedConnectedAccountCredentialV4;
  const settled = await mutateCredential({
    token: input.token,
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
  if (
    settled.credentialRevision === invocation.basis.credentialRevision
    || settled.configurationRevision !== configurationRevision
    || !invocation.basis.isCurrent()
    || !leaseCurrent
  ) {
    throw new Error(
      'Qualified Connected Account refresh mutation did not settle against the exact current invocation basis',
    );
  }
  return Object.freeze({
    status: 'refreshed' as const,
    credentialRevision: settled.credentialRevision,
    result: invocation.result,
    basis: invocation.basis,
  });
}
