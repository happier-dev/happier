import { applyAcpBackendUpsertV1 } from '../catalogMutationsV1.js';
import { AcpCatalogSettingsV1StoredSchema, type AcpBackendDefinitionV1 } from '../settingsV1.js';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '../../../registries/registryActionsV1.js';
import { RegistryFetchErrorV1 } from '../../../registries/registryListV1.js';
import { buildConfiguredAcpAgentSelectionV1 } from '../../../agents/executionTargetV1.js';
import { DaemonAgentInstallStartResponseSchema } from '../../../daemon/agentInstallJobs.js';
import { MachinesAgentsListOutputSchema } from '../../../capabilities/machineAgentInventory.js';
import { ActionExecuteFailureSchema, type ActionExecuteResult } from '../../../actions/actionExecutionResult.js';
import type { ActionExecutorContext, ActionExecutorDeps } from '../../../actions/executor/types.js';
import { mapAcpRegistryAgentToDefinitionV1 } from './mapAcpRegistryAgentV1.js';
import { AgentsAcpBackendsInstallFromRegistryOutputV1Schema, type AgentsAcpBackendsInstallFromRegistryInputV1 } from './registryInstallActionV1.js';

/** One confirmed admission: the registry owns reading, the ACP mutation/CAS owns writing, and the daemon owns acquisition. */
export async function installAcpRegistryAgentV1(input: AgentsAcpBackendsInstallFromRegistryInputV1,
  context: ActionExecutorContext,
  deps: Pick<ActionExecutorDeps, 'registryActionExecute' | 'updateAccountAcpCatalogSettings' | 'machineAgentInstallStart' | 'machinesAgentsList'>,
): Promise<ActionExecuteResult> {
  const executeRegistry = deps.registryActionExecute;
  const updateCatalog = deps.updateAccountAcpCatalogSettings;
  const startInstall = deps.machineAgentInstallStart;
  if (!executeRegistry || !updateCatalog || input.installOn?.length && (!startInstall || !deps.machinesAgentsList)) {
    return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:agents.acp.backends.installFromRegistry' };
  }
  context.signal?.throwIfAborted();
  let sources;
  let item;
  try {
    const rawSources = await executeRegistry({ actionId: 'registries.sources.list', input: { kind: 'agent' }, context });
    const sourceFailure = ActionExecuteFailureSchema.safeParse(rawSources);
    if (sourceFailure.success) return sourceFailure.data;
    sources = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.sources.list'].parse(rawSources).sources;
    const rawItem = await executeRegistry({ actionId: 'registries.items.read', input: { kind: 'agent', ...input.fromRegistry }, context });
    const readFailure = ActionExecuteFailureSchema.safeParse(rawItem);
    if (readFailure.success) return readFailure.data;
    item = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(rawItem).item;
  } catch (error) {
    if (!(error instanceof RegistryFetchErrorV1)) throw error;
    return { ok: false, errorCode: 'registry_read_failed', error: 'registry_read_failed', details: { status: error.status } };
  }
  const source = sources.find(source => source.id === item.summary.sourceId);
  if (!source?.enabled || source.format !== 'acp-registry' || item.summary.problem || item.payload.kind !== 'agent'
    || item.summary.itemId !== input.fromRegistry.itemId || item.summary.version !== input.fromRegistry.version) {
    return { ok: false, errorCode: 'registry_item_unavailable', error: 'registry_item_unavailable' };
  }
  const agent = item.payload.agent;
  const provenance = { sourceId: source.id, format: source.format, sourceUrl: source.url, itemId: agent.id,
    ref: { kind: 'version' as const, version: input.fromRegistry.version }, importedAt: Date.now() };
  let definition: AcpBackendDefinitionV1 | undefined;
  let refusal: Readonly<{ code: string; message: string }> | undefined;
  const persisted = await updateCatalog({
    ...(context.signal ? { signal: context.signal } : {}),
    mutate: current => {
      // CAS retry callbacks recompute against the actual incumbent, preserving the person's latest edits.
      definition = undefined;
      refusal = undefined;
      const settings = AcpCatalogSettingsV1StoredSchema.safeParse(current ?? { v: 2, backends: [] });
      if (!settings.success) {
        refusal = { code: 'acp_catalog_unavailable', message: 'acp_catalog_unavailable' };
        return current;
      }
      const existing = settings.data.backends.find(backend => backend.origin?.provenance.sourceId === source.id
        && backend.origin.provenance.itemId === agent.id);
      const mapped = mapAcpRegistryAgentToDefinitionV1({ agent, provenance, existing, nowMs: provenance.importedAt });
      if (!mapped.ok) {
        refusal = { code: mapped.code, message: mapped.code };
        return current;
      }
      const outcome = applyAcpBackendUpsertV1({ settings: settings.data, backend: mapped.definition,
        nowMs: provenance.importedAt, mode: 'registryInstall' });
      if (!outcome.ok) {
        refusal = { code: outcome.code, message: outcome.message };
        return current;
      }
      definition = outcome.backend;
      return outcome.settings;
    },
  });
  if (refusal) return { ok: false, errorCode: refusal.code, error: refusal.message };
  if (!persisted.ok) return { ...persisted, errorCode: persisted.errorCode === 'conflict' ? 'acp_catalog_conflict' : persisted.errorCode };
  if (!definition) return { ok: false, errorCode: 'acp_catalog_unavailable', error: 'acp_catalog_unavailable' };
  if (definition.launch.kind === 'command') throw new Error('Registry mapping requires a version-pinned launch');
  const definitionId = definition.id;
  const selection = buildConfiguredAcpAgentSelectionV1(definitionId);
  const reviewedVersion = definition.launch.version;
  const jobs: Array<{ machineId: string; jobId: string }> = [];
  const failures: Array<{ machineId: string; errorCode: string }> = [];
  for (const machineId of input.installOn ?? []) {
    try {
      context.signal?.throwIfAborted();
      const inventory = MachinesAgentsListOutputSchema.safeParse(await deps.machinesAgentsList!({
        machineId, agentId: selection.agentId, definitionId, refresh: true,
        ...(context.serverId ? { serverId: context.serverId } : {}),
      }, context));
      const facts = inventory.success ? inventory.data.items.find(item => item.agentId === selection.agentId
        && item.definitionId === definitionId) : undefined;
      if (!facts) {
        failures.push({ machineId, errorCode: 'machine_agent_inventory_unavailable' });
        continue;
      }
      const result = DaemonAgentInstallStartResponseSchema.parse(await startInstall!({
        machineId, agentId: selection.agentId, definitionId,
        expectedDefinitionVersion: reviewedVersion,
        intent: facts.installed ? 'update' : 'install', consent: { vendorRecipe: false },
        ...(context.serverId ? { serverId: context.serverId } : {}), ...(context.signal ? { signal: context.signal } : {}),
      }));
      if (result.ok) jobs.push({ machineId, jobId: result.jobId });
      else failures.push({ machineId, errorCode: result.errorCode });
    } catch {
      failures.push({ machineId, errorCode: context.signal?.aborted ? 'cancelled' : 'install_outcome_unknown' });
    }
  }
  const result = AgentsAcpBackendsInstallFromRegistryOutputV1Schema.parse({ definition, jobs });
  // The durable definition and accepted jobs are receipts even if a later machine refuses or loses its response.
  return failures.length ? { ok: false, errorCode: 'agent_install_partial', error: 'agent_install_partial', details: { ...result, failures } }
    : { ok: true, result };
}
