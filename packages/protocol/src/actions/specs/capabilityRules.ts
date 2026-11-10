import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ReachRuleDraftV1Schema, ReachRuleV1Schema } from '../../reach/reachRuleV1.js';
import { McpServerCatalogMutationResponseV1Schema } from '../../mcp/servers/catalogSchemasV1.js';
import { ReachRulesChangeV1Schema } from '../../reach/reachRulesChangeV1.js';
import { readRecord } from '../../inputs/inputRecords.js';
import type { ActionCliBindContext } from '../actionCliProjection.js';
import type { ActionId } from '../actionIds.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';

export { CAPABILITY_RULES_ACTION_IDS_V1 } from '../capabilityRulesActionIdsV1.js';
const identity = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
export const McpRulesSetInputV1Schema = lazyZodSchema(() => z.strictObject({
  items: z.array(z.union([z.strictObject({ serverId: identity }), z.strictObject({ name: identity })])).check(z.minLength(1)),
  change: ReachRulesChangeV1Schema,
  /** Evidence-bound changes compare at the catalog owner before its row CAS. */
  expectedRevision: z.optional(z.number().check(z.int(), z.nonnegative(), z.int())),
}));
export const McpRulesSetItemResultV1Schema = lazyZodSchema(() => McpServerCatalogMutationResponseV1Schema._zod.def.options[0].shape.items._zod.def.innerType._zod.def.element);
export const McpRulesSetOutputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), items: z.array(McpRulesSetItemResultV1Schema),
    revision: z.number().check(z.int(), z.nonnegative()) }),
  z.strictObject({ ok: z.literal(false), code: z.enum(['not_found', 'conflict', 'catalog_unavailable', 'replace_needs_one_item']) }),
]));
export const SkillsRulesSetInputV1Schema = lazyZodSchema(() => z.strictObject({
  items: z.array(z.union([z.strictObject({ skillId: identity }), z.strictObject({ name: identity })])).check(z.minLength(1)),
  change: ReachRulesChangeV1Schema,
}));
export const SkillsRulesSetOutputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), items: z.array(z.strictObject({ skillId: identity,
    rules: z.array(ReachRuleV1Schema), previous: z.array(ReachRuleV1Schema) })),
    revision: z.number().check(z.int(), z.nonnegative()) }),
  z.strictObject({ ok: z.literal(false), code: z.enum(['not_found', 'conflict', 'catalog_unavailable', 'replace_needs_one_item']) }),
]));
const rulesCliInput = lazyZodSchema(() => z.strictObject({
  names: z.optional(z.array(identity)), itemIds: z.optional(z.array(identity)),
  everywhere: z.optional(z.boolean()), machine: z.optional(identity), project: z.optional(identity), folder: z.optional(identity),
  agent: z.optional(identity), rules: z.optional(z.array(ReachRuleDraftV1Schema)),
}));

/** Friendly argv reshaping only; name lookup and mutation belong to the catalog Action. */
function bindRulesCliInput(value: unknown, context: ActionCliBindContext, idField: 'serverId' | 'skillId'): unknown {
  const input = rulesCliInput.parse(value);
  const items = [...(input.names ?? []).map(name => ({ name })), ...(input.itemIds ?? []).map(id => ({ [idField]: id }))];
  const leaf = context.commandPath?.at(-1);
  if (leaf === 'rules' || leaf === 'set') {
    if (input.rules === undefined) throw new Error('Supply the replacement rules with --rules-json.');
    return { items, change: { kind: 'replace', rules: input.rules } };
  }
  const state = leaf === 'bind' ? 'on' : leaf === 'unbind' ? 'inherit' : leaf;
  if (state !== 'on' && state !== 'off' && state !== 'inherit') throw new Error('Choose on, off or inherit.');
  if (input.rules !== undefined) throw new Error('Replacement rules use the rules command.');
  const places = Number(input.everywhere === true) + Number(input.project !== undefined)
    + Number(input.machine !== undefined && input.folder === undefined) + Number(input.folder !== undefined);
  if (places > 1 || (input.folder !== undefined && input.machine === undefined)) throw new Error('Choose one place; --folder requires --machine.');
  const place = input.folder !== undefined ? { t: 'workspace', machineId: input.machine, workspaceRoot: input.folder }
    : input.project !== undefined ? { t: 'project', projectKey: input.project }
      : input.machine !== undefined ? { t: 'machine', machineId: input.machine } : { t: 'allMachines' };
  return { items, change: { kind: 'write', write: { place, state, ...(input.agent ? { agentId: input.agent } : {}) } } };
}

/** Both catalogs declare one rules operation and their own identity/receipt schemas. */
export function createCapabilityRulesActionSpecV1<TId extends ActionId, TInput extends z.ZodMiniType, TOutput extends z.ZodMiniType>(input: Readonly<{
  id: TId; title: string; itemKind: 'mcp' | 'skills'; idField: 'serverId' | 'skillId';
  inputSchema: TInput; outputSchema: TOutput;
}>): PreNormalizedActionSpec & Readonly<{ id: TId; inputSchema: TInput; outputSchema: TOutput }> {
  const commands = [
    { path: [input.itemKind, 'rules', 'set'], visibility: 'canonical' as const },
    ...(['on', 'off', 'inherit', 'rules'] as const).map(leaf => ({
      path: [input.itemKind, leaf], variadicPositional: 'names', visibility: 'canonical' as const,
    })),
    ...(input.itemKind === 'mcp' ? (['bind', 'unbind'] as const).map(leaf => ({
      path: ['mcp', 'servers', leaf], variadicPositional: 'names', visibility: 'alias' as const,
    })) : []),
  ];
  const projectObservation = (raw: unknown) => {
    const value = readRecord(raw);
    return { ...(typeof value.ok === 'boolean' ? { ok: value.ok } : {}),
      ...(typeof value.revision === 'number' ? { revision: value.revision } : {}),
      ...(Array.isArray(value.items) ? { itemIds: value.items.map(item => readRecord(item)[input.idField]).filter(id => typeof id === 'string') } : {}) };
  };
  return {
    id: input.id, title: input.title, safety: 'danger', approval: { result: 'required' },
    approvalPolicy: { uiConfirmation: 'direct' },
    sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'account', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: true },
    bindings: { rpcMethod: input.id, mcpToolName: input.id.replaceAll('.', '_') },
    inputSchema: input.inputSchema, outputSchema: input.outputSchema,
    projectObservationInput: projectObservation, projectObservationOutput: projectObservation,
    // The deciding person reviews the complete rule intent; shared observations
    // retain only identity and receipt fields.
    approvalPresentation: { summary: () => null, projectInput: raw => input.inputSchema.parse(raw), retainInputOnSettlement: true },
    inputHints: { fields: [
      { path: `items.[].${input.idField}`, title: input.itemKind === 'skills' ? 'Skill' : 'MCP server', widget: 'text' },
      { path: 'items.[].name', title: input.itemKind === 'skills' ? 'Skill' : 'MCP server', widget: 'text' },
      { path: 'change.write.place', title: 'Where', widget: 'json' },
      { path: 'change.write.state', title: 'Change', widget: 'select', options: [
        { value: 'on', label: 'Turn on' }, { value: 'off', label: 'Turn off' }, { value: 'inherit', label: 'Use inherited rules' },
      ] },
      { path: 'change.write.agentId', title: 'Agent', widget: 'text' },
      { path: 'change.rules', title: 'Replacement rules', widget: 'json' },
    ] },
    cli: { acceptsServerId: true, commands, inputSchema: rulesCliInput,
      bindInput: (value, context) => bindRulesCliInput(value, context, input.idField),
      flagAliases: [{ path: 'everywhere', aliases: ['--all-machines'] }, ...(input.itemKind === 'mcp' ? [{ path: 'names', aliases: ['--mcp-server'] }] : []),
        { path: 'rules', aliases: ['--rules-json'] }],
      inputHints: { fields: [{ path: 'rules', title: 'Replacement rules', widget: 'json' }] } },
  };
}
function createCapabilityRulesActionSpecsV1() {
  return [createCapabilityRulesActionSpecV1({
  id: 'mcp.rules.set', title: 'Change where MCP servers are on', itemKind: 'mcp', idField: 'serverId',
  inputSchema: McpRulesSetInputV1Schema, outputSchema: McpRulesSetOutputV1Schema,
}), createCapabilityRulesActionSpecV1({
  id: 'skills.rules.set', title: 'Change where skills are on', itemKind: 'skills', idField: 'skillId',
  inputSchema: SkillsRulesSetInputV1Schema, outputSchema: SkillsRulesSetOutputV1Schema,
})] as const;
}

export const CAPABILITY_RULES_ACTION_SPECS_V1: ReturnType<typeof createCapabilityRulesActionSpecsV1> = lazyActionSpecArray(createCapabilityRulesActionSpecsV1);
