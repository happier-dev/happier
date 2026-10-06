import {
  resolveConnectedServiceSessionSelection,
} from '@happier-dev/agents';
import { ConnectedServiceBindingsV2Schema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { QualifiedConnectedAccountPurposeBindingsV1Schema } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { TeamCredentialResourceEntitledPageV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { projectAgentConnectedAccountPurposeDefaultsToSessionBindings, resolveAgentConnectedAccountPurposeDefaults } from '@happier-dev/protocol/account/settings/connected-services';
import type { ActionExecutorDeps, AgentConnectedAccountPurposeDefault, QualifiedConnectedAccountPurposeV1, ConnectedServiceBindingSelectionV1, ConnectedServiceBindingSelectionV2, ConnectedServiceBindingsV2, TeamCredentialResourceCatalogEntryV1, TeamResourceConnectedServiceSelectionV2 } from '@happier-dev/protocol';
import { SessionTeamCredentialBindingIntentsV1Schema, sessionTeamCredentialSlotKeyV1 } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import type { SessionTeamCredentialBindingIntentListV1, SessionTeamCredentialBindingIntentV1 } from '@happier-dev/protocol/teams';

import type { StoredCredentials } from '@/persistence';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { configuration } from '@/configuration';
import { resolveCatalogAgentConnectedAccountServiceIds } from '@/agent/catalog/registry';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';

export function agentSupportsSpawnConnectedServicesDefaults(agentId: string): boolean {
  return resolveCatalogAgentConnectedAccountServiceIds(agentId).length > 0;
}

export type SpawnConnectedServicesDefaultDisposition =
  | Readonly<{ kind: 'connected'; bindings: ConnectedServiceBindingsV2 }>
  | Readonly<{ kind: 'native' }>
  | Readonly<{
      kind: 'unavailable';
      reason:
        | 'connected_services_default_settings_invalid'
        | 'connected_services_team_default_requires_current_resource';
    }>;

export type SpawnConnectedServicesTeamResourceCatalog = Readonly<{
  serverId: string;
  accountId: string;
  resources: readonly TeamCredentialResourceCatalogEntryV1[];
}>;

export type ResolveSpawnConnectedServicesTeamResourceCatalog = (params: Readonly<{
  teamIds: readonly string[];
}>) => Promise<SpawnConnectedServicesTeamResourceCatalog | null>;

function readRecipientCatalogNextCursor(page: object): string | null {
  if (!('nextCursor' in page)) return null;
  return typeof page.nextCursor === 'string' ? page.nextCursor : null;
}

export function createSpawnConnectedServicesTeamResourceCatalogResolver(params: Readonly<{
  homeDomainAction: NonNullable<ActionExecutorDeps['homeDomainAction']>;
  serverId: string;
  accountId: string;
}>): ResolveSpawnConnectedServicesTeamResourceCatalog {
  return async ({ teamIds }) => {
    const resources: TeamCredentialResourceCatalogEntryV1[] = [];
    for (const teamId of teamIds) {
      let cursor: string | null = null;
      do {
        const raw = await params.homeDomainAction({
          actionId: 'teams.credentials.entitled.list', input: { teamId, ...(cursor ? { cursor } : {}) },
          context: { surface: 'cli', serverId: params.serverId },
        });
        if (raw && typeof raw === 'object' && 'ok' in raw && raw.ok === false) return null;
        const parsed = TeamCredentialResourceEntitledPageV1Schema.safeParse(raw);
        if (!parsed.success) return null;
        resources.push(...parsed.data.resources);
        cursor = readRecipientCatalogNextCursor(parsed.data);
      } while (cursor);
    }
    return {
      serverId: params.serverId,
      accountId: params.accountId,
      resources,
    };
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
  readonly code = 'connected_services_default_unavailable';

  constructor(readonly reason:
    | 'connected_services_default_settings_invalid'
    | 'connected_services_team_default_requires_current_resource') {
    super(reason);
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
 * Ordinary bootstrap failures retain the legacy no-default behavior. A
 * persisted Team-resource default is different: it is an explicit selection,
 * so missing or stale current-resource evidence throws the typed unavailable
 * error instead of silently falling back to native authentication.
 */
export async function resolveSessionSpawnConnectedServicesDefaultsPayload(params: Readonly<{
  agentId: string;
  credentials: StoredCredentials;
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

  try {
    const accountSettingsContext = await bootstrapAccountSettingsContext({
      credentials: params.credentials,
      mode: 'blocking',
      deps: { applySideEffects: () => undefined },
    });
    const teamIds = readTeamResourceDefaultTeamIds({
      accountSettings: accountSettingsContext.settings,
      agentId,
    });
    let teamCredentialResourceCatalog: SpawnConnectedServicesTeamResourceCatalog | undefined;
    if (teamIds.length > 0) {
      try {
        teamCredentialResourceCatalog = await params.resolveTeamCredentialResourceCatalog?.({ teamIds }) ?? undefined;
      } catch {
        throw new ConnectedServicesDefaultUnavailableError(
          'connected_services_team_default_requires_current_resource',
        );
      }
      if (!teamCredentialResourceCatalog) {
        throw new ConnectedServicesDefaultUnavailableError(
          'connected_services_team_default_requires_current_resource',
        );
      }
    }
    const disposition = resolveSpawnConnectedServicesDefaultDisposition({
      accountSettings: accountSettingsContext.settings,
      agentId,
      ...(teamCredentialResourceCatalog ? { teamCredentialResourceCatalog } : {}),
    });
    if (disposition.kind === 'unavailable') {
      throw new ConnectedServicesDefaultUnavailableError(disposition.reason);
    }
    if (disposition.kind === 'native') return null;
    const teamCredentialBindings = resolvePurposeTeamCredentialBindingIntents({
      teamResourceSelections: readAgentPurposeDefaults({ accountSettings: accountSettingsContext.settings, agentId })
        .flatMap((entry) => (
          entry.teamResource
            ? [{ purpose: entry.purpose, services: [entry.service], ...entry.teamResource }]
            : []
        )),
      teamCredentialResourceCatalog,
    });
    return {
      connectedServices: disposition.bindings,
      connectedServicesUpdatedAt: Date.now(),
      ...(teamCredentialBindings.length > 0 ? { teamCredentialBindings } : {}),
    };
  } catch (error) {
    if (error instanceof ConnectedServicesDefaultUnavailableError) throw error;
    return null;
  }
}

/**
 * The Agent's default authentication, read through the one owner
 * (`connectedAccountPurposeBindingsV1`, with released service-keyed defaults
 * migrated forward on read). The Agent's purposes come from its current
 * contribution projection — the same declarations its Session materializes.
 */
function readAgentPurposeDefaults(params: Readonly<{
  accountSettings: unknown;
  agentId: string;
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
    agentId: params.agentId,
    consumer,
    declarations: snapshot.authorizedPurposes.flatMap((scope) => (
      scope.serviceRefs[0] ? [{ purpose: scope.purpose.purpose, service: scope.serviceRefs[0] }] : []
    )),
  });
}

function readTeamResourceDefaultTeamIds(params: Readonly<{
  accountSettings: unknown;
  agentId: string;
}>): readonly string[] {
  return Array.from(new Set(readAgentPurposeDefaults(params).flatMap((entry) => (
    entry.teamResource ? [entry.teamResource.teamId] : []
  ))));
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
function resolveCurrentTeamResourceDefaultBinding(params: Readonly<{
  serviceId: string;
  teamId: string;
  selection: TeamResourceConnectedServiceSelectionV2;
  catalog: SpawnConnectedServicesTeamResourceCatalog | undefined;
}>): TeamResourceConnectedServiceSelectionV2 | null {
  return resolveCurrentTeamResourceDefault(params)?.selection ?? null;
}

function resolveCurrentTeamResourceDefault(params: Readonly<{
  serviceId: string | readonly string[];
  teamId: string;
  selection: TeamResourceConnectedServiceSelectionV2;
  catalog: SpawnConnectedServicesTeamResourceCatalog | undefined;
}>): Readonly<{
  resource: TeamCredentialResourceCatalogEntryV1;
  selection: TeamResourceConnectedServiceSelectionV2;
}> | null {
  const { selection, catalog } = params;
  if (!catalog) return null;
  const serviceIds = typeof params.serviceId === 'string' ? [params.serviceId] : params.serviceId;

  const resource = catalog.resources.find((candidate) => (
    candidate.id === selection.resourceId
    && candidate.teamId === params.teamId
    && candidate.readiness.kind === 'available'
    && candidate.sourcePresentation?.kind === 'connected_service'
    && serviceIds.includes(buildQualifiedPluginContributionKey(candidate.sourcePresentation.service))
  ));
  if (!resource) return null;

  const offeredSelection = resource.connectedServiceSelections.find((offered) => {
    if (
      offered.resourceId !== selection.resourceId
      || offered.deliveryMode !== selection.deliveryMode
    ) return false;
    if (offered.deliveryMode === 'brokered') return true;
    if (selection.deliveryMode !== 'direct') return false;
    return offered.disclosedMember.accountId === selection.disclosedMember.accountId
      && offered.disclosedMember.service.pluginId === selection.disclosedMember.service.pluginId
      && offered.disclosedMember.service.localId === selection.disclosedMember.service.localId;
  });
  return offeredSelection ? { resource, selection: offeredSelection } : null;
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
  teamCredentialResourceCatalog: SpawnConnectedServicesTeamResourceCatalog | undefined;
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
    ...(params.explicit ?? []),
    ...params.admitted.filter((intent) => !explicitSlotKeys.has(sessionTeamCredentialSlotKeyV1(intent.slot))),
  ]);
}

export async function resolvePurposeTeamCredentialBindingIntentsFromHome(params: Readonly<{
  teamResourceSelections: readonly PurposeTeamResourceSelectionForSession[];
  resolveTeamCredentialResourceCatalog: ResolveSpawnConnectedServicesTeamResourceCatalog | undefined;
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
    catalog = await params.resolveTeamCredentialResourceCatalog?.({ teamIds }) ?? null;
  } catch {
    catalog = null;
  }
  return resolvePurposeTeamCredentialBindingIntents({
    teamResourceSelections: params.teamResourceSelections,
    teamCredentialResourceCatalog: catalog ?? undefined,
  });
}

export function resolveSpawnConnectedServicesDefaultDisposition(params: Readonly<{
  accountSettings: unknown;
  agentId: string;
  teamCredentialResourceCatalog?: SpawnConnectedServicesTeamResourceCatalog;
}>): SpawnConnectedServicesDefaultDisposition {
  const supportedServiceIds = resolveCatalogAgentConnectedAccountServiceIds(params.agentId);
  if (supportedServiceIds.length === 0) return { kind: 'native' };

  const settingsRecord = params.accountSettings && typeof params.accountSettings === 'object' && !Array.isArray(params.accountSettings)
    ? params.accountSettings as { connectedAccountPurposeBindingsV1?: unknown }
    : {};
  if (
    settingsRecord.connectedAccountPurposeBindingsV1 !== undefined
    && !QualifiedConnectedAccountPurposeBindingsV1Schema.safeParse(settingsRecord.connectedAccountPurposeBindingsV1).success
  ) {
    return {
      kind: 'unavailable',
      reason: 'connected_services_default_settings_invalid',
    };
  }

  const defaults = readAgentPurposeDefaults({ accountSettings: params.accountSettings, agentId: params.agentId });
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
        ? resolveCurrentTeamResourceDefaultBinding({
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
      bindingsByServiceId[serviceId] = resolved;
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
  teamCredentialResourceCatalog?: SpawnConnectedServicesTeamResourceCatalog;
}>): ConnectedServiceBindingsV2 | null {
  const disposition = resolveSpawnConnectedServicesDefaultDisposition(params);
  return disposition.kind === 'connected' ? disposition.bindings : null;
}
