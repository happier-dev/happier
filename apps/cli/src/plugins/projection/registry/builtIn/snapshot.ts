import type { AgentCatalogEntry, CatalogAgentId } from '@/agent/catalog/types';
import { createResolvedContributionRegistry } from '../createResolvedContributionRegistry';
import { resolveBuiltInContributions } from '../resolveBuiltInContributions';
import type { ResolvedContributionRegistry, ResolvedPluginEnablement, UnavailableAgentPlugin } from '../types';
import { resolveBundledPluginEnablement } from './enablement';
import { applyMachineRoleAdmission } from './machineRoles';
import { BUNDLED_FIRST_PARTY_PLUGIN_METADATA } from '../sources/generatedBundledPluginManifests';
import type { AccountPluginDataStorageHostDependencies } from '@/plugins/runtime/context/accountPluginDataStorage';
import { BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS } from '../sources/generatedBundledPlugins';
import { getAllAgentDefinitionContracts } from '@happier-dev/agents/definitions';
import { readAdmittedPluginRegistryStateSync, resolveBundledPluginMachineEnablement } from '@/plugins/store/registry/admittedState';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { projectActionFailureCauseV1, readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ExternalActionRequestIdV1Schema } from '@happier-dev/protocol/actions/externalActionHttpError';
import { logger } from '@/ui/logger';
import type { PluginProjectScopeV1 } from '@happier-dev/protocol/plugins/availability/v1';

/** Read desired scope facts once for this admission, never from its consumers. */
export async function readCurrentBundledPluginEnablement(params?: Readonly<{
  happyHomeDir?: string;
  machineEnabledById?: Readonly<Record<string, boolean>>;
  accountStorageDependencies?: Pick<AccountPluginDataStorageHostDependencies, 'readCredentials' | 'resolveBaseUrl'>;
  installedPluginIds?: readonly string[] | 'current';
}>): Promise<Readonly<Record<string, ResolvedPluginEnablement>>> {
  const state = params?.machineEnabledById === undefined || params.installedPluginIds === 'current'
    ? await (await import('@/plugins/store/registry/currentState'))
      .createPluginRegistryStateStore({ happyHomeDir: params?.happyHomeDir }).readSnapshot()
    : undefined;
  const machineEnabledById = params?.machineEnabledById ?? state?.bundledPluginEnabledById;
  const installedPluginIds = params?.installedPluginIds === 'current'
    ? Object.entries(state?.plugins ?? {}).flatMap(([id, installation]) => installation.enabled ? [id] : [])
    : params?.installedPluginIds ?? [];
  const pluginIds = BUNDLED_FIRST_PARTY_PLUGIN_METADATA.map(plugin => plugin.pluginId);
  let accountEnabledById: ReadonlyMap<string, boolean> | undefined;
  const projectScopes = new Map<string, PluginProjectScopeV1>();
  let accountFailure: Parameters<typeof resolveBundledPluginEnablement>[0]['accountFailure'];
  try {
    const [{ readStoredCredentials }, { returnNullOnCliReloginRequired }] = await Promise.all([
      import('@/persistence'),
      import('@/auth/returnNullOnCliReloginRequired'),
    ]);
    const credentials = await (params?.accountStorageDependencies?.readCredentials ?? readStoredCredentials)()
      .catch(returnNullOnCliReloginRequired);
    if (credentials) {
      const { resolveServerHttpBaseUrl } = await import('@/api/client/serverHttpBaseUrl');
      const { readCurrentAccountPluginEnablementIntents } = await import('@/plugins/runtime/accountPluginActivationSource');
      const intents = await readCurrentAccountPluginEnablementIntents({ credentials,
        serverUrl: params?.accountStorageDependencies?.resolveBaseUrl?.() ?? resolveServerHttpBaseUrl(),
        pluginIds: [...pluginIds, ...installedPluginIds] });
      accountEnabledById = new Map(pluginIds.map(pluginId => [pluginId, intents.get(pluginId)?.enabled ?? true]));
      for (const [pluginId, intent] of intents) if (intent?.projectScope) projectScopes.set(pluginId, intent.projectScope);
    }
  } catch (error) {
    // No exception prose, request configuration or payload leaves this boundary.
    // Keep the read failure distinct from an authoritative Account refusal.
    const response: unknown = error && typeof error === 'object' && 'response' in error ? error.response : undefined;
    const data: unknown = response && typeof response === 'object' && 'data' in response ? response.data : undefined;
    const headers: unknown = response && typeof response === 'object' && 'headers' in response ? response.headers : undefined;
    const requestId = ExternalActionRequestIdV1Schema.safeParse(
      error && typeof error === 'object' && 'requestId' in error ? error.requestId
        : data && typeof data === 'object' && 'requestId' in data ? data.requestId
          : headers && typeof headers === 'object' && 'x-request-id' in headers ? headers['x-request-id'] : undefined,
    );
    const failureCause = projectActionFailureCauseV1(error, 'plugins.account_census');
    const errorCode = readActionErrorCodeV1(data) ?? failureCause.errorCode;
    accountFailure = Object.freeze({ failureCause: Object.freeze({ ...failureCause, errorCode }),
      ...(requestId.success ? { requestId: requestId.data } : {}),
    });
    logger.warnLocalFile('[PLUGIN RUNTIME] Account plugin census failed', accountFailure);
  }
  const enablement = resolveBundledPluginEnablement({ pluginIds, accountEnabledById, machineEnabledById, accountFailure });
  if (projectScopes.size === 0) return enablement;
  return Object.freeze({ ...enablement, ...Object.fromEntries([...projectScopes].map(([pluginId, projectScope]) => [pluginId,
    Object.freeze({ ...(enablement[pluginId] ?? { machineEnabled: true, enabled: true }), projectScope }),
  ])) });
}

/**
 * The sole immutable built-in snapshot. Import this owner only when the full
 * snapshot is needed; exact selections use the canonical projection directly.
 * Semantic admission settles before synchronous readers can see the snapshot.
 * Installed plugins and reloads never replace this built-in authority.
 */
let builtInResolvedContributionRegistry: ResolvedContributionRegistry | null = null;

/**
 * The bundled declarations are a pure function of the admitted enablement: the bundled
 * assets are immutable for the process. Boot consumers each read an equal enablement, so the
 * last resolution is kept by enablement content (one entry: a change resolves again).
 */
let lastBuiltInDeclarations: Readonly<{ key: string; declarations: ResolvedContributionRegistry }> | null = null;

function resolveBuiltInDeclarations(
  pluginEnablementById: Readonly<Record<string, ResolvedPluginEnablement>>,
): ResolvedContributionRegistry {
  const key = JSON.stringify(Object.keys(pluginEnablementById).sort().map(pluginId => [pluginId, pluginEnablementById[pluginId]]));
  if (lastBuiltInDeclarations?.key === key) return lastBuiltInDeclarations.declarations;
  const declarations = createResolvedContributionRegistry(resolveBuiltInContributions({ pluginEnablementById }));
  lastBuiltInDeclarations = { key, declarations };
  return declarations;
}

/** Agent backends withdrawn by plugin enablement: a projection of enablement and the generated bindings only. */
export function resolveUnavailableAgentPluginsByBackendId(
  pluginEnablementById: Readonly<Record<string, ResolvedPluginEnablement>>,
): Readonly<Record<string, UnavailableAgentPlugin>> {
  const unavailableAgentPluginsByBackendId: Record<string, UnavailableAgentPlugin> = {};
  const definitions = new Map(getAllAgentDefinitionContracts().map(definition => [definition.id, definition]));
  for (const binding of BUNDLED_FIRST_PARTY_AGENT_REGISTRATION_BINDINGS) {
    const pluginId = binding.identity.pluginId;
    const fact = pluginEnablementById[pluginId];
    if (!fact || fact.enabled) continue;
    const unavailable = Object.freeze({ ...fact, pluginId, code: fact.unavailableCode ?? 'plugin_disabled' as const });
    const definition = definitions.get(binding.implementationOwnerId);
    for (const backendId of new Set([binding.implementationOwnerId, ...(definition?.ownedBackendIds ?? [])])) {
      unavailableAgentPluginsByBackendId[backendId] = unavailable;
    }
  }
  return Object.freeze(unavailableAgentPluginsByBackendId);
}

export function getResolvedContributionRegistry(params?: Readonly<{
  pluginEnablementById: Readonly<Record<string, ResolvedPluginEnablement>>;
}>): ResolvedContributionRegistry {
  if (!params) {
    if (builtInResolvedContributionRegistry) return builtInResolvedContributionRegistry;
    const current = readAdmittedPluginRegistryStateSync(resolvePluginStorePaths());
    const machineEnabledById = current ? resolveBundledPluginMachineEnablement({
      state: current.catalog, bundledPluginEnabledById: current.revision.bundledPluginEnabledById,
    }) : undefined;
    return builtInResolvedContributionRegistry = getResolvedContributionRegistry({
      pluginEnablementById: resolveBundledPluginEnablement({
        pluginIds: BUNDLED_FIRST_PARTY_PLUGIN_METADATA.map(plugin => plugin.pluginId), machineEnabledById,
      }),
    });
  }
  const declarations = resolveBuiltInDeclarations(params.pluginEnablementById);
  // Machine roles need the admitted declarations, so they join the fact after admission.
  const pluginEnablementById = applyMachineRoleAdmission({ pluginEnablementById: params.pluginEnablementById,
    machineRoles: declarations.machineRoles ?? [] });
  return Object.freeze({ ...declarations, pluginEnablementById,
    unavailableAgentPluginsByBackendId: resolveUnavailableAgentPluginsByBackendId(params.pluginEnablementById) });
}

export function getBuiltInCatalogEntries(): Record<CatalogAgentId, AgentCatalogEntry> {
  return getResolvedContributionRegistry().catalogEntriesById as Record<CatalogAgentId, AgentCatalogEntry>;
}
