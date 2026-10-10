import { PluginError, type Disposable } from '@happier-dev/plugin-sdk';
import type {
  ConnectedAccountMetadataList as PluginConnectedAccountMetadataList,
  ConnectedAccountMaterializationRequest,
  ConnectedAccountBindingSummary as PluginConnectedAccountBindingSummary,
  ConnectedAccountMaterialization as PluginConnectedAccountMaterialization } from '@happier-dev/plugin-sdk/connected-accounts';
import type {
  PluginContributionRef,
} from '@happier-dev/plugin-sdk';
import { QualifiedConnectedAccountPurposeBindingV1Schema, QualifiedConnectedAccountPurposeBindingTargetV1Schema, qualifiedPurposeKey } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { ConnectedPurposeCatalogV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { QualifiedConnectedAccountPurposeV1Schema } from '@happier-dev/protocol/connect/connectedAccountPurposeIdentity';
import { QualifiedConnectedAccountRequestAuthUseV1Schema } from '@happier-dev/protocol/connect/connected-account-request-auth';
import { ConnectedServiceCredentialRevisionV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';
import { PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { PluginContributionIdentityV1, ConnectedServiceCredentialRevisionV1, QualifiedConnectedAccountPurposeBindingsV1, QualifiedConnectedAccountPurposeBindingV1, QualifiedConnectedAccountPurposeBindingTargetV1, QualifiedConnectedAccountPurposeTeamResourceSelectionV1, QualifiedConnectedAccountPurposeV1, QualifiedConnectedAccountRequestAuthUseV1, QualifiedConnectedAccountRef, TeamResourceConnectedServiceSelectionV2 } from '@happier-dev/protocol';

import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { createCliConnectedAccountCatalogStore } from '@/settings/connectedAccounts/connectedAccountCatalogStore';
import { refreshActiveConnectedAccountCatalog } from '@/settings/connectedAccounts/hydrateConnectedAccountCatalog';
import {
  getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken,
  readConnectedAccountCatalogFromSnapshot,
  subscribeActiveAccountSettingsSnapshotChanges,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type {
  HostCurrentSessionUiServices,
} from '@/agent/runtime/state/currentSessionUiTypes';
import type { PermissionRequestOwner } from '@/agent/permissions/permissionRequestOwner';
import { logger } from '@/ui/logger';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import type {
  ConnectedAccountMaterializationCredentialRevisionBasis,
  StablePluginConnectedAccountsOwner,
} from '@/plugins/runtime/invocation/services/connectedAccounts';
import {
  ConnectedAccountRequestAuthError,
  type BearerMaterial,
  type ConnectedAccountRequestAuthResolvedBinding,
  type ConnectedAccountRequestAuthPurposeUse,
  type ConnectedAccountRequestAuthSubject,
} from '../requestAuth/ConnectedAccountRequestAuthService';
import {
  parseHttpHeadersRequestAuthBearer,
} from '../requestAuth/parseHttpHeadersRequestAuthBearer';

export type ConnectedAccountPurposeBindingStore = Readonly<{
  read(signal?: AbortSignal): Promise<QualifiedConnectedAccountPurposeBindingsV1>;
  update(
    mutate: (
      current: QualifiedConnectedAccountPurposeBindingsV1,
    ) => QualifiedConnectedAccountPurposeBindingsV1,
    signal?: AbortSignal,
  ): Promise<QualifiedConnectedAccountPurposeBindingsV1>;
  subscribe(listener: () => void): Disposable;
}>;

export type ConnectedAccountPurposeResolvedTarget = Readonly<{
  displayName: string;
  /** Exact current account. Group intent is resolved here, at read/materialization time. */
  account: QualifiedConnectedAccountRef;
  /** Present only when the resolved target is a qualified group. */
  group?: Readonly<{
    groupId: string;
    generation: number;
  }>;
}>;

/** Launch-only pointer to one exact recipient-scoped Team material row. */
export type ConnectedAccountTeamDirectMaterialOrigin = Readonly<{
  purpose: QualifiedConnectedAccountPurposeV1;
  resourceId: string;
  disclosedMember: QualifiedConnectedAccountRef;
}>;
type ActiveConnectedAccountTeamDirectMaterialOrigin =
  ConnectedAccountTeamDirectMaterialOrigin & Readonly<{
    consumer: Readonly<
      | { kind: 'session'; sessionId: string }
      | { kind: 'execution_run'; executionRunId: string }
    >;
  }>;

export type ConnectedAccountPurposeBindingOwnerDependencies = Readonly<{
  store: ConnectedAccountPurposeBindingStore;
  /** Genuine UI/policy boundary: the owner validates this result before persistence. */
  selectTarget(input: Readonly<{
    purpose: QualifiedConnectedAccountPurposeV1;
    serviceRefs: readonly PluginContributionRef[];
    currentSession?: HostCurrentSessionUiServices;
    permissionOwner?: PermissionRequestOwner;
    assertGenerationCurrent(): void;
    reason: string;
    signal: AbortSignal;
  }>): Promise<QualifiedConnectedAccountPurposeBindingTargetV1>;
  /** Canonical account/group projection boundary. Returns null for removed or unavailable truth. */
  resolveTarget(
    target: QualifiedConnectedAccountPurposeBindingTargetV1,
    signal: AbortSignal,
  ): Promise<ConnectedAccountPurposeResolvedTarget | null>;
  /** Producer-owned materializer boundary for the exact resolved current account. */
  materializeAccount(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    expectedConfigurationRevision?: string | null;
    credentialRevisionBasis?: ConnectedAccountMaterializationCredentialRevisionBasis;
    request: ConnectedAccountMaterializationRequest;
    signal: AbortSignal;
  }>): Promise<PluginConnectedAccountMaterialization>;
  /** Machine-owned native credential boundary; material is never written to the binding store. */
  materializeNative?(input: Readonly<{
    service: PluginContributionRef;
    request: ConnectedAccountMaterializationRequest;
    signal: AbortSignal;
  }>): Promise<PluginConnectedAccountMaterialization>;
  materializeTeamDirect?(input: Readonly<{
    origin: ConnectedAccountTeamDirectMaterialOrigin;
    consumer: Readonly<
      | { kind: 'session'; sessionId: string }
      | { kind: 'execution_run'; executionRunId: string }
    >;
    account: QualifiedConnectedAccountRef;
    credentialRevisionBasis?: ConnectedAccountMaterializationCredentialRevisionBasis;
    request: ConnectedAccountMaterializationRequest;
    signal: AbortSignal;
  }>): Promise<PluginConnectedAccountMaterialization>;
  /**
   * Credential-free projection from one exact binding target. The runtime owns
   * account/group transport and metadata; this binding owner remains the sole
   * authority that decides which target may be projected.
   */
  projectTargetAccounts(input: Readonly<{
    target: QualifiedConnectedAccountPurposeBindingTargetV1;
    limit: number;
    signal: AbortSignal;
  }>): Promise<PluginConnectedAccountMetadataList>;
  /**
   * Rechecks that one exact account remains admitted by the same exact binding
   * target and its configured-origin projection before credential disclosure.
   */
  assertTargetAccountMaterializable(input: Readonly<{
    target: QualifiedConnectedAccountPurposeBindingTargetV1;
    account: QualifiedConnectedAccountRef;
    request: ConnectedAccountMaterializationRequest;
    signal: AbortSignal;
  }>): Promise<void>;
  /** Host-private revision reader used by the daemon request-auth broker. */
  resolveCredentialRevision?: (
    account: QualifiedConnectedAccountRef,
    signal: AbortSignal,
  ) => Promise<ConnectedServiceCredentialRevisionV1 | null>;
  resolveCredentialConfigurationRevision?: (
    account: QualifiedConnectedAccountRef,
    signal: AbortSignal,
  ) => Promise<string | null>;
  /** Account/group/credential/materializer invalidations not represented by the binding store. */
  subscribeInvalidations?: (listener: () => void) => Disposable;
}>;

export type ConnectedAccountPurposeAuthorizationScope = Readonly<{
  purpose: QualifiedConnectedAccountPurposeV1;
  serviceRefs: readonly PluginContributionRef[];
}>;

export type ConnectedAccountPurposeBindingSubject =
  | Readonly<{
      kind: 'session';
      sessionId: string;
    }>
  | Readonly<{
      kind: 'execution_run';
      runId: string;
      runnerPid: number;
      agentId: CatalogAgentId;
      isCurrent(): boolean;
    }>
  | Readonly<{
      kind: 'managed_provider_operation';
      operationId: string;
      pluginId: string;
      providerLocalId: string;
      isCurrent(): boolean;
      credentialConfigurations?: readonly Readonly<{ account: QualifiedConnectedAccountRef; revision: string | null }>[];
    }>
  | Readonly<{
      kind: 'agent_catalog_observation';
      operationId: string;
      consumer: PluginContributionIdentityV1;
      isCurrent(): boolean;
    }>
  /**
   * One host-private, correlation-scoped operation subject. Target Actions use
   * this for one invocation lifetime; it never represents a generation or a
   * background service.
   */
  | Readonly<{
      kind: 'operation';
      operationId: string;
      consumer: PluginContributionIdentityV1;
      /**
       * The Session this operation materializes launch material for. Its
       * direct Team material opens only through that Session's Home-admitted
       * Team binding (lane 10 child 06 §15); without it the operation has no
       * direct-material consumer.
       */
      sessionId?: string;
      isCurrent(): boolean;
    }>;

export type ConnectedAccountPurposeBindingLease = Readonly<{
  subjectId: string;
  isCurrent(): boolean;
  resolvePurposeBinding(
    purpose: QualifiedConnectedAccountPurposeV1,
  ): QualifiedConnectedAccountPurposeBindingV1 | null;
  listPurposeBindings(): readonly QualifiedConnectedAccountPurposeBindingV1[];
  dispose(): void;
}>;

export type ConnectedAccountSessionPurposeBindingLease =
  ConnectedAccountPurposeBindingLease;

export type ConnectedAccountSessionPurposeBindingSnapshot = Readonly<{
  purposes: readonly QualifiedConnectedAccountPurposeV1[];
  bindings: readonly QualifiedConnectedAccountPurposeBindingV1[];
}>;

/**
 * A new Session's launch snapshot read from the durable defaults. A durable
 * Team resource default appears twice, both derived from its one canonical
 * selection: `teamResourceSelections` is what the Session must be created
 * with (its Home-admitted Team binding), and a direct selection's
 * disclosed-member binding plus `directMaterialOrigins` is how that Session
 * materializes it.
 */
export type ConnectedAccountCurrentSessionPurposeBindingSnapshot =
  ConnectedAccountSessionPurposeBindingSnapshot & Readonly<{
    directMaterialOrigins: readonly ConnectedAccountTeamDirectMaterialOrigin[];
    teamResourceSelections: readonly ConnectedAccountSessionTeamResourceSelection[];
  }>;

/** One composition input/output: a snapshot plus any direct Team material it launches with. */
export type ComposableConnectedAccountSessionPurposeBindingSnapshot =
  ConnectedAccountSessionPurposeBindingSnapshot & Readonly<{
    directMaterialOrigins?: readonly ConnectedAccountTeamDirectMaterialOrigin[];
  }>;

/** A durable Team resource default with the purpose's declared services it must serve. */
export type ConnectedAccountSessionTeamResourceSelection =
  QualifiedConnectedAccountPurposeTeamResourceSelectionV1 & Readonly<{
    services: readonly PluginContributionRef[];
  }>;

/**
 * Canonical composition boundary for a session's complete Agent + managed Provider purpose
 * authority. Any overlap is rejected even when the two snapshots happen to select the same target:
 * two producers must never silently co-own one purpose. Direct Team material origins pass
 * through unchanged; session activation validates each against its composed binding.
 */
export function composeConnectedAccountSessionPurposeBindingSnapshot(
  snapshots: readonly ComposableConnectedAccountSessionPurposeBindingSnapshot[],
): ComposableConnectedAccountSessionPurposeBindingSnapshot {
  const purposes: QualifiedConnectedAccountPurposeV1[] = [];
  const bindings: QualifiedConnectedAccountPurposeBindingV1[] = [];
  const directMaterialOrigins: ConnectedAccountTeamDirectMaterialOrigin[] = [];
  const purposeKeys = new Set<string>();

  for (const snapshot of snapshots) {
    const snapshotPurposeKeys = new Set<string>();
    for (const purposeLike of snapshot.purposes) {
      const purpose = QualifiedConnectedAccountPurposeV1Schema.parse(purposeLike);
      const key = qualifiedPurposeKey(purpose);
      if (purposeKeys.has(key)) {
        throw new Error(
          'connected_account_session_binding_snapshot_duplicate_purpose',
        );
      }
      purposeKeys.add(key);
      snapshotPurposeKeys.add(key);
      purposes.push(Object.freeze(purpose));
    }
    const parsedBindings = ConnectedPurposeCatalogV1Schema.parse({
      v: 1,
      bindings: snapshot.bindings,
    }).bindings;
    const snapshotBindingKeys = new Set<string>();
    for (const binding of parsedBindings) {
      const key = qualifiedPurposeKey(binding.purpose);
      if (!snapshotPurposeKeys.has(key)) {
        throw new Error(
          'connected_account_session_binding_snapshot_undeclared_purpose',
        );
      }
      if (snapshotBindingKeys.has(key)) {
        throw new Error(
          'connected_account_session_binding_snapshot_duplicate_binding',
        );
      }
      snapshotBindingKeys.add(key);
      bindings.push(immutableBinding(binding));
    }
    directMaterialOrigins.push(...(snapshot.directMaterialOrigins ?? []));
  }

  return Object.freeze({
    purposes: Object.freeze(purposes),
    bindings: Object.freeze(bindings),
    ...(directMaterialOrigins.length > 0
      ? { directMaterialOrigins: Object.freeze(directMaterialOrigins) }
      : {}),
  });
}

/**
 * Least-privilege request-auth view over one canonical session lease. This view owns no
 * selection, lifecycle, or currentness state; it only filters exact purposes while delegating
 * every authority decision to the union lease.
 */
export function scopeConnectedAccountPurposeBindingLease(input: Readonly<{
  lease: ConnectedAccountPurposeBindingLease;
  subjectId: string;
  uses: readonly QualifiedConnectedAccountRequestAuthUseV1[];
  /** Exact Session captured by the host issuer, not an encoded diagnostic id. */
  parentSessionId?: string;
  registerRedaction: ConnectedAccountRequestAuthSubject['registerRedaction'];
  /**
   * Host-issued certificate for the catalog-Agent-only legacy service-keyed adapter.
   * Every other caller, including manifest-qualified external Agents, remains on the
   * qualified binding owner even when its target service has a legacy projection.
   */
  legacyServiceKeyedCompatibility?: true;
}>): ConnectedAccountRequestAuthSubject {
  const subjectId = input.subjectId.trim();
  if (!subjectId) {
    throw new Error('connected_account_session_binding_scope_subject_id_required');
  }
  const useByPurposeKey = new Map<string, QualifiedConnectedAccountRequestAuthUseV1>();
  for (const useLike of input.uses) {
    const use = QualifiedConnectedAccountRequestAuthUseV1Schema.parse({
      purpose: {
        consumer: { ...useLike.purpose.consumer },
        purpose: useLike.purpose.purpose,
      },
      materialization: {
        ...useLike.materialization,
        headerNames: [...useLike.materialization.headerNames],
      },
    });
    const key = qualifiedPurposeKey(use.purpose);
    if (useByPurposeKey.has(key)) {
      throw new Error('connected_account_session_binding_scope_duplicate_purpose');
    }
    useByPurposeKey.set(key, Object.freeze({
      purpose: Object.freeze({
        consumer: Object.freeze({ ...use.purpose.consumer }),
        purpose: use.purpose.purpose,
      }),
      materialization: Object.freeze({
        ...use.materialization,
        headerNames: Object.freeze([...use.materialization.headerNames]),
      }),
    }));
  }
  const isCurrent = (): boolean => input.lease.isCurrent();
  return Object.freeze({
    subjectId,
    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
    ...(input.legacyServiceKeyedCompatibility === true
      ? { legacyServiceKeyedCompatibility: true as const }
      : {}),
    isCurrent,
    registerRedaction(values) {
      if (!isCurrent()) {
        throw new ConnectedAccountRequestAuthError('request_auth_not_active');
      }
      input.registerRedaction(values);
    },
    resolvePurposeUse(rawPurpose) {
      const purpose = QualifiedConnectedAccountPurposeV1Schema.parse(rawPurpose);
      const use = useByPurposeKey.get(qualifiedPurposeKey(purpose));
      if (!use) return null;
      const binding = input.lease.resolvePurposeBinding(purpose);
      return binding ? Object.freeze({ binding, use }) : null;
    },
    listPurposeUses() {
      if (!isCurrent()) return Object.freeze([]);
      const purposeUses: ConnectedAccountRequestAuthPurposeUse[] = [];
      for (const binding of input.lease.listPurposeBindings()) {
        const use = useByPurposeKey.get(qualifiedPurposeKey(binding.purpose));
        if (use) purposeUses.push(Object.freeze({ binding, use }));
      }
      return Object.freeze(purposeUses);
    },
  });
}

export const scopeConnectedAccountSessionPurposeBindingLease =
  scopeConnectedAccountPurposeBindingLease;

/**
 * Binding-scoped Connected Accounts authority. Purpose-scoped account inventory
 * and exact-listed materialization are not binding decisions, so they stay with
 * the daemon runtime that owns the account inventory rather than being mirrored
 * here.
 */
export type ConnectedAccountPurposeBindingOwner =
  StablePluginConnectedAccountsOwner & Readonly<{
    readCredentialConfigurationRevision(account: QualifiedConnectedAccountRef, signal: AbortSignal): Promise<string | null>;
    /**
     * Canonical immutable launch snapshot for either a primary Agent session or one exact
     * execution-run owner. The run subject remains current only while its captured runner,
     * Agent generation, and bridge ownership remain exact.
     */
    activatePurposeBindings(input: Readonly<{
      subject: ConnectedAccountPurposeBindingSubject;
      purposes: readonly QualifiedConnectedAccountPurposeV1[];
      bindings: readonly QualifiedConnectedAccountPurposeBindingV1[];
      directMaterialOrigins?: readonly ConnectedAccountTeamDirectMaterialOrigin[];
    }>): ConnectedAccountPurposeBindingLease;
    /**
     * Installs one immutable, launch-scoped compatibility projection. Every declared purpose is
     * covered, including explicitly unbound/native purposes, so durable defaults cannot silently
     * replace launch intent. The returned lease is also the request-auth subject.
     */
    activateSessionPurposeBindings(input: Readonly<{
      sessionId: string;
      purposes: readonly QualifiedConnectedAccountPurposeV1[];
      bindings: readonly QualifiedConnectedAccountPurposeBindingV1[];
      directMaterialOrigins?: readonly ConnectedAccountTeamDirectMaterialOrigin[];
    }>): ConnectedAccountSessionPurposeBindingLease;
    resolveBindingIntent(input: Readonly<{
      purpose: QualifiedConnectedAccountPurposeV1;
      target: QualifiedConnectedAccountPurposeBindingTargetV1;
      serviceRefs: readonly PluginContributionRef[];
      signal: AbortSignal;
    }>): Promise<QualifiedConnectedAccountPurposeBindingV1>;
    resolveBindingIntentSelection(input: Readonly<{
      purpose: QualifiedConnectedAccountPurposeV1;
      target: QualifiedConnectedAccountPurposeBindingTargetV1;
      serviceRefs: readonly PluginContributionRef[];
      signal: AbortSignal;
    }>): Promise<Readonly<{
      binding: QualifiedConnectedAccountPurposeBindingV1;
      resolved: ConnectedAccountPurposeResolvedTarget;
      isCurrent(signal?: AbortSignal): Promise<boolean>;
    }>>;
    /**
     * Resolves one current, immutable launch snapshot from already-authorized qualified
     * purpose declarations. This is a read of the canonical selection owner; it neither
     * persists a selection nor activates a session lease.
     */
    resolveCurrentSessionPurposeBindingSnapshot(input: Readonly<{
      authorizedPurposes: readonly ConnectedAccountPurposeAuthorizationScope[];
      signal: AbortSignal;
    }>): Promise<ConnectedAccountCurrentSessionPurposeBindingSnapshot>;
    /**
     * Host-private broker bridge. It reads only one active exact session binding through this
     * owner, then fences it to the current credential revision without exposing either to a
     * plugin contribution.
     */
    resolveCurrentRequestAuthBinding(input: Readonly<{
      subjectId: string;
      binding: QualifiedConnectedAccountPurposeBindingV1;
      signal: AbortSignal;
    }>): Promise<ConnectedAccountRequestAuthResolvedBinding | null>;
    /**
     * Host-private broker bridge that delegates the actual materialization to this owner's one
     * canonical account materializer, with the previously resolved credential revision fenced.
     */
    materializeRequestAuthBearer(input: Readonly<{
      subjectId: string;
      binding: QualifiedConnectedAccountPurposeBindingV1;
      resolved: ConnectedAccountRequestAuthResolvedBinding;
      materialization: QualifiedConnectedAccountRequestAuthUseV1['materialization'];
      signal: AbortSignal;
    }>): Promise<BearerMaterial>;
    /**
     * Atomic generation-adoption contraction for the complete previous/current consumer union.
     * Call once after candidate validation and before publication. A removed consumer is
     * represented by an empty authorizedPurposes list.
     */
    reconcileAuthorizedPurposes(input: Readonly<{
      consumerScopes: readonly Readonly<{
        consumer: PluginContributionIdentityV1;
        authorizedPurposes: readonly ConnectedAccountPurposeAuthorizationScope[];
      }>[];
      signal: AbortSignal;
      /** Synchronous, non-throwing candidate publication while affected consumer locks remain held. */
      publish(): void;
    }>): Promise<void>;
  }>;

function contributionKey(ref: Readonly<{ pluginId: string; localId: string }>): string {
  return JSON.stringify([ref.pluginId, ref.localId]);
}

function targetService(
  target: QualifiedConnectedAccountPurposeBindingTargetV1,
): PluginContributionRef {
  return target.kind === 'account' ? target.account.service : target.service;
}

function targetKey(target: QualifiedConnectedAccountPurposeBindingTargetV1): string {
  return JSON.stringify(target);
}

function resourceNotSelected(purpose: QualifiedConnectedAccountPurposeV1): PluginError {
  return new PluginError({
    code: 'plugin_host_access_resource_not_selected',
    message: `Connected Accounts purpose '${purpose.purpose}' is not selected`,
  });
}

/**
 * Typed refusal for a purpose whose durable default is a Team resource
 * selection, used outside a Session: no Home admits a Team binding for it.
 * The default is the user's standing intent and is never erased here (lane 10
 * child 02 §11.6 "no silent native fallback").
 */
function teamResourceUnavailable(): PluginError {
  return new PluginError({
    code: 'plugin_connected_account_team_resource_unavailable',
    message: 'A Team credential is used only inside a Session whose Team binding the Home admitted',
    details: { reason: 'session_required' },
  });
}

/**
 * A Team resource selection as a Session/Execution Run purpose binding: the
 * purpose target stays `account | group` (lane 10 child 02 :271, child 06
 * :506). A direct selection binds its disclosed source member and carries the
 * materialization origin that opens it only through the Home-admitted Team
 * binding; it is never resolved against the viewer's own inventory. A
 * brokered selection is served by its broker and has no purpose binding here.
 */
export function projectTeamResourceSelectionToSessionPurposeBinding(input: Readonly<{
  purpose: QualifiedConnectedAccountPurposeV1;
  service: PluginContributionIdentityV1;
  selection: TeamResourceConnectedServiceSelectionV2;
}>): Readonly<{
  binding: QualifiedConnectedAccountPurposeBindingV1;
  origin: ConnectedAccountTeamDirectMaterialOrigin;
}> | null {
  const selection = input.selection;
  if (
    selection.deliveryMode !== 'direct'
    || contributionKey(selection.disclosedMember.service) !== contributionKey(input.service)
  ) return null;
  const purpose = Object.freeze({
    consumer: Object.freeze({ ...input.purpose.consumer }),
    purpose: input.purpose.purpose,
  });
  const disclosedMember = Object.freeze({
    service: Object.freeze({ ...selection.disclosedMember.service }),
    accountId: selection.disclosedMember.accountId,
  });
  return Object.freeze({
    binding: Object.freeze({
      purpose,
      target: Object.freeze({ kind: 'account' as const, account: disclosedMember }),
    }),
    origin: Object.freeze({ purpose, resourceId: selection.resourceId, disclosedMember }),
  });
}

function bindingOutOfScope(): PluginError {
  return new PluginError({
    code: 'plugin_connected_account_binding_out_of_scope',
    message: 'Connected Accounts selection is outside the authorized service scope',
  });
}

/**
 * Recognizes the one refusal that startup reconciliation degrades on rather than
 * escalating. Every other CAS outcome stays terminal for its caller.
 */
function isAccountSettingsBoundaryUnavailable(error: unknown): error is PluginError {
  return error instanceof PluginError
    && error.code === 'plugin_connected_account_settings_unavailable';
}

function assertTargetAuthorized(
  target: QualifiedConnectedAccountPurposeBindingTargetV1,
  serviceRefs: readonly PluginContributionRef[],
): void {
  const selectedServiceKey = contributionKey(targetService(target));
  if (!serviceRefs.some((service) => contributionKey(service) === selectedServiceKey)) {
    throw bindingOutOfScope();
  }
}

function replacePurposeBinding(
  collectionLike: QualifiedConnectedAccountPurposeBindingsV1,
  purpose: QualifiedConnectedAccountPurposeV1,
  target: QualifiedConnectedAccountPurposeBindingTargetV1 | null,
): QualifiedConnectedAccountPurposeBindingsV1 {
  const collection = ConnectedPurposeCatalogV1Schema.parse(collectionLike);
  const key = qualifiedPurposeKey(purpose);
  // Agent Team resource defaults share this document. They are kept, except
  // that an explicit personal choice for the same purpose replaces its Team
  // default: one purpose has one default.
  const teamResourceSelections = (collection.teamResourceSelections ?? []).filter((entry) => (
    !target || qualifiedPurposeKey(entry.purpose) !== key
  ));
  return ConnectedPurposeCatalogV1Schema.parse({
    v: 1,
    bindings: [
      ...collection.bindings.filter((binding) => qualifiedPurposeKey(binding.purpose) !== key),
      ...(target ? [{ purpose, target }] : []),
    ].sort((left, right) => qualifiedPurposeKey(left.purpose).localeCompare(qualifiedPurposeKey(right.purpose))),
    ...(teamResourceSelections.length > 0 ? { teamResourceSelections } : {}),
  });
}

function readPurposeTeamResourceSelection(
  collectionLike: QualifiedConnectedAccountPurposeBindingsV1,
  purpose: QualifiedConnectedAccountPurposeV1,
): QualifiedConnectedAccountPurposeTeamResourceSelectionV1 | null {
  const key = qualifiedPurposeKey(purpose);
  return ConnectedPurposeCatalogV1Schema.parse(collectionLike)
    .teamResourceSelections
    ?.find((entry) => qualifiedPurposeKey(entry.purpose) === key) ?? null;
}

function readPurposeBinding(
  collectionLike: QualifiedConnectedAccountPurposeBindingsV1,
  purpose: QualifiedConnectedAccountPurposeV1,
): QualifiedConnectedAccountPurposeBindingTargetV1 | null {
  const key = qualifiedPurposeKey(purpose);
  return ConnectedPurposeCatalogV1Schema.parse(collectionLike)
    .bindings
    .find((binding) => qualifiedPurposeKey(binding.purpose) === key)
    ?.target ?? null;
}

function assertResolvedTargetMatchesIntent(
  target: QualifiedConnectedAccountPurposeBindingTargetV1,
  resolved: ConnectedAccountPurposeResolvedTarget,
): void {
  const intendedService = contributionKey(targetService(target));
  if (contributionKey(resolved.account.service) !== intendedService) {
    throw new Error('connected_account_purpose_resolution_service_mismatch');
  }
  if (
    target.kind === 'account'
    && !sameQualifiedConnectedAccountRef(resolved.account, target.account)
  ) {
    throw new Error('connected_account_purpose_resolution_account_mismatch');
  }
}

function summary(
  purpose: QualifiedConnectedAccountPurposeV1,
  target: QualifiedConnectedAccountPurposeBindingTargetV1,
  resolved: ConnectedAccountPurposeResolvedTarget,
): PluginConnectedAccountBindingSummary {
  return Object.freeze({
    purpose: purpose.purpose,
    service: Object.freeze({ ...targetService(target) }),
    target: Object.freeze({
      kind: target.kind,
      displayName: resolved.displayName,
    }),
    account: Object.freeze({
      service: Object.freeze({ ...resolved.account.service }),
      accountId: resolved.account.accountId,
    }),
  });
}

function sameResolvedTarget(
  left: Readonly<{
    target: QualifiedConnectedAccountPurposeBindingTargetV1;
    resolved: ConnectedAccountPurposeResolvedTarget;
  }>,
  right: Readonly<{
    target: QualifiedConnectedAccountPurposeBindingTargetV1;
    resolved: ConnectedAccountPurposeResolvedTarget;
  }>,
): boolean {
  return targetKey(left.target) === targetKey(right.target)
    && sameQualifiedConnectedAccountRef(left.resolved.account, right.resolved.account)
    && left.resolved.group?.groupId === right.resolved.group?.groupId
    && left.resolved.group?.generation === right.resolved.group?.generation;
}

function immutableBinding(
  bindingLike: QualifiedConnectedAccountPurposeBindingV1,
): QualifiedConnectedAccountPurposeBindingV1 {
  const binding = QualifiedConnectedAccountPurposeBindingV1Schema.parse(bindingLike);
  return Object.freeze({
    purpose: Object.freeze({
      consumer: Object.freeze({ ...binding.purpose.consumer }),
      purpose: binding.purpose.purpose,
    }),
    target: binding.target.kind === 'account'
      ? Object.freeze({
          kind: 'account' as const,
          account: Object.freeze({
            service: Object.freeze({ ...binding.target.account.service }),
            accountId: binding.target.account.accountId,
          }),
        })
      : Object.freeze({
          kind: 'group' as const,
          service: Object.freeze({ ...binding.target.service }),
          groupId: binding.target.groupId,
        }),
  });
}

export function createConnectedAccountPurposeBindingOwner(
  dependencies: ConnectedAccountPurposeBindingOwnerDependencies,
): ConnectedAccountPurposeBindingOwner {
  type PurposeBindingState = Readonly<{
    subjectId: string;
    isSubjectCurrent(): boolean;
    coveredPurposeKeys: ReadonlySet<string>;
    bindingByPurposeKey: ReadonlyMap<string, QualifiedConnectedAccountPurposeBindingV1>;
    bindings: readonly QualifiedConnectedAccountPurposeBindingV1[];
    credentialConfigurations?: readonly Readonly<{ account: QualifiedConnectedAccountRef; revision: string | null }>[];
    directMaterialOriginByPurposeKey: ReadonlyMap<string, ActiveConnectedAccountTeamDirectMaterialOrigin>;
  }>;
  const purposeBindingsBySubjectKey = new Map<string, PurposeBindingState>();
  const purposeBindingsBySubjectId = new Map<string, PurposeBindingState>();
  const retainedConfigurationBasis = (subjectId: string | undefined, account: QualifiedConnectedAccountRef) => {
    const retained = subjectId ? purposeBindingsBySubjectId.get(subjectId)?.credentialConfigurations : undefined;
    if (!retained) return {};
    const basis = retained.find(configuration => sameQualifiedConnectedAccountRef(configuration.account, account));
    if (!basis || retained.some(configuration => sameQualifiedConnectedAccountRef(configuration.account, account)
        && configuration.revision !== basis.revision)) throw bindingOutOfScope();
    return { expectedConfigurationRevision: basis.revision };
  };
  const sessionInvalidationListenersBySessionId = new Map<string, Set<() => void>>();
  const sessionSubjectKey = (sessionId: string): string =>
    JSON.stringify(['session', sessionId]);
  const notifySessionInvalidations = (sessionId: string): void => {
    for (const listener of sessionInvalidationListenersBySessionId.get(sessionId) ?? []) {
      listener();
    }
  };
  const readSessionPurposeBinding = (input: Readonly<{
    exactPurposeBindingSubjectId?: string;
    sessionId?: string;
    purpose: QualifiedConnectedAccountPurposeV1;
  }>): Readonly<{
    covered: boolean;
    binding: QualifiedConnectedAccountPurposeBindingV1 | null;
    directMaterialOrigin: ActiveConnectedAccountTeamDirectMaterialOrigin | null;
  }> => {
    if (input.exactPurposeBindingSubjectId) {
      const state = purposeBindingsBySubjectId.get(
        input.exactPurposeBindingSubjectId,
      );
      const purposeKey = qualifiedPurposeKey(input.purpose);
      let current = false;
      try {
        current = state?.isSubjectCurrent() === true;
      } catch {
        current = false;
      }
      return {
        covered: true,
        binding: current && state?.coveredPurposeKeys.has(purposeKey)
          ? state.bindingByPurposeKey.get(purposeKey) ?? null
          : null,
        directMaterialOrigin: current && state?.coveredPurposeKeys.has(purposeKey)
          ? state.directMaterialOriginByPurposeKey.get(purposeKey) ?? null
          : null,
      };
    }
    if (!input.sessionId) return { covered: false, binding: null, directMaterialOrigin: null };
    const state = purposeBindingsBySubjectKey.get(
      sessionSubjectKey(input.sessionId),
    );
    const purposeKey = qualifiedPurposeKey(input.purpose);
    if (!state?.coveredPurposeKeys.has(purposeKey)) {
      return { covered: false, binding: null, directMaterialOrigin: null };
    }
    return {
      covered: true,
      binding: state.bindingByPurposeKey.get(purposeKey) ?? null,
      directMaterialOrigin: state.directMaterialOriginByPurposeKey.get(purposeKey) ?? null,
    };
  };
  const consumerMutationTails = new Map<string, Promise<void>>();
  const acquireSerializedConsumerMutations = async (
    consumerKeysLike: readonly string[],
  ): Promise<() => void> => {
    const reservations = [...new Set(consumerKeysLike)].sort().map((consumerKey) => {
      const previous = consumerMutationTails.get(consumerKey) ?? Promise.resolve();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => held);
      consumerMutationTails.set(consumerKey, tail);
      return { consumerKey, previous, release, tail };
    });
    await Promise.all(reservations.map(({ previous }) => previous));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const reservation of reservations) {
        reservation.release();
        if (consumerMutationTails.get(reservation.consumerKey) === reservation.tail) {
          consumerMutationTails.delete(reservation.consumerKey);
        }
      }
    };
  };
  const withSerializedConsumerMutations = async <T>(
    consumerKeysLike: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> => {
    const release = await acquireSerializedConsumerMutations(consumerKeysLike);
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const activatePurposeBindings: ConnectedAccountPurposeBindingOwner[
    'activatePurposeBindings'
  ] = (input) => {
    const subject = input.subject;
    const normalized = (() => {
      if (subject.kind === 'session') {
        const sessionId = subject.sessionId.trim();
        if (!sessionId) {
          throw new Error(
            'connected_account_session_binding_session_id_required',
          );
        }
        return {
          subjectKey: sessionSubjectKey(sessionId),
          subjectId: `agent-session:${sessionId}`,
          isSubjectCurrent: () => true,
          sessionId,
          errorPrefix: 'connected_account_session_binding',
          expectedConsumer: null,
          directMaterialConsumer: { kind: 'session' as const, sessionId },
        };
      }
      if (subject.kind === 'execution_run') {
        const runId = subject.runId.trim();
        const agentId = subject.agentId.trim();
        if (!runId) {
          throw new Error(
            'connected_account_execution_run_binding_run_id_required',
          );
        }
        if (!Number.isInteger(subject.runnerPid) || subject.runnerPid <= 0) {
          throw new Error(
            'connected_account_execution_run_binding_runner_pid_required',
          );
        }
        if (!agentId) {
          throw new Error(
            'connected_account_execution_run_binding_agent_id_required',
          );
        }
        return {
          subjectKey: JSON.stringify(['execution_run', runId]),
          subjectId:
            `execution-run:${runId}/runner:${subject.runnerPid}/agent:${agentId}`,
          isSubjectCurrent: subject.isCurrent,
          sessionId: null,
          errorPrefix: 'connected_account_execution_run_binding',
          expectedConsumer: null,
          directMaterialConsumer: { kind: 'execution_run' as const, executionRunId: runId },
        };
      }
      if (subject.kind === 'agent_catalog_observation') {
        const operationId = subject.operationId.trim();
        const consumer = PluginContributionIdentityV1Schema.parse(subject.consumer);
        if (!operationId) {
          throw new Error(
            'connected_account_agent_catalog_observation_binding_operation_id_required',
          );
        }
        return {
          subjectKey: JSON.stringify(['agent_catalog_observation', operationId]),
          subjectId:
            `agent-catalog-observation:${operationId}/agent:${consumer.pluginId}/${consumer.localId}`,
          isSubjectCurrent: subject.isCurrent,
          sessionId: null,
          errorPrefix: 'connected_account_agent_catalog_observation_binding',
          expectedConsumer: Object.freeze({ ...consumer }),
          directMaterialConsumer: null,
        };
      }
      if (subject.kind === 'operation') {
        const operationId = subject.operationId.trim();
        const consumer = PluginContributionIdentityV1Schema.parse(subject.consumer);
        if (!operationId) {
          throw new Error(
            'connected_account_operation_binding_operation_id_required',
          );
        }
        const launchSessionId = subject.sessionId?.trim() ?? '';
        return {
          subjectKey: JSON.stringify(['operation', operationId]),
          subjectId:
            `operation:${operationId}/consumer:${consumer.pluginId}/${consumer.localId}`,
          isSubjectCurrent: subject.isCurrent,
          sessionId: null,
          errorPrefix: 'connected_account_operation_binding',
          expectedConsumer: Object.freeze({ ...consumer }),
          directMaterialConsumer: launchSessionId
            ? { kind: 'session' as const, sessionId: launchSessionId }
            : null,
        };
      }
      const operationId = subject.operationId.trim();
      const pluginId = subject.pluginId.trim();
      const providerLocalId = subject.providerLocalId.trim();
      if (!operationId) {
        throw new Error(
          'connected_account_managed_provider_operation_binding_operation_id_required',
        );
      }
      if (!pluginId || !providerLocalId) {
        throw new Error(
          'connected_account_managed_provider_operation_binding_identity_required',
        );
      }
      return {
        subjectKey: JSON.stringify([
          'managed_provider_operation',
          operationId,
        ]),
        subjectId:
          `managed-provider-operation:${operationId}/provider:${pluginId}/${providerLocalId}`,
        isSubjectCurrent: subject.isCurrent,
        sessionId: null,
        errorPrefix:
          'connected_account_managed_provider_operation_binding',
        expectedConsumer: Object.freeze({
          pluginId,
          localId: providerLocalId,
        }),
        directMaterialConsumer: null,
      };
    })();
    if (
      purposeBindingsBySubjectKey.has(normalized.subjectKey)
      || purposeBindingsBySubjectId.has(normalized.subjectId)
    ) {
      throw new Error(`${normalized.errorPrefix}_already_active`);
    }
    const purposes = input.purposes.map((purpose) =>
      QualifiedConnectedAccountPurposeV1Schema.parse(purpose)
    );
    const coveredPurposeKeys = new Set<string>();
    for (const purpose of purposes) {
      if (
        normalized.expectedConsumer
        && (
          purpose.consumer.pluginId !== normalized.expectedConsumer.pluginId
          || purpose.consumer.localId !== normalized.expectedConsumer.localId
        )
      ) {
        throw new Error(`${normalized.errorPrefix}_consumer_mismatch`);
      }
      const key = qualifiedPurposeKey(purpose);
      if (coveredPurposeKeys.has(key)) {
        throw new Error(`${normalized.errorPrefix}_duplicate_purpose`);
      }
      coveredPurposeKeys.add(key);
    }
    const parsedBindings = ConnectedPurposeCatalogV1Schema.parse({
      v: 1,
      bindings: input.bindings,
    }).bindings.map(immutableBinding);
    const bindingByPurposeKey =
      new Map<string, QualifiedConnectedAccountPurposeBindingV1>();
    for (const binding of parsedBindings) {
      const key = qualifiedPurposeKey(binding.purpose);
      if (!coveredPurposeKeys.has(key)) {
        throw new Error(`${normalized.errorPrefix}_undeclared_purpose`);
      }
      if (bindingByPurposeKey.has(key)) {
        throw new Error(`${normalized.errorPrefix}_duplicate_binding`);
      }
      bindingByPurposeKey.set(key, binding);
    }
    const directMaterialOriginByPurposeKey = new Map<
      string,
      ActiveConnectedAccountTeamDirectMaterialOrigin
    >();
    // The materialization origin (lane 10 child 06 :506-508) is the one
    // carrier of direct Team material: it names the Team resource behind an
    // exact disclosed-member binding, and the Session/Execution Run consumer
    // opens it only through the Home's Team-binding admission. A subject
    // without such a consumer can never serve one.
    for (const origin of input.directMaterialOrigins ?? []) {
      if (!normalized.directMaterialConsumer) {
        throw new Error(`${normalized.errorPrefix}_direct_material_consumer_unsupported`);
      }
      const purpose = QualifiedConnectedAccountPurposeV1Schema.parse(origin.purpose);
      const key = qualifiedPurposeKey(purpose);
      const binding = bindingByPurposeKey.get(key);
      if (
        !binding
        || binding.target.kind !== 'account'
        || !sameQualifiedConnectedAccountRef(binding.target.account, origin.disclosedMember)
      ) {
        throw new Error(`${normalized.errorPrefix}_direct_material_origin_mismatch`);
      }
      if (directMaterialOriginByPurposeKey.has(key)) {
        throw new Error(`${normalized.errorPrefix}_duplicate_direct_material_origin`);
      }
      directMaterialOriginByPurposeKey.set(key, Object.freeze({
        ...origin,
        purpose: Object.freeze({
          consumer: Object.freeze({ ...purpose.consumer }),
          purpose: purpose.purpose,
        }),
        disclosedMember: Object.freeze({
          service: Object.freeze({ ...origin.disclosedMember.service }),
          accountId: origin.disclosedMember.accountId,
        }),
        consumer: normalized.directMaterialConsumer,
      }));
    }
    const state: PurposeBindingState = Object.freeze({
      subjectId: normalized.subjectId,
      isSubjectCurrent: normalized.isSubjectCurrent,
      coveredPurposeKeys,
      bindingByPurposeKey,
      bindings: Object.freeze(parsedBindings),
      ...(subject.kind === 'managed_provider_operation' && subject.credentialConfigurations
        ? { credentialConfigurations: Object.freeze(subject.credentialConfigurations.map(configuration => Object.freeze({
            account: Object.freeze({ service: Object.freeze({ ...configuration.account.service }), accountId: configuration.account.accountId }),
            revision: configuration.revision,
          }))) } : {}),
      directMaterialOriginByPurposeKey,
    });
    purposeBindingsBySubjectKey.set(normalized.subjectKey, state);
    purposeBindingsBySubjectId.set(normalized.subjectId, state);
    if (normalized.sessionId) {
      notifySessionInvalidations(normalized.sessionId);
    }
    let active = true;
    const isCurrent = (): boolean => {
      if (
        !active
        || purposeBindingsBySubjectKey.get(normalized.subjectKey) !== state
        || purposeBindingsBySubjectId.get(normalized.subjectId) !== state
      ) {
        return false;
      }
      try {
        return state.isSubjectCurrent();
      } catch {
        return false;
      }
    };
    return Object.freeze({
      subjectId: state.subjectId,
      isCurrent,
      resolvePurposeBinding(rawPurpose) {
        if (!isCurrent()) return null;
        const purpose = QualifiedConnectedAccountPurposeV1Schema.parse(rawPurpose);
        return state.bindingByPurposeKey.get(qualifiedPurposeKey(purpose)) ?? null;
      },
      listPurposeBindings() {
        return isCurrent() ? state.bindings : Object.freeze([]);
      },
      dispose() {
        if (!active) return;
        active = false;
        if (
          purposeBindingsBySubjectKey.get(normalized.subjectKey) === state
        ) {
          purposeBindingsBySubjectKey.delete(normalized.subjectKey);
          if (purposeBindingsBySubjectId.get(normalized.subjectId) === state) {
            purposeBindingsBySubjectId.delete(normalized.subjectId);
          }
          if (normalized.sessionId) {
            notifySessionInvalidations(normalized.sessionId);
          }
        }
      },
    });
  };

  const readAuthorizedResolvedLocked = async (input: Readonly<{
    purpose: QualifiedConnectedAccountPurposeV1;
    serviceRefs: readonly PluginContributionRef[];
    exactPurposeBindingSubjectId?: string;
    sessionId?: string;
    signal: AbortSignal;
  }>): Promise<Readonly<{
    target: QualifiedConnectedAccountPurposeBindingTargetV1;
    resolved: ConnectedAccountPurposeResolvedTarget;
    directMaterialOrigin: ActiveConnectedAccountTeamDirectMaterialOrigin | null;
  }> | null> => {
    input.signal.throwIfAborted();
    const purpose = QualifiedConnectedAccountPurposeV1Schema.parse(input.purpose);
    const sessionBinding = readSessionPurposeBinding({
      ...(input.exactPurposeBindingSubjectId
        ? {
            exactPurposeBindingSubjectId:
              input.exactPurposeBindingSubjectId,
          }
        : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      purpose,
    });
    if (sessionBinding.covered) {
      const target = sessionBinding.binding?.target ?? null;
      if (!target) return null;
      try {
        assertTargetAuthorized(target, input.serviceRefs);
      } catch {
        return null;
      }
      if (sessionBinding.directMaterialOrigin) {
        return {
          target,
          resolved: Object.freeze({
            displayName: sessionBinding.directMaterialOrigin.disclosedMember.accountId,
            account: sessionBinding.directMaterialOrigin.disclosedMember,
          }),
          directMaterialOrigin: sessionBinding.directMaterialOrigin,
        };
      }
      const resolved = await dependencies.resolveTarget(target, input.signal);
      input.signal.throwIfAborted();
      if (!resolved) return null;
      assertResolvedTargetMatchesIntent(target, resolved);
      return { target, resolved, directMaterialOrigin: null };
    }
    const durable = await dependencies.store.read(input.signal);
    input.signal.throwIfAborted();
    const target = readPurposeBinding(durable, purpose);
    if (!target) {
      // A durable Team resource default is the user's standing intent and the
      // Home is its currentness authority: outside a Session it is refused
      // with a type, never resolved against the personal inventory or erased.
      if (readPurposeTeamResourceSelection(durable, purpose)) throw teamResourceUnavailable();
      return null;
    }
    try {
      assertTargetAuthorized(target, input.serviceRefs);
    } catch {
      // Scope controls disclosure, not user intent. Erasing an explicit selection here
      // would let a later request silently substitute a native credential.
      return null;
    }
    const resolved = await dependencies.resolveTarget(target, input.signal);
    input.signal.throwIfAborted();
    if (!resolved) {
      const revalidatedTarget = readPurposeBinding(
        await dependencies.store.read(input.signal),
        purpose,
      );
      input.signal.throwIfAborted();
      if (!revalidatedTarget || targetKey(revalidatedTarget) !== targetKey(target)) {
        return null;
      }
      const revalidatedResolved = await dependencies.resolveTarget(
        revalidatedTarget,
        input.signal,
      );
      input.signal.throwIfAborted();
      if (revalidatedResolved) {
        assertResolvedTargetMatchesIntent(revalidatedTarget, revalidatedResolved);
        return { target: revalidatedTarget, resolved: revalidatedResolved, directMaterialOrigin: null };
      }
      // Unavailable credential truth does not clear the user's standing selection.
      return null;
    }
    assertResolvedTargetMatchesIntent(target, resolved);
    return { target, resolved, directMaterialOrigin: null };
  };
  const readAuthorizedResolved = async (input: Readonly<{
    purpose: QualifiedConnectedAccountPurposeV1;
    serviceRefs: readonly PluginContributionRef[];
    exactPurposeBindingSubjectId?: string;
    sessionId?: string;
    signal: AbortSignal;
  }>): Promise<Readonly<{
    target: QualifiedConnectedAccountPurposeBindingTargetV1;
    resolved: ConnectedAccountPurposeResolvedTarget;
    directMaterialOrigin: ActiveConnectedAccountTeamDirectMaterialOrigin | null;
  }> | null> => await withSerializedConsumerMutations(
    [contributionKey(QualifiedConnectedAccountPurposeV1Schema.parse(input.purpose).consumer)],
    async () => await readAuthorizedResolvedLocked(input),
  );
  const resolveCurrentSessionPurposeBindingSnapshot = async (input: Readonly<{
    authorizedPurposes: readonly ConnectedAccountPurposeAuthorizationScope[];
    signal: AbortSignal;
  }>): Promise<ConnectedAccountCurrentSessionPurposeBindingSnapshot> => {
    input.signal.throwIfAborted();
    const scopeByPurposeKey = new Map<string, ConnectedAccountPurposeAuthorizationScope>();
    for (const scopeLike of input.authorizedPurposes) {
      const purpose = Object.freeze(
        QualifiedConnectedAccountPurposeV1Schema.parse(scopeLike.purpose),
      );
      const key = qualifiedPurposeKey(purpose);
      if (scopeByPurposeKey.has(key)) {
        throw new Error(
          'connected_account_session_binding_snapshot_duplicate_purpose',
        );
      }
      const serviceRefs = Object.freeze(scopeLike.serviceRefs.map((service) => (
        Object.freeze(PluginContributionIdentityV1Schema.parse(service))
      )));
      scopeByPurposeKey.set(key, Object.freeze({ purpose, serviceRefs }));
    }
    const scopes = [...scopeByPurposeKey.values()];
    return await withSerializedConsumerMutations(
      scopes.map((scope) => contributionKey(scope.purpose.consumer)),
      async () => {
        const bindings: QualifiedConnectedAccountPurposeBindingV1[] = [];
        const directMaterialOrigins: ConnectedAccountTeamDirectMaterialOrigin[] = [];
        const teamResourceSelections: ConnectedAccountSessionTeamResourceSelection[] = [];
        const current = await dependencies.store.read(input.signal);
        input.signal.throwIfAborted();
        for (const scope of scopes) {
          const teamSelection = readPurposeTeamResourceSelection(current, scope.purpose);
          if (teamSelection) {
            const selection = teamSelection.selection;
            if (selection.deliveryMode === 'direct') {
              const service = scope.serviceRefs.find((candidate) => (
                contributionKey(candidate) === contributionKey(selection.disclosedMember.service)
              ));
              const projected = service
                ? projectTeamResourceSelectionToSessionPurposeBinding({
                    purpose: scope.purpose,
                    service,
                    selection,
                  })
                : null;
              if (!projected) continue;
              bindings.push(projected.binding);
              directMaterialOrigins.push(projected.origin);
            }
            teamResourceSelections.push(Object.freeze({
              purpose: scope.purpose,
              teamId: teamSelection.teamId,
              selection,
              services: scope.serviceRefs,
            }));
            continue;
          }
          const resolved = await readAuthorizedResolvedLocked({
            purpose: scope.purpose,
            serviceRefs: scope.serviceRefs,
            signal: input.signal,
          });
          if (resolved) {
            bindings.push(immutableBinding({
              purpose: scope.purpose,
              target: resolved.target,
            }));
          }
        }
        return Object.freeze({
          purposes: Object.freeze(scopes.map((scope) => scope.purpose)),
          bindings: Object.freeze(bindings),
          directMaterialOrigins: Object.freeze(directMaterialOrigins),
          teamResourceSelections: Object.freeze(teamResourceSelections),
        });
      },
    );
  };

  const materialize = async (
    input: Parameters<StablePluginConnectedAccountsOwner['materialize']>[0],
  ): Promise<PluginConnectedAccountMaterialization> => {
    if (input.nativeService && (input.expectedAccount || input.credentialRevisionBasis)) throw bindingOutOfScope();
    const nativeService = input.nativeService
      ? PluginContributionIdentityV1Schema.safeParse(input.nativeService)
      : null;
    if (nativeService && (!nativeService.success || !input.serviceRefs.some((ref) => (
      contributionKey(ref) === contributionKey(nativeService.data)
    )))) throw bindingOutOfScope();
    const authorizationInput = Object.freeze({
      purpose: input.purpose,
      serviceRefs: input.serviceRefs,
      ...(input.exactPurposeBindingSubjectId
        ? { exactPurposeBindingSubjectId: input.exactPurposeBindingSubjectId }
        : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      signal: input.signal,
    });
    const hasExplicitSelectionLocked = async (): Promise<boolean> => {
      if (input.exactPurposeBindingSubjectId) {
        const state = purposeBindingsBySubjectId.get(input.exactPurposeBindingSubjectId);
        let current = false;
        try {
          current = state?.isSubjectCurrent() === true
            && state.coveredPurposeKeys.has(qualifiedPurposeKey(input.purpose));
        } catch {
          current = false;
        }
        if (!current) throw resourceNotSelected(input.purpose);
      }
      const session = readSessionPurposeBinding(authorizationInput);
      if (session.covered) return session.binding !== null;
      const durable = await dependencies.store.read(input.signal);
      input.signal.throwIfAborted();
      return readPurposeBinding(durable, input.purpose) !== null
        || readPurposeTeamResourceSelection(durable, input.purpose) !== null;
    };
    const readMaterializationTarget = async () => await readAuthorizedResolved(authorizationInput);
    const before = input.nativeService
      ? await withSerializedConsumerMutations(
          [contributionKey(input.purpose.consumer)],
          async () => ({
            explicit: await hasExplicitSelectionLocked(),
            resolved: await readAuthorizedResolvedLocked(authorizationInput),
          }),
        )
      : { explicit: false, resolved: await readMaterializationTarget() };
    const resolved = before.resolved;
    if (!resolved) {
      if (before.explicit || !input.nativeService || !dependencies.materializeNative) throw resourceNotSelected(input.purpose);
      if (!nativeService?.success) throw bindingOutOfScope();
      const service = Object.freeze(nativeService.data);
      const materialization = await dependencies.materializeNative({ service, request: input.request, signal: input.signal });
      input.signal.throwIfAborted();
      await withSerializedConsumerMutations([contributionKey(input.purpose.consumer)], async () => {
        if (await hasExplicitSelectionLocked()) throw resourceNotSelected(input.purpose);
      });
      return materialization;
    }
    if (
      input.expectedAccount
      && !sameQualifiedConnectedAccountRef(input.expectedAccount, resolved.resolved.account)
    ) {
      throw resourceNotSelected(input.purpose);
    }
    let materializedCredentialRevision: ConnectedServiceCredentialRevisionV1 | null = null;
    const credentialRevisionBasis = input.credentialRevisionBasis
      ? Object.freeze({
          expectedCredentialRevision:
            input.credentialRevisionBasis.expectedCredentialRevision,
          captureCredentialRevision(credentialRevision: ConnectedServiceCredentialRevisionV1) {
            materializedCredentialRevision = credentialRevision;
          },
        })
      : null;
    const materialization = resolved.directMaterialOrigin
      ? await (() => {
          if (!dependencies.materializeTeamDirect) throw bindingOutOfScope();
          return dependencies.materializeTeamDirect({
            origin: resolved.directMaterialOrigin,
            consumer: resolved.directMaterialOrigin.consumer,
            account: resolved.resolved.account,
            ...(credentialRevisionBasis ? { credentialRevisionBasis } : {}),
            request: input.request,
            signal: input.signal,
          });
        })()
      : await dependencies.materializeAccount({
          account: resolved.resolved.account,
          ...retainedConfigurationBasis(input.exactPurposeBindingSubjectId, resolved.resolved.account),
          ...(credentialRevisionBasis ? { credentialRevisionBasis } : {}),
          request: input.request,
          signal: input.signal,
        });
    input.signal.throwIfAborted();
    const current = await readMaterializationTarget();
    if (
      !current
      || targetKey(current.target) !== targetKey(resolved.target)
      || !sameQualifiedConnectedAccountRef(
        current.resolved.account,
        resolved.resolved.account,
      )
      || current.directMaterialOrigin?.resourceId
        !== resolved.directMaterialOrigin?.resourceId
      || (
        input.expectedAccount
        && !sameQualifiedConnectedAccountRef(input.expectedAccount, current.resolved.account)
      )
    ) {
      throw resourceNotSelected(input.purpose);
    }
    if (input.credentialRevisionBasis) {
      if (materializedCredentialRevision === null) throw bindingOutOfScope();
      input.credentialRevisionBasis.captureCredentialRevision(
        materializedCredentialRevision,
      );
    }
    return materialization;
  };

  const listAccounts = async (
    input: Parameters<StablePluginConnectedAccountsOwner['listAccounts']>[0],
  ): Promise<PluginConnectedAccountMetadataList> => {
    const authorizationInput = Object.freeze({
      purpose: input.purpose,
      serviceRefs: input.serviceRefs,
      ...(input.exactPurposeBindingSubjectId
        ? { exactPurposeBindingSubjectId: input.exactPurposeBindingSubjectId }
        : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      signal: input.signal,
    });
    const before = await readAuthorizedResolved(authorizationInput);
    if (!before) throw resourceNotSelected(input.purpose);
    const listing = await dependencies.projectTargetAccounts({
      target: before.target,
      limit: input.limit,
      signal: input.signal,
    });
    input.signal.throwIfAborted();
    const after = await readAuthorizedResolved(authorizationInput);
    if (!after || !sameResolvedTarget(before, after)) {
      throw bindingOutOfScope();
    }
    return listing;
  };

  const materializeListedAccount = async (
    input: Parameters<StablePluginConnectedAccountsOwner['materializeListedAccount']>[0],
  ): Promise<PluginConnectedAccountMaterialization> => {
    const authorizationInput = Object.freeze({
      purpose: input.purpose,
      serviceRefs: input.serviceRefs,
      ...(input.exactPurposeBindingSubjectId
        ? { exactPurposeBindingSubjectId: input.exactPurposeBindingSubjectId }
        : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      signal: input.signal,
    });
    const before = await readAuthorizedResolved(authorizationInput);
    if (!before) throw bindingOutOfScope();
    await dependencies.assertTargetAccountMaterializable({
      target: before.target,
      account: input.account,
      request: input.request,
      signal: input.signal,
    });
    const materialization = await dependencies.materializeAccount({
      account: input.account,
      ...retainedConfigurationBasis(input.exactPurposeBindingSubjectId, input.account),
      request: input.request,
      signal: input.signal,
    });
    input.signal.throwIfAborted();
    await dependencies.assertTargetAccountMaterializable({
      target: before.target,
      account: input.account,
      request: input.request,
      signal: input.signal,
    });
    const after = await readAuthorizedResolved(authorizationInput);
    if (!after || !sameResolvedTarget(before, after)) {
      throw bindingOutOfScope();
    }
    return materialization;
  };

  const groupForRequestAuthTarget = (
    target: QualifiedConnectedAccountPurposeBindingTargetV1,
    resolved: ConnectedAccountPurposeResolvedTarget,
  ): ConnectedAccountRequestAuthResolvedBinding['group'] | null => {
    if (target.kind === 'account') {
      return resolved.group === undefined ? undefined : null;
    }
    if (
      !resolved.group
      || resolved.group.groupId !== target.groupId
    ) {
      return null;
    }
    return Object.freeze({
      groupId: resolved.group.groupId,
      generation: resolved.group.generation,
    });
  };

  const resolveCurrentRequestAuthBinding = async (input: Readonly<{
    subjectId: string;
    binding: QualifiedConnectedAccountPurposeBindingV1;
    signal: AbortSignal;
  }>): Promise<ConnectedAccountRequestAuthResolvedBinding | null> => {
    const subjectId = input.subjectId.trim();
    if (!subjectId) return null;
    const binding = QualifiedConnectedAccountPurposeBindingV1Schema.parse(
      input.binding,
    );
    const service = Object.freeze({ ...targetService(binding.target) });
    const readCurrent = async () => {
      const current = await readAuthorizedResolvedLocked({
        purpose: binding.purpose,
        serviceRefs: Object.freeze([service]),
        exactPurposeBindingSubjectId: subjectId,
        signal: input.signal,
      });
      if (
        !current
        || targetKey(current.target) !== targetKey(binding.target)
      ) {
        return null;
      }
      const group = groupForRequestAuthTarget(
        current.target,
        current.resolved,
      );
      return group === null
        ? null
        : Object.freeze({ current, group });
    };
    return await withSerializedConsumerMutations(
      [contributionKey(binding.purpose.consumer)],
      async () => {
        const before = await readCurrent();
        if (!before) return null;
        const revisionLike = before.current.directMaterialOrigin?.resourceId
          ?? (dependencies.resolveCredentialRevision
            ? await dependencies.resolveCredentialRevision(
                before.current.resolved.account,
                input.signal,
              )
            : null);
        input.signal.throwIfAborted();
        const revision = before.current.directMaterialOrigin
          ? { success: true as const, data: revisionLike as ConnectedServiceCredentialRevisionV1 }
          : ConnectedServiceCredentialRevisionV1Schema.safeParse(revisionLike);
        if (!revision.success || revisionLike === null) return null;
        const after = await readCurrent();
        if (
          !after
          || !sameQualifiedConnectedAccountRef(
            before.current.resolved.account,
            after.current.resolved.account,
          )
          || before.group?.groupId !== after.group?.groupId
          || before.group?.generation !== after.group?.generation
        ) {
          return null;
        }
        return Object.freeze({
          account: Object.freeze({
            service: Object.freeze({ ...after.current.resolved.account.service }),
            accountId: after.current.resolved.account.accountId,
          }),
          credentialRevision: revision.data,
          ...(after.group ? { group: after.group } : {}),
        });
      },
    );
  };

  const materializeRequestAuthBearer = async (input: Readonly<{
    subjectId: string;
    binding: QualifiedConnectedAccountPurposeBindingV1;
    resolved: ConnectedAccountRequestAuthResolvedBinding;
    materialization: QualifiedConnectedAccountRequestAuthUseV1['materialization'];
    signal: AbortSignal;
  }>): Promise<BearerMaterial> => {
    const subjectId = input.subjectId.trim();
    if (!subjectId) throw bindingOutOfScope();
    const binding = QualifiedConnectedAccountPurposeBindingV1Schema.parse(
      input.binding,
    );
    const revision = ConnectedServiceCredentialRevisionV1Schema.safeParse(
      input.resolved.credentialRevision,
    );
    if (!revision.success) throw bindingOutOfScope();
    const expectedCredentialRevision = revision.data;
    if (
      contributionKey(input.resolved.account.service)
      !== contributionKey(targetService(binding.target))
    ) {
      throw bindingOutOfScope();
    }
    const expectedGroup = groupForRequestAuthTarget(binding.target, {
      displayName: '',
      account: input.resolved.account,
      ...(input.resolved.group ? { group: input.resolved.group } : {}),
    });
    if (expectedGroup === null) throw bindingOutOfScope();
    if (
      binding.target.kind === 'account'
      && !sameQualifiedConnectedAccountRef(binding.target.account, input.resolved.account)
    ) {
      throw bindingOutOfScope();
    }
    const currentBefore = await resolveCurrentRequestAuthBinding({
      subjectId,
      binding,
      signal: input.signal,
    });
    if (
      !currentBefore
      || !sameQualifiedConnectedAccountRef(currentBefore.account, input.resolved.account)
      || currentBefore.credentialRevision !== expectedCredentialRevision
      || currentBefore.group?.groupId !== input.resolved.group?.groupId
      || currentBefore.group?.generation !== input.resolved.group?.generation
    ) {
      throw bindingOutOfScope();
    }
    let materializedCredentialRevision: ConnectedServiceCredentialRevisionV1 | null = null;
    const materialization = await materialize({
      purpose: binding.purpose,
      serviceRefs: Object.freeze([
        Object.freeze({ ...targetService(binding.target) }),
      ]),
      exactPurposeBindingSubjectId: subjectId,
      expectedAccount: input.resolved.account,
      credentialRevisionBasis: Object.freeze({
        expectedCredentialRevision,
        captureCredentialRevision(credentialRevision) {
          materializedCredentialRevision = credentialRevision;
        },
      }),
      request: input.materialization,
      signal: input.signal,
    });
    if (materializedCredentialRevision !== expectedCredentialRevision) {
      throw bindingOutOfScope();
    }
    const currentAfter = await resolveCurrentRequestAuthBinding({
      subjectId,
      binding,
      signal: input.signal,
    });
    if (
      !currentAfter
      || !sameQualifiedConnectedAccountRef(currentAfter.account, input.resolved.account)
      || currentAfter.credentialRevision !== expectedCredentialRevision
      || currentAfter.group?.groupId !== input.resolved.group?.groupId
      || currentAfter.group?.generation !== input.resolved.group?.generation
    ) {
      throw bindingOutOfScope();
    }
    return parseHttpHeadersRequestAuthBearer(
      input.materialization,
      materialization,
    );
  };

  const resolveBindingIntentSelection: ConnectedAccountPurposeBindingOwner['resolveBindingIntentSelection'] = async (input) => {
    input.signal.throwIfAborted();
    const purpose = QualifiedConnectedAccountPurposeV1Schema.parse(input.purpose);
    const target = QualifiedConnectedAccountPurposeBindingTargetV1Schema.parse(input.target);
    assertTargetAuthorized(target, input.serviceRefs);
    const resolved = await dependencies.resolveTarget(target, input.signal);
    input.signal.throwIfAborted();
    if (!resolved) throw resourceNotSelected(purpose);
    assertResolvedTargetMatchesIntent(target, resolved);
    const binding = immutableBinding({ purpose, target });
    return Object.freeze({
      binding,
      resolved,
      async isCurrent(signal: AbortSignal = input.signal) {
        if (signal.aborted) return false;
        try {
          const current = await dependencies.resolveTarget(target, signal);
          return !signal.aborted && current !== null
            && sameQualifiedConnectedAccountRef(current.account, resolved.account)
            && current.group?.groupId === resolved.group?.groupId
            && current.group?.generation === resolved.group?.generation;
        } catch {
          return false;
        }
      },
    });
  };

  return Object.freeze({
    activatePurposeBindings,
    async readCredentialConfigurationRevision(account, signal) {
      signal.throwIfAborted();
      if (!dependencies.resolveCredentialConfigurationRevision) throw bindingOutOfScope();
      const revision = await dependencies.resolveCredentialConfigurationRevision(account, signal);
      signal.throwIfAborted();
      return revision;
    },
    activateSessionPurposeBindings(input) {
      return activatePurposeBindings({
        subject: {
          kind: 'session',
          sessionId: input.sessionId,
        },
        purposes: input.purposes,
        bindings: input.bindings,
        ...(input.directMaterialOrigins
          ? { directMaterialOrigins: input.directMaterialOrigins }
          : {}),
      });
    },
    resolveBindingIntentSelection,
    async resolveBindingIntent(input) {
      return (await resolveBindingIntentSelection(input)).binding;
    },
    resolveCurrentSessionPurposeBindingSnapshot,
    resolveCurrentRequestAuthBinding,
    materializeRequestAuthBearer,
    async reconcileAuthorizedPurposes(input) {
      input.signal.throwIfAborted();
      const authorizedByConsumerKey = new Map<string, ReadonlySet<string>>();
      // Validate the complete candidate before entering the one durable mutation.
      for (const consumerScope of input.consumerScopes) {
        const consumer = PluginContributionIdentityV1Schema.parse(
          consumerScope.consumer,
        );
        const consumerKey = contributionKey(consumer);
        if (authorizedByConsumerKey.has(consumerKey)) {
          throw new Error(
            'connected_account_purpose_reconciliation_duplicate_consumer',
          );
        }
        const authorizedPurposeKeys = new Set<string>();
        for (const scope of consumerScope.authorizedPurposes) {
          const purpose = QualifiedConnectedAccountPurposeV1Schema.parse(
            scope.purpose,
          );
          if (contributionKey(purpose.consumer) !== consumerKey) {
            throw new Error(
              'connected_account_purpose_reconciliation_consumer_mismatch',
            );
          }
          const purposeKey = qualifiedPurposeKey(purpose);
          if (authorizedPurposeKeys.has(purposeKey)) {
            throw new Error(
              'connected_account_purpose_reconciliation_duplicate_purpose',
            );
          }
          authorizedPurposeKeys.add(purposeKey);
        }
        authorizedByConsumerKey.set(
          consumerKey,
          authorizedPurposeKeys,
        );
      }
      if (authorizedByConsumerKey.size === 0) {
        input.publish();
        return;
      }
      const release = await acquireSerializedConsumerMutations(
        [...authorizedByConsumerKey.keys()],
      );
      try {
        while (true) {
          input.signal.throwIfAborted();
          try {
            await dependencies.store.update((currentLike) => {
              const current = ConnectedPurposeCatalogV1Schema.parse(currentLike);
              return ConnectedPurposeCatalogV1Schema.parse({
                ...current,
                bindings: current.bindings.filter((binding) => {
                  const authorizedPurposeKeys =
                    authorizedByConsumerKey.get(
                      contributionKey(binding.purpose.consumer),
                    );
                  if (!authorizedPurposeKeys) return true;
                  // Only removal of the purpose retires its durable intent. A service-scope
                  // change refuses disclosure without reopening native fallback.
                  return authorizedPurposeKeys.has(qualifiedPurposeKey(binding.purpose));
                }),
              });
            }, input.signal);
            break;
          } catch (error) {
            // Automatic pruning can reapply its current declaration set to a
            // freshly observed row. User selections still surface CAS conflicts.
            if (!(error instanceof PluginError)
              || error.code !== 'plugin_connected_account_settings_conflict' || !error.retryable) throw error;
          }
        }
        input.publish();
        release();
      } catch (error) {
        if (!isAccountSettingsBoundaryUnavailable(error)) {
          release();
          throw error;
        }
        // The Account Settings boundary is the same missing truth the startup
        // warmer and the retained-materialization scan both already treat as
        // non-fatal. This prune is durable cleanup, not the authorization gate:
        // every read re-checks `assertTargetAuthorized` and refuses an
        // out-of-scope entry without erasing explicit intent. Escalating
        // here instead left the candidate registry unpublished and the daemon
        // unable to start at all, with no cache to recover from on a fresh host.
        logger.debug(
          '[connected-accounts] Account Settings is unavailable; deferred the'
          + ' Connected Account purpose-binding prune and published the candidate'
          + ' registry anyway',
          {
            // Details first, so the error's own identity below can never be
            // shadowed by a detail key.
            ...(error.details && typeof error.details === 'object' && !Array.isArray(error.details)
              ? error.details
              : {}),
            code: error.code,
            retryable: error.retryable,
            // The flag decides the operator's next move, so it is stated rather
            // than left for them to infer from the code.
            recovery: error.retryable
              ? 'the prune re-runs on the next registry publication'
              : 'the boundary will not recover without operator action',
          },
        );
        input.publish();
        release();
      }
    },
    async getBinding(input) {
      const resolved = await readAuthorizedResolved(input);
      return resolved ? summary(input.purpose, resolved.target, resolved.resolved) : null;
    },
    async requestSelection(input) {
      input.signal.throwIfAborted();
      const purpose = QualifiedConnectedAccountPurposeV1Schema.parse(input.purpose);
      const target = QualifiedConnectedAccountPurposeBindingTargetV1Schema.parse(
        await dependencies.selectTarget({
          purpose,
          serviceRefs: input.serviceRefs,
          ...(input.currentSession ? { currentSession: input.currentSession } : {}),
          ...(input.permissionOwner ? { permissionOwner: input.permissionOwner } : {}),
          assertGenerationCurrent: input.assertGenerationCurrent,
          reason: input.reason,
          signal: input.signal,
        }),
      );
      assertTargetAuthorized(target, input.serviceRefs);
      return await withSerializedConsumerMutations(
        [contributionKey(purpose.consumer)],
        async () => {
          input.assertGenerationCurrent();
          input.signal.throwIfAborted();
          const resolved = await dependencies.resolveTarget(target, input.signal);
          input.assertGenerationCurrent();
          input.signal.throwIfAborted();
          if (!resolved) {
            throw resourceNotSelected(purpose);
          }
          assertResolvedTargetMatchesIntent(target, resolved);
          await dependencies.store.update(
            (current) => {
              input.assertGenerationCurrent();
              return replacePurposeBinding(current, purpose, target);
            },
            input.signal,
          );
          input.assertGenerationCurrent();
          input.signal.throwIfAborted();
          return summary(purpose, target, resolved);
        },
      );
    },
    materialize,
    listAccounts,
    materializeListedAccount,
    watch(input) {
      QualifiedConnectedAccountPurposeV1Schema.parse(input.purpose);
      let disposed = false;
      const notify = () => {
        if (!disposed) input.listener();
      };
      const storeSubscription = dependencies.store.subscribe(notify);
      const projectionSubscription = dependencies.subscribeInvalidations?.(notify);
      const sessionListeners = input.sessionId
        ? sessionInvalidationListenersBySessionId.get(input.sessionId) ?? new Set<() => void>()
        : null;
      if (input.sessionId && sessionListeners) {
        sessionInvalidationListenersBySessionId.set(input.sessionId, sessionListeners);
        sessionListeners.add(notify);
      }
      return Object.freeze({
        dispose() {
          if (disposed) return;
          disposed = true;
          storeSubscription.dispose();
          projectionSubscription?.dispose();
          if (input.sessionId && sessionListeners) {
            sessionListeners.delete(notify);
            if (sessionListeners.size === 0) {
              sessionInvalidationListenersBySessionId.delete(input.sessionId);
            }
          }
        },
      });
    },
  });
}

export function createActiveAccountSettingsConnectedAccountPurposeBindingStore(input: Readonly<{
  credentials?: StoredCredentials; operationContext?: SavedSecretOperationContextV1;
  subscribe?: ConnectedAccountPurposeBindingStore['subscribe'];
}> = {}): ConnectedAccountPurposeBindingStore {
  const readSnapshot = () => input.operationContext ? input.operationContext.readSnapshot() : getActiveAccountSettingsSnapshot();
  const unavailable = (reason: string) => new PluginError({ code: 'plugin_connected_account_settings_unavailable',
    message: 'Connected Account purpose catalog is unavailable', details: { reason } });
  const captureOperation = () => {
    const snapshot = readSnapshot();
    const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
    const assertCurrent = () => {
      if (!snapshot?.scopeKey || readSnapshot()?.scopeKey !== snapshot.scopeKey
        || !input.operationContext && getActiveAccountSettingsSnapshotLifetimeToken() !== lifetime) {
        throw unavailable('scope-retired');
      }
    };
    const verifyCurrent = async () => {
      assertCurrent();
      if (input.operationContext && !await input.operationContext.isCurrent()) throw unavailable('scope-retired');
      assertCurrent();
    };
    assertCurrent();
    return { assertCurrent, verifyCurrent };
  };
  const credentialsForOperation = async (operation: ReturnType<typeof captureOperation>) => {
    const credentials = input.operationContext?.credentials ?? input.credentials ?? await readStoredCredentials();
    await operation.verifyCurrent();
    if (!credentials) throw unavailable('credentials-unavailable');
    return credentials;
  };
  const readCatalog = async (operation: ReturnType<typeof captureOperation>, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    await operation.verifyCurrent();
    let catalog = readConnectedAccountCatalogFromSnapshot(readSnapshot(), 'purposes');
    if (catalog.status === 'loading') catalog = await refreshActiveConnectedAccountCatalog({
      credentials: await credentialsForOperation(operation), key: 'purposes', signal, operationContext: input.operationContext });
    await operation.verifyCurrent();
    if (catalog.status !== 'ready') throw unavailable(catalog.status === 'unavailable' ? catalog.reason : 'loading');
    if (catalog.record.key !== 'purposes') throw unavailable('invalid-stored-content');
    signal?.throwIfAborted();
    return { ...catalog, record: catalog.record };
  };
  return Object.freeze({
    async read(signal) {
      const operation = captureOperation();
      const catalog = await readCatalog(operation, signal);
      operation.assertCurrent();
      return catalog.record.value;
    },
    async update(mutate, signal) {
      const operation = captureOperation();
      const current = await readCatalog(operation, signal);
      await operation.verifyCurrent();
      operation.assertCurrent();
      const value = ConnectedPurposeCatalogV1Schema.parse(mutate(current.record.value));
      const credentials = await credentialsForOperation(operation);
      operation.assertCurrent();
      const transport = createCliConnectedAccountCatalogStore({ credentials, signal, operationContext: input.operationContext });
      const result = await transport.writeRecord({ record: { key: 'purposes', value }, expectedRevision: current.revision }).catch((error: unknown) => {
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        if (code === 'outcome_unknown') throw new PluginError({ code: 'plugin_connected_account_settings_outcome_unknown',
          message: 'Connected Account purpose mutation outcome is unknown' });
        if (code === 'scope-retired') throw unavailable('scope-retired');
        throw error;
      });
      if (result.status === 'conflict' || result.status === 'settings-conflict') {
        // Retain the current winner before a caller re-applies automatic
        // reconciliation; replaying against the stale snapshot cannot converge.
        await refreshActiveConnectedAccountCatalog({ credentials, key: 'purposes', signal,
          operationContext: input.operationContext }, true);
        await operation.verifyCurrent();
        throw new PluginError({
          code: 'plugin_connected_account_settings_conflict', message: 'Connected Account purpose catalog changed', retryable: true,
          details: { currentVersion: String(result.revision) } });
      }
      if (result.status !== 'updated') throw unavailable(result.status);
      const acknowledgedUnavailable = (reason: string) => new PluginError({
        code: 'plugin_connected_account_settings_unavailable',
        message: 'Bindings unavailable after the acknowledged Connected Account mutation',
        details: { reason, mutationStatus: 'updated', revision: result.revision },
      });
      const verifyAcknowledgedReadback = async () => {
        try { await operation.verifyCurrent(); } catch {
          throw acknowledgedUnavailable('scope-retired');
        }
      };
      await verifyAcknowledgedReadback();
      const observed = await refreshActiveConnectedAccountCatalog({ credentials, key: 'purposes', signal,
        operationContext: input.operationContext }, true);
      await verifyAcknowledgedReadback();
      if (observed.status !== 'ready' || observed.record.key !== 'purposes' || observed.revision < result.revision) {
        throw acknowledgedUnavailable('authority-not-confirmed');
      }
      return observed.record.value;
    },
    subscribe(listener) {
      // Bindings, service configuration and the Saved Secrets they reference
      // live in the Account snapshot. The Connected Services projection reaches
      // purpose watches through the runtime's own invalidation instead.
      if (input.subscribe) return input.subscribe(listener);
      const unsubscribe = subscribeActiveAccountSettingsSnapshotChanges(() => listener());
      return Object.freeze({ dispose: unsubscribe });
    },
  });
}

export {
  readPurposeBinding,
  replacePurposeBinding,
};
