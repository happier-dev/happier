import { lazyZodSchema } from '../../lazyZodSchema.js';
import { InputOptionsConsumerV1Schema } from '../../inputs/inputOptionsConsumer.js';
import { z } from 'zod/mini';
import { DaemonProviderModelProjectionResponseV1Schema } from '../../rpc/providers.js';
import { PluginProjectedMachineRecipeEntryV1Schema } from '../../daemon/machineSetupProjection.js';
import { ActionInputOptionSchema } from '../actionInputHints.js';
import { ActionDiscoveryDefinitionSummaryV1Schema, ActionDiscoveryDefinitionV1Schema } from '../actionDefinitionV1.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { WidgetSurfaceRefV1Schema } from '../../widgets/widgetInstanceV1.js';
import { ActionInvokeInputSchema } from '../actionInvokeInput.js';
import type { PreNormalizedActionSpec } from './definition.js';


export const ActionSpecSearchInputSchema = lazyZodSchema(() => z.looseObject({
  query: z.optional(z.string().check(z.trim())),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(100))),
}));

export const ActionSpecSearchCliInputSchema = lazyZodSchema(() => z.strictObject({
  query: z._default(z.array(z.string()), []),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(100))),
}));

export const ActionSpecGetInputSchema = lazyZodSchema(() => z.looseObject({
  id: z.string().check(z.minLength(1)),
  includeOutputSchema: z.optional(z.boolean()),
  schemaPath: z.optional(z.string().check(z.startsWith('/'))),
}));

export const ActionSpecSearchResultSchema = lazyZodSchema(() => z.strictObject({
  actionSpecs: z.array(ActionDiscoveryDefinitionSummaryV1Schema),
}));

export const ActionSpecGetResultSchema = lazyZodSchema(() => z.strictObject({
  actionSpec: ActionDiscoveryDefinitionV1Schema,
  schemaSections: z.optional(z.array(z.strictObject({ path: z.string(), description: z.string() }))),
  schemaSection: z.optional(z.strictObject({ path: z.string(), schema: z.record(z.string(), z.unknown()) })),
  invocationContext: z.optional(z.strictObject({
    sessionId: z.optional(z.string()),
    widgetSurface: z.optional(WidgetSurfaceRefV1Schema),
  })),
}));

export const ActionOptionsResolveInputSchema = lazyZodSchema(() => z.looseObject({
  actionId: z.optional(z.string().check(z.minLength(1))),
  fieldPath: z.optional(z.string().check(z.minLength(1))),
  consumer: z.optional(InputOptionsConsumerV1Schema),
  optionsSourceId: z.optional(z.string().check(z.minLength(1))),
  sessionId: z.optional(z.string().check(z.minLength(1))),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(200))),
  query: z.optional(z.string().check(z.trim())),
  values: z.optional(z.array(StrictJsonValueSchema)),
  draftInput: z.optional(z.record(z.string(), z.unknown())),
}).check(z.superRefine((value, ctx) => {
  const actionId = typeof value.actionId === 'string' ? value.actionId.trim() : '';
  const fieldPath = typeof value.fieldPath === 'string' ? value.fieldPath.trim() : '';
  const optionsSourceId = typeof value.optionsSourceId === 'string' ? value.optionsSourceId.trim() : '';
  if (!optionsSourceId && !(actionId && fieldPath) && !(value.consumer && fieldPath)) {
    ctx.addIssue({
      code: "custom",
      message: 'Provide actionId + fieldPath, consumer + fieldPath, or optionsSourceId',
      path: ['fieldPath'],
    });
  }
})));

export const ActionOptionsResolveResultSchema = lazyZodSchema(() => z.strictObject({
  actionId: z.nullable(z.string().check(z.minLength(1))),
  fieldPath: z.nullable(z.string().check(z.minLength(1))),
  optionsSourceId: z.nullable(z.string().check(z.minLength(1))),
  options: z.readonly(z.array(ActionInputOptionSchema)),
  machineRecipeDetails: z.optional(z.readonly(z.array(PluginProjectedMachineRecipeEntryV1Schema))),
  modelCatalog: z.optional(z.strictObject({
    nativeModels: z.readonly(z.array(z.strictObject({
      value: z.string().check(z.minLength(1)),
      label: ActionInputOptionSchema.shape.label,
      description: ActionInputOptionSchema.shape.description,
    }))),
    providerProjection: z.nullable(DaemonProviderModelProjectionResponseV1Schema._zod.def.options[0]),
  })),
}).check(z.superRefine((value, ctx) => {
  if (value.machineRecipeDetails !== undefined
    && (value.optionsSourceId !== 'machines.setup.software.available'
      || value.machineRecipeDetails.some(entry => entry.definition.software !== true))) {
    ctx.addIssue({ code: 'custom', path: ['machineRecipeDetails'], message: 'Recipe details belong to software selection' });
  }
  if (value.modelCatalog !== undefined
    && (value.actionId !== 'session.spawn_new' || value.fieldPath !== 'modelSelection')) {
    ctx.addIssue({ code: 'custom', path: ['modelCatalog'], message: 'Model catalog belongs to Session spawn model selection' });
  }
})));

export const ACTION_CATALOG_ACTION_SPECS = Object.freeze([
  {
    id: 'action.spec.search', executionPlacement: 'account', toolExposure: { agent: 'direct', mcp: 'direct' }, originalExecution: { accountRoot: 'allowed' }, approval: {result: 'required'},
    title: 'Search action specs',
    sideEffectClass: 'read',
    description: 'Search available Happier action specs by name, description, bindings, and field hints.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'searchActionSpecs', mcpToolName: 'action_spec_search' },
    examples: {
      voice: { argsExample: '{"query":"plan mode","limit":5}' },
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
      title: 'Search action specs',
      description: 'Use this before guessing action ids or tool names.',
      fields: [
        { path: 'query', title: 'Query', description: 'Natural-language search text.', widget: 'text' },
        { path: 'limit', title: 'Limit', description: 'Maximum number of action specs to return.', widget: 'text' },
      ],
    },
    cli: {
      acceptsServerId: true,
      commands: [{
        path: ['actions', 'search'],
        variadicPositional: 'query',
        visibility: 'canonical',
      }],
      inputSchema: ActionSpecSearchCliInputSchema,
      inputHints: {
        title: 'Search action specs',
        description: 'Use this before guessing action ids or tool names.',
        fields: [
          { path: 'query', title: 'Query words', description: 'Natural-language search text.', widget: 'text' },
          { path: 'limit', title: 'Limit', description: 'Maximum number of action specs to return.', widget: 'text' },
        ],
      },
      bindInput: (value) => {
        const parsed = ActionSpecSearchCliInputSchema.parse(value);
        return {
          query: parsed.query.join(' '),
          ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
        };
      },
    },
    outputSchema: ActionSpecSearchResultSchema,
    inputSchema: ActionSpecSearchInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'action.spec.get', executionPlacement: 'account', toolExposure: { agent: 'direct', mcp: 'direct' }, originalExecution: { accountRoot: 'allowed' }, approval: {result: 'required'},
    title: 'Get action spec',
    sideEffectClass: 'read',
    description: 'Get a Happier action spec, hints, examples and invoking Session context. Agent, MCP and CLI results reference named schemaSections: retrieve any section with the same id and schemaPath. Nothing is truncated. Section-local # references resolve against the original inputSchema or outputSchema root. Set includeOutputSchema:true for outputs. UI/API keep full schemas. Session Board actions fill omitted sessionId from the invoking Session; widget Actions require a qualified surface: use invocationContext.widgetSurface for this Session Board, changing only owner to {kind:"home"} for Home. Never guess serverId/accountId.',
    safety: 'safe',
    placements: ['voice_panel'],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'getActionSpec', mcpToolName: 'action_spec_get' },
    examples: {
      voice: { argsExample: '{"id":"subagents.plan.start"}' },
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
      title: 'Get action spec',
      fields: [
        { path: 'id', title: 'Action id', description: 'The exact Happier action id.', widget: 'text', required: true },
        { path: 'includeOutputSchema', title: 'Include output schema', description: 'Include the complete output schema. Defaults to false for Agent, MCP and CLI discovery; true on other surfaces.', widget: 'boolean' },
        { path: 'schemaPath', title: 'Schema section', description: 'Read a schemaSections path from the same Action. JSON Pointer into the original inputSchema/outputSchema; named definitions are complete and local references keep their original root.', widget: 'text' },
      ],
    },
    cli: {
      acceptsServerId: true,
      commands: [{
        path: ['actions', 'get'],
        positionals: ['id'],
        visibility: 'canonical',
      }],
    },
    outputSchema: ActionSpecGetResultSchema,
    inputSchema: ActionSpecGetInputSchema,
  } satisfies PreNormalizedActionSpec,
] as const);


export const ACTION_OPTIONS_ACTION_SPECS = Object.freeze([
  {
    id: 'action.options.resolve', executionPlacement: 'machine', toolExposure: { agent: 'direct', mcp: 'direct' }, approval: {result: 'required'},
    title: 'Resolve action options',
    sideEffectClass: 'read',
    description: 'Resolve valid options for one Action field or one declared workflow/widget input. Provide actionId and fieldPath, consumer and fieldPath, or a direct optionsSourceId. A consumer always requires fieldPath.',
    safety: 'safe',
    placements: ['voice_panel'],
    bindings: { voiceClientToolName: 'resolveActionOptions', mcpToolName: 'action_options_resolve', rpcMethod: 'action.options.resolve' },
    examples: {
      voice: { argsExample: '{"actionId":"subagents.plan.start","fieldPath":"backendTargetKeys","sessionId":"{{sessionId}}"}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    inputHints: {
      title: 'Resolve action options',
      description: 'Resolve choices for a specific input with static options, an optionsSourceId, or an input type. For a workflow consumer, fieldPath is the declared input name; it is not the inputs container.',
      fields: [
        { path: 'actionId', title: 'Action id', description: 'Optional when consumer or optionsSourceId is provided directly.', widget: 'text' },
        { path: 'consumer', title: 'Input consumer', description: 'The schema-defined workflow or widget consumer reference. Workflow consumers identify kind workflow and a workflow reference; supply that workflow input name in fieldPath.', widget: 'json' },
        { path: 'fieldPath', title: 'Field path', description: 'Required with actionId or consumer. Use the Action input dot-path, or the declared workflow input name without an inputs prefix. A known workflow with an unknown name returns availableFields in its refusal details.', widget: 'text' },
        { path: 'optionsSourceId', title: 'Options source id', description: 'Direct options source lookup when known.', widget: 'text' },
        { path: 'sessionId', title: 'Session id', prompt: 'Which session?', description: 'Omit to use the current invoking Session. Set only for an intentional authorized cross-Session target.', widget: 'text' },
        { path: 'draftInput', title: 'Partial action input', description: 'Dependent inventory context: for execution.run.start use {"backendTargetKey":"<backend option.value>"} for model, config, or connected-service choices; backendTarget alone does not select an inventory. Ergonomic multi-backend starts use backendTargetKeys. Session spawn uses its agentTarget and executionTarget objects.', widget: 'json' },
        { path: 'query', title: 'Query filter', description: 'Optional search text to filter the returned options.', widget: 'text' },
        { path: 'limit', title: 'Limit', description: 'Maximum number of options to return.', widget: 'text' },
        { path: 'values', title: 'Values', description: 'Return only the options for these values, to check a picked value without reading the whole inventory. A source that can answer directly does; any other is read in full and narrowed.', widget: 'json' },
      ],
    },
    outputSchema: ActionOptionsResolveResultSchema,
    inputSchema: ActionOptionsResolveInputSchema,
  } satisfies PreNormalizedActionSpec,
  {
    id: 'action.invoke', executionPlacement: 'machine', approval: {result: 'required'},
    title: 'Invoke contributed action',
    description: 'Invoke one currently available contributed Action through the canonical host dispatcher. If the result is `denied`, the person declined the confirmation: report that and do not invoke it again unless they ask.',
    sideEffectClass: 'external',
    safety: 'safe',
    placements: [],
    prompting: { voiceHotPath: true },
    bindings: { voiceClientToolName: 'invokeAction', rpcMethod: 'action.invoke' },
    examples: {
      voice: { argsExample: '{"action":{"pluginId":"acme.plugin","localId":"open-details"},"input":{"source":"voice"}}' },
    },
    surfaces: {
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: true,
      rpc: true,
    },
    inputHints: {
      title: 'Invoke contributed action',
      description: 'Use the exact qualified Action identity returned by action discovery and only its declared input.',
      fields: [
        { path: 'action.pluginId', title: 'Plugin id', widget: 'text', required: true },
        { path: 'action.localId', title: 'Action id', widget: 'text', required: true },
        { path: 'input', title: 'Declared Action input', widget: 'textarea' },
      ],
    },
    outputSchema: StrictJsonValueSchema,
    inputSchema: ActionInvokeInputSchema,
  } satisfies PreNormalizedActionSpec,
] as const);

