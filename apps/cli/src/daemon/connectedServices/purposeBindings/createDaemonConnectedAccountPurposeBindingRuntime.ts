import {
  ConnectedAccountUiProjectionEntryV1Schema,
  ConnectedServiceIdSchema,
  MAX_INTERACTION_TRANSIENT_CHOICES_V1,
  buildQualifiedPluginContributionKey,
  createPluginContributionIdentity,
  isQualifiedConnectedAccountProfileActiveV4,
  isQualifiedConnectedAccountProfileUsableV4,
  resolveQualifiedConnectedAccountGroupActiveAccountV4,
  sameQualifiedConnectedAccountRef,
  type ConnectedServiceId,
  type PluginConnectedAccountAuthenticationV2,
  type QualifiedConnectedAccountGroupV4,
  type QualifiedConnectedAccountProfileV4,
  type QualifiedConnectedAccountPurposeV1,
  type QualifiedConnectedAccountPurposeBindingTargetV1,
  type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';
import type {
  ConnectedAccountMaterializationRequest,
  ConnectedAccountListedAccount as PluginConnectedAccountListedAccount,
  ConnectedAccountListedState as PluginConnectedAccountListedState,
  ConnectedAccountMaterialization as PluginConnectedAccountMaterialization,
  ConnectedAccountMetadataList as PluginConnectedAccountMetadataList } from '@happier-dev/plugin-sdk/connected-accounts';
import type {
  PluginContributionRef,
} from '@happier-dev/plugin-sdk';

import type { ApiClient } from '@/api/api';
import type { PermissionRequestOwner } from '@/agent/permissions/permissionRequestOwner';
import type {
  QualifiedConnectedAccountPeerOperationTransport,
} from '@/api/client/qualifiedConnectedAccountApi';
import { connectedAccountProjectionFamily } from '@/plugins/projection/registry/connectedAccounts';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type {
  ConnectedAccountConfiguredEndpoint,
} from '@/plugins/runtime/connectedAccounts/configuredOrigins';
import { createPluginInteractionsService } from '@/plugins/runtime/invocation/services/interactions';
import type {
  ConnectedAccountMaterializationCredentialRevisionBasis,
  StablePluginConnectedAccountsOwner,
} from '@/plugins/runtime/invocation/services/connectedAccounts';
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
  QualifiedConnectedAccountEstablishedRuntimeOwner,
  RevisionedLegacyConnectedAccountMaterializationOwner,
} from '../qualifiedConnectedAccountEstablishedRuntimeOwner';

type ConnectedAccountPurposeBindingApi = Pick<
  ApiClient,
  | 'getAccountEncryptionMode'
  | 'getConnectedServiceCredentialPlain'
  | 'getConnectedServiceCredentialSealed'
  | 'listConnectedServiceProfiles'
>;

type QualifiedConnectedAccountMaterializationOwner = Pick<
  QualifiedConnectedAccountEstablishedRuntimeOwner,
  'invokeWithReceipt'
> & Partial<Pick<
  QualifiedConnectedAccountEstablishedRuntimeOwner,
  'readCredentialRevision'
>>;

type ResolvedDaemonConnectedAccountService = Readonly<{
  service: QualifiedConnectedAccountRef['service'];
  legacyServiceId: ConnectedServiceId | null;
  availability: 'available' | 'unavailable';
  authentication: PluginConnectedAccountAuthenticationV2;
}>;
type DaemonConnectedAccountSelectionProfile = Readonly<{
  profileId: string;
  active: boolean;
  providerAccountId?: string | null;
  providerEmail?: string | null;
  displayName?: string;
}>;
type DaemonConnectedAccountSelectionGroup = Readonly<{
  groupId: string;
  displayName: string | null;
  resolvable: boolean;
}>;

type DaemonConnectedAccountRegistryLease = Readonly<{
  isCurrent(): boolean;
  resolveService(service: PluginContributionRef): ResolvedDaemonConnectedAccountService | null;
  listServices?(): readonly ResolvedDaemonConnectedAccountService[];
  release(): Promise<void>;
}>;

export type DaemonConnectedAccountRuntimeRegistry = Readonly<{
  acquire(): Promise<DaemonConnectedAccountRegistryLease>;
  subscribe(listener: () => void): () => void;
}>;

/** A transient Action-form choice; credentials and service authority stay private. */
export type DaemonConnectedAccountActionFormOption = Readonly<{
  value: QualifiedConnectedAccountRef;
  label: string;
}>;

export type DaemonConnectedAccountPurposeBindingRuntime = Readonly<{
  owner: StablePluginConnectedAccountsOwner;
  activatePurposeBindings:
    ConnectedAccountPurposeBindingOwner['activatePurposeBindings'];
  activateSessionPurposeBindings:
    ConnectedAccountPurposeBindingOwner['activateSessionPurposeBindings'];
  resolveCurrentSessionPurposeBindingSnapshot:
    ConnectedAccountPurposeBindingOwner['resolveCurrentSessionPurposeBindingSnapshot'];
  resolveCurrentRequestAuthBinding:
    ConnectedAccountPurposeBindingOwner['resolveCurrentRequestAuthBinding'];
  materializeRequestAuthBearer:
    ConnectedAccountPurposeBindingOwner['materializeRequestAuthBearer'];
  resolveBindingIntent: ConnectedAccountPurposeBindingOwner['resolveBindingIntent'];
  /**
   * Lists account targets for one purpose already authorized by the caller.
   * This is intentionally account-only: group selection remains the separate
   * interactive Connected Account binding flow.
   */
  listActionFormConnectedAccountOptions(input: Readonly<{
    purpose: QualifiedConnectedAccountPurposeV1;
    serviceRefs: readonly PluginContributionRef[];
    signal: AbortSignal;
  }>): Promise<readonly DaemonConnectedAccountActionFormOption[]>;
  listCoordinatorAccounts(
    signal?: AbortSignal,
  ): Promise<readonly QualifiedConnectedAccountProfileV4[]>;
  listGroupQuotaTargets(input: Readonly<{
    service: QualifiedConnectedAccountRef['service'];
    groupId: string;
    accountIds: ReadonlyArray<string>;
    signal: AbortSignal;
  }>): Promise<readonly Readonly<{
    profile: QualifiedConnectedAccountProfileV4;
    groupGeneration: number;
  }>[]>;
  reconcileRegistryPublication(input: Readonly<{
    previous: ResolvedContributionRegistry | null;
    candidate: ResolvedContributionRegistry;
    candidateActivePluginIds?: ReadonlySet<string>;
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
            authentication: entry.authentication,
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
              authentication: entry.authentication,
            })];
          }));
        },
        release: lease.release,
      });
    },
  };
  return Object.freeze(access);
}

/** Shared ceiling for the authorized account inventory exposed to one purpose. */
const CONNECTED_ACCOUNT_AUTHORIZED_INVENTORY_BOUND = 256;
const CONNECTED_ACCOUNT_DISPLAY_NAME_MAX_LENGTH = 512;

type DaemonConnectedAccountInventoryEntry = Readonly<{
  account: QualifiedConnectedAccountRef;
  displayName: string;
  state: PluginConnectedAccountListedState;
  /** Only a qualified V4 account owns a projectable configured-origin snapshot. */
  qualified: boolean;
}>;

type DaemonConnectedAccountInventory = Readonly<{
  entries: readonly DaemonConnectedAccountInventoryEntry[];
}>;

function inventoryKey(account: QualifiedConnectedAccountRef): string {
  return JSON.stringify([
    account.service.pluginId,
    account.service.localId,
    account.accountId,
  ]);
}

function boundedDisplayName(labelLike: unknown, fallback: string): string {
  return typeof labelLike === 'string'
    && labelLike.trim().length > 0
    && labelLike.length <= CONNECTED_ACCOUNT_DISPLAY_NAME_MAX_LENGTH
    ? labelLike.trim()
    : fallback;
}

/**
 * Released V2/V3 profiles did not carry V4 revision semantics. Keep their
 * compatibility rule separate from the V4 active-account predicate.
 */
function isRevisionedLegacyConnectedAccountProfileActive(profile: Readonly<{
  status: string;
  expiresAt?: number | null;
}>): boolean {
  return profile.status === 'connected'
    && (typeof profile.expiresAt !== 'number' || profile.expiresAt > Date.now());
}

/**
 * A V4 public list continues to show retained rows, while only current
 * revisioned rows are admitted to direct purpose targets.
 */
function listedQualifiedConnectedAccountState(
  profile: QualifiedConnectedAccountProfileV4,
  authentication: PluginConnectedAccountAuthenticationV2,
): PluginConnectedAccountListedState {
  if (profile.status === 'needs_reauth') return 'reconnectRequired';
  if (profile.status !== 'connected') return 'unavailable';
  if (!isQualifiedConnectedAccountProfileActiveV4(profile, Date.now())) {
    return typeof profile.expiresAt === 'number' && profile.expiresAt <= Date.now()
      ? 'expired'
      : 'unavailable';
  }
  return isQualifiedConnectedAccountProfileUsableV4({
    profile,
    authentication,
    now: Date.now(),
  })
    ? 'connected'
    : 'unavailable';
}

function listedRevisionedLegacyConnectedAccountState(profile: Readonly<{
  status: 'connected' | 'refreshing' | 'needs_reauth' | 'refresh_failed_retryable';
  expiresAt?: number | null;
  configurationReady?: boolean;
}>): PluginConnectedAccountListedState {
  if (profile.status === 'needs_reauth') return 'reconnectRequired';
  if (profile.status !== 'connected') return 'unavailable';
  if (!isRevisionedLegacyConnectedAccountProfileActive(profile)) return 'expired';
  if (profile.configurationReady === false) return 'unavailable';
  return 'connected';
}

function configuredOriginsUnavailable(): PluginError {
  return new PluginError({
    code: 'connected_account_configured_origins_unavailable',
    message:
      'Connected Account configured-origin projection is unavailable for this daemon runtime',
  });
}

function listedAccountOutOfScope(): PluginError {
  return new PluginError({
    code: 'plugin_connected_account_binding_out_of_scope',
    message: 'Connected Account is not currently authorized for this purpose',
  });
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
    throw new Error('Connected-account runtime registry is no longer current');
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
  /**
   * Host-private projection of the incumbent configured-endpoint owner for one
   * exact qualified account. It returns bounded, unique, host-normalized,
   * credential-free endpoints — the network origin paired with the configured
   * service base — and never a preferred one. Absent it, the purpose-scoped
   * listing and exact-listed materialization fail closed rather than reporting
   * an unverified empty endpoint set.
   */
  resolveConnectedAccountEndpoints?: (
    input: Readonly<{
      account: QualifiedConnectedAccountRef;
      signal: AbortSignal;
    }>,
  ) => Promise<readonly ConnectedAccountConfiguredEndpoint[]>;
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
      permissionOwner?: PermissionRequestOwner;
      assertGenerationCurrent(): void;
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
      const profile = result.accounts.find((candidate) =>
        sameQualifiedConnectedAccountRef(candidate.ref, account),
      );
      if (!profile || !isQualifiedConnectedAccountProfileUsableV4({
        profile,
        authentication: service.authentication,
        now: Date.now(),
      })) {
        return null;
      }
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
    if (!profile || !isRevisionedLegacyConnectedAccountProfileActive(profile)) {
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
    const accountResult = await params.qualifiedApi.listAccounts(service.service, signal);
    signal.throwIfAborted();
    if (
      accountResult.service.pluginId !== service.service.pluginId
      || accountResult.service.localId !== service.service.localId
    ) return null;
    const activeAccount = resolveQualifiedConnectedAccountGroupActiveAccountV4({
      group,
      accounts: accountResult.accounts,
      authentication: service.authentication,
      now: Date.now(),
    });
    if (!activeAccount) return null;
    return Object.freeze({
      displayName: group.displayName ?? group.ref.groupId,
      account: Object.freeze({
        service: Object.freeze({ ...activeAccount.ref.service }),
        accountId: activeAccount.ref.accountId,
      }),
      group: Object.freeze({
        groupId: group.ref.groupId,
        generation: group.generation,
      }),
    });
  };

  const selectTarget = async (
    input: Parameters<NonNullable<typeof params.selectTarget>>[0],
  ): Promise<QualifiedConnectedAccountPurposeBindingTargetV1> => {
    input.assertGenerationCurrent();
    if (params.selectTarget) {
      const target = await params.selectTarget(input);
      input.assertGenerationCurrent();
      input.signal.throwIfAborted();
      return target;
    }
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
              .then((result) => result.accounts),
            params.qualifiedApi!.listGroups(service.service, input.signal),
          ]).then(([qualifiedAccounts, groupResult]) => {
            const now = Date.now();
            return [
              qualifiedAccounts.map((profile) => Object.freeze({
                profileId: profile.ref.accountId,
                active: isQualifiedConnectedAccountProfileUsableV4({
                  profile,
                  authentication: service.authentication,
                  now,
                }),
                providerAccountId: profile.providerIdentity?.accountId,
                providerEmail: profile.providerIdentity?.email,
                displayName: profile.displayName,
              })),
              groupResult.groups.map((group) => Object.freeze({
                groupId: group.ref.groupId,
                displayName: group.displayName,
                resolvable: resolveQualifiedConnectedAccountGroupActiveAccountV4({
                  group,
                  accounts: qualifiedAccounts,
                  authentication: service.authentication,
                  now,
                }) !== null,
              })),
            ] as const;
          })
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
              active: isRevisionedLegacyConnectedAccountProfileActive(profile),
              providerAccountId: profile.providerAccountId,
              providerEmail: profile.providerEmail,
            }))),
            Object.freeze([]),
          ];
      input.signal.throwIfAborted();
      const availableProfiles = new Map(profiles.flatMap((profile) => (
        profile.active
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
        if (!group.resolvable) continue;
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
    const interactions = createPluginInteractionsService({
      currentSession: input.currentSession ?? null,
      signal: input.signal,
      isGenerationCurrent: () => {
        try {
          input.assertGenerationCurrent();
          return !input.signal.aborted;
        } catch {
          return false;
        }
      },
      ...(input.permissionOwner ? { permissionOwner: input.permissionOwner } : {}),
    });
    const pagedTargetCount = MAX_INTERACTION_TRANSIENT_CHOICES_V1 - 2;
    const pageCount = candidates.length <= MAX_INTERACTION_TRANSIENT_CHOICES_V1
      ? 1
      : Math.ceil(candidates.length / pagedTargetCount);
    let pageIndex = 0;
    while (pageIndex < pageCount) {
      input.assertGenerationCurrent();
      input.signal.throwIfAborted();
      const firstCandidateIndex = pageCount === 1 ? 0 : pageIndex * pagedTargetCount;
      const pageCandidates = pageCount === 1
        ? candidates
        : candidates.slice(firstCandidateIndex, firstCandidateIndex + pagedTargetCount);
      const targetChoices = pageCandidates.map((candidate, index) => ({
        id: `target-${pageIndex}-${index}`,
        label: candidate.label,
        description: candidate.description,
      }));
      const previousChoiceId = `page-${pageIndex}-previous`;
      const nextChoiceId = `page-${pageIndex}-next`;
      const choices = [
        ...targetChoices,
        ...(pageIndex > 0 ? [{
          id: previousChoiceId,
          label: 'Previous page',
          description: 'Show earlier Connected Accounts',
        }] : []),
        ...(pageIndex + 1 < pageCount ? [{
          id: nextChoiceId,
          label: 'Next page',
          description: 'Show more Connected Accounts',
        }] : []),
      ] as [
        { id: string; label: string; description: string },
        ...{ id: string; label: string; description: string }[],
      ];
      const result = await interactions.askQuestions({
        kind: 'questions',
        title: 'Choose Connected Account',
        questions: [{
          id: 'connected-account-target',
          prompt: input.reason,
          type: 'singleChoice',
          required: true,
          choices,
        }],
      });
      input.assertGenerationCurrent();
      input.signal.throwIfAborted();
      if (result.status !== 'answered') {
        throw new PluginError({
          code: result.status === 'userCancelled' ? 'plugin_ui_cancelled' : 'plugin_ui_unavailable',
          message: result.status === 'userCancelled'
            ? 'Connected Account selection was cancelled'
            : 'Connected Account selection is unavailable',
        });
      }
      const answer = result.answers['connected-account-target'];
      const selectedId = answer?.kind === 'singleChoice' && answer.answer.kind === 'choice'
        ? answer.answer.choiceId
        : null;
      if (selectedId === previousChoiceId && pageIndex > 0) {
        pageIndex -= 1;
        continue;
      }
      if (selectedId === nextChoiceId && pageIndex + 1 < pageCount) {
        pageIndex += 1;
        continue;
      }
      const selected = selectedId === null
        ? undefined
        : pageCandidates.find(
            (_candidate, index) => selectedId === `target-${pageIndex}-${index}`,
          );
      if (!selected) {
        throw new PluginError({
          code: 'plugin_connected_account_binding_out_of_scope',
          message: 'Connected Account selection returned an unknown target',
        });
      }
      return selected.target;
    }
    throw new Error('Connected Account selection page is unavailable');
  };

  /**
   * The one purpose-scoped account inventory. Every consumer of "which accounts
   * are authorized for this purpose" reads it here, so a bounded upstream
   * response, service identity mismatch, and state projection cannot diverge
   * between the interactive Action form and the public bounded listing.
   */
  const readAuthorizedAccountInventory = async (input: Readonly<{
    lease: DaemonConnectedAccountRegistryLease;
    serviceRefs: readonly PluginContributionRef[];
    signal: AbortSignal;
  }>): Promise<DaemonConnectedAccountInventory> => {
    const entries = new Map<string, DaemonConnectedAccountInventoryEntry>();
    const add = (entry: DaemonConnectedAccountInventoryEntry): void => {
      entries.set(inventoryKey(entry.account), entry);
    };

    for (const serviceRef of input.serviceRefs) {
      assertCurrentRegistry(input.lease, input.signal);
      const service = input.lease.resolveService(serviceRef);
      if (!service || service.availability !== 'available') continue;
      let transport: QualifiedConnectedAccountPeerOperationTransport;
      try {
        transport = params.resolveQualifiedConnectedAccountMaterializationTransport(
          service.service,
        );
      } catch {
        continue;
      }

      if (transport.kind === 'v4') {
        if (!params.qualifiedApi) continue;
        const result = await params.qualifiedApi.listAccounts(service.service, input.signal);
        assertCurrentRegistry(input.lease, input.signal);
        if (
          result.service.pluginId !== service.service.pluginId
          || result.service.localId !== service.service.localId
        ) {
          throw new Error('Qualified Connected Account inventory returned a different service');
        }
        for (const profile of result.accounts) {
          if (
            profile.ref.service.pluginId !== service.service.pluginId
            || profile.ref.service.localId !== service.service.localId
          ) continue;
          add({
            account: Object.freeze({
              service: Object.freeze({ ...profile.ref.service }),
              accountId: profile.ref.accountId,
            }),
            displayName: boundedDisplayName(
              profile.displayName
                ?? profile.providerIdentity?.email
                ?? profile.providerIdentity?.accountId,
              profile.ref.accountId,
            ),
            state: listedQualifiedConnectedAccountState(
              profile,
              service.authentication,
            ),
            qualified: true,
          });
        }
        continue;
      }

      if (
        transport.peerClass !== 'revisioned_v2_v3'
        || !service.legacyServiceId
        || transport.serviceId !== service.legacyServiceId
      ) continue;
      const result = await params.api.listConnectedServiceProfiles({
        serviceId: transport.serviceId,
        forceRefresh: true,
      });
      assertCurrentRegistry(input.lease, input.signal);
      if (result.serviceId !== transport.serviceId) {
        throw new Error('Connected Account inventory returned a different legacy service');
      }
      for (const profile of result.profiles) {
        add({
          account: Object.freeze({
            service: Object.freeze({ ...service.service }),
            accountId: profile.profileId,
          }),
          displayName: boundedDisplayName(
            profile.providerEmail ?? profile.providerAccountId,
            profile.profileId,
          ),
          state: listedRevisionedLegacyConnectedAccountState(profile),
          qualified: false,
        });
      }
    }
    assertCurrentRegistry(input.lease, input.signal);
    return Object.freeze({
      entries: Object.freeze(
        [...entries.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([, entry]) => entry),
      ),
    });
  };

  const listActionFormConnectedAccountOptions = async (input: Readonly<{
    purpose: QualifiedConnectedAccountPurposeV1;
    serviceRefs: readonly PluginContributionRef[];
    signal: AbortSignal;
  }>): Promise<readonly DaemonConnectedAccountActionFormOption[]> => {
    input.signal.throwIfAborted();
    const lease = await runtimeRegistry.acquire();
    try {
      assertCurrentRegistry(lease, input.signal);
      const inventory = await readAuthorizedAccountInventory({
        lease,
        serviceRefs: input.serviceRefs,
        signal: input.signal,
      });
      const selectable = inventory.entries.filter((entry) => entry.state === 'connected');
      if (selectable.length > CONNECTED_ACCOUNT_AUTHORIZED_INVENTORY_BOUND) {
        throw new PluginError({
          code: 'plugin_ui_unavailable',
          message: 'Connected Account Action-form selection is unavailable because the authorized account inventory is too large',
        });
      }
      return Object.freeze(selectable.map((entry) => Object.freeze({
        value: entry.account,
        label: entry.displayName,
      })));
    } finally {
      await lease.release();
    }
  };

  /**
   * Raw account/group projection for an already-selected binding target. This
   * deliberately has no purpose lookup or grant state: the binding owner
   * supplies the exact target and rechecks it around every public operation.
   */
  const readTargetAccountInventory = async (input: Readonly<{
    target: QualifiedConnectedAccountPurposeBindingTargetV1;
    signal: AbortSignal;
  }>): Promise<DaemonConnectedAccountInventory> => {
    input.signal.throwIfAborted();
    const target = input.target;
    const lease = await runtimeRegistry.acquire();
    try {
      assertCurrentRegistry(lease, input.signal);
      const serviceRef = target.kind === 'account'
        ? target.account.service
        : target.service;
      const inventory = await readAuthorizedAccountInventory({
        lease,
        serviceRefs: Object.freeze([serviceRef]),
        signal: input.signal,
      });
      if (target.kind === 'account') {
        const targetAccountKey = inventoryKey(target.account);
        return Object.freeze({
          entries: Object.freeze(inventory.entries.filter((entry) => (
            inventoryKey(entry.account) === targetAccountKey
          ))),
        });
      }
      if (!params.qualifiedApi) {
        return Object.freeze({ entries: Object.freeze([]) });
      }
      const targetService = target.service;
      const targetGroupId = target.groupId;
      const service = lease.resolveService(targetService);
      if (!service || service.availability !== 'available') {
        return Object.freeze({ entries: Object.freeze([]) });
      }
      const group = await params.qualifiedApi.readGroup({
        service: service.service,
        groupId: targetGroupId,
      }, input.signal);
      assertCurrentRegistry(lease, input.signal);
      if (
        !group
        || group.ref.groupId !== targetGroupId
        || group.ref.service.pluginId !== targetService.pluginId
        || group.ref.service.localId !== targetService.localId
      ) {
        return Object.freeze({ entries: Object.freeze([]) });
      }
      const memberIds = new Set(
        group.members
          .filter((member) => member.enabled !== false)
          .map((member) => member.connectedAccountId),
      );
      return Object.freeze({
        entries: Object.freeze(inventory.entries.filter((entry) => (
          entry.account.service.pluginId === targetService.pluginId
          && entry.account.service.localId === targetService.localId
          && memberIds.has(entry.account.accountId)
        ))),
      });
    } finally {
      await lease.release();
    }
  };

  const readListedAccountEndpoints = async (input: Readonly<{
    entry: DaemonConnectedAccountInventoryEntry;
    signal: AbortSignal;
  }>): Promise<readonly ConnectedAccountConfiguredEndpoint[]> => {
    if (!params.resolveConnectedAccountEndpoints) throw configuredOriginsUnavailable();
    // A legacy account carries no qualified configuration snapshot, so it owns no
    // projectable configured endpoint. That is an honest empty, not an elision.
    if (!input.entry.qualified) return Object.freeze([]);
    const endpoints = await params.resolveConnectedAccountEndpoints({
      account: input.entry.account,
      signal: input.signal,
    });
    input.signal.throwIfAborted();
    const byBase = new Map(endpoints.map((endpoint) => [endpoint.base, endpoint]));
    return Object.freeze(
      [...byBase.values()].sort((left, right) => (left.base < right.base ? -1 : 1)),
    );
  };

  const projectTargetAccounts = async (
    input: Readonly<{
      target: QualifiedConnectedAccountPurposeBindingTargetV1;
      limit: number;
      signal: AbortSignal;
    }>,
  ): Promise<PluginConnectedAccountMetadataList> => {
    if (!params.resolveConnectedAccountEndpoints) throw configuredOriginsUnavailable();
    const inventory = await readTargetAccountInventory(input);
    const page = inventory.entries.slice(0, Math.max(0, Math.trunc(input.limit)));
    const accounts: PluginConnectedAccountListedAccount[] = [];
    for (const entry of page) {
      const endpoints = await readListedAccountEndpoints({
        entry,
        signal: input.signal,
      });
      accounts.push(Object.freeze({
        account: entry.account,
        displayName: entry.displayName,
        state: entry.state,
        // Both facts project together: HostAccess still governs by origin while
        // a source routes by the configured base.
        connectedAccountOrigins: Object.freeze(
          [...new Set(endpoints.map((endpoint) => endpoint.origin))].sort(),
        ),
        connectedAccountBases: Object.freeze(endpoints.map((endpoint) => endpoint.base)),
      }));
    }
    return Object.freeze({
      status: page.length < inventory.entries.length
        ? 'truncated' as const
        : 'complete' as const,
      accounts: Object.freeze(accounts),
    });
  };

  const assertTargetAccountMaterializable = async (input: Readonly<{
    target: QualifiedConnectedAccountPurposeBindingTargetV1;
    account: QualifiedConnectedAccountRef;
    request: ConnectedAccountMaterializationRequest;
    signal: AbortSignal;
  }>): Promise<void> => {
    const inventory = await readTargetAccountInventory(input);
    const entry = inventory.entries.find((candidate) => sameQualifiedConnectedAccountRef(
      candidate.account,
      input.account,
    ));
    if (!entry || entry.state !== 'connected') throw listedAccountOutOfScope();
    if (input.request.kind !== 'httpHeaders') return;
    const origins = new Set(
      (await readListedAccountEndpoints({ entry, signal: input.signal }))
        .map((endpoint) => endpoint.origin),
    );
    // An account with no configured origin is a fixed-origin or non-HTTP
    // materialization: the incumbent HostAccess fixed-origin admission remains
    // the sole authority there. A configured-origin account is constrained to
    // exactly the origins the host currently projects for it.
    if (origins.size === 0) return;
    if (!origins.has(input.request.origin)) throw listedAccountOutOfScope();
  };

  const materializeAccount = async (input: Readonly<{
    account: QualifiedConnectedAccountRef;
    credentialRevisionBasis?: ConnectedAccountMaterializationCredentialRevisionBasis;
    request: ConnectedAccountMaterializationRequest;
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
      const receipt = await params.revisionedLegacyMaterializationOwner.invokeWithReceipt({
        account: input.account,
        serviceId: transport.serviceId,
        request: input.request,
        ...(input.credentialRevisionBasis?.expectedCredentialRevision
          ? {
              expectedCredentialRevision:
                input.credentialRevisionBasis.expectedCredentialRevision,
            }
          : {}),
        signal: input.signal,
      });
      input.credentialRevisionBasis?.captureCredentialRevision(
        receipt.basis.credentialRevision,
      );
      return receipt.result;
    }
    const receipt = await params.establishedRuntimeOwner.invokeWithReceipt({
      account: input.account,
      operation: Object.freeze({
        kind: 'materialize',
        request: input.request,
      }),
      ...(input.credentialRevisionBasis?.expectedCredentialRevision
        ? {
            expectedCredentialRevision:
              input.credentialRevisionBasis.expectedCredentialRevision,
          }
        : {}),
      signal: input.signal,
    });
    input.credentialRevisionBasis?.captureCredentialRevision(
      receipt.basis.credentialRevision,
    );
    return receipt.result;
  };

  const bindingStore =
    params.store ?? createActiveAccountSettingsConnectedAccountPurposeBindingStore();
  const bindingOwner = createConnectedAccountPurposeBindingOwner({
    store: bindingStore,
    selectTarget,
    resolveTarget,
    materializeAccount,
    projectTargetAccounts,
    assertTargetAccountMaterializable,
    async resolveCredentialRevision(account, signal) {
      signal.throwIfAborted();
      let transport: QualifiedConnectedAccountPeerOperationTransport;
      try {
        transport = params.resolveQualifiedConnectedAccountMaterializationTransport(
          account.service,
        );
      } catch {
        return null;
      }
      if (
        transport.kind !== 'v4'
        || !params.establishedRuntimeOwner.readCredentialRevision
      ) {
        // External request-auth never re-enters the service-keyed compatibility adapter. A
        // revisioned V4 read is the only qualified source of a cache/currentness fence here.
        return null;
      }
      const revision = await params.establishedRuntimeOwner
        .readCredentialRevision({ account, signal });
      signal.throwIfAborted();
      return revision;
    },
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
    resolveCurrentSessionPurposeBindingSnapshot:
      bindingOwner.resolveCurrentSessionPurposeBindingSnapshot,
    resolveCurrentRequestAuthBinding:
      bindingOwner.resolveCurrentRequestAuthBinding,
    materializeRequestAuthBearer:
      bindingOwner.materializeRequestAuthBearer,
    resolveBindingIntent: bindingOwner.resolveBindingIntent,
    listActionFormConnectedAccountOptions,
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
    async listGroupQuotaTargets(input) {
      input.signal.throwIfAborted();
      if (params.resolveQualifiedConnectedAccountV4Support() !== 'advertised' || !params.qualifiedApi) {
        return Object.freeze([]);
      }
      const group = await params.qualifiedApi.readGroup({
        service: input.service,
        groupId: input.groupId,
      }, input.signal);
      input.signal.throwIfAborted();
      const accountsResult = await params.qualifiedApi.listAccounts(input.service, input.signal);
      input.signal.throwIfAborted();
      if (!group) return Object.freeze([]);
      if (
        group.ref.groupId !== input.groupId
        || group.ref.service.pluginId !== input.service.pluginId
        || group.ref.service.localId !== input.service.localId
        || accountsResult.service.pluginId !== input.service.pluginId
        || accountsResult.service.localId !== input.service.localId
      ) {
        throw new Error('Qualified Connected Account group quota target identity mismatch');
      }
      const groupMemberIds = new Set(group.members.map((member) => member.connectedAccountId));
      const requestedIds = new Set(input.accountIds);
      return Object.freeze(accountsResult.accounts.filter((profile) => (
        profile.ref.service.pluginId === input.service.pluginId
        && profile.ref.service.localId === input.service.localId
        && requestedIds.has(profile.ref.accountId)
        && groupMemberIds.has(profile.ref.accountId)
      )).map((profile) => Object.freeze({
        profile,
        groupGeneration: group.generation,
      })));
    },
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
