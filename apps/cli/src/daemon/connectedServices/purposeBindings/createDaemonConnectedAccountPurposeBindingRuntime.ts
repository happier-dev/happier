import { ConnectedAccountUiProjectionEntryV1Schema } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { createConnectedAccountPurposeMaterializer, readConnectedAccountPurposeInventory, readConnectedAccountPurposeTargetInventory,
  projectConnectedAccountPurposeTargetInventory,
  createConnectedAccountPurposeTargetAccountListing, connectedAccountListedAccountOutOfScope as listedAccountOutOfScope,
  CONNECTED_ACCOUNT_AUTHORIZED_INVENTORY_BOUND, type ConnectedAccountPurposeInventoryEntry } from '@happier-dev/cli-common/connectedAccounts';
import type { DaemonPluginActionFormConnectedAccountOption } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { RequesterConnectedAccountObservation } from '@/api/client/accountEncryptionCurrentnessObservation';
import { ConnectedAccountMaterializationRequestSchema } from '@happier-dev/protocol/connect/connected-account-purposes';
import { MAX_INTERACTION_TRANSIENT_CHOICES_V1 } from '@happier-dev/protocol/plugins/interactions/transientV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { isQualifiedConnectedAccountProfileUsableV4, resolveQualifiedConnectedAccountGroupActiveAccountV4 } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { ConnectedAccountServiceIdentityV1Schema, sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { ConnectedServiceCredentialRevisionV1, PluginConnectedAccountAuthenticationV2, QualifiedConnectedAccountGroupV4, QualifiedConnectedAccountProfileV4, QualifiedConnectedAccountPurposeV1, QualifiedConnectedAccountPurposeBindingTargetV1, QualifiedConnectedAccountRef } from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';
import type {
  ConnectedAccountMaterializationRequest,
  ConnectedAccountMaterialization as PluginConnectedAccountMaterialization,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type {
  PluginContributionRef,
} from '@happier-dev/plugin-sdk';

import type { ConnectedAccountHostRuntimeInvoker } from '@/plugins/runtime/connectedAccounts/runtimeInvoker';
import type { PermissionRequestOwner } from '@/agent/permissions/permissionRequestOwner';
import { connectedAccountProjectionFamily } from '@/plugins/projection/registry/connectedAccounts';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type {
  ConnectedAccountConfiguredEndpoint,
} from '@/plugins/runtime/connectedAccounts/configuredOrigins';
import { createPluginInteractionsService } from '@/plugins/runtime/invocation/services/interactions';
import type {
  StablePluginConnectedAccountsOwner,
} from '@/plugins/runtime/invocation/services/connectedAccounts';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import type { PluginAccessSelection } from '@/plugins/store/install/accessScopeRegistry';
import { logger } from '@/ui/logger';
import { createPurposeTargetResolver } from './resolveTarget';
import { createCoordinatorInventory } from './coordinatorInventory';

import {
  createActiveAccountSettingsConnectedAccountPurposeBindingStore,
  createConnectedAccountPurposeBindingOwner,
  readConnectedAccountPurposeProfileLabel,
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
} from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import type {
  TeamCredentialDirectMaterialClient,
  TeamCredentialDirectMaterialOperationFailure,
  TeamCredentialDirectMaterialUnavailableReason,
} from '../directMaterial/teamCredentialDirectMaterialClient';
import type { ConnectedServiceSwitchTarget } from '../sessionAuthSwitch/connectedServiceSwitchDeferralQueue';

type QualifiedConnectedAccountMaterializationOwner = Pick<
  QualifiedConnectedAccountEstablishedRuntimeOwner,
  'invokeWithReceipt' | 'invokeDirectMaterial'
> & Partial<Pick<
  QualifiedConnectedAccountEstablishedRuntimeOwner,
  'readCredentialRevision' | 'readCredentialConfigurationRevision'
>>;

type ResolvedDaemonConnectedAccountService = Readonly<{
  service: QualifiedConnectedAccountRef['service'];
  availability: 'available' | 'unavailable';
  authentication: PluginConnectedAccountAuthenticationV2;
}>;
type DaemonConnectedAccountSelectionProfile = Readonly<{
  profileId: string;
  active: boolean;
  providerIdentity?: QualifiedConnectedAccountProfileV4['providerIdentity'];
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
  materializeNative?: ConnectedAccountHostRuntimeInvoker['invokeNative'];
  release(): Promise<void>;
}>;

export type DaemonConnectedAccountRuntimeRegistry = Readonly<{
  acquire(): Promise<DaemonConnectedAccountRegistryLease>;
  subscribe(listener: () => void): () => void;
}>;

/** A transient Action-form choice; credentials and service authority stay private. */
export type DaemonConnectedAccountActionFormOption = DaemonPluginActionFormConnectedAccountOption;

export type DaemonConnectedAccountPurposeBindingRuntime = Readonly<{
  owner: StablePluginConnectedAccountsOwner;
  readBindingObservation: ConnectedAccountPurposeBindingOwner['readBindingObservation'];
  readCredentialConfigurationRevision: ConnectedAccountPurposeBindingOwner['readCredentialConfigurationRevision'];
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
  resolveBindingIntentSelection: ConnectedAccountPurposeBindingOwner['resolveBindingIntentSelection'];
  /**
   * Lists exact Account targets and explicitly declared native choices for
   * one purpose already authorized by the caller. Group selection remains
   * the separate interactive Connected Account binding flow.
   */
  listActionFormConnectedAccountOptions(input: Readonly<{
    purpose: QualifiedConnectedAccountPurposeV1;
    serviceRefs: readonly PluginContributionRef[];
    nativeServicePath?: string;
    signal: AbortSignal;
  }>): Promise<readonly DaemonConnectedAccountActionFormOption[]>;
  listCoordinatorAccounts(
    signal?: AbortSignal,
    service?: QualifiedConnectedAccountRef['service'],
  ): Promise<readonly QualifiedConnectedAccountProfileV4[]>;
  listGroupQuotaTargets(input: Readonly<{
    service: QualifiedConnectedAccountRef['service'];
    groupId: string;
    /** Omit to observe every actual member of the selected group. */
    accountIds?: ReadonlyArray<string>;
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
  subscribeInvalidations(listener: (event?: RequesterConnectedAccountObservation) => void): () => void;
  invalidate(event?: RequesterConnectedAccountObservation, reason?:
    | 'machine-account-changes' | 'machine-recovery' | 'credential-updated'
    | 'requester-account-changes' | 'requester-recovery'): void;
}>;

export type DaemonConnectedAccountPurposeSessionRestartOwner = (
  input: Readonly<{
    sessionId: string;
    purpose: Parameters<StablePluginConnectedAccountsOwner['watch']>[0]['purpose'];
    target: ConnectedServiceSwitchTarget;
  }>,
) => void;

function qualifiedContributionKey(ref: PluginContributionRef): string {
  return buildQualifiedPluginContributionKey(ConnectedAccountServiceIdentityV1Schema.parse(ref));
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
          const host = lease.registry.connectedAccountContributions?.describe(service);
          if (host?.sourceCustody.kind === 'host') {
            return Object.freeze({ service: host.ref,
              availability: host.isCurrent() ? 'available' as const : 'unavailable' as const,
              authentication: host.descriptor.authentication });
          }
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
            availability: entry.availability.state === 'available'
              ? 'available' as const
              : 'unavailable' as const,
            authentication: entry.authentication,
          });
        },
        listServices() {
          const hosts = lease.registry.connectedAccountContributions?.list().flatMap(entry => entry.sourceCustody.kind === 'host'
            ? [{ service: entry.ref, availability: entry.isCurrent() ? 'available' as const : 'unavailable' as const, authentication: entry.descriptor.authentication }]
            : []) ?? [];
          return Object.freeze([...hosts, ...Object.values(projected.entriesById).flatMap((rawEntry) => {
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
              availability: entry.availability.state === 'available'
                ? 'available' as const
                : 'unavailable' as const,
              authentication: entry.authentication,
            })];
          })]);
        },
        materializeNative: input => lease.registry.connectedAccountRuntimeInvoker.invokeNative(input),
        release: lease.release,
      });
    },
  };
  return Object.freeze(access);
}

type DaemonConnectedAccountInventoryEntry = ConnectedAccountPurposeInventoryEntry;

type DaemonConnectedAccountInventory = Readonly<{
  entries: readonly DaemonConnectedAccountInventoryEntry[];
}>;

function teamDirectMaterialFailure(
  reason: TeamCredentialDirectMaterialUnavailableReason,
  service: QualifiedConnectedAccountRef['service'],
): PluginError {
  switch (reason) {
    case 'preparing':
      return new PluginError({
        code: 'plugin_connected_account_direct_material_preparing',
        message: 'Shared Connected Account access is still being prepared',
        retryable: true,
        remediation: { kind: 'retry' },
      });
    case 'temporarily_unavailable':
      return new PluginError({
        code: 'plugin_connected_account_direct_material_temporarily_unavailable',
        message: 'Shared Connected Account access is temporarily unavailable',
        retryable: true,
        remediation: { kind: 'retry' },
      });
    case 'source_changed':
      return new PluginError({
        code: 'plugin_connected_account_direct_material_source_changed',
        message: 'The shared Connected Account source changed and is being updated',
        retryable: true,
        remediation: { kind: 'retry' },
      });
    case 'recipient_binding_changed':
      return new PluginError({
        code: 'plugin_connected_account_direct_material_recipient_binding_changed',
        message: 'This device needs current Account encryption material before using the shared Connected Account',
        remediation: { kind: 'openSettings', path: '/settings/account/security' },
      });
    case 'access_removed':
      return new PluginError({
        code: 'plugin_connected_account_direct_access_removed',
        message: 'Access to the shared Connected Account was removed',
        remediation: { kind: 'selectAccount', service },
      });
    case 'disabled':
      return new PluginError({
        code: 'plugin_connected_account_direct_material_disabled',
        message: 'Direct access to the shared Connected Account is disabled',
        remediation: { kind: 'selectAccount', service },
      });
    case 'unsupported_direct_source':
      return new PluginError({
        code: 'plugin_connected_account_direct_material_unsupported',
        message: 'This client cannot use the shared Connected Account directly',
        remediation: { kind: 'selectAccount', service },
      });
    case 'invalid_material':
      return new PluginError({
        code: 'plugin_connected_account_direct_material_invalid',
        message: 'The shared Connected Account material must be repaired before it can be used',
      });
    case 'resource_corrupt':
      return new PluginError({
        code: 'plugin_connected_account_direct_resource_corrupt',
        message: 'The shared Connected Account resource must be repaired before it can be used',
      });
  }
}

function teamDirectMaterialOperationFailure(
  error: TeamCredentialDirectMaterialOperationFailure,
): PluginError {
  const remediation = error.error === 'team_authentication_required'
    || error.error === 'team_authentication_policy_unavailable'
    ? { kind: 'openSettings' as const, path: '/settings/teams/authentication' }
    : undefined;
  return new PluginError({
    code: error.error,
    message: error.error,
    ...(remediation ? { remediation } : {}),
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
  credentialOwnerAccountId?: string;
  establishedRuntimeOwner: QualifiedConnectedAccountMaterializationOwner;
  openTeamDirect?: TeamCredentialDirectMaterialClient['open'];
  workerMachineId?: string;
  resolveQualifiedConnectedAccountV4Support(): QualifiedConnectedAccountV4Support | Promise<QualifiedConnectedAccountV4Support>;
  /** Root Account changes/reconnect invalidate this projection; requester contexts without that observer retain only in-flight reads. */
  coordinatorInventoryIsObserved?: () => boolean;
  reloadController?: Pick<
    PluginReloadController,
    'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent' | 'subscribe'
  >;
  runtimeRegistry?: DaemonConnectedAccountRuntimeRegistry;
  store?: ConnectedAccountPurposeBindingStore;
  /** A foreign requester cannot borrow the host custodian's native sign-in. */
  allowNativeAccountCredentials?: boolean;
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
    listAccountsForServices(
      services: readonly QualifiedConnectedAccountRef['service'][],
      signal: AbortSignal,
    ): Promise<Readonly<{
      services: readonly QualifiedConnectedAccountRef['service'][];
      accounts: readonly QualifiedConnectedAccountProfileV4[];
    }>>;
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
  const invalidationListeners = new Set<(event?: RequesterConnectedAccountObservation) => void>();
  const bindingInvalidationListeners = new Map<() => void, readonly PluginContributionRef[]>();
  let sessionRestartOwner: DaemonConnectedAccountPurposeSessionRestartOwner | null = null;

  const readCoordinatorInventories = async (
    demandedServices: readonly QualifiedConnectedAccountRef['service'][],
    signal: AbortSignal,
    setCurrentness: (isCurrent: () => boolean) => void,
    observationOnly: boolean,
  ): Promise<ReadonlyMap<string, readonly QualifiedConnectedAccountProfileV4[]>> => {
    const lease = await runtimeRegistry.acquire();
    try {
      setCurrentness(lease.isCurrent);
      assertCurrentRegistry(lease, signal);
      const services = demandedServices.flatMap(ref => {
        const service = lease.resolveService(ref);
        return service?.availability === 'available' ? [service.service] : [];
      });
      const accountsByService = new Map(demandedServices.map(service => [
        buildQualifiedPluginContributionKey(service), [] as QualifiedConnectedAccountProfileV4[],
      ]));
      if (services.length === 0) return accountsByService;
      const result = services.length === 1 && !observationOnly
        ? await params.qualifiedApi!.listAccounts(services[0], signal).then(result => ({ services: [result.service], accounts: result.accounts }))
        : await params.qualifiedApi!.listAccountsForServices(services, signal);
      const expectedKeys = new Set(services.map(buildQualifiedPluginContributionKey));
      const receivedKeys = new Set(result.services.map(buildQualifiedPluginContributionKey));
      if (result.services.length !== expectedKeys.size || receivedKeys.size !== expectedKeys.size
        || [...receivedKeys].some(key => !expectedKeys.has(key))) {
        throw new Error('Qualified Connected Account inventory returned a different service');
      }
      for (const profile of result.accounts) {
        const key = buildQualifiedPluginContributionKey(profile.ref.service);
        if (!expectedKeys.has(key)) throw new Error('Qualified Connected Account inventory returned a different service');
        accountsByService.get(key)!.push(profile);
      }
      assertCurrentRegistry(lease, signal);
      return new Map([...accountsByService].map(([key, accounts]) => [key, Object.freeze(accounts)]));
    } finally {
      await lease.release();
    }
  };

  const { list: listServiceInventories, invalidate: invalidateCoordinatorInventories } = createCoordinatorInventory({
    read: readCoordinatorInventories, isObserved: params.coordinatorInventoryIsObserved,
  });

  const listServiceAccounts = async (service: QualifiedConnectedAccountRef['service'], signal: AbortSignal, observationOnly = false) =>
    (await listServiceInventories([service], signal, observationOnly))[0];

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

  const resolveTarget = createPurposeTargetResolver({ available: params.qualifiedApi !== undefined,
    resolveService, listAccounts: listServiceAccounts,
    ...(params.qualifiedApi ? { readGroup: (ref, signal) => params.qualifiedApi!.readGroup(ref, signal) } : {}),
  });

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
      if (!params.qualifiedApi) continue;
      const [profiles, groups]: readonly [
        readonly DaemonConnectedAccountSelectionProfile[],
        readonly DaemonConnectedAccountSelectionGroup[],
      ] = await Promise.all([
        params.qualifiedApi.listAccounts(service.service, input.signal)
          .then((result) => result.accounts),
        params.qualifiedApi.listGroups(service.service, input.signal),
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
            providerIdentity: profile.providerIdentity,
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
      });
      input.signal.throwIfAborted();
      const availableProfiles = new Map(profiles.flatMap((profile) => (
        profile.active
          ? [[profile.profileId, profile] as const]
          : []
      )));
      for (const profile of availableProfiles.values()) {
        candidates.push(Object.freeze({
          label: readConnectedAccountPurposeProfileLabel(profile) ?? profile.profileId,
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
      isOccurrenceCurrent: () => {
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
    const inventory = await readConnectedAccountPurposeInventory({
      available: params.qualifiedApi !== undefined,
      async resolveService(serviceRef) {
        assertCurrentRegistry(input.lease, input.signal);
        const service = input.lease.resolveService(serviceRef);
        return service?.availability === 'available' ? service : null;
      },
      async listAccounts(service, signal) {
        const api = params.qualifiedApi;
        if (!api) return [];
        const result = await api.listAccounts(service, signal);
        assertCurrentRegistry(input.lease, signal);
        if (result.service.pluginId !== service.pluginId || result.service.localId !== service.localId) {
          throw new Error('Qualified Connected Account inventory returned a different service');
        }
        return result.accounts;
      },
    }, input);
    assertCurrentRegistry(input.lease, input.signal);
    return inventory;
  };

  const listActionFormConnectedAccountOptions = async (input: Readonly<{
    purpose: QualifiedConnectedAccountPurposeV1;
    serviceRefs: readonly PluginContributionRef[];
    nativeServicePath?: string;
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
      const nativeOptions: DaemonConnectedAccountActionFormOption[] = [];
      if (input.nativeServicePath && params.allowNativeAccountCredentials !== false) {
        for (const serviceRef of input.serviceRefs) {
          const service = lease.resolveService(serviceRef);
          if (service?.availability !== 'available' || !service.authentication.native) continue;
          if (nativeOptions.some(option => 'nativeServicePath' in option
            && option.value.pluginId === service.service.pluginId && option.value.localId === service.service.localId)) continue;
          nativeOptions.push(Object.freeze({ value: service.service, label: service.authentication.native.systemTool,
            nativeServicePath: input.nativeServicePath }));
        }
      }
      if (selectable.length + nativeOptions.length > CONNECTED_ACCOUNT_AUTHORIZED_INVENTORY_BOUND) {
        throw new PluginError({
          code: 'plugin_ui_unavailable',
          message: 'Connected Account Action-form selection is unavailable because the authorized account inventory is too large',
        });
      }
      return Object.freeze([...selectable.map((entry) => Object.freeze({
        value: entry.account,
        label: entry.displayName,
      })), ...nativeOptions]);
    } finally {
      await lease.release();
    }
  };

  /**
   * Raw account/group projection for an already-selected binding target. This
   * deliberately has no purpose lookup or grant state: the binding owner
   * supplies the exact target and its next-acquisition observation.
   */
  const readTargetAccountInventory = async (input: Readonly<{
    target: QualifiedConnectedAccountPurposeBindingTargetV1;
    observation?: ConnectedAccountPurposeResolvedTarget['observation'];
    signal: AbortSignal;
  }>): Promise<DaemonConnectedAccountInventory> => {
    input.signal.throwIfAborted();
    if (input.observation) return projectConnectedAccountPurposeTargetInventory({
      target: input.target, observation: input.observation });
    // Disclosed Team direct-material origins bypass local V4 resolution and
    // retain their incumbent physical inventory read rather than inventing one.
    const target = input.target;
    const lease = await runtimeRegistry.acquire();
    try {
      assertCurrentRegistry(lease, input.signal);
      return await readConnectedAccountPurposeTargetInventory({
        readInventory: request => readAuthorizedAccountInventory({ ...request, lease }),
        async readGroup(ref, signal) {
          const service = lease.resolveService(ref.service);
          if (!params.qualifiedApi || !service || service.availability !== 'available') return null;
          const group = await params.qualifiedApi.readGroup({ service: service.service, groupId: ref.groupId }, signal);
          assertCurrentRegistry(lease, signal);
          return group;
        },
      }, { target, signal: input.signal });
    } finally {
      await lease.release();
    }
  };

  const { projectTargetAccounts, assertTargetAccountMaterializable } = createConnectedAccountPurposeTargetAccountListing({
    readTargetAccountInventory,
    resolveConnectedAccountEndpoints: params.resolveConnectedAccountEndpoints,
  });

  const materializeAccount = createConnectedAccountPurposeMaterializer<PluginConnectedAccountMaterialization>(params.establishedRuntimeOwner);

  const bindingStore =
    params.store ?? createActiveAccountSettingsConnectedAccountPurposeBindingStore();
  const bindingOwner = createConnectedAccountPurposeBindingOwner({
    credentialOwnerAccountId: params.credentialOwnerAccountId,
    store: bindingStore,
    selectTarget,
    resolveTarget,
    materializeAccount,
    async materializeNative(input): Promise<PluginConnectedAccountMaterialization> {
      if (params.allowNativeAccountCredentials === false) throw new PluginError({
        code: 'plugin_connected_account_native_unavailable',
        message: 'Select a Connected Account for this requester; this Account Action cannot use the host native login',
        remediation: { kind: 'selectAccount', service: input.service },
      });
      const unavailable = () => new PluginError({
        code: 'plugin_connected_account_native_unavailable',
        message: 'The selected service does not provide native authentication',
        remediation: { kind: 'selectAccount', service: input.service },
      });
      const lease = await runtimeRegistry.acquire();
      try {
        assertCurrentRegistry(lease, input.signal);
        const service = lease.resolveService(input.service);
        if (service?.availability !== 'available' || !service.authentication.native || !lease.materializeNative) {
          throw unavailable();
        }
        const request = ConnectedAccountMaterializationRequestSchema.safeParse(input.request);
        if (!request.success) {
          throw new PluginError({
            code: 'plugin_connected_account_binding_out_of_scope',
            message: 'Native credentials require an authorized materialization request',
          });
        }
        return await lease.materializeNative({ service: input.service, request: request.data, signal: input.signal });
      } finally {
        await lease.release();
      }
    },
    async materializeTeamDirect(input) {
      if (!params.openTeamDirect) throw listedAccountOutOfScope();
      const open = async () => await params.openTeamDirect!({
        ...(input.origin.teamId ? { teamId: input.origin.teamId } : {}),
        resourceId: input.origin.resourceId,
        consumer: input.consumer.kind !== 'execution_run'
          ? input.consumer
          : {
              ...input.consumer,
              workerMachineId: params.workerMachineId ?? unavailableSelection(),
            },
        slot: { kind: 'connected_service_purpose', purpose: input.origin.purpose },
        disclosedMember: input.origin.disclosedMember,
        signal: input.signal,
      });
      const opened = await open();
      if (!opened.ok) {
        if ('operationError' in opened) throw teamDirectMaterialOperationFailure(opened.operationError);
        throw teamDirectMaterialFailure(opened.reason, input.account.service);
      }
      if (
        opened.payload.material.kind !== 'qualified_connected_account'
        || opened.payload.sourceMember.kind !== 'connected_account'
        || opened.payload.sourceMember.connectedAccountId !== input.account.accountId
        || opened.payload.sourceMember.service.pluginId !== input.account.service.pluginId
        || opened.payload.sourceMember.service.localId !== input.account.service.localId
      ) {
        throw teamDirectMaterialFailure('invalid_material', input.account.service);
      }
      const materialization = await params.establishedRuntimeOwner.invokeDirectMaterial({
        account: input.account,
        sourceVersion: opened.payload.sourceVersion,
        material: opened.payload.material,
        operation: Object.freeze({ kind: 'materialize', request: input.request,
          ...(input.existingFiles ? { existingFiles: input.existingFiles } : {}) }),
        isCurrent: async () => {
          // Finite platform work keeps its admission until completion or local cancel.
          if (input.consumer.kind === 'platform_operation') {
            input.signal.throwIfAborted();
            return true;
          }
          const current = await open();
          if (!current.ok) {
            if ('operationError' in current) throw teamDirectMaterialOperationFailure(current.operationError);
            throw teamDirectMaterialFailure(current.reason, input.account.service);
          }
          return true;
        },
        signal: input.signal,
      });
      input.credentialRevisionBasis?.captureCredentialRevision(
        input.origin.resourceId as ConnectedServiceCredentialRevisionV1,
      );
      input.captureAdmittedResource?.({
        teamId: opened.payload.teamId,
        displayName: opened.admittedResource?.displayName ?? null,
        resourceRevision: opened.payload.resourceRevision,
      });
      return materialization;
    },
    projectTargetAccounts,
    assertTargetAccountMaterializable,
    async resolveCredentialConfigurationRevision(account, signal) {
      if (!params.establishedRuntimeOwner.readCredentialConfigurationRevision) throw listedAccountOutOfScope();
      return await params.establishedRuntimeOwner.readCredentialConfigurationRevision({ account, signal });
    },
    async resolveCredentialRevision(account, signal) {
      signal.throwIfAborted();
      if (!params.establishedRuntimeOwner.readCredentialRevision) {
        return null;
      }
      const revision = await params.establishedRuntimeOwner
        .readCredentialRevision({ account, signal });
      signal.throwIfAborted();
      return revision;
    },
    subscribeInvalidations(listener, serviceRefs) {
      bindingInvalidationListeners.set(listener, serviceRefs);
      const unsubscribeReload = runtimeRegistry.subscribe(() => listener());
      return {
        dispose() {
          bindingInvalidationListeners.delete(listener);
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
        async listener(change) {
          const delivered = Promise.resolve()
            .then(() => input.listener(change))
            .catch(() => undefined);
          if (!input.sessionId || !sessionRestartOwner || restartPending || !change?.account) {
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
              target: {
                serviceId: qualifiedContributionKey(change.account.service),
                profileId: change.account.accountId,
                groupId: change.group?.groupId ?? '',
                generation: change.group?.generation ?? 0,
              },
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
    readBindingObservation: bindingOwner.readBindingObservation,
    readCredentialConfigurationRevision: bindingOwner.readCredentialConfigurationRevision,
    activatePurposeBindings: bindingOwner.activatePurposeBindings,
    activateSessionPurposeBindings: bindingOwner.activateSessionPurposeBindings,
    resolveCurrentSessionPurposeBindingSnapshot:
      bindingOwner.resolveCurrentSessionPurposeBindingSnapshot,
    resolveCurrentRequestAuthBinding:
      bindingOwner.resolveCurrentRequestAuthBinding,
    materializeRequestAuthBearer:
      bindingOwner.materializeRequestAuthBearer,
    resolveBindingIntent: bindingOwner.resolveBindingIntent,
    resolveBindingIntentSelection: bindingOwner.resolveBindingIntentSelection,
    listActionFormConnectedAccountOptions,
    async listCoordinatorAccounts(signal = new AbortController().signal, demandedService?: QualifiedConnectedAccountRef['service']) {
      signal.throwIfAborted();
      if (
        await params.resolveQualifiedConnectedAccountV4Support() !== 'advertised'
        || !params.qualifiedApi
      ) {
        return Object.freeze([]);
      }
      if (demandedService) return await listServiceAccounts(demandedService, signal, true);
      const lease = await runtimeRegistry.acquire();
      try {
        assertCurrentRegistry(lease, signal);
        const services = (lease.listServices?.() ?? []).filter(service => service.availability === 'available');
        const accounts = await listServiceInventories(services.map(service => service.service), signal, true);
        assertCurrentRegistry(lease, signal);
        return Object.freeze(accounts.flat());
      } finally {
        await lease.release();
      }
    },
    async listGroupQuotaTargets(input) {
      input.signal.throwIfAborted();
      if (await params.resolveQualifiedConnectedAccountV4Support() !== 'advertised' || !params.qualifiedApi) {
        return Object.freeze([]);
      }
      const group = await params.qualifiedApi.readGroup({
        service: input.service,
        groupId: input.groupId,
      }, input.signal);
      input.signal.throwIfAborted();
      if (!group) return Object.freeze([]);
      if (
        group.ref.groupId !== input.groupId
        || group.ref.service.pluginId !== input.service.pluginId
        || group.ref.service.localId !== input.service.localId
      ) {
        throw new Error('Qualified Connected Account group quota target identity mismatch');
      }
      const accounts = await listServiceAccounts(input.service, input.signal, true);
      const groupMemberIds = new Set(group.members.map((member) => member.connectedAccountId));
      const requestedIds = input.accountIds ? new Set(input.accountIds) : null;
      return Object.freeze(accounts.filter((profile) => (
        (!requestedIds || requestedIds.has(profile.ref.accountId))
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
    invalidate(event, reason) {
      if (event?.quotaRefreshOnly !== true) {
        const keys = event?.services ? new Set(event.services.map(buildQualifiedPluginContributionKey)) : null;
        logger.debug('[ConnectedAccounts] inventory invalidated', {
          scope: keys ? 'services' : 'all',
          serviceCount: keys?.size ?? null,
          serviceKinds: [...new Set(event?.services?.map(service => service.localId) ?? [])],
          reason: reason ?? 'unspecified',
        });
        invalidateCoordinatorInventories(keys);
        for (const [listener, serviceRefs] of bindingInvalidationListeners) {
          if (keys && !serviceRefs.some(service => keys.has(buildQualifiedPluginContributionKey(service)))) continue;
          listener();
        }
      }
      for (const listener of invalidationListeners) listener(event);
    },
  });
}
