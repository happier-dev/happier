import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ScmDiffSummaryModelSelectorSchema } from '../../scm/diffSummary.js';
import { readRecord } from '../../inputs/inputRecords.js';
import { readRegistryAgentCliLocatorV1 } from './registries.js';
import { AgentsAcpBackendsInstallFromRegistryInputV1Schema, AgentsAcpBackendsInstallFromRegistryOutputV1Schema } from '../../acp/catalog/registry/registryInstallActionV1.js';
import { AgentsAcpBackendsDeleteInputV1Schema, AgentsAcpBackendsDeleteOutputV1Schema, AgentsAcpBackendsGetInputV1Schema, AgentsAcpBackendsGetOutputV1Schema, AgentsAcpBackendsUpsertInputV1Schema, AgentsAcpBackendsUpsertOutputV1Schema } from '../../acp/catalog/catalogMutationsV1.js';
import { z } from 'zod/mini';
import { MachinesAgentsSignInStartInputSchema, MachinesAgentsSignInStartOutputSchema, MachinesAgentsSignInStatusInputSchema, AgentSignInStatusResponseSchema, MachinesAgentsSignInCancelInputSchema, MachinesAgentsSignInCancelOutputSchema } from '../../daemon/agentSignIn.js';
import { MachinesAgentsListInputSchema, MachinesAgentsListOutputSchema } from '../../capabilities/machineAgentInventory.js';
import { DaemonAgentInstallStartRequestSchema, DaemonAgentInstallStartResponseSchema, DaemonAgentInstallReadRequestSchema, DaemonAgentInstallReadResponseSchema, DaemonAgentInstallCancelRequestSchema, DaemonAgentInstallCancelResponseSchema } from '../../daemon/agentInstallJobs.js';
import { AcpBackendApprovalInputSchema, projectAcpBackendApprovalInput } from './acpBackendApproval.js';
import { AgentsBackendsListOutputSchema } from '../agentBackendInventory.js';
import { BackendTargetKeySchema } from '../../backends/targets/backendTargetRef.js';
import { BackendTargetKeyV2Schema } from '../../backends/targets/backendTargetRefV2.js';
import { ConnectedServiceBindingsV2IngressSchema } from '../../connect/connectedServiceBindings.js';
import { AgentModelsProbeObservationSchema, AgentSessionModesProbeObservationSchema, AgentConfigOptionsProbeObservationSchema } from '../../capabilities/agentProbeObservation.js';
import { ProbedCatalogOptionValueSchema } from '../../capabilities/probedCatalogOption.js';
import { NonBlankOpaqueIdentifierSchema } from '../../strings/opaqueIdentifier.js';
import { ScmDiffSummaryModelCatalogObservationV1Schema } from '../settings/scmDiffSummarySettings.js';
import { SessionMcpSelectionV1Schema } from '../../mcp/servers/sessionSelectionV1.js';
import { RuntimeDescriptorV1Schema } from '../../sessions/metadata/runtimeDescriptorV1.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { validateAgentIdAndBackendTargetKeySelection } from './session/messages.js';
import type { PreNormalizedActionSpec } from './definition.js';


export const MachineAgentInstallCliInputSchema = lazyZodSchema(() => z.strictObject({
  machineId: z.optional(z.string().check(z.minLength(1))), agentId: z.string().check(z.minLength(1)), definitionId: z.optional(z.string().check(z.minLength(1))),
  intent: z.optional(z.enum(['install', 'update'])), consent: z.optional(DaemonAgentInstallStartRequestSchema.shape.consent),
  force: z.optional(z.boolean()), yes: z.optional(z.boolean()), allowVendorRecipe: z.optional(z.boolean()), dryRun: z.optional(z.boolean()),
  version: z.optional(z.string().check(z.minLength(1))),
}));

/**
 * `machineId` scopes the answer to the installed/external Agents one machine's
 * daemon projection admits. The executor forwards it to the host inventory
 * owner, so it is part of this canonical contract rather than passthrough
 * residue: an input the schema does not name is a contract the schema lies
 * about.
 */
export const AgentsBackendsListInputSchema = lazyZodSchema(() => z.looseObject({
  includeDisabled: z.optional(z.boolean()),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(200))),
  machineId: z.optional(z.string().check(z.minLength(1))),
}));

export const AgentInventoryProbeInputSchema = lazyZodSchema(() => z.strictObject({
  cwd: z.optional(z.string().check(z.trim(), z.minLength(1))),
  timeoutMs: z.optional(z.number().check(z.positive())),
  transportTimeoutMs: z.optional(z.number().check(z.positive())),
  bypassCache: z.optional(z.boolean()),
  profileId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  runtimeDescriptorV1: z.optional(RuntimeDescriptorV1Schema),
  connectedServices: z.optional(ConnectedServiceBindingsV2IngressSchema),
  configOptionOverrides: z.optional(z.record(NonBlankOpaqueIdentifierSchema, ProbedCatalogOptionValueSchema)),
}));
export type AgentInventoryProbeInput = z.output<typeof AgentInventoryProbeInputSchema>;

export function inventoryOutputWithProbeObservation(observationSchema: z.ZodMiniType) {
  return lazyZodSchema(() => StrictJsonValueSchema.check(z.superRefine((value, ctx) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'probeObservation')) return;
    const rawObservation: unknown = Reflect.get(value, 'probeObservation');
    const observation = observationSchema.safeParse(rawObservation);
    if (!observation.success) for (const issue of observation.error.issues) {
      ctx.addIssue({ ...issue, path: ['probeObservation', ...issue.path] });
    }
  })));
}

export const AgentsModelsListInputSchema = lazyZodSchema(() => z.strictObject({
  purpose: z.optional(z.literal('scm_diff_summary')),
  discoveryTargetKey: z.optional(BackendTargetKeyV2Schema),
  modelSelector: z.optional(ScmDiffSummaryModelSelectorSchema),
  agentId: z.optional(z.string().check(z.minLength(1))),
  backendTargetKey: z.optional(z.union([BackendTargetKeySchema, BackendTargetKeyV2Schema])),
  machineId: z.optional(z.string().check(z.minLength(1))),
  // Home routing is bound by the authenticated host, never authored inventory input.
  serverId: z.optional(z.never()),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(200))),
  probe: z.optional(AgentInventoryProbeInputSchema),
}).check(z.superRefine((value, ctx) => {
  if (value.purpose === 'scm_diff_summary') {
    if (!value.machineId || value.agentId || value.backendTargetKey || value.probe || value.limit !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'Summary catalog requires only an exact machine target', path: ['machineId'] });
    }
    return;
  }
  if (value.discoveryTargetKey || value.modelSelector) ctx.addIssue({ code: 'custom', message: 'Summary catalog purpose is required', path: ['purpose'] });
  if (!value.agentId && !value.backendTargetKey) {
    ctx.addIssue({
      code: "custom",
      message: 'agentId or backendTargetKey is required',
      path: ['agentId'],
    });
  }
  validateAgentIdAndBackendTargetKeySelection(value, ctx);
})));

export const AgentSpawnOptionsListInputBaseSchema = lazyZodSchema(() => z.object({
  agentId: z.optional(z.string().check(z.minLength(1))),
  backendTargetKey: z.optional(z.union([BackendTargetKeySchema, BackendTargetKeyV2Schema])),
  machineId: z.optional(z.string().check(z.minLength(1))),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(200))),
}));

export const AgentSpawnOptionsListInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AgentSpawnOptionsListInputBaseSchema, {
  serverId: z.optional(z.never()),
  probe: z.optional(AgentInventoryProbeInputSchema),
})).check(z.superRefine((value, ctx) => {
  if (!value.agentId && !value.backendTargetKey) {
    ctx.addIssue({
      code: "custom",
      message: 'agentId or backendTargetKey is required',
      path: ['agentId'],
    });
  }
  validateAgentIdAndBackendTargetKeySelection(value, ctx);
})));

/**
 * `sessions.spawn.profiles.list` is the one spawn-option source whose agent
 * scope is a FILTER, not a requirement.
 *
 * Models, config options and session modes cannot be enumerated without knowing
 * whose they are, so the shared schema demands an agent. A Launch Profile is the
 * other way round: `LaunchProfileListItemV1.supportedAgentIds` rides every row,
 * so an unscoped list loses no information, and a caller that selects a profile
 * FIRST — a Triage action does exactly that, and the profile then supplies the
 * agent — has no agent to scope by. Requiring one made that read fail input
 * validation, which the caller could only observe as "the catalog did not
 * answer": the selector stayed empty and every profile-configured press refused
 * forever.
 *
 * A contradictory pair is still refused, because half an agent scope is not a
 * weaker filter.
 */
export const SpawnProfilesListInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(AgentSpawnOptionsListInputBaseSchema).check(z.superRefine((value, ctx) => {
    validateAgentIdAndBackendTargetKeySelection(value, ctx);
  })));

export const AgentsConfigOptionsListInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AgentSpawnOptionsListInputBaseSchema, {
  modelId: z.optional(z.string().check(z.minLength(1))),
  serverId: z.optional(z.never()),
  probe: z.optional(AgentInventoryProbeInputSchema),
})).check(z.superRefine((value, ctx) => {
  if (!value.agentId && !value.backendTargetKey) {
    ctx.addIssue({
      code: "custom",
      message: 'agentId or backendTargetKey is required',
      path: ['agentId'],
    });
  }
  validateAgentIdAndBackendTargetKeySelection(value, ctx);
})));

export const SpawnConnectedServicesListInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(AgentSpawnOptionsListInputBaseSchema, {
  includeUnavailable: z.optional(z.boolean()),
  serverId: z.optional(z.never()),
})).check(z.superRefine((value, ctx) => {
  if (!value.agentId && !value.backendTargetKey) {
    ctx.addIssue({
      code: "custom",
      message: 'agentId or backendTargetKey is required',
      path: ['agentId'],
    });
  }
  validateAgentIdAndBackendTargetKeySelection(value, ctx);
})));

export const SpawnMcpServersPreviewInputSchema = lazyZodSchema(() => z.looseObject({
  agentId: z.optional(z.string().check(z.minLength(1))),
  backendTargetKey: z.optional(z.union([BackendTargetKeySchema, BackendTargetKeyV2Schema])),
  machineId: z.optional(z.string().check(z.minLength(1))),
  directory: z.optional(z.string().check(z.minLength(1))),
  path: z.optional(z.string().check(z.minLength(1))),
  selection: z.optional(SessionMcpSelectionV1Schema),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(200))),
}).check(z.superRefine((value, ctx) => {
  if (!value.agentId && !value.backendTargetKey) {
    ctx.addIssue({
      code: "custom",
      message: 'agentId or backendTargetKey is required',
      path: ['agentId'],
    });
  }
  validateAgentIdAndBackendTargetKeySelection(value, ctx);
})));

export const AGENT_CATALOG_ACTION_SPECS = Object.freeze([
  {
    id: 'machines.agents.signIn.start', executionPlacement: 'machine', approval: {result: 'none'}, approvalPolicy: { uiConfirmation: 'direct' },
    title: 'Sign in to an agent',
    description: 'Connect an accepted account, or open the agent native login on the selected machine.',
    sideEffectClass: 'write', safety: 'danger', placements: [],
    bindings: { mcpToolName: 'machines_agents_sign_in_start', voiceClientToolName: 'machines_agents_sign_in_start' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: MachinesAgentsSignInStartInputSchema,
    outputSchema: MachinesAgentsSignInStartOutputSchema,
    inputHints: { title: 'Sign in to an agent', fields: [
      { path: 'machineId', title: 'Machine id', widget: 'text' },
      { path: 'agentId', title: 'Agent id', widget: 'text' },
      { path: 'method', title: 'Method (connected or native)', widget: 'text' },
      { path: 'serviceId', title: 'Connected service id', widget: 'text' },
    ] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'machines.agents.signIn.status', executionPlacement: 'machine', approval: {result: 'none'},
    title: 'Check agent sign-in', sideEffectClass: 'read', safety: 'safe', placements: [],
    bindings: { mcpToolName: 'machines_agents_sign_in_status', voiceClientToolName: 'machines_agents_sign_in_status' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: MachinesAgentsSignInStatusInputSchema, outputSchema: AgentSignInStatusResponseSchema,
    inputHints: { description: 'See whether an agent is signed in on a machine, or still waiting for you to finish.', title: 'Check agent sign-in', fields: [
      { path: 'machineId', title: 'Machine id', widget: 'text' },
      { path: 'agentId', title: 'Agent id', widget: 'text' },
    ] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'machines.agents.signIn.cancel', executionPlacement: 'machine', approval: {result: 'none'}, approvalPolicy: { uiConfirmation: 'direct' },
    title: 'Cancel agent sign-in', sideEffectClass: 'write', safety: 'danger', placements: [],
    bindings: { mcpToolName: 'machines_agents_sign_in_cancel', voiceClientToolName: 'machines_agents_sign_in_cancel' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: MachinesAgentsSignInCancelInputSchema, outputSchema: MachinesAgentsSignInCancelOutputSchema,
    inputHints: { description: 'Stop an agent sign-in that is still waiting.', fields: [
      { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
      { path: 'agentId', title: 'Agent id', widget: 'text', required: true },
      { path: 'terminalId', title: 'Native sign-in terminal id', widget: 'text', required: true },
    ] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'machines.agents.signIn.restart', executionPlacement: 'machine', approval: {result: 'none'}, approvalPolicy: { uiConfirmation: 'direct' },
    title: 'Restart agent sign-in', sideEffectClass: 'write', safety: 'danger', placements: [],
    bindings: { mcpToolName: 'machines_agents_sign_in_restart', voiceClientToolName: 'machines_agents_sign_in_restart' },
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: MachinesAgentsSignInCancelInputSchema, outputSchema: MachinesAgentsSignInStartOutputSchema,
    inputHints: { description: 'Start an agent sign-in over when it stalled or expired.', fields: [
      { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
      { path: 'agentId', title: 'Agent id', widget: 'text', required: true },
      { path: 'terminalId', title: 'Native sign-in terminal id', widget: 'text', required: true },
    ] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'machines.agents.install', executionPlacement: 'machine', approval: {result: 'required'}, approvalPolicy: { uiConfirmation: 'policy' },
    confirmVerb: { key: 'common.install', fallback: 'Install' },
    title: 'Install or update an agent',
    sideEffectClass: 'danger',
    description: 'Start a daemon-owned agent install or update job.',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'machines_agents_install', sdkMethod: 'machines.agents.install.start' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: lazyZodSchema(() => z.extend(z.omit(DaemonAgentInstallStartRequestSchema, { expectedDefinitionVersion: true }), {
      machineId: z.string().check(z.minLength(1)),
      intent: z.enum(['install', 'update']),
      consent: z.optional(DaemonAgentInstallStartRequestSchema.shape.consent),
    })),
    outputSchema: DaemonAgentInstallStartResponseSchema,
    cli: { acceptsServerId: true, inputSchema: MachineAgentInstallCliInputSchema,
      flagAliases: [{ path: 'machineId', aliases: ['--machine'] }],
      bindInput: (raw, context) => {
        const { yes, allowVendorRecipe, dryRun: _dryRun, version: _version, ...input } = readRecord(raw);
        return { ...input, intent: context.commandPath?.[1] === 'update' ? 'update' : input.intent ?? 'install',
          ...(yes || allowVendorRecipe ? { consent: { vendorRecipe: true } } : {}) };
      },
      commands: [
        { path: ['agents', 'install'], positionals: ['agentId'], visibility: 'canonical' },
        { path: ['agents', 'update'], positionals: ['agentId'], visibility: 'alias' },
        { path: ['install', 'provider'], positionals: ['agentId'], visibility: 'alias' },
      ] },
    inputHints: {
      title: 'Install or update an agent',
      fields: [
        { path: 'machineId', title: 'Machine', widget: 'text' },
        { path: 'agentId', title: 'Agent', widget: 'text' },
        { path: 'definitionId', title: 'Custom agent', widget: 'text' },
        { path: 'intent', title: 'Intent', widget: 'text' },
        { path: 'consent.vendorRecipe', title: 'Allow the vendor install recipe', widget: 'boolean' },
        { path: 'force', title: 'Reinstall an installed agent', widget: 'boolean' },
      ],
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'machines.agents.uninstall', approval: { result: 'required' }, approvalPolicy: { uiConfirmation: 'policy' },
    confirmVerb: { key: 'settingsPlugins.uninstall', fallback: 'Uninstall' },
    title: 'Remove an agent from a machine',
    sideEffectClass: 'danger', description: 'Remove a Happier-managed agent installation through the daemon job owner.',
    safety: 'danger', executionPlacement: 'machine', placements: [],
    bindings: { mcpToolName: 'machines_agents_uninstall' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: lazyZodSchema(() => z.strictObject({ machineId: z.string().check(z.minLength(1)), agentId: z.string().check(z.minLength(1)),
      definitionId: z.optional(z.string().check(z.minLength(1))) })),
    outputSchema: DaemonAgentInstallStartResponseSchema,
    cli: { acceptsServerId: true, inputSchema: lazyZodSchema(() => z.strictObject({ machineId: z.optional(z.string().check(z.minLength(1))),
      agentId: z.string().check(z.minLength(1)), definitionId: z.optional(z.string().check(z.minLength(1))) })),
      flagAliases: [{ path: 'machineId', aliases: ['--machine'] }],
      commands: [{ path: ['agents', 'remove'], positionals: ['agentId'], visibility: 'canonical' }] },
    inputHints: { title: 'Remove an agent from a machine', fields: [
      { path: 'machineId', title: 'Machine', widget: 'text', required: true },
      { path: 'agentId', title: 'Agent', widget: 'text', required: true },
      { path: 'definitionId', title: 'Custom agent', widget: 'text' },
    ] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'machines.agents.install.status', executionPlacement: 'machine', approval: {result: 'required'},
    title: 'Read an agent install job',
    description: 'Read the daemon-owned current steps, byte progress, and outcome alongside events after the cursor. Omitting the cursor reads events from the start.',
    sideEffectClass: 'read',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'machines_agents_install_status' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: lazyZodSchema(() => z.extend(DaemonAgentInstallReadRequestSchema, {
      machineId: z.string().check(z.minLength(1)), cursor: z.optional(DaemonAgentInstallReadRequestSchema.shape.cursor),
    })),
    outputSchema: DaemonAgentInstallReadResponseSchema,
    cli: { acceptsServerId: true, inputSchema: lazyZodSchema(() => z.strictObject({ machineId: z.optional(z.string().check(z.minLength(1))),
      jobId: z.string().check(z.minLength(1)), cursor: z.optional(z.number().check(z.int(), z.nonnegative())) })),
      flagAliases: [{ path: 'machineId', aliases: ['--machine'] }],
      commands: [{ path: ['agents', 'install', 'status'], positionals: ['jobId'], visibility: 'canonical' }] },
    inputHints: { title: 'Read an agent install job', fields: [
      { path: 'machineId', title: 'Machine id', widget: 'text' },
      { path: 'jobId', title: 'Job id', widget: 'text' },
      { path: 'cursor', title: 'Event cursor', widget: 'text' },
    ] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'machines.agents.install.cancel', executionPlacement: 'machine', approval: {result: 'required'}, approvalPolicy: { uiConfirmation: 'direct' },
    title: 'Cancel agent install',
    sideEffectClass: 'danger',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'machines_agents_install_cancel' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: lazyZodSchema(() => z.extend(DaemonAgentInstallCancelRequestSchema, { machineId: z.string().check(z.minLength(1)) })),
    outputSchema: DaemonAgentInstallCancelResponseSchema,
    cli: { acceptsServerId: true, inputSchema: lazyZodSchema(() => z.strictObject({ machineId: z.optional(z.string().check(z.minLength(1))),
      jobId: z.string().check(z.minLength(1)) })), flagAliases: [{ path: 'machineId', aliases: ['--machine'] }],
      commands: [{ path: ['agents', 'install', 'cancel'], positionals: ['jobId'], visibility: 'canonical' }] },
    inputHints: { description: 'Stop installing an agent on a machine.', title: 'Cancel agent install', fields: [
      { path: 'machineId', title: 'Machine', widget: 'text' },
      { path: 'jobId', title: 'Install job', widget: 'text' },
    ] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'agents.models.list', executionPlacement: 'machine', approval: {result: 'required'},
    title: 'List agent models',
    sideEffectClass: 'read',
    description: 'List available models for an agent backend. Omit serverId; the authenticated host binds the Home.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listAgentModels', mcpToolName: 'agents_models_list' },
    examples: {
      voice: { argsExample: '{"agentId":"claude","backendTargetKey":"backend:plugin-review-bot","machineId":"{{machineId}}","limit":10}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List agent models',
      fields: [
        { path: 'agentId', title: 'Runtime agent id', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'machineId', title: 'Machine id (optional)', widget: 'text' },
        { path: 'limit', title: 'Max results', widget: 'text' },
      ],
    },
    inputSchema: AgentsModelsListInputSchema,
    outputSchema: lazyZodSchema(() => inventoryOutputWithProbeObservation(AgentModelsProbeObservationSchema).check(z.superRefine((value, ctx) => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'scmDiffSummaryCatalog')) return;
      const catalog = ScmDiffSummaryModelCatalogObservationV1Schema.safeParse(Reflect.get(value, 'scmDiffSummaryCatalog'));
      if (!catalog.success) for (const issue of catalog.error.issues) ctx.addIssue({ ...issue, path: ['scmDiffSummaryCatalog', ...issue.path] });
    }))),
  } satisfies PreNormalizedActionSpec,
  {
    id: 'agents.config_options.list', executionPlacement: 'machine', approval: {result: 'required'},
    title: 'List agent config options',
    sideEffectClass: 'read',
    description: 'List configurable option definitions for an agent backend without exposing current values. Supply modelId to include that model’s declared options and allowed values alongside session-wide options. Omit serverId; the authenticated host binds the Home.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listAgentConfigOptions', mcpToolName: 'agents_config_options_list' },
    examples: {
      voice: { argsExample: '{"agentId":"claude","backendTargetKey":"agent:happier.agent.claude/claude","machineId":"{{machineId}}","limit":10}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List agent config options',
      fields: [
        { path: 'agentId', title: 'Runtime agent id', description: 'For an external Agent, retain the runtime agentId returned by backend inventory alongside its qualified backendTargetKey.', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'modelId', title: 'Model id', widget: 'text' },
        { path: 'machineId', title: 'Machine id (optional)', widget: 'text' },
        { path: 'limit', title: 'Max results', widget: 'text' },
      ],
    },
    inputSchema: AgentsConfigOptionsListInputSchema,
    outputSchema: lazyZodSchema(() => inventoryOutputWithProbeObservation(AgentConfigOptionsProbeObservationSchema)),
  } satisfies PreNormalizedActionSpec,
  {
    id: 'agents.session_modes.list', executionPlacement: 'machine', approval: {result: 'required'},
    title: 'List agent session modes',
    sideEffectClass: 'read',
    description: 'List session modes available for an agent backend. Omit serverId; the authenticated host binds the Home.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'listAgentSessionModes', mcpToolName: 'agents_session_modes_list' },
    examples: {
      voice: { argsExample: '{"agentId":"codex","backendTargetKey":"agent:happier.agent.codex/codex","machineId":"{{machineId}}","limit":10}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List agent session modes',
      fields: [
        { path: 'agentId', title: 'Runtime agent id', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'machineId', title: 'Machine id (optional)', widget: 'text' },
        { path: 'limit', title: 'Max results', widget: 'text' },
      ],
    },
    inputSchema: AgentSpawnOptionsListInputSchema,
    outputSchema: lazyZodSchema(() => inventoryOutputWithProbeObservation(AgentSessionModesProbeObservationSchema)),
  } satisfies PreNormalizedActionSpec,
  {
    id: 'sessions.spawn.profiles.list', executionPlacement: 'machine', approval: {result: 'required'},
    title: 'List spawn profiles',
    sideEffectClass: 'read',
    description: 'List Agent launch profile references available for new sessions without exposing secret bindings.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listSpawnProfiles', mcpToolName: 'sessions_spawn_profiles_list' },
    examples: {
      voice: { argsExample: '{"agentId":"codex","backendTargetKey":"agent:happier.agent.codex/codex","limit":10}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List spawn profiles',
      fields: [
        { path: 'agentId', title: 'Runtime agent id (optional filter)', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key (optional filter)', widget: 'text' },
        { path: 'limit', title: 'Max results', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SpawnProfilesListInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'sessions.spawn.connected_services.list', executionPlacement: 'machine', approval: {result: 'required'},
    title: 'List spawn connected services',
    sideEffectClass: 'read',
    description: 'List connected-service references available for new sessions without exposing credentials. Omit serverId; the authenticated host binds the Home.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listSpawnConnectedServices', mcpToolName: 'sessions_spawn_connected_services_list' },
    examples: {
      voice: { argsExample: '{"agentId":"codex","backendTargetKey":"agent:happier.agent.codex/codex","includeUnavailable":false}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List spawn connected services',
      fields: [
        { path: 'agentId', title: 'Runtime agent id', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'machineId', title: 'Machine id (optional)', widget: 'text' },
        { path: 'includeUnavailable', title: 'Include unavailable', widget: 'boolean' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SpawnConnectedServicesListInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'sessions.spawn.mcp_servers.preview', executionPlacement: 'machine', approval: {result: 'required'},
    title: 'Preview spawn MCP servers',
    sideEffectClass: 'read',
    description: 'Preview MCP servers that would be available to a new session.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'previewSpawnMcpServers', mcpToolName: 'sessions_spawn_mcp_servers_preview' },
    examples: {
      voice: { argsExample: '{"agentId":"codex","machineId":"{{machineId}}","directory":"{{path}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'Preview spawn MCP servers',
      fields: [
        { path: 'agentId', title: 'Runtime agent id', widget: 'text' },
        { path: 'backendTargetKey', title: 'Backend target key', widget: 'text' },
        { path: 'machineId', title: 'Machine id', widget: 'text' },
        { path: 'directory', title: 'Directory', widget: 'text' },
        { path: 'path', title: 'Path', widget: 'text' },
        { path: 'selection', title: 'Selection', widget: 'json' },
        { path: 'limit', title: 'Max results', widget: 'text' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: SpawnMcpServersPreviewInputSchema,
  } satisfies PreNormalizedActionSpec,
] as const);


export const AGENT_INVENTORY_ACTION_SPECS = Object.freeze([
  {
    id: 'agents.backends.list', executionPlacement: 'machine', approval: {result: 'required'},
    title: 'List agent backends',
    sideEffectClass: 'read',
    description: 'List available Agent backends for spawning sessions.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'listAgentBackends', mcpToolName: 'agents_backends_list' },
    examples: {
      voice: { argsExample: '{"includeDisabled":false,"limit":10,"machineId":"{{machineId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
      },
    inputHints: {
      title: 'List agent backends',
      fields: [
        { path: 'includeDisabled', title: 'Include disabled', widget: 'boolean' },
        { path: 'limit', title: 'Max results', widget: 'text' },
        { path: 'machineId', title: 'Machine id (optional)', widget: 'text' },
      ],
    },
    outputSchema: AgentsBackendsListOutputSchema,
    inputSchema: AgentsBackendsListInputSchema,
    cli: { acceptsServerId: true, commands: [{ path: ['agents', 'backends', 'list'], visibility: 'canonical' }] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'machines.agents.list', executionPlacement: 'machine', approval: {result: 'required'},
    title: 'List agents on a machine',
    sideEffectClass: 'read',
    description: 'Read daemon-owned Agent installation, sign-in, platform and update facts for a machine.',
    safety: 'safe',
    placements: [],
    bindings: { mcpToolName: 'machines_agents_list' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    cli: { acceptsServerId: true, commands: [{ path: ['machines', 'agents', 'list'], visibility: 'canonical' }] },
    inputHints: {
      title: 'List agents on a machine',
      fields: [
        { path: 'machineId', title: 'Machine id', widget: 'text' },
        { path: 'serverId', title: 'Home id (optional)', widget: 'text' },
        { path: 'agentId', title: 'Agent id (optional)', widget: 'text' },
        { path: 'refresh', title: 'Refresh inventory', widget: 'boolean' },
      ],
    },
    inputSchema: MachinesAgentsListInputSchema,
    outputSchema: MachinesAgentsListOutputSchema,
  } satisfies PreNormalizedActionSpec,
] as const);


export const ACP_BACKEND_ACTION_SPECS = Object.freeze([
  {
    id: 'agents.acp.backends.installFromRegistry',
    approval: { result: 'required' }, approvalPolicy: { uiConfirmation: 'policy' },
    title: 'Install registry ACP agent',
    description: 'Add or update a pinned registry agent and optionally install it on the selected machines.',
    safety: 'danger', sideEffectClass: 'write', executionPlacement: 'account', requiredAuthority: 'account_automation',
    placements: [], bindings: { mcpToolName: 'agents_acp_backends_install_from_registry' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: AgentsAcpBackendsInstallFromRegistryInputV1Schema,
    outputSchema: AgentsAcpBackendsInstallFromRegistryOutputV1Schema,
    inputHints: { title: 'Install registry ACP agent', fields: [
      { path: 'fromRegistry.sourceId', title: 'Registry source', widget: 'text', required: true },
      { path: 'fromRegistry.itemId', title: 'Agent id', widget: 'text', required: true },
      { path: 'fromRegistry.version', title: 'Version', widget: 'text', required: true },
      { path: 'installOn', title: 'Install on machines', widget: 'text_list', listSeparator: 'comma' },
    ] },
    cli: { acceptsServerId: true,
      inputSchema: lazyZodSchema(() => z.strictObject({ registryItem: z.optional(z.string().check(z.minLength(1))), version: z.optional(z.string().check(z.minLength(1))),
        install: z.optional(z.enum(['now', 'first-use'])), machine: z.optional(z.array(z.string().check(z.minLength(1)))),
        fromRegistry: z.optional(AgentsAcpBackendsInstallFromRegistryInputV1Schema.shape.fromRegistry),
        installOn: AgentsAcpBackendsInstallFromRegistryInputV1Schema.shape.installOn,
        command: z.optional(z.string().check(z.minLength(1))), name: z.optional(z.string().check(z.minLength(1))), title: z.optional(z.string().check(z.minLength(1))),
        args: z.optional(z.array(z.string())), dryRun: z.optional(z.boolean()) })),
      bindInput: raw => {
        const input = readRecord(raw);
        const locator = typeof input.registryItem === 'string' ? input.registryItem : '';
        return { fromRegistry: input.fromRegistry ?? { ...readRegistryAgentCliLocatorV1(locator), version: input.version },
          ...(input.install === 'first-use' ? {} : input.installOn || input.machine ? { installOn: input.installOn ?? input.machine } : {}) };
      },
      commands: [{ path: ['agents', 'acp', 'backends', 'install-from-registry'], visibility: 'canonical' },
        { path: ['agents', 'add'], positionals: ['registryItem'], visibility: 'alias' }] },
    projectObservationInput: input => {
      const parsed = AgentsAcpBackendsInstallFromRegistryInputV1Schema.safeParse(input);
      return parsed.success ? { fromRegistry: parsed.data.fromRegistry,
        ...(parsed.data.installOn === undefined ? {} : { installOn: parsed.data.installOn }) } : undefined;
    },
    projectObservationOutput: output => {
      const parsed = AgentsAcpBackendsInstallFromRegistryOutputV1Schema.safeParse(output);
      return parsed.success ? { definitionId: parsed.data.definition.id, jobs: parsed.data.jobs } : undefined;
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'agents.acp.backends.get', executionPlacement: 'account', approval: {result: 'required'},
    title: 'Read custom ACP agent',
    description: 'Read one full Account-private configured ACP agent definition and its catalog revision.',
    safety: 'safe',
    sideEffectClass: 'read',
    placements: [],
    bindings: { mcpToolName: 'agents_acp_backends_get' },
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    inputSchema: AgentsAcpBackendsGetInputV1Schema,
    outputSchema: AgentsAcpBackendsGetOutputV1Schema,
    cli: { acceptsServerId: true, commands: [{ path: ['agents', 'acp', 'backends', 'get'], positionals: ['backendId'], visibility: 'canonical' }] },
    projectObservationOutput: output => {
      const parsed = AgentsAcpBackendsGetOutputV1Schema.safeParse(output);
      return parsed.success ? { backendId: parsed.data.backend.id, revision: parsed.data.revision } : undefined;
    },
    inputHints: { title: 'Read custom ACP agent', fields: [
      { path: 'backendId', title: 'Id', widget: 'text', required: true },
    ] },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'agents.acp.backends.upsert', executionPlacement: 'account', approval: {result: 'required'}, approvalPolicy: { uiConfirmation: 'direct' },
    title: 'Save custom ACP agent',
    description: 'Add or replace one custom ACP agent (a command that speaks the Agent Client Protocol) in the Account agent catalog. Names must be unique; an existing id is replaced.',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'agents_acp_backends_upsert' },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    outputSchema: AgentsAcpBackendsUpsertOutputV1Schema,
    inputSchema: AgentsAcpBackendsUpsertInputV1Schema,
    approvalPresentation: { summary: () => null, projectInput: projectAcpBackendApprovalInput,
      inputSchema: AcpBackendApprovalInputSchema, retainInputOnSettlement: true },
    cli: { acceptsServerId: true, commands: [{ path: ['agents', 'acp', 'backends', 'upsert'], visibility: 'canonical' }] },
    inputHints: {
      title: 'Save custom ACP agent',
      fields: [
        { path: 'backend.id', title: 'Id', widget: 'text', required: true },
        { path: 'backend.name', title: 'Name', widget: 'text', required: true },
        { path: 'backend.title', title: 'Agent', widget: 'text', required: true },
        { path: 'backend.launch', title: 'Launch', widget: 'json', required: true },
        { path: 'backend.description', title: 'Description', widget: 'textarea' },
        { path: 'backend.env', title: 'Environment variables', widget: 'json' },
        { path: 'backend.auth', title: 'Sign-in', widget: 'json' },
        { path: 'backend.runtime', title: 'Runtime behavior', widget: 'json' },
        { path: 'backend.defaultMode', title: 'Default mode', widget: 'text' },
        { path: 'backend.defaultModel', title: 'Default model', widget: 'text' },
        { path: 'backend.capabilities', title: 'Capabilities', widget: 'json' },
        { path: 'backend.origin', title: 'Source', widget: 'json' },
        { path: 'backend.compatibility', title: 'Compatibility', widget: 'json' },
        { path: 'backend.createdAt', title: 'Created at', widget: 'text' },
        { path: 'backend.updatedAt', title: 'Updated at', widget: 'text' },
        { path: 'dryRun', title: 'Preview only', widget: 'boolean' },
        { path: 'expectedRevision', title: 'Reviewed revision', widget: 'text' },
        { path: 'sourceSettingsVersion', title: 'Reviewed settings version', widget: 'text' },
      ],
    },
  } satisfies PreNormalizedActionSpec,
  {
    id: 'agents.acp.backends.delete', executionPlacement: 'account', approval: {result: 'required'}, approvalPolicy: { uiConfirmation: 'policy' },
    title: 'Delete custom ACP agent',
    description: 'Remove one custom ACP agent from the Account agent catalog.',
    safety: 'danger',
    placements: [],
    bindings: { mcpToolName: 'agents_acp_backends_delete' },
    surfaces: {
      ui: true,
      voice: false,
      agent: true,
      mcp: true,
      cli: true,
      rpc: false,
    },
    outputSchema: AgentsAcpBackendsDeleteOutputV1Schema,
    inputSchema: AgentsAcpBackendsDeleteInputV1Schema,
    cli: { acceptsServerId: true, commands: [{ path: ['agents', 'delete'], positionals: ['backendId'], visibility: 'canonical' },
      { path: ['agents', 'acp', 'backends', 'delete'], positionals: ['backendId'], visibility: 'alias' }] },
    inputHints: {
      title: 'Delete custom ACP agent',
      fields: [
        { path: 'backendId', title: 'Agent', widget: 'text', required: true },
      ],
    },
  } satisfies PreNormalizedActionSpec,
] as const);

