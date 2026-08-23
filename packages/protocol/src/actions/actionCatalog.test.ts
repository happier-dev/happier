import { describe, expect, it } from 'vitest';

import {
  type ActionSpec,
  actionSpecToActionDefinitionV1,
  getActionSpec,
  listActionDefinitionsForCatalogSurface,
  searchSerializedActionSpecs,
  serializeActionSpec,
  SerializedActionDefinitionV1Schema,
} from '../index.js';
import { z } from 'zod';

describe('actionCatalog action-definition adapter', () => {
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
    });
    expect(getActionSpec('session.spawn_new').operation).toEqual({
      version: 1,
      visibility: 'activity',
      progress: 'reported',
    });
    expect(getActionSpec('session.handoff').operation).toEqual({
      version: 1,
      visibility: 'activity',
      progress: 'reported',
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

  it('projects every Agent-visible Action definition through the canonical schema boundary', () => {
    const definitions = listActionDefinitionsForCatalogSurface({ surface: 'agent' });

    expect(definitions.length).toBeGreaterThan(0);
    for (const definition of definitions) {
      expect(SerializedActionDefinitionV1Schema.safeParse(definition).success).toBe(true);
    }
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
});
