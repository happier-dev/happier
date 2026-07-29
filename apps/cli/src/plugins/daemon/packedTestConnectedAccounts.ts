import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { PluginError } from '@happier-dev/plugin-sdk';
import type {
  PluginConnectedAccountMaterialization,
  PluginConnectedAccountMaterializationRequest,
  PluginContributionRef,
} from '@happier-dev/plugin-sdk/runtime';
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

function selectRequestedValues(
  requested: readonly string[],
  values: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(requested.flatMap((key) => (
    Object.prototype.hasOwnProperty.call(values, key) ? [[key, values[key]!]] : []
  ))));
}

function materializationFor(
  request: PluginConnectedAccountMaterializationRequest,
  values: Readonly<{
    headers?: Readonly<Record<string, string>>;
    environment?: Readonly<Record<string, string>>;
    files?: Readonly<Record<string, string>>;
  }>,
): PluginConnectedAccountMaterialization {
  if (request.kind === 'httpHeaders') {
    return Object.freeze({
      kind: 'httpHeaders',
      headers: selectRequestedValues(request.headerNames, values.headers ?? {}),
    });
  }
  if (request.kind === 'environment') {
    return Object.freeze({
      kind: 'environment',
      env: selectRequestedValues(request.keys, values.environment ?? {}),
    });
  }
  const encoded = Object.fromEntries(request.fileIds.flatMap((fileId) => {
    const value = values.files?.[fileId];
    return value === undefined ? [] : [[fileId, new TextEncoder().encode(value)]];
  }));
  return Object.freeze({
    kind: 'files',
    files: Object.freeze(encoded),
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
    request: PluginConnectedAccountMaterializationRequest;
    signal: AbortSignal;
  }>): Promise<PluginConnectedAccountMaterialization> => {
    input.signal.throwIfAborted();
    switch (input.account.accountId) {
      case 'fixed':
        return materializationFor(input.request, {
          headers: { authorization: 'Bearer packed-header-secret' },
          environment: { FIXED_TOKEN: 'packed-environment-secret' },
          files: { credential: 'packed-file-secret' },
        });
      case 'multi':
        return materializationFor(input.request, {
          environment: { MULTI_TOKEN: 'packed-alternate-secret' },
        });
      case 'alpha':
        await serializeMutation((current) => ({
          next: { ...current, groupMember: 'beta' },
          result: undefined,
          notifyInvalidations: true,
        }));
        input.signal.throwIfAborted();
        return materializationFor(input.request, {
          environment: { GROUP_TOKEN: 'packed-group-alpha-secret' },
        });
      case 'beta':
        return materializationFor(input.request, {
          environment: { GROUP_TOKEN: 'packed-group-beta-secret' },
        });
      case 'replaceable-1':
        return materializationFor(input.request, {
          environment: { REPLACEABLE_TOKEN: 'packed-replacement-one-secret' },
        });
      case 'replaceable-2':
        return materializationFor(input.request, {
          environment: { REPLACEABLE_TOKEN: 'packed-replacement-two-secret' },
        });
      case 'revocable':
        await serializeMutation((current) => ({
          next: { ...current, revocableAccountRevoked: true },
          result: undefined,
          notifyInvalidations: true,
        }));
        input.signal.throwIfAborted();
        return materializationFor(input.request, {
          environment: { REVOCABLE_TOKEN: 'packed-revocable-secret' },
        });
      case 'rotating': {
        const materializer = await serializeMutation((current) => ({
          next: {
            ...current,
            rotatingMaterializer: 2,
          },
          result: current.rotatingMaterializer,
          notifyInvalidations: current.rotatingMaterializer === 1,
        }));
        input.signal.throwIfAborted();
        return materializationFor(input.request, {
          environment: {
            ROTATING_TOKEN: materializer === 1
              ? 'packed-materializer-one-secret'
              : 'packed-materializer-two-secret',
          },
        });
      }
      default:
        return materializationFor(input.request, {
          environment: { TOKEN: 'packed-generic-secret' },
        });
    }
  };

  const bindingOwner = createConnectedAccountPurposeBindingOwner({
    store,
    selectTarget: async (input) => await selectTarget(input),
    resolveTarget,
    materializeAccount,
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
    owner: bindingOwner,
    async reconcileRegistryPublication(input) {
      const signal = new AbortController().signal;
      const persistedBindings = await store.read(signal);
      await bindingOwner.reconcileAuthorizedPurposes({
        consumerScopes: deriveRegistryConnectedAccountPurposeReconciliationScopes(
          input.previous,
          input.candidate,
          persistedBindings.bindings.map((binding) => binding.purpose.consumer),
          input.resolveOptionalAccess,
        ),
        signal,
        publish: input.publish,
      });
    },
  });
}
