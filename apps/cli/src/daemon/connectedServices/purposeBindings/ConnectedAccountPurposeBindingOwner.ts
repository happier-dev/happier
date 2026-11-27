import { withActionFailureDiagnostic } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';
import type { TeamCredentialDirectMaterialClient } from '../directMaterial/teamCredentialDirectMaterialClient';
import type { TeamCredentialDirectMaterialConsumerV1 } from '@happier-dev/protocol/teams';
import { isDeepStrictEqual } from 'node:util';
import { readConnectedAccountPurposeProfileLabel, type ConnectedAccountPurposeResolvedTarget,
  type ConnectedAccountInvocationPurposeBinding, type ConnectedAccountConfiguredOriginAssertion } from '@happier-dev/cli-common/connectedAccounts';
import type { ActionOperationCredentialUseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isPluginError, PluginError, type Disposable } from '@happier-dev/plugin-sdk';
import type { QualifiedConnectedAccountProfileV4, QualifiedConnectedAccountGroupV4 } from '@happier-dev/protocol';
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
import type { ConnectedAccountCatalogSnapshotV1 } from '@happier-dev/protocol/connect/connectedAccountCatalogV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { QualifiedConnectedAccountPurposeV1Schema } from '@happier-dev/protocol/connect/connectedAccountPurposeIdentity';
import { QualifiedConnectedAccountRequestAuthUseV1Schema } from '@happier-dev/protocol/connect/connected-account-request-auth';
import { ConnectedServiceCredentialRevisionV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';
import { PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import { ConnectedAccountServiceIdentityV1Schema, HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1, sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { canonicalMcpOAuthResourceUrlV1 } from '@happier-dev/protocol/mcp/oauth/mcpOAuthResourceV1';
import { MCP_REQUEST_AUTH_PURPOSE } from '@/mcp/runtime/mcpRequestAuth';
import type { PluginContributionIdentityV1, ConnectedServiceCredentialRevisionV1, QualifiedConnectedAccountPurposeBindingsV1, QualifiedConnectedAccountPurposeBindingV1, QualifiedConnectedAccountPurposeBindingTargetV1, QualifiedConnectedAccountPurposeTeamResourceSelectionV1, QualifiedConnectedAccountPurposeV1, QualifiedConnectedAccountRequestAuthUseV1, QualifiedConnectedAccountRef, TeamResourceConnectedServiceSelectionV2 } from '@happier-dev/protocol';

import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { createCliConnectedAccountCatalogStore } from '@/settings/connectedAccounts/connectedAccountCatalogStore';
import { readActiveConnectedAccountCatalog, refreshActiveConnectedAccountCatalog } from '@/settings/connectedAccounts/hydrateConnectedAccountCatalog';
import {
  commitActiveConnectedAccountCatalog,
  getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken,
  readConnectedAccountCatalogFromSnapshot,
  readPublishedConnectedAccountCatalog,
  subscribeActiveAccountSettingsKeys,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type {
  HostCurrentSessionUiServices,
} from '@/agent/runtime/state/currentSessionUiTypes';
import type { PermissionRequestOwner } from '@/agent/permissions/permissionRequestOwner';
import { logger } from '@/ui/logger';
import { observeCurrentConnectedServiceMaterializationPhase as observeMaterializationPhase } from '../materialize/materializationPhase';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import type {
  ConnectedAccountMaterializationCredentialRevisionBasis,
  StablePluginConnectedAccountsOwner,
} from '@/plugins/runtime/invocation/services/connectedAccounts';
import {
  ConnectedAccountRequestAuthError,
  type HeadersMaterial,
  type ConnectedAccountRequestAuthResolvedBinding,
  type ConnectedAccountRequestAuthPurposeUse,
  type ConnectedAccountRequestAuthSubject,
  type ConnectedAccountRequestAuthBindingAuthority,
} from '../requestAuth/ConnectedAccountRequestAuthService';
import {
  parseHttpHeadersRequestAuthMaterial,
} from '../requestAuth/parseHttpHeadersRequestAuthMaterial';
import { runConnectedAccountBindingStage, withConnectedAccountBindingDiagnostic } from './bindingDiagnostics';
import {
  assertConnectedAccountPurposeTargetAuthorized as assertTargetAuthorized,
  assertConnectedAccountPurposeResolvedTargetMatchesIntent as assertResolvedTargetMatchesIntent,
  readConnectedAccountPurposeBindingTarget,
} from '@happier-dev/cli-common/connectedAccounts';

export type ConnectedAccountPurposeBindingStore = Readonly<{
  read(signal?: AbortSignal, options?: Readonly<{ published: true }>): Promise<QualifiedConnectedAccountPurposeBindingsV1>;
  update(
    mutate: (
      current: QualifiedConnectedAccountPurposeBindingsV1,
    ) => QualifiedConnectedAccountPurposeBindingsV1,
    signal?: AbortSignal,
  ): Promise<QualifiedConnectedAccountPurposeBindingsV1>;
  subscribe(listener: () => void): Disposable;
}>;

export { readConnectedAccountPurposeProfileLabel, type ConnectedAccountPurposeResolvedTarget } from '@happier-dev/cli-common/connectedAccounts';

/** Existing logical selection and native member/generation tuple, retained for one host operation. */
export type ConnectedAccountPurposeBindingIntentSelection = Readonly<{
  binding: QualifiedConnectedAccountPurposeBindingV1;
  resolved: ConnectedAccountPurposeResolvedTarget;
  isCurrent(signal?: AbortSignal): Promise<boolean>;
}>;

/** Admission pointer to one exact recipient-scoped Team material row. */
export type ConnectedAccountTeamDirectMaterialOrigin = Readonly<{
  /** Team routing captured by the admitting owner, never inferred from the source member. */
  teamId?: string;
  purpose: QualifiedConnectedAccountPurposeV1;
  resourceId: string;
  disclosedMember: QualifiedConnectedAccountRef;
  /** Host-private finite admission; released with the existing operation lease. */
  admittedActionMaterial?: Extract<Awaited<ReturnType<TeamCredentialDirectMaterialClient['open']>>, { ok: true }>;
}>;
// The runtime adapter supplies the worker Machine for execution Runs.
type TeamDirectMaterialConsumer =
  | Exclude<TeamCredentialDirectMaterialConsumerV1, { kind: 'execution_run' }>
  | Omit<Extract<TeamCredentialDirectMaterialConsumerV1, { kind: 'execution_run' }>, 'workerMachineId'>;

type ActiveConnectedAccountTeamDirectMaterialOrigin =
  ConnectedAccountTeamDirectMaterialOrigin & Readonly<{
    consumer: TeamDirectMaterialConsumer;
  }>;

export type ConnectedAccountPurposeBindingOwnerDependencies = Readonly<{
  /** Authenticated Account whose credential materializer this owner uses. */
  credentialOwnerAccountId?: string;
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
    observationOnly?: true,
  ): Promise<ConnectedAccountPurposeResolvedTarget | null>;
  /** Producer-owned materializer boundary for the exact resolved current account. */
  materializeAccount(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    assertConfiguredOrigin?: ConnectedAccountConfiguredOriginAssertion;
    expectedConfigurationRevision?: string | null;
    credentialRevisionBasis?: ConnectedAccountMaterializationCredentialRevisionBasis;
    observeMaterializationPublicValues?: (values: readonly string[]) => void;
    observeMaterializationSecretValues?: (values: readonly string[]) => void;
    request: ConnectedAccountMaterializationRequest;
    existingFiles?: Readonly<Record<string, Uint8Array>>;
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
    consumer: TeamDirectMaterialConsumer;
    account: QualifiedConnectedAccountRef;
    credentialRevisionBasis?: ConnectedAccountMaterializationCredentialRevisionBasis;
    observeMaterializationSecretValues?: (values: readonly string[]) => void;
    request: ConnectedAccountMaterializationRequest;
    existingFiles?: Readonly<Record<string, Uint8Array>>;
    signal: AbortSignal;
    captureAdmittedResource?(resource: Readonly<{ teamId: string; displayName: string | null; resourceRevision: number }>): void;
  }>): Promise<PluginConnectedAccountMaterialization>;
  /**
   * Credential-free projection from one exact binding target. The runtime owns
   * account/group transport and metadata; this binding owner remains the sole
   * authority that decides which target may be projected.
   */
  projectTargetAccounts(input: Readonly<{
    target: QualifiedConnectedAccountPurposeBindingTargetV1;
    observation?: ConnectedAccountPurposeResolvedTarget['observation'];
    limit?: number;
    signal: AbortSignal;
  }>): Promise<PluginConnectedAccountMetadataList>;
  /**
   * Admits the exact binding target and supplies its configured-origin check
   * for the materializer's credential/configuration snapshot.
   */
  assertTargetAccountMaterializable(input: Readonly<{
    target: QualifiedConnectedAccountPurposeBindingTargetV1;
    observation?: ConnectedAccountPurposeResolvedTarget['observation'];
    account: QualifiedConnectedAccountRef;
    request: ConnectedAccountMaterializationRequest;
    signal: AbortSignal;
  }>): Promise<void | ConnectedAccountConfiguredOriginAssertion>;
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
  subscribeInvalidations?: (listener: () => void, serviceRefs: readonly PluginContributionRef[]) => Disposable;
}>;

export type ConnectedAccountPurposeAuthorizationScope = Readonly<{
  purpose: QualifiedConnectedAccountPurposeV1;
  serviceRefs: readonly PluginContributionRef[];
}>;

type ManagedCredentialConfigurations = NonNullable<ConnectedAccountInvocationPurposeBinding['managedOperation']>['credentialConfigurations'];

export type ConnectedAccountPurposeBindingSubject =
  | Readonly<Omit<Extract<TeamCredentialDirectMaterialConsumerV1, { kind: 'action_operation' }>, 'purpose'> & {
      consumer: PluginContributionIdentityV1;
      /** Host-admitted machine CLI consumers of this finite process operation. */
      consumers?: readonly PluginContributionIdentityV1[];
      isCurrent(): boolean;
    }>
  | Readonly<Extract<TeamCredentialDirectMaterialConsumerV1, { kind: 'platform_operation' }> & {
      /** One finite host operation spends its accepted Deployment receipt. */
      consumer: PluginContributionIdentityV1;
      isCurrent(): boolean;
    }>
  | Readonly<{
      /** Host-private issuance only, after authenticated Session resource admission. */
      kind: 'mcp_request_auth';
      operationId: string;
      serverId: string;
      resource: string;
      isCurrent(): boolean;
    }>
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
      credentialConfigurations?: ManagedCredentialConfigurations;
      isCurrent(): boolean;
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
      /** Host-admitted launch consumers, including declared machine CLIs. */
      consumers?: readonly PluginContributionIdentityV1[];
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
  requestAuth: ConnectedAccountRequestAuthBindingAuthority;
  isCurrent(): boolean;
  resolvePurposeBinding(
    purpose: QualifiedConnectedAccountPurposeV1,
  ): QualifiedConnectedAccountPurposeBindingV1 | null;
  listPurposeBindings(): readonly QualifiedConnectedAccountPurposeBindingV1[];
  dispose(): void;
}>;

/** A host-private finite projection of one explicitly selected account. */
export type ConnectedAccountPurposeOperationSelection = Readonly<{
  owner: Pick<StablePluginConnectedAccountsOwner, 'getBinding' | 'listAccounts' | 'materialize'>;
  dispose(): void;
}>;

export type PrepareConnectedAccountOperationSelection = (input: Readonly<{
  purpose: QualifiedConnectedAccountPurposeV1;
  serviceRefs: readonly PluginContributionRef[];
  account: QualifiedConnectedAccountRef;
  operationId: string;
  signal: AbortSignal;
}>) => Promise<ConnectedAccountPurposeOperationSelection>;

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
  validateCurrent?: ConnectedAccountRequestAuthSubject['validateCurrent'];
  registerRedaction: ConnectedAccountRequestAuthSubject['registerRedaction'];
  /**
   * The Session whose Agent receives this subject's credentials. Each served value is registered
   * in that Session's transcript scope on its runner before it is served (register-then-serve);
   * an unreachable runner refuses the serve.
   */
  transcriptSessionId?: string;
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
    bindingAuthority: input.lease.requestAuth,
    ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
    ...(input.validateCurrent ? { validateCurrent: input.validateCurrent } : {}),
    ...(input.legacyServiceKeyedCompatibility === true
      ? { legacyServiceKeyedCompatibility: true as const }
      : {}),
    isCurrent,
    async registerRedaction(values) {
      if (!isCurrent()) {
        throw new ConnectedAccountRequestAuthError('request_auth_not_active');
      }
      await input.registerRedaction(values);
      if (input.transcriptSessionId) {
        const { registerLocalSessionTranscriptSecrets, SessionTranscriptRuntimeUnavailableError } =
          await import('@/session/transport/rpc/localSessionRpcChannel');
        try {
          await registerLocalSessionTranscriptSecrets({ sessionId: input.transcriptSessionId, values });
        } catch (error) {
          // The owner's typed refusal: nothing is served, and the daemon log keeps the cause.
          if (error instanceof SessionTranscriptRuntimeUnavailableError) {
            throw new ConnectedAccountRequestAuthError('request_auth_credential_unavailable',
              { causeCode: 'session_transcript_runtime_unavailable' });
          }
          throw error;
        }
      }
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
    /** One nonsecret observation of the exact selected binding; never acquires credentials. */
    readBindingObservation(input: Parameters<StablePluginConnectedAccountsOwner['getBinding']>[0]): Promise<PluginConnectedAccountBindingSummary | null>;
    readCredentialConfigurationRevision(account: QualifiedConnectedAccountRef, signal: AbortSignal): Promise<string | null>;
    /** Reads an admitted Session selection without consulting defaults or acquiring credentials. */
    readSessionPurposeBindingSnapshot(sessionId: string): Readonly<{
      subjectId: string;
      purposes: readonly QualifiedConnectedAccountPurposeV1[];
      bindings: readonly QualifiedConnectedAccountPurposeBindingV1[];
    }> | null;
    /**
     * Canonical immutable launch snapshot for either a primary Agent session or one exact
     * execution-run owner. The run subject remains current only while its captured runner,
     * Agent generation, and bridge ownership remain exact.
     */
    activatePurposeBindings(input: Readonly<{
      subject: ConnectedAccountPurposeBindingSubject;
      purposes: readonly QualifiedConnectedAccountPurposeV1[];
      bindings: readonly QualifiedConnectedAccountPurposeBindingV1[];
      bindingSelections?: readonly ConnectedAccountPurposeBindingIntentSelection[];
      directMaterialOrigins?: readonly ConnectedAccountTeamDirectMaterialOrigin[];
      /** Host-only observation port bound to this exact operation lifetime. */
      recordOperationCredentialUse?: (use: ActionOperationCredentialUseV1) => void;
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
    }>): Promise<ConnectedAccountPurposeBindingIntentSelection>;
    /**
     * Pins one explicit Account to one host operation without modifying the
     * durable purpose default. Callers receive only the existing account port,
     * scoped to this finite binding subject.
     */
    prepareOperationSelection: PrepareConnectedAccountOperationSelection;
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
    }>): Promise<HeadersMaterial>;
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
 * A retained Team choice is standing intent even when its binding is unavailable.
 * Refuse at the purpose owner without erasing it or substituting personal/native access.
 */
function teamResourceUnavailable(reason: 'session_required' | 'scope_unauthorized' = 'session_required'): PluginError {
  return new PluginError({
    code: 'plugin_connected_account_team_resource_unavailable',
    message: reason === 'scope_unauthorized'
      ? 'The selected Team credential is outside the declared service scope'
      : 'The selected Team credential requires an admitted Session or Action binding',
    details: { reason },
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
  teamId?: string;
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
    origin: Object.freeze({ ...(input.teamId ? { teamId: input.teamId } : {}), purpose, resourceId: selection.resourceId, disclosedMember }),
  });
}

function bindingOutOfScope(): PluginError {
  return new PluginError({
    code: 'plugin_connected_account_binding_out_of_scope',
    message: 'Connected Accounts selection is outside the authorized service scope',
  });
}

type BindingUnavailableReason = 'subject_absent' | 'subject_retired' | 'purpose_unauthorized'
  | 'scope_unauthorized' | 'target_unavailable' | 'unselected';

function unavailableBinding(input: Readonly<{ requireSelected?: true }>, reasonCode: BindingUnavailableReason): null {
  if (input.requireSelected) throw new PluginError({
    code: 'plugin_connected_account_binding_unavailable',
    message: 'Connected Account binding is unavailable',
    details: { reasonCode },
  });
  return null;
}

/**
 * Automatic pruning can defer an unavailable boundary or an uncertain effect.
 * Explicit user mutations still surface both outcomes through the store.
 */
function isPurposeReconciliationDeferred(error: unknown): error is PluginError {
  return error instanceof PluginError
    && (error.code === 'plugin_connected_account_settings_unavailable'
      || error.code === 'plugin_connected_account_settings_outcome_unknown');
}

function replacePurposeBinding(
  collectionLike: QualifiedConnectedAccountPurposeBindingsV1,
  purpose: QualifiedConnectedAccountPurposeV1,
  target: QualifiedConnectedAccountPurposeBindingTargetV1 | null,
): QualifiedConnectedAccountPurposeBindingsV1 {
  const collection = createStoredReadSchema(ConnectedPurposeCatalogV1Schema).parse(collectionLike);
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
  return createStoredReadSchema(ConnectedPurposeCatalogV1Schema).parse(collectionLike)
    .teamResourceSelections
    ?.find((entry) => qualifiedPurposeKey(entry.purpose) === key) ?? null;
}

function readPurposeBinding(
  collectionLike: QualifiedConnectedAccountPurposeBindingsV1,
  purpose: QualifiedConnectedAccountPurposeV1,
): QualifiedConnectedAccountPurposeBindingTargetV1 | null {
  return readConnectedAccountPurposeBindingTarget(
    createStoredReadSchema(ConnectedPurposeCatalogV1Schema).parse(collectionLike), purpose,
  );
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
    purposes: readonly QualifiedConnectedAccountPurposeV1[];
    coveredPurposeKeys: ReadonlySet<string>;
    bindingByPurposeKey: ReadonlyMap<string, QualifiedConnectedAccountPurposeBindingV1>;
    bindingSelectionByPurposeKey: ReadonlyMap<string, ConnectedAccountPurposeBindingIntentSelection>;
    bindings: readonly QualifiedConnectedAccountPurposeBindingV1[];
    credentialConfigurations?: ManagedCredentialConfigurations;
    hostMcpRequestAuth?: Readonly<{ serverId: string; resource: string }>;
    directMaterialOriginByPurposeKey: ReadonlyMap<string, ActiveConnectedAccountTeamDirectMaterialOrigin>;
    recordOperationCredentialUse?: (use: ActionOperationCredentialUseV1) => void;
  }>;
  const purposeBindingsBySubjectKey = new Map<string, PurposeBindingState>();
  const purposeBindingsBySubjectId = new Map<string, PurposeBindingState>();
  const readAdmittedConfigurationBasis = (subjectId: string | undefined, account: QualifiedConnectedAccountRef): Readonly<{
    expectedConfigurationRevision?: string | null;
  }> => {
    const captured = subjectId ? purposeBindingsBySubjectId.get(subjectId)?.credentialConfigurations
      ?.find(entry => sameQualifiedConnectedAccountRef(entry.account, account)) : undefined;
    return captured ? { expectedConfigurationRevision: captured.revision } : {};
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
    unavailableReason?: BindingUnavailableReason;
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
        ...(!state ? { unavailableReason: 'subject_absent' as const }
          : !current ? { unavailableReason: 'subject_retired' as const }
          : !state.coveredPurposeKeys.has(purposeKey) ? { unavailableReason: 'purpose_unauthorized' as const } : {}),
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
    const release = await runConnectedAccountBindingStage('consumer_lock', () => acquireSerializedConsumerMutations(consumerKeysLike));
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
      if (subject.kind === 'mcp_request_auth') {
        const operationId = subject.operationId.trim();
        if (!operationId || !subject.serverId.trim()) throw bindingOutOfScope();
        canonicalMcpOAuthResourceUrlV1(subject.resource);
        return { subjectKey: JSON.stringify(['mcp_request_auth', operationId]), subjectId: `mcp-request-auth:${operationId}`,
          isSubjectCurrent: subject.isCurrent, sessionId: null, errorPrefix: 'connected_account_mcp_request_auth_binding',
          expectedConsumer: MCP_REQUEST_AUTH_PURPOSE.consumer, directMaterialConsumer: null };
      }
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
      if (subject.kind === 'operation' || subject.kind === 'platform_operation' || subject.kind === 'action_operation') {
        const operationId = subject.operationId.trim();
        const consumer = PluginContributionIdentityV1Schema.parse(subject.consumer);
        if (!operationId) {
          throw new Error(
            'connected_account_operation_binding_operation_id_required',
          );
        }
        const launchSessionId = subject.kind === 'operation' ? subject.sessionId?.trim() ?? '' : '';
        return {
          subjectKey: JSON.stringify([subject.kind, operationId]),
          subjectId:
            `${subject.kind}:${operationId}/consumer:${consumer.pluginId}/${consumer.localId}`,
          isSubjectCurrent: subject.isCurrent,
          sessionId: null,
          errorPrefix: 'connected_account_operation_binding',
          expectedConsumer: Object.freeze({ ...consumer }),
          directMaterialConsumer: subject.kind === 'action_operation'
            ? { kind: 'action_operation' as const, actionId: subject.actionId, pluginVersion: subject.pluginVersion, operationId }
            : subject.kind === 'platform_operation'
            ? { kind: 'platform_operation' as const, deploymentId: subject.deploymentId,
                environmentId: subject.environmentId, operationId }
            : launchSessionId
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
    const purposes = input.purposes.map((purpose) => {
      const parsed = QualifiedConnectedAccountPurposeV1Schema.parse(purpose);
      return Object.freeze({ ...parsed, consumer: Object.freeze(parsed.consumer) });
    });
    const coveredPurposeKeys = new Set<string>();
    const launchConsumers = (subject.kind === 'operation' || subject.kind === 'action_operation') && subject.consumers
      ? subject.consumers.map(consumer => PluginContributionIdentityV1Schema.parse(consumer)) : null;
    for (const purpose of purposes) {
      if (
        normalized.expectedConsumer
        && !(launchConsumers ?? [normalized.expectedConsumer]).some(consumer => (
          purpose.consumer.pluginId === consumer.pluginId
          && purpose.consumer.localId === consumer.localId
        ))
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
      const hostTarget = contributionKey(targetService(binding.target)) === contributionKey(HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1);
      if (hostTarget && (subject.kind !== 'mcp_request_auth' || binding.target.kind !== 'account'
        || binding.target.account.accountId !== subject.serverId || qualifiedPurposeKey(binding.purpose) !== qualifiedPurposeKey(MCP_REQUEST_AUTH_PURPOSE))) throw bindingOutOfScope();
      if (subject.kind === 'mcp_request_auth' && !hostTarget) throw bindingOutOfScope();
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
        consumer: normalized.directMaterialConsumer.kind === 'action_operation'
          ? { ...normalized.directMaterialConsumer, purpose } : normalized.directMaterialConsumer,
      }));
    }
    const bindingSelectionByPurposeKey = new Map<string, ConnectedAccountPurposeBindingIntentSelection>();
    for (const selection of input.bindingSelections ?? []) {
      const key = qualifiedPurposeKey(selection.binding.purpose);
      const binding = bindingByPurposeKey.get(key);
      if (!binding || targetKey(binding.target) !== targetKey(selection.binding.target) || bindingSelectionByPurposeKey.has(key)) {
        throw bindingOutOfScope();
      }
      bindingSelectionByPurposeKey.set(key, selection);
    }
    const state: PurposeBindingState = Object.freeze({
      subjectId: normalized.subjectId,
      isSubjectCurrent: normalized.isSubjectCurrent,
      purposes: Object.freeze(purposes),
      coveredPurposeKeys,
      bindingByPurposeKey,
      bindingSelectionByPurposeKey,
      bindings: Object.freeze(parsedBindings),
      ...(subject.kind === 'managed_provider_operation' && subject.credentialConfigurations !== undefined
        ? { credentialConfigurations: subject.credentialConfigurations } : {}),
      ...(subject.kind === 'mcp_request_auth' ? { hostMcpRequestAuth: Object.freeze({ serverId: subject.serverId,
        resource: canonicalMcpOAuthResourceUrlV1(subject.resource) }) } : {}),
      directMaterialOriginByPurposeKey,
      ...(input.recordOperationCredentialUse ? { recordOperationCredentialUse: input.recordOperationCredentialUse } : {}),
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
      requestAuth: Object.freeze({
        resolveCurrentBinding: async (request: Parameters<ConnectedAccountRequestAuthBindingAuthority['resolveCurrentBinding']>[0]) => {
          if (!isCurrent()) return null;
          return await resolveCurrentRequestAuthBinding({ ...request, subjectId: state.subjectId });
        },
        materializeHeaders: async (request: Parameters<ConnectedAccountRequestAuthBindingAuthority['materializeHeaders']>[0]) => {
          if (!isCurrent()) throw new ConnectedAccountRequestAuthError('request_auth_not_active');
          return await materializeRequestAuthBearer({ ...request, subjectId: state.subjectId });
        },
      }),
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

  // Reads consume the published admission/catalog; maintenance and selection writers
  // own the mutation tail. Target/credential I/O must not reserve that tail for readers.
  const readAuthorizedResolved = async (input: Readonly<{
    purpose: QualifiedConnectedAccountPurposeV1;
    serviceRefs: readonly PluginContributionRef[];
    exactPurposeBindingSubjectId?: string;
    requireSelected?: true;
    sessionId?: string;
    signal: AbortSignal;
    observationOnly?: true;
  }>, publishedCatalog?: QualifiedConnectedAccountPurposeBindingsV1): Promise<Readonly<{
    target: QualifiedConnectedAccountPurposeBindingTargetV1;
    resolved: ConnectedAccountPurposeResolvedTarget;
    directMaterialOrigin: ActiveConnectedAccountTeamDirectMaterialOrigin | null;
  }> | null> => {
    input.signal.throwIfAborted();
    const purpose = QualifiedConnectedAccountPurposeV1Schema.parse(input.purpose);
    const sessionBinding = await runConnectedAccountBindingStage('retained_binding', () => readSessionPurposeBinding({
      ...(input.exactPurposeBindingSubjectId
        ? {
            exactPurposeBindingSubjectId:
              input.exactPurposeBindingSubjectId,
          }
        : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      purpose,
    }));
    if (sessionBinding.covered) {
      const target = sessionBinding.binding?.target ?? null;
      if (!target) return unavailableBinding(input, sessionBinding.unavailableReason ?? 'unselected');
      try {
        assertTargetAuthorized(target, input.serviceRefs, Boolean(input.exactPurposeBindingSubjectId
          && purposeBindingsBySubjectId.get(input.exactPurposeBindingSubjectId)?.hostMcpRequestAuth));
      } catch {
        return unavailableBinding(input, 'scope_unauthorized');
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
      const resolved = await runConnectedAccountBindingStage('target_resolution', () => dependencies.resolveTarget(target, input.signal, input.observationOnly));
      input.signal.throwIfAborted();
      if (!resolved) return unavailableBinding(input, 'target_unavailable');
      assertResolvedTargetMatchesIntent(target, resolved);
      const retainedSelection = input.exactPurposeBindingSubjectId
        ? purposeBindingsBySubjectId.get(input.exactPurposeBindingSubjectId)?.bindingSelectionByPurposeKey.get(qualifiedPurposeKey(purpose)) : null;
      if (retainedSelection && !sameResolvedTarget({ target, resolved }, {
        target: retainedSelection.binding.target, resolved: retainedSelection.resolved,
      })) return unavailableBinding(input, 'target_unavailable');
      return { target, resolved, directMaterialOrigin: null };
    }
    const durable = publishedCatalog
      ?? await runConnectedAccountBindingStage('account_purpose_read', () => dependencies.store.read(input.signal, { published: true }));
    input.signal.throwIfAborted();
    const target = readPurposeBinding(durable, purpose);
    if (!target) {
      // A durable Team resource default is the user's standing intent and the
      // Home is its currentness authority: outside a Session it is refused
      // with a type, never resolved against the personal inventory or erased.
      if (readPurposeTeamResourceSelection(durable, purpose)) throw teamResourceUnavailable();
      return unavailableBinding(input, 'unselected');
    }
    try {
      assertTargetAuthorized(target, input.serviceRefs);
    } catch {
      // Scope controls disclosure, not user intent. Erasing an explicit selection here
      // would let a later request silently substitute a native credential.
      return unavailableBinding(input, 'scope_unauthorized');
    }
    const resolved = await runConnectedAccountBindingStage('target_resolution', () => dependencies.resolveTarget(target, input.signal, input.observationOnly));
    input.signal.throwIfAborted();
    if (!resolved) {
      // An observation reports the recorded selection as absent; it does not
      // retry the same Pool lookup or seek a usable replacement member.
      if (input.observationOnly) return unavailableBinding(input, 'target_unavailable');
      const revalidatedTarget = readPurposeBinding(
        publishedCatalog ?? await runConnectedAccountBindingStage('account_purpose_read', () => dependencies.store.read(input.signal, { published: true })),
        purpose,
      );
      input.signal.throwIfAborted();
      if (!revalidatedTarget || targetKey(revalidatedTarget) !== targetKey(target)) {
        return unavailableBinding(input, 'target_unavailable');
      }
      const revalidatedResolved = await runConnectedAccountBindingStage('target_resolution', () => dependencies.resolveTarget(
        revalidatedTarget,
        input.signal,
        input.observationOnly,
      ));
      input.signal.throwIfAborted();
      if (revalidatedResolved) {
        assertResolvedTargetMatchesIntent(revalidatedTarget, revalidatedResolved);
        return { target: revalidatedTarget, resolved: revalidatedResolved, directMaterialOrigin: null };
      }
      // Unavailable credential truth does not clear the user's standing selection.
      return unavailableBinding(input, 'target_unavailable');
    }
    assertResolvedTargetMatchesIntent(target, resolved);
    return { target, resolved, directMaterialOrigin: null };
  };
  const readObservation = async (input: Parameters<StablePluginConnectedAccountsOwner['getBinding']>[0]) => {
    const resolved = await readAuthorizedResolved({ ...input, observationOnly: true });
    const profile = resolved?.resolved.observation?.profiles.find(profile => (
      sameQualifiedConnectedAccountRef(profile.ref, resolved.resolved.account)
    ));
    const credentialRevision = resolved && !resolved.directMaterialOrigin
      ? profile ? profile.credentialRevision
        : await dependencies.resolveCredentialRevision?.(resolved.resolved.account, input.signal)
      : undefined;
    const configurationRevision = resolved && !resolved.directMaterialOrigin
      ? profile ? profile.configurationRevision
        : await dependencies.resolveCredentialConfigurationRevision?.(resolved.resolved.account, input.signal)
      : undefined;
    return { resolved, credentialRevision, configurationRevision,
      selectedRevisioned: profile?.revisionSemantics === 'revisioned'
        || resolved?.resolved.observation === undefined && typeof credentialRevision === 'string' };
  };
  const readBindingObservation: ConnectedAccountPurposeBindingOwner['readBindingObservation'] = input => (
    withConnectedAccountBindingDiagnostic({
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      pluginId: input.purpose.consumer.pluginId, localId: input.purpose.consumer.localId, purpose: input.purpose.purpose,
    }, async () => {
      const observation = await runConnectedAccountBindingStage('binding_read', () => readObservation(input));
      if (!observation.resolved) return null;
      return Object.freeze({
        ...summary(input.purpose, observation.resolved.target, observation.resolved.resolved),
        ...(observation.credentialRevision === undefined ? {} : { credentialRevision: observation.credentialRevision }),
        ...(observation.configurationRevision === undefined ? {} : { configurationRevision: observation.configurationRevision }),
        ...(observation.resolved.resolved.group ? { group: observation.resolved.resolved.group } : {}),
      });
    })
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
        Object.freeze(ConnectedAccountServiceIdentityV1Schema.parse(service))
      )));
      scopeByPurposeKey.set(key, Object.freeze({ purpose, serviceRefs }));
    }
    const scopes = [...scopeByPurposeKey.values()];
    const bindings: QualifiedConnectedAccountPurposeBindingV1[] = [];
    const directMaterialOrigins: ConnectedAccountTeamDirectMaterialOrigin[] = [];
    const teamResourceSelections: ConnectedAccountSessionTeamResourceSelection[] = [];
    // Resolve every purpose from this publication, even if another writer finishes during target I/O.
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
                teamId: teamSelection.teamId,
                purpose: scope.purpose,
                service,
                selection,
              })
            : null;
          if (!projected) throw teamResourceUnavailable('scope_unauthorized');
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
      const resolved = await readAuthorizedResolved({
        purpose: scope.purpose,
        serviceRefs: scope.serviceRefs,
        signal: input.signal,
      }, current);
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
  };

  const projectCredentialUse = (input: Readonly<{
    purpose: QualifiedConnectedAccountPurposeV1;
    target: 'account' | 'group' | 'listed_account';
    account: QualifiedConnectedAccountRef;
    resolved: ConnectedAccountPurposeResolvedTarget;
    isTeamResource?: boolean;
    teamResource?: Readonly<{ teamId: string; displayName: string | null; resourceRevision: number }> | null;
  }>): ActionOperationCredentialUseV1 => {
    const profile = input.resolved.observation?.profiles.find(candidate => sameQualifiedConnectedAccountRef(candidate.ref, input.account));
    const label = input.isTeamResource
      ? input.teamResource?.displayName ?? null
      : profile ? readConnectedAccountPurposeProfileLabel(profile)
        : !input.resolved.observation && input.target === 'account' ? input.resolved.displayName : null;
    return {
      v: 1,
      kind: input.isTeamResource ? 'team_resource' : 'connected_account',
      label: label?.trim() ? label : null,
      owner: input.isTeamResource
        ? input.teamResource ? { kind: 'team', teamId: input.teamResource.teamId } : null
        : dependencies.credentialOwnerAccountId ? { kind: 'account', accountId: dependencies.credentialOwnerAccountId } : null,
      service: { ...input.account.service },
      why: { kind: 'purpose_binding', purpose: { consumer: { ...input.purpose.consumer }, purpose: input.purpose.purpose }, target: input.target },
      currentness: { kind: 'current_at_materialization',
        ...(input.teamResource ? { resourceRevision: input.teamResource.resourceRevision } : {}) },
    };
  };

  const materialize = async (
    input: Parameters<StablePluginConnectedAccountsOwner['materialize']>[0],
    recordCredentialUse = input.recordOperationCredentialUse ?? (input.exactPurposeBindingSubjectId
      ? purposeBindingsBySubjectId.get(input.exactPurposeBindingSubjectId)?.recordOperationCredentialUse
      : undefined),
  ): Promise<PluginConnectedAccountMaterialization> => {
    if (input.serviceRefs.some(service => contributionKey(service) === contributionKey(HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1))) {
      const basis = input.exactPurposeBindingSubjectId ? purposeBindingsBySubjectId.get(input.exactPurposeBindingSubjectId)?.hostMcpRequestAuth : null;
      if (!basis || input.request.kind !== 'httpHeaders' || input.request.origin !== new URL(basis.resource).origin) throw bindingOutOfScope();
    }
    if (input.nativeService && (input.expectedAccount || input.credentialRevisionBasis)) throw bindingOutOfScope();
    const nativeService = input.nativeService
      ? ConnectedAccountServiceIdentityV1Schema.safeParse(input.nativeService)
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
    const hasExplicitSelection = async (): Promise<boolean> => {
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
      const durable = await dependencies.store.read(input.signal, { published: true });
      input.signal.throwIfAborted();
      return readPurposeBinding(durable, input.purpose) !== null
        || readPurposeTeamResourceSelection(durable, input.purpose) !== null;
    };
    // Retained admissions consume the published binding while only mutations queue.
    const before = await observeMaterializationPhase('materialization_binding_before', async () => ({
      explicit: input.nativeService ? await hasExplicitSelection() : false,
      resolved: await readAuthorizedResolved(authorizationInput),
    }));
    const resolved = before.resolved;
    if (!resolved) {
      if (before.explicit || !input.nativeService || !dependencies.materializeNative) throw resourceNotSelected(input.purpose);
      if (!nativeService?.success) throw bindingOutOfScope();
      const service = Object.freeze(nativeService.data);
      const materialization = await dependencies.materializeNative({ service, request: input.request, signal: input.signal });
      input.signal.throwIfAborted();
      return materialization;
    }
    if (
      input.expectedAccount
      && !sameQualifiedConnectedAccountRef(input.expectedAccount, resolved.resolved.account)
    ) {
      throw resourceNotSelected(input.purpose);
    }
    let materializedCredentialRevision: ConnectedServiceCredentialRevisionV1 | null = null;
    let admittedTeamResource: Readonly<{ teamId: string; displayName: string | null; resourceRevision: number }> | null = null;
    const credentialRevisionBasis = input.credentialRevisionBasis
      ? Object.freeze({
          expectedCredentialRevision:
            input.credentialRevisionBasis.expectedCredentialRevision,
          captureCredentialRevision(credentialRevision: ConnectedServiceCredentialRevisionV1) {
            materializedCredentialRevision = credentialRevision;
          },
        })
      : null;
    const materialization = await observeMaterializationPhase('materialization_invoke', async () => resolved.directMaterialOrigin
      ? await (() => {
          if (!dependencies.materializeTeamDirect) throw bindingOutOfScope();
          return dependencies.materializeTeamDirect({
            origin: resolved.directMaterialOrigin,
            consumer: resolved.directMaterialOrigin.consumer,
            account: resolved.resolved.account,
            ...(credentialRevisionBasis ? { credentialRevisionBasis } : {}),
            ...(input.observeMaterializationSecretValues
              ? { observeMaterializationSecretValues: input.observeMaterializationSecretValues } : {}),
            request: input.request,
            ...(input.existingFiles ? { existingFiles: input.existingFiles } : {}),
            signal: input.signal,
            captureAdmittedResource(resource) { admittedTeamResource = resource; },
          });
        })()
      : await dependencies.materializeAccount({
          account: resolved.resolved.account,
          ...readAdmittedConfigurationBasis(input.exactPurposeBindingSubjectId, resolved.resolved.account),
          ...(input.observeMaterializationPublicValues ? { observeMaterializationPublicValues: input.observeMaterializationPublicValues } : {}),
          ...(input.observeMaterializationSecretValues ? { observeMaterializationSecretValues: input.observeMaterializationSecretValues } : {}),
          ...(credentialRevisionBasis ? { credentialRevisionBasis } : {}),
          request: input.request,
          ...(input.existingFiles ? { existingFiles: input.existingFiles } : {}),
          signal: input.signal,
        }));
    input.signal.throwIfAborted();
    if (input.credentialRevisionBasis) {
      if (materializedCredentialRevision === null) throw bindingOutOfScope();
      input.credentialRevisionBasis.captureCredentialRevision(
        materializedCredentialRevision,
      );
    }
    if (recordCredentialUse) {
      recordCredentialUse(projectCredentialUse({
        purpose: input.purpose, target: resolved.target.kind, account: resolved.resolved.account,
        resolved: resolved.resolved, teamResource: admittedTeamResource,
        isTeamResource: resolved.directMaterialOrigin !== null,
      }));
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
      observation: before.resolved.observation,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      signal: input.signal,
    });
    input.signal.throwIfAborted();
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
    const markScopeRefusal = (error: unknown, phase: 'listed_purpose_resolution' | 'listed_target_account' |
      'listed_credential_materialization'): never => {
      if (isPluginError(error) && error.code === 'plugin_connected_account_binding_out_of_scope') {
        try { withActionFailureDiagnostic(error, { phase, causeKind: 'access_denied' }); }
        catch { /* The original scope refusal wins even if the error is frozen. */ }
      }
      throw error;
    };
    const before = await readAuthorizedResolved(authorizationInput)
      .catch(error => markScopeRefusal(error, 'listed_purpose_resolution'));
    if (!before) return markScopeRefusal(bindingOutOfScope(), 'listed_purpose_resolution');
    const assertConfiguredOrigin = await dependencies.assertTargetAccountMaterializable({
      target: before.target,
      observation: before.resolved.observation,
      account: input.account,
      request: input.request,
      signal: input.signal,
    }).catch(error => markScopeRefusal(error, 'listed_target_account'));
    const materialization = await dependencies.materializeAccount({
      account: input.account,
      ...(assertConfiguredOrigin ? { assertConfiguredOrigin } : {}),
      ...readAdmittedConfigurationBasis(input.exactPurposeBindingSubjectId, input.account),
      ...(input.observeMaterializationPublicValues ? { observeMaterializationPublicValues: input.observeMaterializationPublicValues } : {}),
      request: input.request,
      signal: input.signal,
    }).catch(error => markScopeRefusal(error, 'listed_credential_materialization'));
    input.signal.throwIfAborted();
    const recordCredentialUse = input.recordOperationCredentialUse ?? (input.exactPurposeBindingSubjectId
      ? purposeBindingsBySubjectId.get(input.exactPurposeBindingSubjectId)?.recordOperationCredentialUse
      : undefined);
    recordCredentialUse?.(projectCredentialUse({ purpose: input.purpose, target: 'listed_account', account: input.account, resolved: before.resolved }));
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
      const current = await readAuthorizedResolved({
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
  };

  const materializeRequestAuthBearer = async (input: Readonly<{
    subjectId: string;
    binding: QualifiedConnectedAccountPurposeBindingV1;
    resolved: ConnectedAccountRequestAuthResolvedBinding;
    materialization: QualifiedConnectedAccountRequestAuthUseV1['materialization'];
    signal: AbortSignal;
  }>): Promise<HeadersMaterial> => {
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
    let credentialUse: ActionOperationCredentialUseV1 | null = null;
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
    }, use => { credentialUse = use; });
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
    const bearer = parseHttpHeadersRequestAuthMaterial(
      input.materialization,
      materialization,
    );
    if (credentialUse) purposeBindingsBySubjectId.get(subjectId)?.recordOperationCredentialUse?.(credentialUse);
    return bearer;
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
        const current = await dependencies.resolveTarget(target, signal);
        return !signal.aborted && current !== null
          && sameQualifiedConnectedAccountRef(current.account, resolved.account)
          && current.group?.groupId === resolved.group?.groupId
          && current.group?.generation === resolved.group?.generation;
      },
    });
  };

  const getBinding: StablePluginConnectedAccountsOwner['getBinding'] = input => {
    if (input.observation) return readBindingObservation(input);
    return withConnectedAccountBindingDiagnostic({
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      pluginId: input.purpose.consumer.pluginId, localId: input.purpose.consumer.localId, purpose: input.purpose.purpose,
    }, async () => {
      const resolved = await runConnectedAccountBindingStage('binding_read', () => readAuthorizedResolved(input));
      return resolved ? summary(input.purpose, resolved.target, resolved.resolved) : null;
    });
  };

  const prepareOperationSelection: PrepareConnectedAccountOperationSelection = async input => {
    input.signal.throwIfAborted();
    const purpose = QualifiedConnectedAccountPurposeV1Schema.parse(input.purpose);
    const target = QualifiedConnectedAccountPurposeBindingTargetV1Schema.parse({
      kind: 'account', account: input.account,
    });
    const selection = await resolveBindingIntentSelection({ purpose, target,
      serviceRefs: input.serviceRefs, signal: input.signal });
    const lease = activatePurposeBindings({
      subject: { kind: 'operation', operationId: input.operationId, consumer: purpose.consumer,
        isCurrent: () => !input.signal.aborted },
      purposes: [purpose], bindings: [selection.binding], bindingSelections: [selection],
    });
    const rejectNestedExactSubject = (exactPurposeBindingSubjectId: string | undefined) => {
      if (exactPurposeBindingSubjectId !== undefined) throw bindingOutOfScope();
    };
    return Object.freeze({
      owner: Object.freeze({
        // The operation subject is authoritative; an incidental hosted-Session
        // scope cannot override the Account explicitly admitted for this clone.
        getBinding: async ({ exactPurposeBindingSubjectId, sessionId: _sessionId, ...request }) => {
          rejectNestedExactSubject(exactPurposeBindingSubjectId);
          return await getBinding({ ...request, exactPurposeBindingSubjectId: lease.subjectId });
        },
        listAccounts: async ({ exactPurposeBindingSubjectId, sessionId: _sessionId, ...request }) => {
          rejectNestedExactSubject(exactPurposeBindingSubjectId);
          return await listAccounts({ ...request, exactPurposeBindingSubjectId: lease.subjectId });
        },
        materialize: async ({ exactPurposeBindingSubjectId, sessionId: _sessionId, ...request }) => {
          rejectNestedExactSubject(exactPurposeBindingSubjectId);
          return await materialize({ ...request, exactPurposeBindingSubjectId: lease.subjectId });
        },
      }),
      dispose: () => lease.dispose(),
    });
  };

  return Object.freeze({
    activatePurposeBindings,
    readExecutionRunPurposeBindingSubjectId(runId) {
      return purposeBindingsBySubjectKey.get(
        JSON.stringify(['execution_run', runId.trim()]),
      )?.subjectId ?? null;
    },
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
    readSessionPurposeBindingSnapshot(sessionId) {
      const state = purposeBindingsBySubjectKey.get(sessionSubjectKey(sessionId));
      if (!state || !state.isSubjectCurrent()) return null;
      return Object.freeze({ subjectId: state.subjectId,
        purposes: state.purposes,
        bindings: state.bindings });
    },
    resolveBindingIntentSelection,
    prepareOperationSelection,
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
              const current = createStoredReadSchema(ConnectedPurposeCatalogV1Schema).parse(currentLike);
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
      } catch (error) {
        if (!isPurposeReconciliationDeferred(error)) {
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
            recovery: error.retryable || error.code === 'plugin_connected_account_settings_outcome_unknown'
              ? 'the prune re-runs on the next registry publication'
              : 'the boundary will not recover without operator action',
          },
        );
        input.publish();
      } finally {
        release();
      }
    },
    getBinding,
    async resolveSelection(input) {
      try {
        // The existing strict read returns a binding or throws a classified
        // refusal; its public legacy signature also covers nullable reads.
        const binding = (await getBinding({ ...input, requireSelected: true }))!;
        return { credentialSource: 'connectedAccount', binding };
      } catch (error) {
        if (isPluginError(error) && error.code === 'plugin_connected_account_binding_unavailable'
          && error.details !== null && typeof error.details === 'object'
          && Reflect.get(error.details, 'reasonCode') === 'unselected') {
          return { credentialSource: 'machineLogin' };
        }
        throw error;
      }
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
    readBindingObservation,
    listAccounts,
    materializeListedAccount,
    watch(input) {
      QualifiedConnectedAccountPurposeV1Schema.parse(input.purpose);
      let disposed = false;
      const controller = new AbortController();
      const read = () => withConnectedAccountBindingDiagnostic({
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        pluginId: input.purpose.consumer.pluginId, localId: input.purpose.consumer.localId, purpose: input.purpose.purpose,
      }, async () => {
        try {
          return { ok: true as const, ...await readObservation({ ...input, signal: controller.signal }) };
        } catch {
          // A failed read cannot establish unchanged authority. Preserve fail-closed delivery.
          return { ok: false as const };
        }
      });
      let observation = read();
      const notify = (sourceInvalidated = false): Promise<void> => {
        const next = observation.then(async previous => {
          if (disposed) return previous;
          const current = await read();
          if (disposed) return current;
          const authorityUnchanged = previous.ok && current.ok && (
            // Null binding reads carry no native credential revision. Only
            // binding-store refreshes can prove unchanged unbound authority;
            // a source invalidation must retire an unversioned native read.
            !sourceInvalidated && !previous.resolved && !current.resolved
            || previous.resolved && current.resolved
              && !previous.resolved.directMaterialOrigin && !current.resolved.directMaterialOrigin
              && sameResolvedTarget(previous.resolved, current.resolved)
              && previous.selectedRevisioned && current.selectedRevisioned
              && typeof previous.credentialRevision === 'string'
              && previous.credentialRevision === current.credentialRevision
              && previous.configurationRevision === current.configurationRevision
          );
          const unchanged = authorityUnchanged && previous.ok && current.ok && (
            !previous.resolved && !current.resolved
            || previous.resolved && current.resolved
              && previous.resolved.resolved.displayName === current.resolved.resolved.displayName
              && isDeepStrictEqual(previous.resolved.resolved.observation, current.resolved.resolved.observation)
          );
          if (!unchanged) {
            const affected = (current.ok ? current.resolved : null)
              ?? (previous.ok ? previous.resolved : null);
            await Promise.resolve().then(() => input.listener({
              account: affected?.resolved.account ?? null,
              ...(affected?.resolved.group ? { group: affected.resolved.group } : {}),
              authorityChanged: !authorityUnchanged,
            })).catch(() => undefined);
          }
          return current;
        });
        observation = next;
        return next.then(() => undefined);
      };
      const storeSubscription = dependencies.store.subscribe(notify);
      const projectionSubscription = dependencies.subscribeInvalidations?.(() => notify(true), input.serviceRefs);
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
          controller.abort();
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
}> = {}): ConnectedAccountPurposeBindingStore {
  const readSnapshot = () => input.operationContext ? input.operationContext.readSnapshot() : getActiveAccountSettingsSnapshot();
  const unavailable = (reason: string, retryable = false) => new PluginError({ code: 'plugin_connected_account_settings_unavailable',
    message: 'Connected Account purpose catalog is unavailable', retryable, details: { reason } });
  const captureOperation = () => {
    const snapshot = readSnapshot();
    const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
    const assertCurrent = () => {
      if (!snapshot?.scopeKey || readSnapshot()?.scopeKey !== snapshot.scopeKey
        || !input.operationContext && getActiveAccountSettingsSnapshotLifetimeToken() !== lifetime) {
        throw unavailable('scope-retired');
      }
    };
    const verifyCurrent = async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      assertCurrent();
      if (input.operationContext && !await input.operationContext.isCurrent(signal)) throw unavailable('scope-retired');
      assertCurrent();
    };
    assertCurrent();
    return { assertCurrent, verifyCurrent, lifetimeToken: lifetime };
  };
  const credentialsForOperation = async (operation: ReturnType<typeof captureOperation>, signal?: AbortSignal) => {
    const credentials = input.operationContext?.credentials ?? input.credentials ?? await readStoredCredentials();
    await operation.verifyCurrent(signal);
    if (!credentials) throw unavailable('credentials-unavailable');
    return credentials;
  };
  const requirePurposeCatalog = (catalog: ConnectedAccountCatalogSnapshotV1) => {
    if (catalog.status !== 'ready') throw unavailable(catalog.status === 'unavailable' ? catalog.reason : 'loading');
    if (catalog.record.key !== 'purposes') throw unavailable('invalid-stored-content');
    return { ...catalog, record: catalog.record };
  };
  const readCatalog = async (operation: ReturnType<typeof captureOperation>, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    await operation.verifyCurrent(signal);
    // A UI/Action write can be acknowledged before its change hint arrives.
    // Reuse the catalog's fresh-read owner before authorizing a purpose.
    const catalog = await readActiveConnectedAccountCatalog({
      credentials: await credentialsForOperation(operation, signal), key: 'purposes', signal, operationContext: input.operationContext });
    await operation.verifyCurrent(signal);
    signal?.throwIfAborted();
    return requirePurposeCatalog(catalog);
  };
  return Object.freeze({
    async read(signal, options) {
      const operation = captureOperation();
      if (!options?.published) {
        const catalog = await readCatalog(operation, signal);
        operation.assertCurrent();
        return catalog.record.value;
      }
      const credentials = await credentialsForOperation(operation, signal);
      const published = input.operationContext
        ? readConnectedAccountCatalogFromSnapshot(readSnapshot(), 'purposes')
        : readPublishedConnectedAccountCatalog({ key: 'purposes', scopeKey: resolveAccountSettingsScopeKey(credentials) });
      // Only first demand needs the loader. A normal republish retains the
      // prior settled row; a published clear/refusal remains authoritative.
      const catalog = published.status === 'loading'
        ? requirePurposeCatalog(await refreshActiveConnectedAccountCatalog({ credentials, key: 'purposes', signal,
            operationContext: input.operationContext, readMode: 'admitted' }))
        : requirePurposeCatalog(published);
      if (published.status === 'loading') await operation.verifyCurrent(signal);
      operation.assertCurrent();
      return catalog.record.value;
    },
    async update(mutate, signal) {
      const operation = captureOperation();
      const current = await readCatalog(operation, signal);
      await operation.verifyCurrent(signal);
      operation.assertCurrent();
      const value = ConnectedPurposeCatalogV1Schema.parse(mutate(current.record.value));
      // Unchanged declaration reconciliation keeps the captured reference census current.
      if (isDeepStrictEqual(value, current.record.value)) return current.record.value;
      const credentials = await credentialsForOperation(operation, signal);
      operation.assertCurrent();
      const transport = createCliConnectedAccountCatalogStore({ credentials, signal, operationContext: input.operationContext });
      const result = await transport.writeRecord({ record: { key: 'purposes', value }, expectedRevision: current.revision }).catch(async (error: unknown) => {
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        if (code === 'outcome_unknown') {
          // The write may have committed. Reobserve before automatic pruning
          // publishes or a later mutation derives intent from this snapshot;
          // readback cannot turn an uncertain user mutation into an ACK.
          await refreshActiveConnectedAccountCatalog({ credentials, key: 'purposes', signal,
            operationContext: input.operationContext }, true);
          throw new PluginError({ code: 'plugin_connected_account_settings_outcome_unknown',
            message: 'Connected Account purpose mutation outcome is unknown' });
        }
        if (code === 'scope-retired') throw unavailable('scope-retired');
        if (code === 'unreachable') throw unavailable('unreachable', true);
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
      const catalog = { status: 'ready' as const, revision: result.revision, record: { key: 'purposes' as const, value } };
      const published = input.operationContext
        ? await input.operationContext.commitConnectedAccountCatalog({ key: 'purposes', catalog })
        : commitActiveConnectedAccountCatalog({ key: 'purposes', catalog,
            scopeKey: resolveAccountSettingsScopeKey(credentials), lifetimeToken: operation.lifetimeToken });
      if (!published) throw unavailable('scope-retired');
      return value;
    },
    subscribe(listener) {
      // Publish purpose-reader demand only for its Account inputs. Independent
      // Profile/Prompt/etc. catalog reads are not binding changes. The snapshot
      // owner retains unchanged preference/key identities; writers reobserve
      // through readCatalog. Connected Services has its own runtime invalidation.
      const keys = { settings: ['secrets'],
        facets: ['connectedPurposeCatalog', 'connectedConfigurationCatalog', 'savedSecretResources', 'savedSecretCatalogState'],
      } as const;
      const unsubscribe = input.operationContext
        ? input.operationContext.subscribeAccountSettings(listener, keys)
        : subscribeActiveAccountSettingsKeys(keys, () => listener());
      return Object.freeze({ dispose: unsubscribe });
    },
  });
}

export {
  readPurposeBinding,
  replacePurposeBinding,
};
