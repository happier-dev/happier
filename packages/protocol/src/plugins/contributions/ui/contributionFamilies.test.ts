import { describe, expect, it } from 'vitest';

import { PluginContributesV2Schema } from '../v2.js';

describe('plugin UI contribution families', () => {
  it('accepts the canonical nested UI graph with header-action consumers', () => {
    const parsed = PluginContributesV2Schema.parse({
      actions: [{
        id: 'roundtrip',
        title: 'Roundtrip',
        scopes: ['session'],
        surfaces: ['ui', 'agent', 'mcp', 'cli'],
        placementBindings: ['commandPalette'],
        dangerLevel: 'safe',
        execution: { target: 'daemon' },
      }],
      tools: [{
        id: 'roundtrip-tool',
        name: 'vertical_a_roundtrip',
        title: 'Roundtrip',
        surfaces: ['agent', 'mcp', 'cli'],
        inputSchema: { type: 'object', additionalProperties: true },
        outputSchema: { type: 'object', additionalProperties: true },
        inputHints: {
          description: 'Input forwarded to the roundtrip action.',
          fields: [{ path: 'operation', title: 'Operation', widget: 'text' }],
        },
        examples: { mcp: { argsExample: '{"operation":"packed-tool-dispatch"}' } },
        promptSnippet: 'Use vertical_a_roundtrip.',
        promptGuidelines: ['Invoke the declared action through this presentation.'],
        action: 'roundtrip',
      }],
      sessionHeaderActions: [{
        id: 'roundtrip-header',
        title: 'Run roundtrip',
        action: { kind: 'executeAction', action: 'roundtrip' },
        order: 10,
      }],
      ui: {
        views: [{
          id: 'preview',
          container: 'rightPane',
          target: { kind: 'session' },
          renderer: 'preview-web',
          fallbackRenderers: ['roundtrip-card'],
          title: 'Preview',
        }],
        renderers: [{
          id: 'preview-web',
          kind: 'hostedWeb',
          source: { kind: 'artifact', artifact: 'preview-web' },
          requiredHostMethods: ['context', 'executeAction'],
        }, {
          id: 'roundtrip-card',
          kind: 'declarative',
          root: {
            kind: 'action',
            action: 'roundtrip',
            label: 'Run roundtrip',
          },
        }],
        translations: [{
          locale: 'en',
          messages: { previewTitle: 'Preview' },
        }],
      },
    });

    expect(parsed.tools[0]).toMatchObject({
      id: 'roundtrip-tool',
      action: 'roundtrip',
      surfaces: ['agent', 'mcp', 'cli'],
    });
    expect(parsed.sessionHeaderActions[0]).toMatchObject({
      id: 'roundtrip-header',
      action: { kind: 'executeAction', action: 'roundtrip' },
    });
    expect(parsed.ui.renderers).toEqual([
      expect.objectContaining({
        id: 'preview-web',
        kind: 'hostedWeb',
        source: { kind: 'artifact', artifact: 'preview-web' },
      }),
      expect.objectContaining({
        id: 'roundtrip-card',
        kind: 'declarative',
      }),
    ]);
  });

  it('rejects renderer definitions that name raw host implementation details', () => {
    const result = PluginContributesV2Schema.safeParse({
      ui: {
        views: [],
        renderers: [{
          id: 'bad-card',
          kind: 'component',
          importPath: './BadCard',
        }],
        translations: [],
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain(
        'ui.renderers.0.kind',
      );
    }
  });

  it('rejects retired top-level UI families instead of maintaining a second authored schema', () => {
    for (const retiredFamily of [
      'uiTranslations',
      'surfacePlacements',
      'hostedWeb',
      'reactNativeBundles',
      'uiArtifacts',
    ]) {
      const result = PluginContributesV2Schema.safeParse({
        [retiredFamily]: [],
      });

      expect(result.success, retiredFamily).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.message.includes(retiredFamily))).toBe(true);
      }
    }
  });

  it('rejects deferred structuredMessages even when the descriptor is otherwise valid', () => {
    const result = PluginContributesV2Schema.safeParse({
      structuredMessages: [{
        id: 'roundtrip-result',
        title: 'Roundtrip result',
        kind: 'acme.preview/roundtrip-result.v1',
        payloadSchema: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
          additionalProperties: false,
        },
        renderer: 'roundtrip-card',
        fallback: { kind: 'summary', template: 'Preview: {message}' },
      }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('structuredMessages'))).toBe(true);
    }
  });
});
