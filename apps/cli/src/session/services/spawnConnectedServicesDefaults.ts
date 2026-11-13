import {
  resolveConnectedServiceSessionSelection,
} from '@happier-dev/agents';
import { ConnectedServiceBindingsV2Schema } from '@happier-dev/protocol/connect/connected-service-bindings';
import type { ConnectedAccountCatalogSnapshotV1, ConnectedAccountCatalogUnavailableReasonV1 } from '@happier-dev/protocol/connect/connectedAccountCatalogV1';
import type { ConnectedServicesDefaultUnavailableDetailsV1 } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { resolveTeamResourceConnectedServiceSelectionV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { buildQualifiedPluginContributionKey, parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { projectAgentConnectedAccountPurposeDefaultsToSessionBindings, resolveAgentConnectedAccountPurposeDefaults } from '@happier-dev/protocol/account/settings/connected-services';
import type { ActionExecutorDeps, AgentConnectedAccountPurposeDefault, QualifiedConnectedAccountPurposeV1, ConnectedServiceBindingSelectionV1, ConnectedServiceBindingSelectionV2, ConnectedServiceBindingsV2, ProviderBrokerApplicationBindingV1, TeamCredentialResourceCatalogEntryV1, TeamResourceConnectedServiceSelectionV2 } from '@happier-dev/protocol';
import { SessionTeamCredentialBindingIntentsV1Schema, sessionTeamCredentialSlotKeyV1 } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import type { SessionTeamCredentialBindingIntentListV1, SessionTeamCredentialBindingIntentV1 } from '@happier-dev/protocol/teams';

import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createInvocationSavedSecretOperationContextV1, type SavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { readConnectedAccountCatalogUnavailableReason, refreshConnectedAccountCatalogForAdmission } from '@/settings/connectedAccounts/hydrateConnectedAccountCatalog';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { configuration } from '@/configuration';
import { resolveCatalogAgentConnectedAccountServiceIds } from '@/agent/catalog/registry';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { isAccountSettingsContentInvalidError } from '@/settings/accountSettings/accountSettingsRefreshError';
import { readTeamCredentialLaunchReadinessRefusal } from './sessionTeamCredentialReadiness';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { readSpawnConnectedServicesTeamResources } from './sessionTeamCredentialCatalog';
import { readTeamCredentialLaunchFailureCode, type TeamCredentialLaunchFailureCode,
  type TeamCredentialLaunchFailurePhase, SessionTeamCredentialLaunchUnavailableError } from './sessionTeamCredentialLaunchError';

export { readSpawnConnectedServicesTeamResources } from './sessionTeamCredentialCatalog';
export { readTeamCredentialLaunchReadinessRefusal } from './sessionTeamCredentialReadiness';

export function agentSupportsSpawnConnectedServicesDefaults(agentId: string): boolean {
  return resolveCatalogAgentConnectedAccountServiceIds(agentId).length > 0;
}

export type SpawnConnectedServicesDefaultDisposition =
  | Readonly<{ kind: 'connected'; bindings: ConnectedServiceBindingsV2 }>
  | Readonly<{ kind: 'native' }>
  | Readonly<{
      kind: 'unavailable';
      catalogReason?: ConnectedAccountCatalogUnavailableReasonV1;
      reason:
        | 'connected_services_default_settings_invalid'
        | 'connected_account_purpose_catalog_unavailable'
        | 'connected_services_team_default_requires_current_resource'
        | NonNullable<ReturnType<typeof readTeamCredentialLaunchReadinessRefusal>>;
    }>;

export type SpawnConnectedServicesTeamResourceCatalog = Readonly<{
  serverId: string;
  accountId: string;
  resources: readonly TeamCredentialResourceCatalogEntryV1[];
}>;

export type ResolveSpawnConnectedServicesTeamResourceCatalog = (params: Readonly<{
  teamIds: readonly string[];
  application?: ProviderBrokerApplicationBindingV1;
  signal?: AbortSignal;
}>) => Promise<SpawnConnectedServicesTeamResourceCatalog | null>;

export function createSpawnConnectedServicesTeamResourceCatalogResolver(params: Readonly<{
  homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']>;
  serverId: string;
  accountId: string;
}>): ResolveSpawnConnectedServicesTeamResourceCatalog {
  return async (request) => {
    const resources = await readSpawnConnectedServicesTeamResources({ ...params, ...request });
    return resources ? { serverId: params.serverId, accountId: params.accountId, resources } : null;
  };
}

/**
 * The Team catalog read for a daemon/runner component that holds only the
 * active Home's stored credentials: that Home's recipient catalog through the
 * canonical Action transport. Absent when the credentials carry no Account.
 */
export function createCredentialsSpawnConnectedServicesTeamResourceCatalogResolver(
  credentials: StoredCredentials,
): ResolveSpawnConnectedServicesTeamResourceCatalog | undefined {
  const accountId = readAccountIdFromToken(credentials.token);
  const homeDomainAction = createAccountServerActionDeps({
    token: credentials.token,
    credentials,
  }).homeDomainAction;
  return accountId && homeDomainAction
    ? createSpawnConnectedServicesTeamResourceCatalogResolver({
        homeDomainAction,
        serverId: configuration.activeServerId,
        accountId,
      })
    : undefined;
}

export class ConnectedServicesDefaultUnavailableError extends Error {
  readonly code: 'connected_services_default_unavailable' | TeamCredentialLaunchFailureCode;
  readonly details: Readonly<{ v: 1; source: 'team_credential' }> | ConnectedServicesDefaultUnavailableDetailsV1;
  readonly failureCause: NonNullable<SessionRuntimeIssueV1['failureCause']> & Readonly<{ code: string }>;

  constructor(readonly reason: Extract<SpawnConnectedServicesDefaultDisposition, { kind: 'unavailable' }>['reason'] | TeamCredentialLaunchFailureCode,
    readonly phase: TeamCredentialLaunchFailurePhase = 'purpose_binding',
    readonly catalogReason?: ConnectedAccountCatalogUnavailableReasonV1) {
    super(reason);
    this.code = reason === 'connected_services_team_default_requires_current_resource'
      ? 'resource_unavailable'
      : reason === 'connected_services_default_settings_invalid' || reason === 'connected_account_purpose_catalog_unavailable'
        ? 'connected_services_default_unavailable'
        : readTeamCredentialLaunchFailureCode(reason) ?? 'connected_services_default_unavailable';
    this.details = reason === 'connected_services_default_settings_invalid' || reason === 'connected_account_purpose_catalog_unavailable'
      ? { v: 1, source: 'account_default', reason, phase: 'purpose_binding', ...(catalogReason ? { catalogReason } : {}) }
      : { v: 1, source: 'team_credential' };
    this.failureCause = {
      code: this.code === 'connected_services_default_unavailable' ? reason : this.code,
      phase: 'authentication', failureReason: 'unknown',
      ...(this.details.source === 'account_default' ? { connectedServicesDefault: this.details } : {}),
    };
  }
}

/**
 * THE session spawn-defaulting owner (one defaulting owner, one settings path — QA2-F02).
 *
 * Resolves the account-default connected-services selection for a catalog Agent from a FRESH,
 * bounded blocking account-settings bootstrap (`bootstrapAccountSettingsContext` mode 'blocking';
 * its network reads carry internal 15s timeouts, so the wait is bounded). Callers must NEVER
 * substitute an in-process settings snapshot for this resolution: a second settings surface is
 * exactly the stale-snapshot split-brain that silently killed run defaulting live (QA2-F02).
 * Consumed by session spawn (createCliActionDeps) AND execution-run start (connectedServicesEnv).
 * Network/bootstrap failures refuse defaulting rather than silently selecting
 * native authentication. Invalid settings content does the same. A
 * persisted Team-resource default is different: it is an explicit selection,
 * so missing or stale current-resource evidence throws the typed unavailable
 * error instead of silently falling back to native authentication.
 */
export async function resolveSessionSpawnConnectedServicesDefaultsPayload(params: Readonly<{
  agentId: string;
  credentials: StoredCredentials;
  signal?: AbortSignal;
  operationContext?: SavedSecretOperationContextV1;
  resolveTeamCredentialResourceCatalog?: ResolveSpawnConnectedServicesTeamResourceCatalog;
}>): Promise<Readonly<{
  connectedServices: ConnectedServiceBindingsV2;
  connectedServicesUpdatedAt: number;
  /**
   * The Session Team slot bindings the defaulted Team targets need: the Home
   * admits a Team target only through the Session's own binding, written when
   * the Session is created (lane 10 child 01). Resolved against the same
   * catalog read as the defaults, so both carry one current revision.
   */
  teamCredentialBindings?: SessionTeamCredentialBindingIntentListV1;
}> | null> {
  const agentId = params.agentId.trim();
  if (!agentSupportsSpawnConnectedServicesDefaults(agentId)) return null;

  const resolve = async () => {
  const serverHttpBaseUrl = params.operationContext?.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
  try {
    const accountSettingsContext = await bootstrapAccountSettingsContext({
      credentials: params.credentials,
      ...(params.signal ? { signal: params.signal } : {}),
      mode: 'blocking',
      publication: 'invocation',
      deps: { applySideEffects: () => undefined },
    });
    const operationContext = params.operationContext ?? createInvocationSavedSecretOperationContextV1({
      credentials: params.credentials, snapshot: accountSettingsContext, serverHttpBaseUrl,
      isCurrent: async () => resolveServerHttpBaseUrl() === serverHttpBaseUrl
        && (await readStoredCredentials())?.token === params.credentials.token,
    });
    if (params.operationContext && !await operationContext.replaceAccountSettings(accountSettingsContext)) {
      throw new ConnectedServicesDefaultUnavailableError('connected_account_purpose_catalog_unavailable');
    }
    const purposeCatalog = await refreshConnectedAccountCatalogForAdmission({ credentials: params.credentials,
      key: 'purposes', operationContext, ...(params.signal ? { signal: params.signal } : {}) });
    if (purposeCatalog.status !== 'ready' || purposeCatalog.record.key !== 'purposes') {
      throw new ConnectedServicesDefaultUnavailableError('connected_account_purpose_catalog_unavailable', 'purpose_binding',
        purposeCatalog.status === 'unavailable' ? purposeCatalog.reason : undefined);
    }
    const admittedSnapshot = operationContext.readSnapshot();
    if (!admittedSnapshot || !await operationContext.isCurrent()) {
      throw new ConnectedServicesDefaultUnavailableError('connected_account_purpose_catalog_unavailable', 'purpose_binding', 'scope-retired');
    }
    const accountSettings = admittedSnapshot.settings;
    const payload = await materializeSessionSpawnConnectedServicesDefaults({
      agentId,
      purposeDefaults: readAgentPurposeDefaults({ accountSettings, agentId, purposeCatalog }),
      ...(params.resolveTeamCredentialResourceCatalog ? { resolveTeamCredentialResourceCatalog: params.resolveTeamCredentialResourceCatalog } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (!payload) return null;
    if (!await operationContext.isCurrent()) {
      throw new ConnectedServicesDefaultUnavailableError('connected_account_purpose_catalog_unavailable', 'purpose_binding', 'scope-retired');
    }
    return payload;
  } catch (error) {
    if (isAccountSettingsContentInvalidError(error)) {
      throw new ConnectedServicesDefaultUnavailableError('connected_services_default_settings_invalid');
    }
    if (error instanceof ConnectedServicesDefaultUnavailableError) throw error;
    throw new ConnectedServicesDefaultUnavailableError('connected_account_purpose_catalog_unavailable', 'purpose_binding',
      readConnectedAccountCatalogUnavailableReason(error, params.signal));
  }
  };
  return params.operationContext ? runWithServerHttpBaseUrl(params.operationContext.serverHttpBaseUrl, resolve) : resolve();
}

/**
 * The Agent's default authentication, read through the one owner
 * (the opened purpose catalog, with released service-keyed defaults migrated
 * forward on read). The Agent's purposes come from its current
 * contribution projection — the same declarations its Session materializes.
 */
export function readAgentPurposeDefaults(params: Readonly<{
  onlySavedDefaults?: boolean;
  accountSettings: unknown;
  agentId: string;
  purposeCatalog?: ConnectedAccountCatalogSnapshotV1;
}>): readonly AgentConnectedAccountPurposeDefault[] {
  const snapshot = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({
    agentId: params.agentId,
    contributions: readCurrentContributionRegistry(),
  });
  const consumer = snapshot?.authorizedPurposes[0]?.purpose.consumer;
  if (!snapshot || !consumer) return [];
  const settings = params.accountSettings && typeof params.accountSettings === 'object' && !Array.isArray(params.accountSettings)
    ? params.accountSettings as Readonly<Record<string, unknown>>
    : {};
  return resolveAgentConnectedAccountPurposeDefaults({
    settings,
    ...(params.onlySavedDefaults ? { onlySavedDefaults: true } : {}),
    ...(params.purposeCatalog?.status === 'ready' && params.purposeCatalog.record.key === 'purposes'
      ? { purposeBindings: params.purposeCatalog.record.value } : {}),
    agentId: params.agentId,
    consumer,
    declarations: snapshot.authorizedPurposes.flatMap((scope) => (
      scope.serviceRefs[0] ? [{ purpose: scope.purpose.purpose, service: scope.serviceRefs[0] }] : []
    )),
  });
}

/** Materialize already resolved purposes through the same Team readiness and slot owners. */
export async function materializeSessionSpawnConnectedServicesDefaults(params: Readonly<{
  agentId: string;
  purposeDefaults: readonly AgentConnectedAccountPurposeDefault[];
  resolveTeamCredentialResourceCatalog?: ResolveSpawnConnectedServicesTeamResourceCatalog;
  signal?: AbortSignal;
}>): Promise<Readonly<{
  connectedServices: ConnectedServiceBindingsV2;
  connectedServicesUpdatedAt: number;
  teamCredentialBindings?: SessionTeamCredentialBindingIntentListV1;
}> | null> {
  const teamIds = [...new Set(params.purposeDefaults.flatMap(entry => entry.teamResource ? [entry.teamResource.teamId] : []))];
  let teamCredentialResourceCatalog: SpawnConnectedServicesTeamResourceCatalog | undefined;
  if (teamIds.length > 0) {
    try {
      teamCredentialResourceCatalog = await params.resolveTeamCredentialResourceCatalog?.({ teamIds, signal: params.signal }) ?? undefined;
    } catch (error) {
      params.signal?.throwIfAborted();
      throw new ConnectedServicesDefaultUnavailableError(readTeamCredentialLaunchFailureCode(error) ?? 'provider_catalog_unavailable',
        error instanceof SessionTeamCredentialLaunchUnavailableError ? error.phase : 'resource_catalog');
    }
    if (!teamCredentialResourceCatalog) throw new ConnectedServicesDefaultUnavailableError('connected_services_team_default_requires_current_resource');
  }
  const disposition = resolveSpawnConnectedServicesDefaultDisposition({
    agentId: params.agentId, accountSettings: {}, purposeDefaults: params.purposeDefaults,
    ...(teamCredentialResourceCatalog ? { teamCredentialResourceCatalog } : {}),
  });
  if (disposition.kind === 'unavailable') throw new ConnectedServicesDefaultUnavailableError(disposition.reason, 'purpose_binding', disposition.catalogReason);
  if (disposition.kind === 'native') return null;
  const teamCredentialBindings = resolvePurposeTeamCredentialBindingIntents({
    teamResourceSelections: params.purposeDefaults.flatMap(entry => entry.teamResource
      ? [{ purpose: entry.purpose, services: [entry.service], ...entry.teamResource }] : []),
    teamCredentialResourceCatalog,
  });
  return { connectedServices: disposition.bindings, connectedServicesUpdatedAt: Date.now(),
    ...(teamCredentialBindings.length > 0 ? { teamCredentialBindings } : {}) };
}

function normalizeBindingForSpawn(
  serviceId: string,
  binding: ConnectedServiceBindingSelectionV1 | undefined,
): ConnectedServiceBindingSelectionV1 {
  const resolution = resolveConnectedServiceSessionSelection({
    serviceId,
    binding,
    availability: { kind: 'deferred' },
  });
  return resolution.status === 'no_selection'
    ? { source: 'native' }
    : { source: 'connected', ...resolution.selection };
}

/**
 * A durable Team default is a reference, not an entitlement: it resolves only
 * while the settings' own Home still offers that exact selection from the
 * named Team. The catalog is read from the same Home the settings came from.
 */
function resolveCurrentTeamResourceDefault(params: Readonly<{
  serviceId: string | readonly string[];
  teamId: string;
  selection: TeamResourceConnectedServiceSelectionV2;
  catalog: Pick<SpawnConnectedServicesTeamResourceCatalog, 'resources'> | undefined;
}>): Readonly<{
  resource: TeamCredentialResourceCatalogEntryV1;
  selection: TeamResourceConnectedServiceSelectionV2;
}> | null {
  const { selection, catalog } = params;
  if (!catalog) return null;
  const serviceIds = typeof params.serviceId === 'string' ? [params.serviceId] : params.serviceId;

  const services = serviceIds.map(parseQualifiedPluginContributionKey).filter(service => service !== null);
  for (const resource of catalog.resources) {
    if (resource.readiness.kind !== 'available'
      && !readTeamCredentialLaunchReadinessRefusal(resource, selection.deliveryMode)) continue;
    const offeredSelection = resolveTeamResourceConnectedServiceSelectionV1({ resource, teamId: params.teamId, selection, services });
    if (offeredSelection) return { resource, selection: offeredSelection };
  }
  return null;
}

/**
 * One durable Team resource default of a purpose, as the Session it launches
 * must bind it: the canonical Team selection, the Team that offers it, and the
 * purpose's declared services the resource must serve.
 */
export type PurposeTeamResourceSelectionForSession = Readonly<{
  purpose: QualifiedConnectedAccountPurposeV1;
  teamId: string;
  selection: TeamResourceConnectedServiceSelectionV2;
  services: readonly Readonly<{ pluginId: string; localId: string }>[];
}>;

/**
 * The Session Team slot bindings a new Session must be created with so the
 * Home admits the durable Team resource defaults it will materialize (lane 10
 * child 01: a Session uses a Team resource only through its own admitted
 * binding). One intent per durable Team selection, carrying the resource
 * revision the settings' own Home currently offers. A Team default that no
 * longer resolves fails typed — never a silent personal/native fallback.
 */
export function resolvePurposeTeamCredentialBindingIntents(params: Readonly<{
  teamResourceSelections: readonly PurposeTeamResourceSelectionForSession[];
  teamCredentialResourceCatalog: Pick<SpawnConnectedServicesTeamResourceCatalog, 'resources'> | undefined;
}>): SessionTeamCredentialBindingIntentListV1 {
  const intents: SessionTeamCredentialBindingIntentV1[] = [];
  for (const entry of params.teamResourceSelections) {
    const resolved = resolveCurrentTeamResourceDefault({
      serviceId: entry.services.map((service) => buildQualifiedPluginContributionKey(service)),
      teamId: entry.teamId,
      selection: entry.selection,
      catalog: params.teamCredentialResourceCatalog,
    });
    if (!resolved) {
      throw new ConnectedServicesDefaultUnavailableError(
        'connected_services_team_default_requires_current_resource',
      );
    }
    const refusal = readTeamCredentialLaunchReadinessRefusal(resolved.resource, resolved.selection.deliveryMode);
    if (refusal) throw new ConnectedServicesDefaultUnavailableError(refusal);
    intents.push({
      v: 1,
      slot: { kind: 'connected_service_purpose', purpose: entry.purpose },
      resourceId: resolved.resource.id,
      expectedResourceRevision: resolved.resource.resourceRevision,
      deliveryMode: resolved.selection.deliveryMode,
      teamId: resolved.resource.teamId,
    });
  }
  return SessionTeamCredentialBindingIntentsV1Schema.parse(intents);
}

/**
 * A Session's creation-time Team slot bindings: an explicit binding the
 * caller chose for a slot wins; admitted durable defaults fill the others.
 */
export function mergeSessionTeamCredentialBindingIntents(params: Readonly<{
  explicit: SessionTeamCredentialBindingIntentListV1 | undefined;
  admitted: SessionTeamCredentialBindingIntentListV1 | null;
}>): SessionTeamCredentialBindingIntentListV1 | undefined {
  if (!params.admitted || params.admitted.length === 0) return params.explicit;
  const explicitSlotKeys = new Set(
    (params.explicit ?? []).map((intent) => sessionTeamCredentialSlotKeyV1(intent.slot)),
  );
  return SessionTeamCredentialBindingIntentsV1Schema.parse([
    ...(params.explicit ?? []).map(intent => {
      if (intent.resourceId === null || intent.teamId !== undefined) return intent;
      const admitted = params.admitted?.find(candidate => candidate.resourceId === intent.resourceId
        && candidate.resourceId !== null && candidate.deliveryMode === intent.deliveryMode
        && sessionTeamCredentialSlotKeyV1(candidate.slot) === sessionTeamCredentialSlotKeyV1(intent.slot));
      return admitted?.resourceId && admitted.teamId ? { ...intent, teamId: admitted.teamId } : intent;
    }),
    ...params.admitted.filter((intent) => !explicitSlotKeys.has(sessionTeamCredentialSlotKeyV1(intent.slot))),
  ]);
}

export async function resolvePurposeTeamCredentialBindingIntentsFromHome(params: Readonly<{
  teamResourceSelections: readonly PurposeTeamResourceSelectionForSession[];
  resolveTeamCredentialResourceCatalog: ResolveSpawnConnectedServicesTeamResourceCatalog | undefined;
  signal?: AbortSignal;
}>): Promise<SessionTeamCredentialBindingIntentListV1> {
  const teamIds = Array.from(new Set(params.teamResourceSelections.map((entry) => entry.teamId)));
  if (teamIds.length === 0) {
    return resolvePurposeTeamCredentialBindingIntents({
      teamResourceSelections: params.teamResourceSelections,
      teamCredentialResourceCatalog: undefined,
    });
  }
  let catalog: SpawnConnectedServicesTeamResourceCatalog | null = null;
  try {
    catalog = await params.resolveTeamCredentialResourceCatalog?.({ teamIds, signal: params.signal }) ?? null;
  } catch (error) {
    params.signal?.throwIfAborted();
    throw new ConnectedServicesDefaultUnavailableError(
      readTeamCredentialLaunchFailureCode(error) ?? 'provider_catalog_unavailable',
      error instanceof SessionTeamCredentialLaunchUnavailableError ? error.phase : 'resource_catalog',
    );
  }
  return resolvePurposeTeamCredentialBindingIntents({
    teamResourceSelections: params.teamResourceSelections,
    teamCredentialResourceCatalog: catalog ?? undefined,
  });
}

export function resolveSpawnConnectedServicesDefaultDisposition(params: Readonly<{
  accountSettings: unknown;
  agentId: string;
  purposeCatalog?: ConnectedAccountCatalogSnapshotV1;
  teamCredentialResourceCatalog?: SpawnConnectedServicesTeamResourceCatalog;
  purposeDefaults?: readonly AgentConnectedAccountPurposeDefault[];
}>): SpawnConnectedServicesDefaultDisposition {
  const supportedServiceIds = resolveCatalogAgentConnectedAccountServiceIds(params.agentId);
  if (supportedServiceIds.length === 0) return { kind: 'native' };

  if (params.purposeCatalog && (params.purposeCatalog.status !== 'ready' || params.purposeCatalog.record.key !== 'purposes')) {
    return {
      kind: 'unavailable',
      reason: 'connected_account_purpose_catalog_unavailable',
      ...(params.purposeCatalog.status === 'unavailable' ? { catalogReason: params.purposeCatalog.reason } : {}),
    };
  }

  const defaults = params.purposeDefaults ?? readAgentPurposeDefaults(params);
  const configuredBindings = projectAgentConnectedAccountPurposeDefaultsToSessionBindings(defaults)
    ?.bindingsByServiceId ?? {};
  const teamIdByServiceId = new Map(defaults.flatMap((entry) => (
    entry.teamResource
      ? [[buildQualifiedPluginContributionKey(entry.service), entry.teamResource.teamId] as const]
      : []
  )));
  const bindingsByServiceId: Record<string, ConnectedServiceBindingSelectionV2> = {};
  let hasNonNativeBinding = false;

  for (const serviceId of supportedServiceIds) {
    const configuredBinding = configuredBindings[serviceId];
    if (configuredBinding?.source === 'team_resource') {
      const teamId = teamIdByServiceId.get(serviceId);
      const resolved = teamId
        ? resolveCurrentTeamResourceDefault({
            serviceId,
            teamId,
            selection: configuredBinding,
            catalog: params.teamCredentialResourceCatalog,
          })
        : null;
      if (!resolved) {
        return {
          kind: 'unavailable',
          reason: 'connected_services_team_default_requires_current_resource',
        };
      }
      const refusal = readTeamCredentialLaunchReadinessRefusal(resolved.resource, resolved.selection.deliveryMode);
      if (refusal) return { kind: 'unavailable', reason: refusal };
      bindingsByServiceId[serviceId] = resolved.selection;
      hasNonNativeBinding = true;
      continue;
    }
    const binding = normalizeBindingForSpawn(
      serviceId,
      configuredBinding?.source === 'connected' ? configuredBinding : undefined,
    );
    bindingsByServiceId[serviceId] = binding;
    if (binding.source === 'connected') {
      hasNonNativeBinding = true;
    }
  }

  if (!hasNonNativeBinding) return { kind: 'native' };
  return {
    kind: 'connected',
    bindings: ConnectedServiceBindingsV2Schema.parse({
      v: 2,
      bindingsByServiceId,
    }),
  };
}

export function resolveSpawnConnectedServicesDefaults(params: Readonly<{
  accountSettings: unknown;
  agentId: string;
  purposeCatalog?: ConnectedAccountCatalogSnapshotV1;
  teamCredentialResourceCatalog?: SpawnConnectedServicesTeamResourceCatalog;
}>): ConnectedServiceBindingsV2 | null {
  const disposition = resolveSpawnConnectedServicesDefaultDisposition(params);
  return disposition.kind === 'connected' ? disposition.bindings : null;
}
