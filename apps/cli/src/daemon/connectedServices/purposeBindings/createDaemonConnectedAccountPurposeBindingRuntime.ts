import {
  ConnectedAccountUiProjectionEntryV1Schema,
  ConnectedServiceIdSchema,
  buildQualifiedPluginContributionKey,
  createPluginContributionIdentity,
  type ConnectedServiceId,
  type QualifiedConnectedAccountGroupV4,
  type QualifiedConnectedAccountProfileV4,
  type QualifiedConnectedAccountPurposeBindingTargetV1,
  type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';
import type {
  PluginConnectedAccountMaterialization,
  PluginConnectedAccountMaterializationRequest,
  PluginContributionRef,
} from '@happier-dev/plugin-sdk/runtime';

import type { ApiClient } from '@/api/api';
import type {
  QualifiedConnectedAccountPeerOperationTransport,
} from '@/api/client/qualifiedConnectedAccountApi';
import { connectedAccountProjectionFamily } from '@/plugins/projection/registry/connectedAccounts';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { createPluginInvocationUi } from '@/plugins/runtime/invocation/services/ui';
import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import type { PluginAccessSelection } from '@/plugins/store/install/accessScopeRegistry';

import {
  createActiveAccountSettingsConnectedAccountPurposeBindingStore,
  createConnectedAccountPurposeBindingOwner,
  type ConnectedAccountPurposeBindingOwner,
  type ConnectedAccountPurposeBindingStore,
  type ConnectedAccountPurposeResolvedTarget,
} from './ConnectedAccountPurposeBindingOwner';
import {
  deriveRegistryConnectedAccountPurposeReconciliationScopes,
} from './deriveRegistryConnectedAccountPurposeAuthorizations';
import type {
  QualifiedConnectedAccountV4Support,
} from '../qualifiedConnectedAccountV4Support';
import type {
  RevisionedLegacyConnectedAccountMaterializationOwner,
} from '../qualifiedConnectedAccountEstablishedRuntimeOwner';

type ConnectedAccountPurposeBindingApi = Pick<
  ApiClient,
  | 'getAccountEncryptionMode'
  | 'getConnectedServiceAuthGroup'
  | 'getConnectedServiceCredentialPlain'
  | 'getConnectedServiceCredentialSealed'
  | 'listConnectedServiceAuthGroups'
  | 'listConnectedServiceProfiles'
>;

type QualifiedConnectedAccountMaterializationOwner = Readonly<{
  invoke(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    operation: Readonly<{
      kind: 'materialize';
      request: PluginConnectedAccountMaterializationRequest;
    }>;
    signal?: AbortSignal;
  }>): Promise<PluginConnectedAccountMaterialization>;
}>;

type ResolvedDaemonConnectedAccountService = Readonly<{
  service: QualifiedConnectedAccountRef['service'];
  legacyServiceId: ConnectedServiceId | null;
  availability: 'available' | 'unavailable';
}>;
type DaemonConnectedAccountSelectionProfile = Readonly<{
  profileId: string;
  status: string;
  providerAccountId?: string | null;
  providerEmail?: string | null;
  displayName?: string;
}>;
type DaemonConnectedAccountSelectionGroup = Readonly<{
  groupId: string;
  displayName: string | null;
  activeAccountId: string | null;
  members: readonly Readonly<{
    accountId: string;
    enabled: boolean;
  }>[];
}>;

type DaemonConnectedAccountRegistryLease = Readonly<{
  generation: string;
  isCurrent(): boolean;
  resolveService(service: PluginContributionRef): ResolvedDaemonConnectedAccountService | null;
  listServices?(): readonly ResolvedDaemonConnectedAccountService[];
  release(): Promise<void>;
}>;

export type DaemonConnectedAccountRuntimeRegistry = Readonly<{
  acquire(): Promise<DaemonConnectedAccountRegistryLease>;
  subscribe(listener: () => void): () => void;
}>;

export type DaemonConnectedAccountPurposeBindingRuntime = Readonly<{
  owner: StablePluginConnectedAccountsOwner;
  activatePurposeBindings:
    ConnectedAccountPurposeBindingOwner['activatePurposeBindings'];
  activateSessionPurposeBindings:
    ConnectedAccountPurposeBindingOwner['activateSessionPurposeBindings'];
  resolveBindingIntent: ConnectedAccountPurposeBindingOwner['resolveBindingIntent'];
  listCoordinatorAccounts(
    signal?: AbortSignal,
  ): Promise<readonly QualifiedConnectedAccountProfileV4[]>;
  reconcileRegistryPublication(input: Readonly<{
    previous: ResolvedContributionRegistry | null;
    candidate: ResolvedContributionRegistry;
    resolveOptionalAccess(pluginId: string): readonly PluginAccessSelection[];
    publish(): void;
  }>): Promise<void>;
  bindSessionRestartOwner(owner: DaemonConnectedAccountPurposeSessionRestartOwner): void;
  subscribeInvalidations(listener: () => void): () => void;
  invalidate(): void;
}>;

export type DaemonConnectedAccountPurposeSessionRestartOwner = (
  input: Readonly<{
    sessionId: string;
    purpose: Parameters<StablePluginConnectedAccountsOwner['watch']>[0]['purpose'];
  }>,
) => void;

function qualifiedContributionKey(ref: PluginContributionRef): string {
  return buildQualifiedPluginContributionKey(createPluginContributionIdentity(ref));
}

function parseLegacyServiceId(value: string): ConnectedServiceId | null {
  const parsed = ConnectedServiceIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function createRuntimeRegistryAccess(
  reloadController: Pick<
    PluginReloadController,
    'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent' | 'subscribe'
  >,
): DaemonConnectedAccountRuntimeRegistry {
  const access: DaemonConnectedAccountRuntimeRegistry = {
    subscribe(listener) {
      return reloadController.subscribe(() => listener());
    },
    async acquire() {
      const lease = await reloadController.acquireRuntimeRegistry();
      const projected = connectedAccountProjectionFamily.project({
        generation: 0,
        registry: lease.registry.contributes,
      });
      return Object.freeze({
        generation: lease.registry.contributes.generationId ?? 'current',
        isCurrent: () => reloadController.isRuntimeRegistryCurrent(lease.registry),
        resolveService(service: PluginContributionRef) {
          const parsedEntry = ConnectedAccountUiProjectionEntryV1Schema.safeParse(
            projected.entriesById[qualifiedContributionKey(service)],
          );
          if (!parsedEntry.success) return null;
          const entry = parsedEntry.data;
          if (entry.pluginId !== service.pluginId || entry.id !== service.localId) return null;
          const activationTarget = lease.registry.contributes.activationTargets.find(
            (target) => target.pluginId === service.pluginId,
          );
          if (!activationTarget) return null;
          return Object.freeze({
            service: Object.freeze({
              pluginId: service.pluginId,
              localId: service.localId,
            }),
            legacyServiceId: parseLegacyServiceId(entry.serviceId),
            availability: entry.availability.state === 'available'
              ? 'available' as const
              : 'unavailable' as const,
          });
        },
        listServices() {
          return Object.freeze(Object.values(projected.entriesById).flatMap((rawEntry) => {
            const parsedEntry = ConnectedAccountUiProjectionEntryV1Schema.safeParse(rawEntry);
            if (!parsedEntry.success) return [];
            const entry = parsedEntry.data;
            const pluginId = entry.pluginId;
            if (!pluginId) return [];
            const activationTarget = lease.registry.contributes.activationTargets.find(
              (target) => target.pluginId === pluginId,
            );
            if (!activationTarget) return [];
            return [Object.freeze({
              service: Object.freeze({
                pluginId,
                localId: entry.id,
              }),
              legacyServiceId: parseLegacyServiceId(entry.serviceId),
              availability: entry.availability.state === 'available'
                ? 'available' as const
                : 'unavailable' as const,
            })];
          }));
        },
        release: lease.release,
      });
    },
  };
  return Object.freeze(access);
}

function unavailableSelection(): never {
  throw new PluginError({
    code: 'plugin_ui_unavailable',
    message: 'Connected Account selection requires a current session with an available user interaction owner',
  });
}

function assertCurrentRegistry(
  registryLease: DaemonConnectedAccountRegistryLease,
  signal: AbortSignal,
): void {
  signal.throwIfAborted();
  if (!registryLease.isCurrent()) {
    throw new Error(
      `Connected-account registry generation '${registryLease.generation}' is no longer current`,
    );
  }
}

export function createDaemonConnectedAccountPurposeBindingRuntime(params: Readonly<{
  api: ConnectedAccountPurposeBindingApi;
  establishedRuntimeOwner: QualifiedConnectedAccountMaterializationOwner;
  revisionedLegacyMaterializationOwner:
    RevisionedLegacyConnectedAccountMaterializationOwner;
  resolveQualifiedConnectedAccountMaterializationTransport(
    service: QualifiedConnectedAccountRef['service'],
  ): QualifiedConnectedAccountPeerOperationTransport;
  resolveQualifiedConnectedAccountV4Support(): QualifiedConnectedAccountV4Support;
  reloadController?: Pick<
    PluginReloadController,
    'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent' | 'subscribe'
  >;
  runtimeRegistry?: DaemonConnectedAccountRuntimeRegistry;
  store?: ConnectedAccountPurposeBindingStore;
  qualifiedApi?: Readonly<{
    listAccounts(
      service: QualifiedConnectedAccountRef['service'],
      signal: AbortSignal,
    ): Promise<Readonly<{
      service: QualifiedConnectedAccountRef['service'];
      accounts: readonly QualifiedConnectedAccountProfileV4[];
    }>>;
    listGroups(
      service: QualifiedConnectedAccountRef['service'],
      signal: AbortSignal,
    ): Promise<Readonly<{ groups: readonly QualifiedConnectedAccountGroupV4[] }>>;
    readGroup(
      group: Readonly<{
        service: QualifiedConnectedAccountRef['service'];
        groupId: string;
      }>,
      signal: AbortSignal,
    ): Promise<QualifiedConnectedAccountGroupV4 | null>;
  }>;
  selectTarget?: (
    input: Readonly<{
      purpose: Parameters<StablePluginConnectedAccountsOwner['requestSelection']>[0]['purpose'];
      serviceRefs: readonly PluginContributionRef[];
      currentSession?: Parameters<StablePluginConnectedAccountsOwner['requestSelection']>[0]['currentSession'];
      reason: string;
      signal: AbortSignal;
    }>,
  ) => Promise<QualifiedConnectedAccountPurposeBindingTargetV1>;
}>): DaemonConnectedAccountPurposeBindingRuntime {
  if (params.runtimeRegistry && params.reloadController) {
    throw new Error('Connected Accounts runtime registry authority is ambiguous');
  }
  if (!params.runtimeRegistry && !params.reloadController) {
    throw new Error('Connected Accounts runtime registry authority is unavailable');
  }
  const runtimeRegistry = params.runtimeRegistry
    ?? createRuntimeRegistryAccess(params.reloadController!);
  const invalidationListeners = new Set<() => void>();
  let sessionRestartOwner: DaemonConnectedAccountPurposeSessionRestartOwner | null = null;

  const resolveService = async (
    service: PluginContributionRef,
    signal: AbortSignal,
  ): Promise<ResolvedDaemonConnectedAccountService | null> => {
    signal.throwIfAborted();
    const lease = await runtimeRegistry.acquire();
    try {
      assertCurrentRegistry(lease, signal);
      const resolved = lease.resolveService(service);
      assertCurrentRegistry(lease, signal);
      return resolved?.availability === 'available' ? resolved : null;
    } finally {
      await lease.release();
    }
  };

  const resolveAccount = async (
    account: QualifiedConnectedAccountRef,
    signal: AbortSignal,
  ): Promise<ConnectedAccountPurposeResolvedTarget | null> => {
    const service = await resolveService(account.service, signal);
    if (!service) return null;
    let transport: QualifiedConnectedAccountPeerOperationTransport;
    try {
      transport =
        params.resolveQualifiedConnectedAccountMaterializationTransport(
          service.service,
        );
    } catch {
      return null;
    }
    if (transport.kind === 'v4') {
      if (!params.qualifiedApi) return null;
      const result = await params.qualifiedApi.listAccounts(
        service.service,
        signal,
      );
      signal.throwIfAborted();
      if (
        result.service.pluginId !== service.service.pluginId
        || result.service.localId !== service.service.localId
      ) {
        return null;
      }
      const profile = result.accounts.find((candidate) => (
        candidate.ref.service.pluginId === account.service.pluginId
        && candidate.ref.service.localId === account.service.localId
        && candidate.ref.accountId === account.accountId
      ));
      if (!profile || profile.status !== 'connected') return null;
      return Object.freeze({
        displayName: profile.displayName
          ?? profile.providerIdentity?.email
          ?? profile.providerIdentity?.accountId
          ?? profile.ref.accountId,
        account: Object.freeze({
          service: Object.freeze({ ...profile.ref.service }),
          accountId: profile.ref.accountId,
        }),
      });
    }
    if (transport.peerClass !== 'revisioned_v2_v3') {
      throw new PluginError({
        code: 'connected_account_v4_contract_unavailable',
        message:
          'Connected Account purpose materialization requires revision-fenced credential state',
      });
    }
    if (
      !service.legacyServiceId
      || transport.serviceId !== service.legacyServiceId
    ) {
      return null;
    }
    const result = await params.api.listConnectedServiceProfiles({
      serviceId: transport.serviceId,
      forceRefresh: true,
    });
    signal.throwIfAborted();
    if (result.serviceId !== transport.serviceId) return null;
    const profile = result.profiles.find((candidate) => candidate.profileId === account.accountId);
    if (
      !profile
      || profile.status !== 'connected'
      || (typeof profile.expiresAt === 'number' && profile.expiresAt <= Date.now())
    ) {
      return null;
    }
    return Object.freeze({
      displayName: profile.providerEmail
        ?? profile.providerAccountId
        ?? profile.profileId,
      account: Object.freeze({
        service: Object.freeze({ ...account.service }),
        accountId: profile.profileId,
      }),
    });
  };

  const resolveTarget = async (
    target: QualifiedConnectedAccountPurposeBindingTargetV1,
    signal: AbortSignal,
  ): Promise<ConnectedAccountPurposeResolvedTarget | null> => {
    if (target.kind === 'account') return await resolveAccount(target.account, signal);
    const service = await resolveService(target.service, signal);
    if (!service) return null;
    let transport: QualifiedConnectedAccountPeerOperationTransport;
    try {
      transport =
        params.resolveQualifiedConnectedAccountMaterializationTransport(
          service.service,
        );
    } catch {
      return null;
    }
    if (transport.kind !== 'v4' || !params.qualifiedApi) return null;
    const group = await params.qualifiedApi.readGroup({
      service: service.service,
      groupId: target.groupId,
    }, signal);
    signal.throwIfAborted();
    if (!group) return null;
    const activeAccountId = group.activeConnectedAccountId;
    if (!activeAccountId) return null;
    const activeMember = group.members.find(
      (member) =>
        member.connectedAccountId === activeAccountId
        && member.enabled !== false,
    );
    if (!activeMember) return null;
    const resolvedAccount = await resolveAccount({
      service: target.service,
      accountId: activeAccountId,
    }, signal);
    return resolvedAccount
      ? Object.freeze({
          ...resolvedAccount,
          displayName: group.displayName
            ?? group.ref.groupId,
        })
      : null;
  };

  const selectTarget = async (
    input: Parameters<NonNullable<typeof params.selectTarget>>[0],
  ): Promise<QualifiedConnectedAccountPurposeBindingTargetV1> => {
    if (params.selectTarget) return await params.selectTarget(input);
    if (!input.currentSession) unavailableSelection();
    input.signal.throwIfAborted();
    const candidates: Array<Readonly<{
      label: string;
      description: string;
      target: QualifiedConnectedAccountPurposeBindingTargetV1;
    }>> = [];
    for (const serviceRef of input.serviceRefs) {
      const service = await resolveService(serviceRef, input.signal);
      if (!service) continue;
      let transport: QualifiedConnectedAccountPeerOperationTransport;
      try {
        transport =
          params.resolveQualifiedConnectedAccountMaterializationTransport(
            service.service,
          );
      } catch {
        continue;
      }
      if (transport.kind === 'v4' && !params.qualifiedApi) continue;
      if (
        transport.kind === 'legacy'
        && (
          transport.peerClass !== 'revisioned_v2_v3'
          || !service.legacyServiceId
          || transport.serviceId !== service.legacyServiceId
        )
      ) {
        continue;
      }
      const qualified = transport.kind === 'v4';
      const [profiles, groups]: readonly [
        readonly DaemonConnectedAccountSelectionProfile[],
        readonly DaemonConnectedAccountSelectionGroup[],
      ] = qualified
        ? await Promise.all([
            params.qualifiedApi!.listAccounts(service.service, input.signal)
              .then((result) => result.accounts.map((profile) => Object.freeze({
                profileId: profile.ref.accountId,
                status: profile.status,
                providerAccountId: profile.providerIdentity?.accountId,
                providerEmail: profile.providerIdentity?.email,
                displayName: profile.displayName,
              }))),
            params.qualifiedApi!.listGroups(service.service, input.signal)
              .then((result) => result.groups.map((group) => Object.freeze({
                groupId: group.ref.groupId,
                displayName: group.displayName,
                activeAccountId: group.activeConnectedAccountId,
                members: Object.freeze(group.members.map((member) => Object.freeze({
                  accountId: member.connectedAccountId,
                  enabled: member.enabled !== false,
                }))),
              }))),
          ])
        : [
            await params.api.listConnectedServiceProfiles({
              serviceId: (
                transport as Extract<
                  QualifiedConnectedAccountPeerOperationTransport,
                  { kind: 'legacy' }
                >
              ).serviceId,
              forceRefresh: true,
            }).then((result) => result.profiles.map((profile) => Object.freeze({
              profileId: profile.profileId,
              status: profile.status,
              providerAccountId: profile.providerAccountId,
              providerEmail: profile.providerEmail,
            }))),
            Object.freeze([]),
          ];
      input.signal.throwIfAborted();
      const availableProfiles = new Map(profiles.flatMap((profile) => (
        profile.status === 'connected'
          ? [[profile.profileId, profile] as const]
          : []
      )));
      for (const profile of availableProfiles.values()) {
        candidates.push(Object.freeze({
          label: profile.displayName
            ?? profile.providerEmail
            ?? profile.providerAccountId
            ?? profile.profileId,
          description: service.service.localId,
          target: Object.freeze({
            kind: 'account' as const,
            account: Object.freeze({
              service: Object.freeze({ ...serviceRef }),
              accountId: profile.profileId,
            }),
          }),
        }));
      }
      for (const group of groups) {
        const activeMember = group.activeAccountId
          ? group.members.find(
              (member) =>
                member.accountId === group.activeAccountId
                && member.enabled,
            )
          : null;
        if (
          !activeMember
          || !availableProfiles.has(group.activeAccountId!)
        ) {
          continue;
        }
        candidates.push(Object.freeze({
          label: group.displayName ?? group.groupId,
          description: `${service.service.localId} group`,
          target: Object.freeze({
            kind: 'group' as const,
            service: Object.freeze({ ...serviceRef }),
            groupId: group.groupId,
          }),
        }));
      }
    }
    input.signal.throwIfAborted();
    if (candidates.length === 0) {
      throw new PluginError({
        code: 'plugin_host_access_resource_not_selected',
        message: 'No available Connected Account matches this purpose',
      });
    }
    if (candidates.length > 256) {
      throw new PluginError({
        code: 'plugin_ui_unavailable',
        message: 'Connected Account selection is unavailable because the authorized target inventory is too large',
      });
    }
    const result = await createPluginInvocationUi({
      currentSession: input.currentSession ?? null,
      signal: input.signal,
      isGenerationCurrent: () => !input.signal.aborted,
    }).askQuestions([{
      id: 'connected-account-target',
      prompt: input.reason,
      type: 'single',
      required: true,
      choices: candidates.map((candidate, index) => ({
        id: `target-${index}`,
        label: candidate.label,
        description: candidate.description,
      })) as [
        { id: string; label: string; description: string },
        ...{ id: string; label: string; description: string }[],
      ],
    }], { title: 'Choose Connected Account' });
    input.signal.throwIfAborted();
    if (result.status !== 'answered') {
      throw new PluginError({
        code: result.status === 'cancelled' ? 'plugin_ui_cancelled' : 'plugin_ui_unavailable',
        message: result.status === 'cancelled'
          ? 'Connected Account selection was cancelled'
          : 'Connected Account selection is unavailable',
        ...('diagnostic' in result && result.diagnostic
          ? { diagnostics: [result.diagnostic] }
          : {}),
      });
    }
    const answer = result.answers['connected-account-target'];
    const selectedId = answer?.type === 'single' && answer.answer.type === 'choice'
      ? answer.answer.choiceId
      : null;
    const selected = selectedId === null
      ? undefined
      : candidates.find((_candidate, index) => selectedId === `target-${index}`);
    if (!selected) {
      throw new PluginError({
        code: 'plugin_connected_account_binding_out_of_scope',
        message: 'Connected Account selection returned an unknown target',
      });
    }
    return selected.target;
  };

  const materializeAccount = async (input: Readonly<{
    account: QualifiedConnectedAccountRef;
    request: PluginConnectedAccountMaterializationRequest;
    signal: AbortSignal;
  }>): Promise<PluginConnectedAccountMaterialization> => {
    input.signal.throwIfAborted();
    const transport =
      params.resolveQualifiedConnectedAccountMaterializationTransport(
        input.account.service,
      );
    if (transport.kind === 'legacy') {
      if (transport.peerClass !== 'revisioned_v2_v3') {
        throw new PluginError({
          code: 'connected_account_v4_contract_unavailable',
          message:
            'Connected Account purpose materialization requires revision-fenced credential state',
        });
      }
      return await params.revisionedLegacyMaterializationOwner.invoke({
        account: input.account,
        serviceId: transport.serviceId,
        request: input.request,
        signal: input.signal,
      });
    }
    return await params.establishedRuntimeOwner.invoke({
      account: input.account,
      operation: Object.freeze({
        kind: 'materialize',
        request: input.request,
      }),
      signal: input.signal,
    });
  };

  const bindingStore =
    params.store ?? createActiveAccountSettingsConnectedAccountPurposeBindingStore();
  const bindingOwner = createConnectedAccountPurposeBindingOwner({
    store: bindingStore,
    selectTarget,
    resolveTarget,
    materializeAccount,
    subscribeInvalidations(listener) {
      invalidationListeners.add(listener);
      const unsubscribeReload = runtimeRegistry.subscribe(listener);
      return {
        dispose() {
          invalidationListeners.delete(listener);
          unsubscribeReload();
        },
      };
    },
  });
  const owner: StablePluginConnectedAccountsOwner = Object.freeze({
    ...bindingOwner,
    watch(input) {
      let disposed = false;
      let restartPending = false;
      const subscription = bindingOwner.watch({
        ...input,
        async listener() {
          const delivered = Promise.resolve()
            .then(() => input.listener())
            .catch(() => undefined);
          if (!input.sessionId || !sessionRestartOwner || restartPending) {
            await delivered;
            return;
          }
          restartPending = true;
          try {
            await delivered;
            if (disposed) return;
            sessionRestartOwner?.({
              sessionId: input.sessionId,
              purpose: input.purpose,
            });
          } finally {
            restartPending = false;
          }
        },
      });
      return Object.freeze({
        dispose() {
          if (disposed) return;
          disposed = true;
          subscription.dispose();
        },
      });
    },
  });

  return Object.freeze({
    owner,
    activatePurposeBindings: bindingOwner.activatePurposeBindings,
    activateSessionPurposeBindings: bindingOwner.activateSessionPurposeBindings,
    resolveBindingIntent: bindingOwner.resolveBindingIntent,
    async listCoordinatorAccounts(signal = new AbortController().signal) {
      signal.throwIfAborted();
      if (
        params.resolveQualifiedConnectedAccountV4Support() !== 'advertised'
        || !params.qualifiedApi
      ) {
        return Object.freeze([]);
      }
      const lease = await runtimeRegistry.acquire();
      try {
        assertCurrentRegistry(lease, signal);
        const services = (lease.listServices?.() ?? [])
          .filter((service) => service.availability === 'available');
        const accounts = (
          await Promise.all(services.map(async (service) => {
            const result = await params.qualifiedApi!.listAccounts(
              service.service,
              signal,
            );
            if (
              result.service.pluginId !== service.service.pluginId
              || result.service.localId !== service.service.localId
            ) {
              throw new Error(
                'Qualified Connected Account inventory returned a different service',
              );
            }
            return result.accounts;
          }))
        ).flat();
        assertCurrentRegistry(lease, signal);
        return Object.freeze(accounts);
      } finally {
        await lease.release();
      }
    },
    async reconcileRegistryPublication(input) {
      const signal = new AbortController().signal;
      const persistedBindings = await bindingStore.read(signal);
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
    bindSessionRestartOwner(nextOwner) {
      if (sessionRestartOwner && sessionRestartOwner !== nextOwner) {
        throw new Error('Connected Accounts session restart authority is already bound');
      }
      sessionRestartOwner = nextOwner;
    },
    subscribeInvalidations(listener) {
      invalidationListeners.add(listener);
      return () => {
        invalidationListeners.delete(listener);
      };
    },
    invalidate() {
      for (const listener of invalidationListeners) listener();
    },
  });
}
