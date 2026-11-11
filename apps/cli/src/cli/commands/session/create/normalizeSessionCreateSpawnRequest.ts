import { indexAgentRoutingIdsByContributionIdentity, readAgentRoutingIdForContributionIdentity } from '@/plugins/projection/registry/agentRoutingIdentity';
import { getProfileDefaultBackendTarget } from '@happier-dev/protocol/profiles/profileCompatibility';
import { assertProfileCompatibleWithBackendTarget, resolveAccountProfileForSessionStart } from '@/settings/profiles/resolveProfileForAgent';
import { DEFAULT_AGENT_ID } from '@happier-dev/agents';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { findSpawnConfigOptionAliasConflicts, mergeSpawnConfigOptionAliases } from '@happier-dev/protocol/actions/sessionSpawnConfigOptions';
import { BackendTargetKeyV2InputSchema, parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { listAgentExecutionTargetsV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { parseAgentPermissionIntentV1Alias } from '@happier-dev/protocol/runtime/permissionIntentV1';
import { resolveSessionModelSelectionInputRefV1 } from '@happier-dev/protocol/providers/model-selection';
import type { SessionSpawnNewInputV2 } from '@happier-dev/protocol';
import { SessionCapabilitySelectionAuthoringV1Schema, type SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';

import { configuration } from '@/configuration';
import { resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import { resolveMachineIdForServerFromSettings } from '@/daemon/resolveMachineIdForServerFromSettings';
import { readSettings, readStoredCredentials, type Settings } from '@/persistence';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createCliMcpServerStore } from '@/settings/mcp/mcpServerStore';
import { readSkillLibraryItems } from '@/prompts/skills/library/readSkillLibraryItems';
import { readAccountPluginSkills } from '@/prompts/skills/library/readAccountPluginSkills';
import { resolveAvailableAccountSettings } from '@/settings/accountSettings/resolveAvailableAccountSettings';
import type { UnavailableAgentPlugin } from '@/plugins/projection/registry/types';

import type { SessionCreateSpawnRequest } from './parseSessionCreateSpawnOptions';

type SpawnAgentDefinition = Readonly<{
  id: string;
  identity?: SessionSpawnNewInputV2['agentTarget']['identity'];
}>;

type SpawnAgentCatalog = Readonly<{
  definitions: Iterable<SpawnAgentDefinition>;
  unavailableAgentPluginsByBackendId?: Readonly<Record<string, Pick<UnavailableAgentPlugin, 'pluginId' | 'code'>>>;
}>;

type SpawnAgentDefinitions = Iterable<SpawnAgentDefinition> | SpawnAgentCatalog;

function isSpawnAgentCatalog(value: SpawnAgentDefinitions): value is SpawnAgentCatalog {
  return typeof value === 'object' && value !== null && 'definitions' in value;
}

type SessionCreateMachineSettings = Pick<
  Settings,
  'machineId' | 'machineIdByServerId' | 'machineIdByServerIdByAccountId' | 'lastTokenSubByServerId'
>;

export type SessionCreateSpawnRequestNormalizerDeps = Readonly<{
  activeServerId: string;
  defaultAgentId: string;
  readSettings: () => Promise<SessionCreateMachineSettings>;
  readAgentDefinitions: () => SpawnAgentDefinitions | Promise<SpawnAgentDefinitions>;
  now: () => number;
  readCapabilityCatalogs?: (kinds: Readonly<{ mcp: boolean; skills: boolean }>) => Promise<Readonly<{
    mcp: readonly Readonly<{ id: string; name: string }>[];
    skills: readonly Readonly<{ id: string; name: string }>[];
  }>>;
}>;

export type NormalizedSessionCreateSpawnRequest = Readonly<{
  input: SessionSpawnNewInputV2;
  agentId: string;
}>;

function nonEmptyString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

type SessionCreateArgumentDetails =
  | Readonly<{ field: 'serverId'; allowedValues: readonly string[] }>
  | Readonly<{ reason: UnavailableAgentPlugin['code'] }>;

function invalidSessionCreateArgument(
  message: string,
  details?: SessionCreateArgumentDetails,
): never {
  throw Object.assign(new Error(`Invalid session create argument: ${message}`), details ? { details } : {});
}

function defaultNormalizerDeps(): SessionCreateSpawnRequestNormalizerDeps {
  return {
    activeServerId: configuration.activeServerId,
    defaultAgentId: DEFAULT_AGENT_ID,
    readSettings,
    readAgentDefinitions: async () => {
      const { ensureMergedAgentCommandRegistryLoaded } = await import('@/cli/commandRegistry');
      const registry = await ensureMergedAgentCommandRegistryLoaded();
      return {
        definitions: registry.agentDefinitionsById.values(),
        unavailableAgentPluginsByBackendId: registry.unavailableAgentPluginsByBackendId,
      };
    },
    now: () => Date.now(),
    readCapabilityCatalogs: async (kinds) => {
      const credentials = await readStoredCredentials();
      if (!credentials) throw Object.assign(new Error('Capability catalogs unavailable'), { code: 'catalog_unavailable' });
      const settings = await resolveAvailableAccountSettings({ credentials });
      if (!settings) throw Object.assign(new Error('Capability catalogs unavailable'), { code: 'catalog_unavailable' });
      const [mcp, skills] = await Promise.all([
        kinds.mcp ? createCliMcpServerStore({ credentials }).readCatalog() : null,
        kinds.skills ? readSkillLibraryItems({ ...createCredentialedAccountArtifactStore(credentials),
          readPluginSkills: (signal, skillIds) => readAccountPluginSkills({ credentials, settings, signal, skillIds, availableOnly: true }) }) : [],
      ]);
      if (mcp && mcp.status !== 'ready') throw Object.assign(new Error('MCP catalog unavailable'), { code: 'catalog_unavailable' });
      return { mcp: mcp?.catalog.servers ?? [], skills };
    },
  };
}

async function resolveCapabilityNames(request: SessionCreateSpawnRequest, deps: SessionCreateSpawnRequestNormalizerDeps): Promise<SessionCapabilitySelectionV1 | undefined> {
  const names = request.capabilitySelectionNames;
  if (!names) return request.capabilitySelection;
  const catalogs = await (deps.readCapabilityCatalogs ?? defaultNormalizerDeps().readCapabilityCatalogs!)({
    mcp: names.mcp.include.length > 0 || names.mcp.exclude.length > 0,
    skills: names.skills.include.length > 0 || names.skills.exclude.length > 0,
  });
  const resolveNames = (kind: 'skill' | 'mcp_server', names: readonly string[]) => names.map(name => {
    const items = (kind === 'skill' ? catalogs.skills : catalogs.mcp).filter(item => item.name === name);
    if (items.length !== 1) throw Object.assign(new Error(`Capability not found: ${name}`), { code: 'not_found', kind, name });
    return items[0]!.id;
  });
  const selection = request.capabilitySelection ?? {};
  return SessionCapabilitySelectionAuthoringV1Schema.parse({
    ...selection,
    ...(names.mcp.include.length || names.mcp.exclude.length ? { mcp: {
      ...selection.mcp, v: 1,
      forceIncludeServerIds: [...(selection.mcp?.forceIncludeServerIds ?? []), ...resolveNames('mcp_server', names.mcp.include)],
      forceExcludeServerIds: [...(selection.mcp?.forceExcludeServerIds ?? []), ...resolveNames('mcp_server', names.mcp.exclude)],
    } } : {}),
    ...(names.skills.include.length || names.skills.exclude.length ? { skills: {
      ...selection.skills,
      v: 1, forceIncludeSkillIds: [...(selection.skills?.forceIncludeSkillIds ?? []), ...resolveNames('skill', names.skills.include)],
      forceExcludeSkillIds: [...(selection.skills?.forceExcludeSkillIds ?? []), ...resolveNames('skill', names.skills.exclude)],
    } } : {}),
  });
}

function resolveConfiguration(
  request: SessionCreateSpawnRequest,
  updatedAtMs: number,
): SessionSpawnNewInputV2['configuration'] | undefined {
  if (!Number.isSafeInteger(updatedAtMs) || updatedAtMs < 0) {
    invalidSessionCreateArgument('configuration timestamp is invalid.');
  }
  if (findSpawnConfigOptionAliasConflicts({
    sessionConfigOptionOverrides: request.sessionConfigOptionOverrides,
    configOptions: request.configOptions,
  }).length > 0) {
    invalidSessionCreateArgument('--config-option conflicts with --config-overrides-json.');
  }

  const merged = mergeSpawnConfigOptionAliases({
    sessionConfigOptionOverrides: request.sessionConfigOptionOverrides,
    configOptions: request.configOptions,
    updatedAt: updatedAtMs,
  });
  if (!merged) return undefined;
  if (
    !Number.isSafeInteger(merged.updatedAt)
    || merged.updatedAt < 0
    || !Object.values(merged.overrides).every((override) => (
      Number.isSafeInteger(override.updatedAt)
      && override.updatedAt >= 0
    ))
  ) {
    invalidSessionCreateArgument('configuration overrides are invalid.');
  }

  return {
    mode: { value: null, updatedAtMs },
    model: { value: null, updatedAtMs },
    permissionIntent: { value: null, updatedAtMs },
    options: Object.fromEntries(Object.entries(merged.overrides).map(([id, override]) => [
      id,
      { value: override.value, updatedAtMs: override.updatedAt },
    ])),
  };
}

async function resolveAgentTarget(
  request: SessionCreateSpawnRequest,
  deps: SessionCreateSpawnRequestNormalizerDeps,
): Promise<Readonly<{
  agentId: string;
  agentTarget: SessionSpawnNewInputV2['agentTarget'];
  backendTargetKey: string;
}>> {
  const requestedTarget = request.backendTargetKey
    ? (() => {
        try {
          const parsed = parseBackendTargetKeyV2(BackendTargetKeyV2InputSchema.parse(request.backendTargetKey));
          return parseBackendTargetKeyV2(buildBackendTargetKeyV2(parsed));
        } catch {
          return invalidSessionCreateArgument('--backend does not identify an executable Agent.');
        }
      })()
    : null;
  const selectedAgentId = requestedTarget?.kind === 'backend'
    ? requestedTarget.backendId : nonEmptyString(deps.defaultAgentId);
  if (!requestedTarget && !selectedAgentId) {
    invalidSessionCreateArgument('the default Agent is unavailable.');
  }
  const catalog = await deps.readAgentDefinitions();
  const isCatalog = isSpawnAgentCatalog(catalog);
  const definitions = [...(isCatalog ? catalog.definitions : catalog)];
  const resolvedAgentId = requestedTarget?.kind === 'agent'
    ? readAgentRoutingIdForContributionIdentity(indexAgentRoutingIdsByContributionIdentity(definitions), requestedTarget.identity)
    : selectedAgentId;
  const agent = definitions.find((candidate) => candidate.id === resolvedAgentId);
  if (!agent?.identity) {
    const unavailable = isCatalog
      ? [
          resolvedAgentId,
          requestedTarget?.kind === 'backend' ? requestedTarget.backendId : null,
          requestedTarget?.kind === 'agent' ? requestedTarget.identity.localId : null,
        ].map((agentId) => agentId ? catalog.unavailableAgentPluginsByBackendId?.[agentId] : undefined)
        .find((entry) => entry !== undefined
          && (requestedTarget?.kind !== 'agent' || entry.pluginId === requestedTarget.identity.pluginId))
      : undefined;
    if (unavailable) {
      invalidSessionCreateArgument(
        unavailable.code === 'plugin_disabled'
          ? 'This Agent plugin is disabled. Re-enable it in Plugins before starting a Session.'
          : 'Account plugin execution is unavailable.',
        { reason: unavailable.code },
      );
    }
    invalidSessionCreateArgument('--backend does not identify an executable Agent.');
  }
  const agentTarget = requestedTarget?.kind === 'agent'
    ? { ...requestedTarget, identity: agent.identity }
    : listAgentExecutionTargetsV1(agent.identity)[0];
  if (!agentTarget) invalidSessionCreateArgument('--backend does not identify an executable Agent.');
  return {
    agentId: agent.id,
    agentTarget,
    backendTargetKey: buildBackendTargetKeyV2(agentTarget),
  };
}

async function resolveExecutionTarget(
  request: SessionCreateSpawnRequest,
  deps: SessionCreateSpawnRequestNormalizerDeps,
): Promise<SessionSpawnNewInputV2['executionTarget']> {
  const activeServerId = nonEmptyString(deps.activeServerId);
  if (!activeServerId) {
    invalidSessionCreateArgument('the active server is unavailable.');
  }
  const homeServerId = await resolveServerProfileHomeIdentityId(activeServerId) ?? activeServerId;
  const requestedServerId = nonEmptyString(request.serverId);
  if (requestedServerId && requestedServerId !== activeServerId && requestedServerId !== homeServerId) {
    invalidSessionCreateArgument('--server-id must match the active server.', {
      field: 'serverId', allowedValues: [...new Set([activeServerId, homeServerId])],
    });
  }
  const settings = await deps.readSettings();
  const accountId = nonEmptyString(settings.lastTokenSubByServerId?.[activeServerId]);
  const configuredMachineId = resolveMachineIdForServerFromSettings(settings, activeServerId, accountId)
    ?? nonEmptyString(settings.machineId);
  const machineId = nonEmptyString(request.machineId) ?? configuredMachineId;
  if (!machineId) {
    throw new Error('Missing machine id. Start the local daemon or pass --machine-id.');
  }
  // The saved profile scopes local settings; the portable Home scopes the
  // recipe that another daemon receives, retains and replays.
  return { serverId: homeServerId, machineId };
}

/**
 * The sole CLI argv-to-Action adapter for ordinary Session creation. It keeps
 * legacy spellings at the CLI boundary and emits the strict canonical V2
 * payload consumed by `session.spawn_new`. The public API transport projects
 * its host-owned execution target at the Action-surface owner.
 */
export async function normalizeSessionCreateSpawnRequest(
  request: SessionCreateSpawnRequest,
  suppliedDeps?: SessionCreateSpawnRequestNormalizerDeps,
): Promise<NormalizedSessionCreateSpawnRequest> {
  const deps = suppliedDeps ?? defaultNormalizerDeps();

  const directory = nonEmptyString(request.directory);
  if (!directory) {
    invalidSessionCreateArgument('--path is required.');
  }
  const profileId = nonEmptyString(request.profileId);
  const selectedProfile = profileId ? await (async () => {
    const credentials = await readStoredCredentials();
    if (!credentials) throw new Error('Authentication required to select a launch Profile.');
    const { bootstrapAccountSettingsContext } = await import('@/settings/accountSettings/bootstrapAccountSettingsContext');
    const accountSettingsContext = await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'auto' });
    return (await resolveAccountProfileForSessionStart({ query: profileId, credentials, accountSettingsContext })).profile;
  })() : null;
  const preferredTarget = !request.backendTargetKey && selectedProfile ? getProfileDefaultBackendTarget(selectedProfile) : null;
  const effectiveRequest = preferredTarget
    ? { ...request, backendTargetKey: buildBackendTargetKeyV2(preferredTarget) } : request;
  const updatedAtMs = deps.now();
  const [executionTarget, resolvedAgent] = await Promise.all([
    resolveExecutionTarget(request, deps),
    resolveAgentTarget(effectiveRequest, deps),
  ]);
  if (selectedProfile) assertProfileCompatibleWithBackendTarget(selectedProfile, resolvedAgent.agentTarget);
  const modelId = nonEmptyString(request.modelId);
  const providerConnectionId = nonEmptyString(request.providerConnectionId);
  if (providerConnectionId && !modelId) {
    invalidSessionCreateArgument('--provider-connection requires --model.');
  }
  const configuration = resolveConfiguration(request, updatedAtMs);
  const title = nonEmptyString(request.title);
  const initialInputText = nonEmptyString(request.initialInput?.text);
  const permissionModeRaw = nonEmptyString(request.permissionMode);
  const permissionMode = permissionModeRaw
    ? parseAgentPermissionIntentV1Alias(permissionModeRaw)
    : null;
  if (permissionModeRaw && !permissionMode) {
    invalidSessionCreateArgument(`permission mode "${permissionModeRaw}" is invalid.`);
  }
  const agentModeId = nonEmptyString(request.agentModeId);
  const capabilitySelection = await resolveCapabilityNames(request, deps);
  // The `default` reset sentinel is native-only: a Provider connection may serve
  // a model literally named `default`, so the canonical resolver — not this
  // adapter — decides whether a flat argv pair is a real structured selection.
  const modelSelectionRef = (() => {
    if (!modelId) return null;
    try {
      return resolveSessionModelSelectionInputRefV1({
        agentTargetKey: resolvedAgent.backendTargetKey,
        providerConnectionId,
        modelId,
      });
    } catch {
      return invalidSessionCreateArgument('the requested model selection is invalid.');
    }
  })();
  const candidate = {
    executionTarget,
    directory: { kind: 'path', path: directory },
    agentTarget: resolvedAgent.agentTarget,
    ...(modelSelectionRef
      ? {
          modelSelection: {
            v: 1 as const,
            updatedAt: updatedAtMs,
            ref: modelSelectionRef,
          },
        }
      : {}),
    ...(title ? { title } : {}),
    ...(initialInputText ? { initialInput: { text: initialInputText } } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(agentModeId ? { agentModeId } : {}),
    ...(configuration ? { configuration } : {}),
    ...(request.connectedServices ? { connectedServices: request.connectedServices } : {}),
    ...(capabilitySelection ? { capabilitySelection } : {}),
    ...(request.transcriptStorage ? { transcriptStorage: request.transcriptStorage } : {}),
    ...(request.terminal ? { terminal: request.terminal } : {}),
    ...(profileId ? { profileId: selectedProfile?.id ?? profileId } : {}),
    ...(request.environmentVariables ? { environmentVariables: request.environmentVariables } : {}),
  };
  const parsed = SessionSpawnNewInputV2Schema.safeParse(candidate);
  if (!parsed.success) {
    invalidSessionCreateArgument('the requested Session creation fields are invalid.');
  }
  return { input: parsed.data, agentId: resolvedAgent.agentId };
}
