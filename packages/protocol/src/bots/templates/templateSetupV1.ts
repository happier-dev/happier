import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { readBuiltInLegacyConnectedAccountServiceKeyIngress,
  type ConnectedServiceBindingsV2 } from '../../connect/connectedServiceBindings.js';
import { mergeMachineSetupsV1, type MachineSetupV1 } from '../../machines/managed/machineSetupV1.js';
import type { MachineSetupObservationV1 } from '../../machines/setup/machineSetupObservationV1.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import type { BotTemplateContentV1 } from './botTemplateV1.js';
import { bindBotTemplateMcpDefinitionV1 } from '../../mcp/servers/portableMcpDefinitionV1.js';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '../../mcp/servers/actionSchemasV1.js';
import { uniqueMcpServerNameV1 } from '../../mcp/servers/serverCatalogV1.js';
import { SessionCapabilitiesSetOutputV1Schema } from '../../actions/specs/sessionCapabilities.js';
import type { MachineSetupPlanResultV1, MachineSetupPlanInputV1 } from '../../machines/managed/actionsV1.js';
import { MachineRecipePackageObservationV1Schema } from '../../machines/setup/machineRecipeV1.js';

import { BotTemplateSetupSelectionsV1Schema, type BotTemplateSetupSelectionsV1 } from './templateSetupSelectionsV1.js';
export { BotTemplateSetupSelectionsV1Schema, type BotTemplateSetupSelectionsV1 } from './templateSetupSelectionsV1.js';
const key = () => z.string().check(z.minLength(1));
const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };

/** The exact selected setup input is signed at admission and consumed unchanged at wake. */
export function buildBotTemplateMachineSetupPlanInputV1(target: Readonly<{ homeId: string; machineId: string }>,
  machineSetup: MachineSetupV1): MachineSetupPlanInputV1 {
  return { ...target, mode: 'effects', sources: [{ kind: 'direct', setup: machineSetup }] };
}

/** One admission of recipient selections; carried declarations never supply source bindings. */
export function prepareBotTemplateSetupV1(needs: BotTemplateContentV1['needs'], raw?: BotTemplateSetupSelectionsV1) {
  const selections = BotTemplateSetupSelectionsV1Schema.parse(raw ?? { software: [], accounts: [], mcpServers: [] });
  const select = <T extends { key: string; selection: { action: string } }>(items: readonly { key: string; requirement: string }[], choices: readonly T[]) => {
    const map = new Map<string, T['selection']>(choices.map(choice => [choice.key, choice.selection]));
    if (map.size !== choices.length || choices.some(choice => !items.some(item => item.key === choice.key))) refuse('invalid_request');
    for (const item of items) if (item.requirement === 'required' && (!map.has(item.key) || map.get(item.key)?.action === 'skip')) refuse('missing_values');
    return map;
  };
  const software = select(needs.software, selections.software);
  const accounts = select(needs.connectedAccounts, selections.accounts);
  const mcp = select(needs.mcpServers, selections.mcpServers);
  const setups: MachineSetupV1[] = needs.software.flatMap(need => {
    const selection = software.get(need.key);
    return selection?.action === 'install' ? [{ items: [{ kind: 'softwareRecipe', selection: { ref: need.recipe, inputs: selection.inputs } }] }] : [];
  });
  const merged = mergeMachineSetupsV1(setups);
  if (!merged.ok) return refuse(merged.errorCode);
  const bindingsByServiceId: ConnectedServiceBindingsV2['bindingsByServiceId'] = {};
  for (const need of needs.connectedAccounts) {
    const selection = accounts.get(need.key);
    if (selection?.action !== 'connect') continue;
    const serviceId = readBuiltInLegacyConnectedAccountServiceKeyIngress(need.serviceId);
    if (!serviceId || selection.binding.source === 'native') return refuse('invalid_request');
    const previous = bindingsByServiceId[serviceId];
    if (previous && !sameStrictJsonValue(previous, selection.binding)) return refuse('invalid_request');
    bindingsByServiceId[serviceId] = selection.binding;
  }
  const boundMcp = needs.mcpServers.flatMap(need => {
    const selection = mcp.get(need.key);
    if (selection?.action !== 'bind') return [];
    // Validate recipient refs before birth; importing and including remain admitted effects.
    const entry = bindBotTemplateMcpDefinitionV1({ definition: need.definition, inputs: selection.inputs, id: need.key, nowMs: 0 });
    return [{ key: need.key, entry }];
  });
  return {
    ...(setups.length ? { machineSetup: merged.setup } : {}),
    ...(Object.keys(bindingsByServiceId).length ? { connectedServices: { v: 2 as const, bindingsByServiceId } } : {}),
    mcp: boundMcp,
  };
}

export function checkBotTemplateSetupReadinessV1(needs: BotTemplateContentV1['needs'], selections?: BotTemplateSetupSelectionsV1):
  Readonly<{ ready: true } | { ready: false; code: string }> {
  try { prepareBotTemplateSetupV1(needs, selections); return { ready: true }; }
  catch (error) { return { ready: false, code: typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'invalid_request' }; }
}

export type BotTemplateSetupInvokeV1 = (action: 'mcp.servers.list' | 'mcp.servers.create' | 'mcp.servers.update' | 'session.capabilities.set', role: string, input: unknown) => Promise<unknown>;
/** One catalog read and one batch mutation, with Session-only inclusion at its existing owner. */
export async function applyBotTemplateMcpSetupV1(input: Readonly<{
  mcp: ReturnType<typeof prepareBotTemplateSetupV1>['mcp']; sessionId: string;
  invoke: BotTemplateSetupInvokeV1; randomId(): string; nowMs(): number;
  recoveryIds?: Readonly<Record<string, string>>;
  existingIds?: Readonly<Record<string, string>>;
  onCreated?(ids: Readonly<Record<string, string>>): void;
  onIncluded?(key: string, id: string): void;
}>): Promise<Record<string, string>> {
  if (Object.keys(input.recoveryIds ?? {}).some(key => !input.mcp.some(item => item.key === key))) return refuse('invalid_request');
  if (!input.mcp.length) return {};
  const ids: Record<string, string> = {};
  const existing = input.mcp.filter(item => input.existingIds?.[item.key]);
  const pendingCreate = input.mcp.filter(item => !input.existingIds?.[item.key] && !input.recoveryIds?.[item.key]);
  for (const item of input.mcp) {
    const recoveredId = input.recoveryIds?.[item.key];
    const existingId = input.existingIds?.[item.key];
    if (existingId && recoveredId && existingId !== recoveredId) return refuse('invalid_request');
    if (existingId || recoveredId) ids[item.key] = existingId ?? recoveredId!;
  }
  if (existing.length || pendingCreate.length) {
    const snapshot = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.list'].parse(await input.invoke('mcp.servers.list', 'template_mcp_catalog', {}));
    if (snapshot.status !== 'ready' || snapshot.authority !== 'active') return refuse('mcp_catalog_unavailable');
    let revision = snapshot.revision;
    const namedServers = [...snapshot.catalog.servers];
    for (const item of existing) {
      const id = ids[item.key]!;
      const previousIndex = namedServers.findIndex(server => server.id === id);
      const previous = namedServers[previousIndex];
      if (!previous || !('createdAt' in previous)) return refuse('mcp_catalog_unavailable');
      const entry = { ...item.entry, id, name: uniqueMcpServerNameV1(item.entry.name, namedServers.filter(server => server.id !== id)), createdAt: previous.createdAt, updatedAt: input.nowMs() };
      const updated = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.update'].parse(await input.invoke('mcp.servers.update', `update_template_mcp:${item.key}`, {
        expectedRevision: revision, entry,
      }));
      if (updated.status !== 'updated') return refuse('mcp_catalog_unavailable');
      revision = updated.revision;
      namedServers[previousIndex] = entry;
    }
    if (pendingCreate.length) {
      const createdIds: Record<string, string> = {};
      const entries = pendingCreate.map(item => {
        const id = input.randomId(); ids[item.key] = id; createdIds[item.key] = id;
        const nowMs = input.nowMs();
        const entry = { ...item.entry, id, name: uniqueMcpServerNameV1(item.entry.name, namedServers), createdAt: nowMs, updatedAt: nowMs };
        namedServers.push(entry);
        return { entry, where: { kind: 'replace' as const, rules: [] } };
      });
      const created = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.create'].parse(await input.invoke('mcp.servers.create', 'create_template_mcp', { expectedRevision: revision, entries }));
      if (created.status !== 'updated') return refuse('mcp_catalog_unavailable');
      input.onCreated?.(createdIds);
    }
  }
  for (const [key, id] of Object.entries(ids)) {
    const included = SessionCapabilitiesSetOutputV1Schema.parse(await input.invoke('session.capabilities.set', `template_mcp:${key}`, {
      sessionId: input.sessionId, kind: 'mcp_server', id, state: 'on',
    }));
    if (!included.ok) return refuse(included.code);
    input.onIncluded?.(key, id);
  }
  return ids;
}

export const BotTemplateSoftwareFactV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ key: key(), status: z.literal('found'), versions: z.array(z.string()) }),
  z.strictObject({ key: key(), status: z.literal('missing') }),
  z.strictObject({ key: key(), status: z.literal('unknown') }),
]));
export type BotTemplateSoftwareFactV1 = z.infer<typeof BotTemplateSoftwareFactV1Schema>;
/** Consume the pushed Machine observation; absence/unavailability never means missing. */
export function projectBotTemplateSoftwareFactsV1(needs: BotTemplateContentV1['needs']['software'], observation: MachineSetupObservationV1 | null,
  demandedPlan?: MachineSetupPlanResultV1 | null): BotTemplateSoftwareFactV1[] {
  return needs.map(need => {
    const recipe = observation?.recipes.find(entry => sameStrictJsonValue(entry.ref, need.recipe));
    if (recipe?.status === 'satisfied') return { key: need.key, status: 'found', versions: [...new Set(recipe.steps.flatMap(step =>
      step.packages?.flatMap(pkg => pkg.present && pkg.version ? [pkg.version] : []) ?? []))] };
    if (recipe) return { key: need.key, status: recipe.status === 'drifted' ? 'missing' : 'unknown' };
    const planned = demandedPlan?.recipePlans?.find(entry => {
      const item = demandedPlan.sources[entry.sourceIndex]?.setup.items?.[entry.itemIndex];
      return item?.kind === 'softwareRecipe' && sameStrictJsonValue(item.selection.ref, need.recipe);
    });
    if (!planned || !planned.plan.nativeFacts.length) return { key: need.key, status: 'unknown' };
    if (planned.plan.nativeFacts.every(fact => fact.status === 'satisfied')) {
      const versions = planned.plan.nativeFacts.flatMap(fact => Array.isArray(fact.facts.packages)
        ? fact.facts.packages.flatMap(raw => {
          const parsed = MachineRecipePackageObservationV1Schema.safeParse(raw);
          return parsed.success && parsed.data.present && parsed.data.version ? [parsed.data.version] : [];
        }) : []);
      return { key: need.key, status: 'found', versions: [...new Set(versions)] };
    }
    return { key: need.key, status: planned.plan.nativeFacts.some(fact => fact.status === 'drifted')
      && planned.plan.nativeFacts.every(fact => fact.status === 'satisfied' || fact.status === 'drifted') ? 'missing' : 'unknown' };
  });
}
