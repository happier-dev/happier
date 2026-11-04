import { AgentsAcpBackendsGetInputV1Schema, AgentsAcpBackendsGetOutputV1Schema, AgentsAcpBackendsUpsertInputV1Schema, AgentsAcpBackendsUpsertOutputV1Schema, applyAcpBackendUpsertV1 } from '../../../acp/catalog/catalogMutationsV1.js';
import { installAcpRegistryAgentV1 } from '../../../acp/catalog/registry/installAcpRegistryAgentV1.js';
import { AgentsAcpBackendsInstallFromRegistryInputV1Schema } from '../../../acp/catalog/registry/registryInstallActionV1.js';
import { readActionFailureEnvelope } from '../actionFailureEnvelope.js';
import { readRecord, readNonEmptyString } from '../../../inputs/inputRecords.js';
import { resolveAcpPlatformFitV1 } from '../../../acp/catalog/registry/acpPlatformFitV1.js';
import { MachinesAgentsListOutputSchema, MachineAcpInventoryDefinitionSchema } from '../../../capabilities/machineAgentInventory.js';
import type { CoreInvocation, DispatchFacts, PreparedCoreAdmission } from '../coreInvocation.js';
import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps } from '../types.js';

type ActionExecuteFailure = Extract<ActionExecuteResult, Readonly<{ ok: false }>>;

export const projectAcpUpsertRefusal = (outcome: Extract<ReturnType<typeof applyAcpBackendUpsertV1>, { ok: false }>): ActionExecuteFailure => ({
          ok: false, errorCode: outcome.code, error: outcome.message,
          ...(outcome.code === 'registry_change_requires_install'
            ? { details: { use: 'agents.acp.backends.installFromRegistry' } } : {}),
        });




export async function dispatchAgentsAcp(inv: Pick<CoreInvocation, 'actionId' | 'deps' | 'data' | 'ctx'>): Promise<ActionExecuteResult | null> {
  const { actionId, deps, data, ctx } = inv;

        if (actionId === 'agents.acp.backends.get') {
          if (!deps.readAccountAcpCatalog) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const request = AgentsAcpBackendsGetInputV1Schema.parse(data);
          const catalog = await deps.readAccountAcpCatalog({ ...(ctx.signal ? { signal: ctx.signal } : {}) });
          if (catalog.status !== 'ready') return { ok: false, errorCode: 'acp_catalog_unavailable', error: 'acp_catalog_unavailable' };
          const backend = catalog.record.definitions.find(entry => entry.id === request.backendId);
          if (!backend) return { ok: false, errorCode: 'acp_backend_not_found', error: 'acp_backend_not_found' };
          return { ok: true, result: AgentsAcpBackendsGetOutputV1Schema.parse({ backend, revision: catalog.revision }) };
        }

        if (actionId === 'agents.acp.backends.installFromRegistry') {
          return await installAcpRegistryAgentV1(AgentsAcpBackendsInstallFromRegistryInputV1Schema.parse(data), ctx, deps);
        }
        if (actionId === 'agents.acp.backends.upsert' && data.dryRun === true) {
          if (!deps.readAccountAcpCatalog) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          if (!deps.machinesList) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          const request = AgentsAcpBackendsUpsertInputV1Schema.parse(data);
          const catalog = await deps.readAccountAcpCatalog({ ...(ctx.signal ? { signal: ctx.signal } : {}) });
          if (catalog.status !== 'ready') return { ok: false, errorCode: 'acp_catalog_unavailable', error: 'acp_catalog_unavailable' };
          const outcome = applyAcpBackendUpsertV1({ settings: { v: 2, backends: catalog.record.definitions },
            backend: request.backend, nowMs: Date.now() });
          if (!outcome.ok) return projectAcpUpsertRefusal(outcome);
          const inventory = await deps.machinesList({ purpose: 'input', ...(ctx.serverId ? { serverId: ctx.serverId } : {}) });
          const failure = readActionFailureEnvelope(inventory);
          if (failure) return failure;
          const rawMachines = readRecord(inventory).items;
          if (!Array.isArray(rawMachines)) return { ok: false, errorCode: 'machine_inventory_unavailable', error: 'machine_inventory_unavailable' };
          const machines = await Promise.all(rawMachines.map(async raw => {
            const machine = readRecord(raw);
            const machineId = readNonEmptyString(machine.machineId);
            if (!machineId) throw new Error('Machine inventory requires an identity');
            const fit = resolveAcpPlatformFitV1(outcome.backend.launch, {
              platform: readNonEmptyString(machine.platform) ?? null, arch: readNonEmptyString(machine.arch) ?? null,
            });
            let commandFound: boolean | null = null;
            if (outcome.backend.launch.kind === 'command' && machine.presence === 'online' && deps.machinesAgentsList) {
              ctx.signal?.throwIfAborted();
              const draft = MachineAcpInventoryDefinitionSchema.parse({ definitionId: outcome.backend.id,
                title: outcome.backend.title, launch: outcome.backend.launch });
              try {
                const result = MachinesAgentsListOutputSchema.safeParse(await deps.machinesAgentsList({ machineId,
                  agentId: 'custom-acp', definitionId: draft.definitionId, draftDefinitions: [draft], refresh: true,
                  ...(ctx.serverId ? { serverId: ctx.serverId } : {}),
                }, ctx));
                const facts = result.success ? result.data.items.find(item => item.agentId === 'custom-acp'
                  && item.definitionId === draft.definitionId) : undefined;
                if (facts) commandFound = facts.installed;
              } catch {
                ctx.signal?.throwIfAborted();
                // Unreachable probes supply no existence fact; offline fit remains useful.
              }
            }
            return { machineId, fit, commandFound };
          }));
          return { ok: true, result: AgentsAcpBackendsUpsertOutputV1Schema.parse({ dryRun: true, backend: outcome.backend, machines }) };
        }
  return null;
}
