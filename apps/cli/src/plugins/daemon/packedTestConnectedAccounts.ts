import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { PluginError } from '@happier-dev/plugin-sdk';
import type {
  ConnectedAccountMaterializationRequest,
  ConnectedAccountMaterialization as PluginConnectedAccountMaterialization,
  ConnectedAccountRuntimeConfiguration,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type {
  PluginContributionRef,
} from '@happier-dev/plugin-sdk';
import {
  QualifiedConnectedAccountPurposeBindingsV1Schema,
  type QualifiedConnectedAccountPurposeBindingsV1,
  type QualifiedConnectedAccountPurposeBindingTargetV1,
  type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';

import {
  createConnectedAccountPurposeBindingOwner,
  type ConnectedAccountPurposeBindingStore,
  type ConnectedAccountPurposeResolvedTarget,
} from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import {
  deriveRegistryConnectedAccountPurposeReconciliationScopes,
} from '@/daemon/connectedServices/purposeBindings/deriveRegistryConnectedAccountPurposeAuthorizations';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type {
  StablePluginConnectedAccountsAuthorizedPurpose,
  StablePluginConnectedAccountsOwner,
} from '@/plugins/runtime/invocation/services/connectedAccounts';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import type { PluginAccessSelection } from '@/plugins/store/install/accessScopeRegistry';

type PackedConnectedAccountsState = Readonly<{
  bindings: QualifiedConnectedAccountPurposeBindingsV1;
  groupMember: 'alpha' | 'beta';
  replacementIndex: 0 | 1 | 2;
  rotatingMaterializer: 1 | 2;
  revocableAccountRevoked: boolean;
}>;

export type PackedTestConnectedAccountsRuntime = Readonly<{
  owner: StablePluginConnectedAccountsOwner;
  reconcileRegistryPublication(input: Readonly<{
    previous: ResolvedContributionRegistry | null;
    candidate: ResolvedContributionRegistry;
    candidateActivePluginIds?: ReadonlySet<string>;
    resolveOptionalAccess(pluginId: string): readonly PluginAccessSelection[];
    publish(): void;
  }>): Promise<void>;
}>;

const EMPTY_BINDINGS = Object.freeze(
  QualifiedConnectedAccountPurposeBindingsV1Schema.parse({ v: 1, bindings: [] }),
);
const EMPTY_STATE: PackedConnectedAccountsState = Object.freeze({
  bindings: EMPTY_BINDINGS,
  groupMember: 'alpha',
  replacementIndex: 0,
  rotatingMaterializer: 1,
  revocableAccountRevoked: false,
});

function unavailable(message: string): PluginError {
  return new PluginError({
    code: 'plugin_host_access_resource_not_selected',
    message,
  });
}

function snapshotState(input: PackedConnectedAccountsState): PackedConnectedAccountsState {
  return Object.freeze({
    bindings: Object.freeze(
      QualifiedConnectedAccountPurposeBindingsV1Schema.parse(input.bindings),
    ),
    groupMember: input.groupMember,
    replacementIndex: input.replacementIndex,
    rotatingMaterializer: input.rotatingMaterializer,
    revocableAccountRevoked: input.revocableAccountRevoked,
  });
}

function readState(path: string): PackedConnectedAccountsState {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PackedConnectedAccountsState>;
    const bindings = QualifiedConnectedAccountPurposeBindingsV1Schema.safeParse(parsed.bindings);
    return snapshotState({
      bindings: bindings.success ? bindings.data : EMPTY_BINDINGS,
      groupMember: parsed.groupMember === 'beta' ? 'beta' : 'alpha',
      replacementIndex: parsed.replacementIndex === 1 || parsed.replacementIndex === 2
        ? parsed.replacementIndex
        : 0,
      rotatingMaterializer: parsed.rotatingMaterializer === 2 ? 2 : 1,
      revocableAccountRevoked: parsed.revocableAccountRevoked === true,
    });
  } catch {
    return EMPTY_STATE;
  }
}

function firstService(
  input: StablePluginConnectedAccountsAuthorizedPurpose,
  preferredLocalId?: string,
): PluginContributionRef {
  const service = preferredLocalId
    ? input.serviceRefs.find((candidate) => candidate.localId === preferredLocalId)
    : input.serviceRefs[0];
  if (!service) {
    throw unavailable('The packed conformance purpose has no authorized Connected Account service');
  }
  return Object.freeze({
    pluginId: service.pluginId,
    localId: service.localId,
  });
}

function accountDisplayName(accountId: string): string {
  if (accountId === 'multi') return 'Alternate conformance account';
  if (accountId === 'replaceable-1') return 'Replaceable account 1';
  if (accountId === 'replaceable-2') return 'Replaceable account 2';
  return `${accountId} conformance account`;
}

/**
 * The packed host composes the production purpose-binding owner. This fixture
 * supplies only deterministic filesystem, selection, account-projection, and
 * materializer boundaries so packed proof still crosses the canonical owner.
 */
export function createPackedTestConnectedAccountsRuntime(params: Readonly<{
  happyHomeDir: string;
  pluginId: string;
  /**
   * The packed daemon's incumbent registry lifecycle. The materializer must
   * use its canonical producer invoker rather than manufacture credentials.
   */
  runtimeRegistry?: Pick<
    PluginReloadController,
    'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent'
  >;
}>): PackedTestConnectedAccountsRuntime {
  const statePath = join(
    params.happyHomeDir,
    'packed-test',
    'connected-accounts',
    `${params.pluginId}.json`,
  );
  let state = readState(statePath);
  let mutationTail = Promise.resolve();
  const bindingListeners = new Set<() => void>();
  const invalidationListeners = new Set<() => void>();

  const persistCurrentState = async (): Promise<void> => {
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, `${JSON.stringify(state)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  };
  const serializeMutation = async <T>(
    mutate: (current: PackedConnectedAccountsState) => Readonly<{
      next: PackedConnectedAccountsState;
      result: T;
      notifyBindings?: boolean;
      notifyInvalidations?: boolean;
    }>,
  ): Promise<T> => {
    let result!: T;
    const operation = mutationTail.then(async () => {
      const mutation = mutate(state);
      state = snapshotState(mutation.next);
      result = mutation.result;
      await persistCurrentState();
      if (mutation.notifyBindings) {
        for (const listener of bindingListeners) listener();
      }
      if (mutation.notifyInvalidations) {
        for (const listener of invalidationListeners) listener();
      }
    });
    mutationTail = operation.catch(() => undefined);
    await operation;
    return result;
  };
  const readCurrentState = async (): Promise<PackedConnectedAccountsState> => {
    await mutationTail;
    return state;
  };

  const store: ConnectedAccountPurposeBindingStore = Object.freeze({
    async read(signal) {
      signal?.throwIfAborted();
      const current = await readCurrentState();
      signal?.throwIfAborted();
      return current.bindings;
    },
    async update(mutate, signal) {
      signal?.throwIfAborted();
      return await serializeMutation((current) => {
        signal?.throwIfAborted();
        const bindings = QualifiedConnectedAccountPurposeBindingsV1Schema.parse(
          mutate(current.bindings),
        );
        return {
          next: { ...current, bindings },
          result: bindings,
          notifyBindings: true,
        };
      });
    },
    subscribe(listener) {
      bindingListeners.add(listener);
      return Object.freeze({
        dispose() {
          bindingListeners.delete(listener);
        },
      });
    },
  });

  const assertFixtureConsumer = (
    input: StablePluginConnectedAccountsAuthorizedPurpose,
  ): void => {
    if (input.purpose.consumer.pluginId !== params.pluginId) {
      throw unavailable('The packed Connected Accounts fixture is not available to this plugin');
    }
  };
  const selectTarget = async (
    input: StablePluginConnectedAccountsAuthorizedPurpose & Readonly<{
      signal: AbortSignal;
    }>,
  ): Promise<QualifiedConnectedAccountPurposeBindingTargetV1> => {
    assertFixtureConsumer(input);
    input.signal.throwIfAborted();
    const purpose = input.purpose.purpose;
    const service = firstService(input, purpose === 'multi' ? 'archive' : undefined);
    if (purpose === 'group') {
      return Object.freeze({
        kind: 'group',
        service,
        groupId: 'packed-conformance-group',
      });
    }
    const accountId = await serializeMutation((current) => {
      const replacementIndex = purpose === 'replaceable'
        ? current.replacementIndex === 1 ? 2 : 1
        : current.replacementIndex;
      const selectedAccountId = purpose === 'replaceable'
        ? `replaceable-${replacementIndex}`
        : purpose === 'multi'
          ? 'multi'
          : purpose;
      return {
        next: {
          ...current,
          replacementIndex,
          ...(purpose === 'revocable' ? { revocableAccountRevoked: false } : {}),
        },
        result: selectedAccountId,
      };
    });
    input.signal.throwIfAborted();
    return Object.freeze({
      kind: 'account',
      account: Object.freeze({ service, accountId }),
    });
  };
  const resolveTarget = async (
    target: QualifiedConnectedAccountPurposeBindingTargetV1,
    signal: AbortSignal,
  ): Promise<ConnectedAccountPurposeResolvedTarget | null> => {
    signal.throwIfAborted();
    const current = await readCurrentState();
    signal.throwIfAborted();
    if (target.kind === 'group') {
      return Object.freeze({
        displayName: 'Packed conformance group',
        account: Object.freeze({
          service: Object.freeze({ ...target.service }),
          accountId: current.groupMember,
        }),
      });
    }
    if (
      target.account.accountId === 'revocable'
      && current.revocableAccountRevoked
    ) {
      return null;
    }
    return Object.freeze({
      displayName: accountDisplayName(target.account.accountId),
      account: Object.freeze({
        service: Object.freeze({ ...target.account.service }),
        accountId: target.account.accountId,
      }),
    });
  };
  const materializeAccount = async (input: Readonly<{
    account: QualifiedConnectedAccountRef;
    credentialRevisionBasis?: Readonly<{
      captureCredentialRevision(credentialRevision: string): void;
    }>;
    request: ConnectedAccountMaterializationRequest;
    signal: AbortSignal;
  }>): Promise<PluginConnectedAccountMaterialization> => {
    input.signal.throwIfAborted();
    const registryLifecycle = params.runtimeRegistry;
    if (!registryLifecycle) {
      throw unavailable('The packed Connected Accounts runtime registry is unavailable');
    }
    const registryLease = await registryLifecycle.acquireRuntimeRegistry();
    try {
      const runtimeRegistry = registryLease.registry;
      const runtimeLease = await runtimeRegistry.resolveConnectedAccountRuntime?.(
        input.account.service,
      );
      const invoker = runtimeRegistry.connectedAccountRuntimeInvoker;
      if (
        !runtimeLease
        || !invoker
        || !registryLifecycle.isRuntimeRegistryCurrent(runtimeRegistry)
        || !runtimeLease.isCurrent()
      ) {
        throw unavailable('The selected packed Connected Account producer is unavailable');
      }
      const mode = runtimeLease.descriptor.authentication.modes.find((candidate) => (
        candidate.id === runtimeLease.descriptor.authentication.defaultModeId
      ));
      if (!mode || mode.kind !== 'manual') {
        throw unavailable('The selected packed Connected Account producer has no manual authentication mode');
      }
      const configuration: ConnectedAccountRuntimeConfiguration = Object.freeze({
        target: Object.freeze(
          mode.configuration?.scope === 'account'
            ? {
              kind: 'account' as const,
              account: input.account,
              modeId: mode.id,
            }
            : {
              kind: 'service' as const,
              service: input.account.service,
              modeId: mode.id,
            },
        ),
        revision: 'packed-test-configuration-1',
        values: Object.freeze({}),
        getSecret: async () => null,
      });
      const credentialValues = new Map<string, string>();
      const attemptCredentials = Object.freeze({
        async get(key: string) {
          return credentialValues.get(key) ?? null;
        },
        async set(key: string, value: string) {
          credentialValues.set(key, value);
        },
        async delete(key: string) {
          credentialValues.delete(key);
        },
      });
      const isCurrent = () => (
        registryLifecycle.isRuntimeRegistryCurrent(runtimeRegistry)
        && runtimeLease.isCurrent()
      );
      const assertCurrent = (): void => {
        input.signal.throwIfAborted();
        if (!isCurrent()) {
          throw unavailable('The selected packed Connected Account producer is no longer current');
        }
      };
      const authentication = await invoker.invokeAuthentication({
        admission: Object.freeze({
          service: runtimeLease.ref,
          descriptor: mode,
          modeId: mode.id,
          generation: runtimeLease.generation,
          immutableGenerationId: runtimeLease.immutableGenerationId,
        }),
        operation: Object.freeze({
          kind: 'submitManual' as const,
          fields: Object.freeze({ token: 'packed-test-token' }),
        }),
        context: Object.freeze({
          service: runtimeLease.ref,
          attempt: Object.freeze({
            kind: 'connect' as const,
            attemptId: `packed-test-${input.account.accountId}`,
          }),
          configuration,
          attemptCredentials,
        }),
        isConfigurationCurrent: () => isCurrent(),
        signal: input.signal,
      });
      if (
        typeof authentication !== 'object'
        || authentication === null
        || !('status' in authentication)
        || authentication.status !== 'connected'
      ) {
        throw unavailable('The selected packed Connected Account producer did not authenticate');
      }
      assertCurrent();
      const target = Object.freeze({
        account: input.account,
        expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        expectedRuntimeConfigurationRevision: configuration.revision,
      });
      const context = Object.freeze({
        account: input.account,
        configuration,
        credentials: Object.freeze({
          async get(key: string) {
            return credentialValues.get(key) ?? null;
          },
        }),
      });
      const refresh = await invoker.invokeEstablished({
        target,
        operation: Object.freeze({
          kind: 'refresh' as const,
          operationId: `packed-test-refresh-${input.account.accountId}`,
          stagedCredentials: attemptCredentials,
        }),
        context,
        isConfigurationCurrent: () => isCurrent(),
        isCredentialRevisionCurrent: () => isCurrent(),
        signal: input.signal,
      });
      if (refresh.status !== 'connected') {
        throw unavailable('The selected packed Connected Account producer did not refresh');
      }
      assertCurrent();
      const materialization = await invoker.invokeEstablished({
        target,
        operation: Object.freeze({ kind: 'materialize' as const, request: input.request }),
        context,
        isConfigurationCurrent: () => isCurrent(),
        isCredentialRevisionCurrent: () => isCurrent(),
        signal: input.signal,
      });
      assertCurrent();
      if (input.account.accountId === 'alpha') {
        await serializeMutation((current) => ({
          next: { ...current, groupMember: 'beta' },
          result: undefined,
          notifyInvalidations: true,
        }));
      } else if (input.account.accountId === 'revocable') {
        await serializeMutation((current) => ({
          next: { ...current, revocableAccountRevoked: true },
          result: undefined,
          notifyInvalidations: true,
        }));
      } else if (input.account.accountId === 'rotating') {
        await serializeMutation((current) => ({
          next: {
            ...current,
            rotatingMaterializer: 2,
          },
          result: undefined,
          notifyInvalidations: current.rotatingMaterializer === 1,
        }));
      }
      assertCurrent();
      input.credentialRevisionBasis?.captureCredentialRevision(
        'csr_0123456789ABCDEFGHJKMNPQRS',
      );
      return materialization;
    } finally {
      await registryLease.release();
    }
  };

  const bindingOwner = createConnectedAccountPurposeBindingOwner({
    store,
    selectTarget: async (input) => await selectTarget(input),
    resolveTarget,
    materializeAccount,
    async projectTargetAccounts() {
      throw unavailable(
        'Packed test Connected Accounts harness exposes no purpose-scoped account listing',
      );
    },
    async assertTargetAccountMaterializable() {
      throw unavailable(
        'Packed test Connected Accounts harness exposes no exact-listed materialization',
      );
    },
    subscribeInvalidations(listener) {
      invalidationListeners.add(listener);
      return Object.freeze({
        dispose() {
          invalidationListeners.delete(listener);
        },
      });
    },
  });

  return Object.freeze({
    // The packed author vertical exercises binding selection and materialization
    // only. It owns no account inventory, so the purpose-scoped listing seam
    // fails closed here instead of reporting an unverified empty inventory.
    owner: Object.freeze({
      ...bindingOwner,
      async listAccounts() {
        throw unavailable(
          'Packed test Connected Accounts harness exposes no purpose-scoped account listing',
        );
      },
      async materializeListedAccount() {
        throw unavailable(
          'Packed test Connected Accounts harness exposes no exact-listed materialization',
        );
      },
    }),
    async reconcileRegistryPublication(input) {
      const signal = new AbortController().signal;
      await bindingOwner.reconcileAuthorizedPurposes({
        consumerScopes: deriveRegistryConnectedAccountPurposeReconciliationScopes(
          input.previous,
          input.candidate,
          input.resolveOptionalAccess,
          { candidateActivePluginIds: input.candidateActivePluginIds },
        ),
        signal,
        publish: input.publish,
      });
    },
  });
}
