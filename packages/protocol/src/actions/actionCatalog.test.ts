import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ActionDefinitionV1,
  type ActionSpec,
  actionSpecToActionDefinitionV1,
  getActionDefinitionForCatalogSurface,
  getActionSpec,
  listActionDefinitionsForCatalogSurface,
  listActionSpecsForCatalogSurface,
  searchSerializedActionSpecsForSurface,
  searchSerializedActionSpecs,
  serializeActionSpec,
  SerializedActionDefinitionV1Schema,
} from '../index.js';
import { z } from 'zod';
import { projectActionDefinitionForExternalDiscovery } from './actionCatalog.js';
import { zodSchemaToJsonSchemaObject } from './actionInputJsonSchema.js';
import { prepareExternalActionResponseEnvelopeV1 } from './externalActionApi.js';

describe('actionCatalog action-definition adapter', () => {
  // Full-catalog projection is synchronous; let worker-reporting IPC complete
  // between contracts instead of starving it across the entire census.
  beforeEach(() => new Promise<void>(resolve => setImmediate(resolve)));

  it.each([
    ['machines.list', 'api'],
    ['session.spawn_new', 'api'],
    ['session.spawn_new', 'cli'],
  ] as const)('projects %s on %s as strict external JSON', (actionId, surface) => {
    const actionSpec = projectActionDefinitionForExternalDiscovery(
      actionSpecToActionDefinitionV1(getActionSpec(actionId), { surface }),
    );

    const prepared = prepareExternalActionResponseEnvelopeV1({
      v: 1,
      actionId: 'action.spec.get',
      execution: { ok: true, result: { actionSpec } },
    });

    expect(prepared.response.execution).toMatchObject({ ok: true });
  });

  it('builds a serialized action definition with a JSON-schema input contract', () => {
    const definition = actionSpecToActionDefinitionV1(getActionSpec('action.spec.get'));

    expect(definition.kindVersion).toBe(1);
    expect(definition.id).toBe('action.spec.get');
    expect(definition.inputSchema.type).toBe('object');
    expect(definition.inputSchema.properties).toMatchObject({
      id: {
        type: 'string',
      },
    });
    expect(definition).toMatchObject({
      requiredAuthority: 'account_automation',
      executionPlacement: 'account',
    });
  });

  it('projects A.6 action metadata into exported action definitions when present', () => {
    const spec = {
      id: 'action.spec.get',
      title: 'Get action spec',
      description: 'Read one action spec.',
      safety: 'safe',
      approval: { result: 'required' },
      placements: [],
      slash: null,
      bindings: {
        mcpToolName: 'action_spec_get',
        sdkMethod: 'actionSpecGet',
        rpcMethod: 'action.spec.get',
      },
      examples: {
        sdk: {
          codeExample: 'await ctx.actions.actionSpecGet({ id: "session.list" })',
        },
      },
      surfaces: {
        ui: false,
        voice: false,
        agent: true,
        mcp: true,
        cli: false,
        rpc: true,
        api: true,
        plugin: true,
      },
      inputHints: null,
      inputSchema: z.object({ id: z.string() }).strict(),
      outputSchema: z.object({ spec: z.unknown() }).passthrough(),
      execution: {
        handler: 'actions.get',
        transport: 'host',
      },
      sideEffectClass: 'read',
      operation: {
        version: 1,
        visibility: 'activity',
        progress: 'indeterminate',
      },
    } satisfies ActionSpec;

    const definition = actionSpecToActionDefinitionV1(spec);

    expect(definition.outputSchema).toEqual(expect.objectContaining({}));
    expect(definition.execution).toEqual(expect.objectContaining({
      handler: 'actions.get',
      transport: 'host',
    }));
    expect(definition.sideEffectClass).toBe('read');
    expect(definition.operation).toEqual({
      version: 1,
      visibility: 'activity',
      progress: 'indeterminate',
    });
    expect(definition.approval).toEqual({ result: 'required' });
    expect(definition.bindings).toEqual(expect.objectContaining({
      mcpToolName: 'action_spec_get',
      sdkMethod: 'actionSpecGet',
      rpcMethod: 'action.spec.get',
    }));
    expect(definition.examples).toEqual(expect.objectContaining({
      sdk: {
        codeExample: 'await ctx.actions.actionSpecGet({ id: "session.list" })',
      },
    }));
  });

  it('declares only the public fork, spawn, and handoff Actions as tracked core operations', () => {
    expect(getActionSpec('session.fork').operation).toEqual({
      version: 1,
      visibility: 'activity',
      progress: 'indeterminate',
      presentation: { onStart: 'current' },
    });
    expect(getActionSpec('session.spawn_new').operation).toEqual({
      version: 1,
      visibility: 'activity',
      progress: 'reported',
      presentation: { onStart: 'current' },
    });
    expect(getActionSpec('session.handoff').operation).toEqual({
      version: 1,
      visibility: 'activity',
      progress: 'reported',
      presentation: { onStart: 'current' },
    });
    expect(getActionSpec('session.handoff.prepare_target').operation).toBeUndefined();
  });

  it('normalizes supported predecessor surfaces at the serialized read seam only', () => {
    const current = actionSpecToActionDefinitionV1(getActionSpec('action.spec.get'));
    const parsed = SerializedActionDefinitionV1Schema.parse({
      ...current,
      surfaces: {
        ui_button: true,
        ui_slash_command: false,
        voice_tool: false,
        voice_action_block: true,
        session_agent: true,
        mcp: true,
        cli: false,
        future_surface: true,
      },
    });

    expect(parsed.surfaces).toEqual({
      ui: true,
      voice: true,
      agent: true,
      mcp: true,
      cli: false,
      rpc: false,
      api: false,
      plugin: false,
    });

    expect(SerializedActionDefinitionV1Schema.safeParse({
      ...current,
      compatibilityExtension: { introducedBy: 'supported-predecessor' },
    }).success).toBe(true);
  });

  it('filters action definitions by surface and enabled predicate', () => {
    const definitions = listActionDefinitionsForCatalogSurface({
      surface: 'cli',
      isActionEnabled: (id) => id !== 'review.start',
    });

    expect(definitions.some((definition) => definition.id === 'review.start')).toBe(false);
    expect(definitions.some((definition) => definition.id === 'session.mode.set')).toBe(true);
    expect(definitions.every((definition) => definition.surfaces.cli === true)).toBe(true);
  });

  it.each(['ui', 'voice', 'agent', 'mcp', 'cli', 'rpc', 'api', 'plugin'] as const)('projects every %s-visible Action definition through the canonical schema boundary', (surface) => {
    const definitions: ActionDefinitionV1[] = [];
    const rejected = listActionSpecsForCatalogSurface({ surface }).flatMap(spec => {
      try {
        definitions.push(actionSpecToActionDefinitionV1(spec, { surface }));
        return [];
      } catch (error) {
        return [`${spec.id}: ${error instanceof Error ? error.message : String(error)}`];
      }
    });
    expect(rejected, rejected.join('\n')).toEqual([]);

    expect(definitions.length).toBeGreaterThan(0);
    expect(definitions.map((definition) => definition.id)).toEqual(
      listActionSpecsForCatalogSurface({ surface }).map((spec) => spec.id),
    );
    for (const definition of definitions) {
      const parsed = SerializedActionDefinitionV1Schema.safeParse(JSON.parse(JSON.stringify(definition)));
      expect(parsed.success, `${definition.id}: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
    }
  });

  it.each(['agent', 'mcp', 'cli'] as const)('searches the real %s catalog without unrelated schema failures', (surface) => {
    expect(searchSerializedActionSpecsForSurface({
      surface,
      query: 'action.spec.get',
      limit: 1,
    }).map((definition) => definition.id)).toEqual(['action.spec.get']);
    expect(searchSerializedActionSpecsForSurface({
      surface,
      query: 'execution.run.stream.read',
      limit: 1,
    }).map((definition) => definition.id)).toEqual(
      getActionSpec('execution.run.stream.read').surfaces[surface] ? ['execution.run.stream.read'] : [],
    );
  });

  it('reuses immutable host projections while evaluating request-current search inputs', () => {
    const hostSpec = getActionSpec('action.spec.get');
    if (!hostSpec.outputSchema) throw new Error('Expected action.spec.get output schema');
    const hostSearchTextPrefix = `${hostSpec.id} ${hostSpec.title}`;
    const originalToLowerCase = String.prototype.toLowerCase;
    let hostSearchTextComputations = 0;
    const toLowerCase = vi.spyOn(String.prototype, 'toLowerCase').mockImplementation(function(this: string) {
      const value = String(this);
      if (value.startsWith(hostSearchTextPrefix)) {
        hostSearchTextComputations += 1;
      }
      return originalToLowerCase.call(this);
    });
    const contributedDefinition = (id: string): ActionDefinitionV1 => ({
      kindVersion: 1,
      id,
      title: id,
      description: null,
      safety: 'safe',
      placements: [],
      slash: null,
      bindings: null,
      examples: null,
      surfaces: {
        ui: false,
        voice: false,
        agent: false,
        mcp: false,
        cli: false,
        rpc: false,
        api: true,
        plugin: false,
      },
      inputHints: null,
      inputSchema: {},
    });

    try {
      const firstHostSearch = searchSerializedActionSpecsForSurface({
        surface: 'api',
        query: hostSpec.id,
        isActionEnabled: () => true,
      });
      const repeatedHostSearch = searchSerializedActionSpecsForSurface({
        surface: 'api',
        query: hostSpec.id,
        isActionEnabled: () => true,
      });
      const secondHostSearch = searchSerializedActionSpecsForSurface({
        surface: 'api',
        query: hostSpec.id,
        isActionEnabled: (id) => id !== hostSpec.id,
      });
      const firstContributedSearch = searchSerializedActionSpecsForSurface({
        surface: 'api',
        query: 'fresh-contribution',
        additionalDefinitions: [contributedDefinition('fresh-contribution-one')],
      });
      const secondContributedSearch = searchSerializedActionSpecsForSurface({
        surface: 'api',
        query: 'fresh-contribution',
        additionalDefinitions: [contributedDefinition('fresh-contribution-two')],
      });

      expect(firstHostSearch.map((definition) => definition.id)).toContain(hostSpec.id);
      expect(repeatedHostSearch.map((definition) => definition.id)).toContain(hostSpec.id);
      expect(secondHostSearch.map((definition) => definition.id)).not.toContain(hostSpec.id);
      expect(firstContributedSearch.map((definition) => definition.id)).toEqual(['fresh-contribution-one']);
      expect(secondContributedSearch.map((definition) => definition.id)).toEqual(['fresh-contribution-two']);
      expect(hostSearchTextComputations).toBe(1);
      expect(repeatedHostSearch.find((definition) => definition.id === hostSpec.id))
        .toBe(firstHostSearch.find((definition) => definition.id === hostSpec.id));
    } finally {
      toLowerCase.mockRestore();
    }
  });

  it('projects contributed Action summaries through named public fields', () => {
    const contributed: ActionDefinitionV1 = {
      kindVersion: 1,
      id: 'com.acme.actions/actions/strictprojectionneedle9x',
      title: 'Strictprojectionneedle9x',
      description: null,
      safety: 'safe',
      placements: [],
      slash: null,
      bindings: null,
      examples: null,
      surfaces: {
        ui: false,
        voice: false,
        agent: false,
        mcp: false,
        cli: true,
        rpc: false,
        api: true,
        plugin: false,
      },
      inputHints: null,
      inputSchema: {},
      scopes: ['global'],
      contributionSurfaces: ['cli'],
      availability: undefined,
      hostAccess: undefined,
      priority: undefined,
      dangerLevel: 'safe',
    };

    expect(searchSerializedActionSpecsForSurface({
      surface: 'api',
      query: 'strictprojectionneedle9x',
      additionalDefinitions: [contributed],
    })).toEqual([{
      id: 'com.acme.actions/actions/strictprojectionneedle9x',
      title: 'Strictprojectionneedle9x',
      description: null,
      safety: 'safe',
      placements: [],
      slash: null,
      bindings: null,
      examples: null,
      surfaces: {
        ui: false,
        voice: false,
        agent: false,
        mcp: false,
        cli: true,
        rpc: false,
        api: true,
        plugin: false,
      },
      inputHints: null,
    }]);
  });

  it('preserves strict object semantics in exported input schemas', () => {
    const definition = actionSpecToActionDefinitionV1(getActionSpec('ui.voice_global.reset'));

    expect(definition.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
  });

  it('projects constrained Action inputs and outputs through the shared catalog', () => {
    const spec: ActionSpec = {
      ...getActionSpec('action.spec.get'),
      inputSchema: z.object({
        label: z.string().min(2).max(20).regex(/^[a-z-]+$/).describe('Action label'),
        attempts: z.number().min(1).max(3),
        tags: z.array(z.string()).min(1).max(2),
        mode: z.enum(['safe', 'fast']),
      }).strict().describe('Constrained action input'),
      outputSchema: z.string().min(2).describe('Result text'),
    };

    const definition = actionSpecToActionDefinitionV1(spec);
    const serialized = serializeActionSpec(spec);

    expect(definition.inputSchema).toMatchObject({
      description: 'Constrained action input',
      additionalProperties: false,
      properties: {
        label: {
          minLength: 2,
          maxLength: 20,
          pattern: '^[a-z-]+$',
          description: 'Action label',
        },
        attempts: { minimum: 1, maximum: 3 },
        tags: { minItems: 1, maxItems: 2 },
        mode: { enum: ['safe', 'fast'] },
      },
    });
    expect(serialized.outputSchema).toMatchObject({
      type: 'string',
      minLength: 2,
      description: 'Result text',
    });
  });

  it('preserves structured Connected Account options without making their identifiers catalog search text', () => {
    const connectedAccountRef = {
      service: { pluginId: 'com.acme.accounts', localId: 'service' },
      accountId: 'account-private-42',
    };
    const spec: ActionSpec = {
      ...getActionSpec('action.spec.get'),
      inputHints: {
        fields: [{
          path: 'id',
          title: 'Selected account',
          widget: 'select',
          options: [{ value: connectedAccountRef, label: 'Account' }],
        }],
      },
    };

    const definition = actionSpecToActionDefinitionV1(spec);
    expect(definition.inputHints?.fields[0]?.options?.[0]?.value).toEqual(connectedAccountRef);
    expect(searchSerializedActionSpecs([spec], { query: 'account-private-42' })).toEqual([]);
    expect(searchSerializedActionSpecs([spec], { query: 'com.acme.accounts' })).toEqual([]);
  });

  it('projects the API output schema through both get and search while retaining the internal output', () => {
    const spec = getActionSpec('session.message.send');
    const apiOutputSchema = spec.surfaceBindings?.api?.outputSchema;
    if (!spec.outputSchema || !apiOutputSchema) throw new Error('Expected internal and API output schemas');

    const apiOutputJsonSchema = zodSchemaToJsonSchemaObject(apiOutputSchema);
    const internalOutputJsonSchema = zodSchemaToJsonSchemaObject(spec.outputSchema);
    const apiDefinition = getActionDefinitionForCatalogSurface({
      id: 'session.message.send',
      surface: 'api',
    });
    const [apiSearchResult] = searchSerializedActionSpecsForSurface({
      surface: 'api',
      query: 'session.message.send',
      limit: 1,
    });

    expect(apiDefinition?.outputSchema).toEqual(apiOutputJsonSchema);
    expect(apiSearchResult?.id).toBe('session.message.send');
    expect(apiSearchResult?.outputSchema).toEqual(apiOutputJsonSchema);
    expect(actionSpecToActionDefinitionV1(spec).outputSchema).toEqual(internalOutputJsonSchema);
  });
});
