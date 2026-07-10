import { describe, expect, it } from 'vitest';

import {
  type ActionSpec,
  actionSpecToActionDefinitionV1,
  getActionSpec,
  listActionDefinitionsForCatalogSurface,
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
        sdk: true,
      },
      inputHints: null,
      inputSchema: z.object({ id: z.string() }).strict(),
      outputSchema: z.object({ spec: z.unknown() }).passthrough(),
      execution: {
        handler: 'actions.get',
        transport: 'host',
      },
      sideEffectClass: 'read',
    } satisfies ActionSpec;

    const definition = actionSpecToActionDefinitionV1(spec);

    expect(definition.outputSchema).toEqual(expect.objectContaining({}));
    expect(definition.execution).toEqual(expect.objectContaining({
      handler: 'actions.get',
      transport: 'host',
    }));
    expect(definition.sideEffectClass).toBe('read');
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

  it('filters action definitions by surface and enabled predicate', () => {
    const definitions = listActionDefinitionsForCatalogSurface({
      surface: 'cli',
      isActionEnabled: (id) => id !== 'review.start',
    });

    expect(definitions.some((definition) => definition.id === 'review.start')).toBe(false);
    expect(definitions.some((definition) => definition.id === 'session.mode.set')).toBe(true);
    expect(definitions.every((definition) => definition.surfaces.cli === true)).toBe(true);
  });

  it('preserves strict object semantics in exported input schemas', () => {
    const definition = actionSpecToActionDefinitionV1(getActionSpec('ui.voice_global.reset'));

    expect(definition.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
  });
});
