import { describe, expect, it } from 'vitest';

import { PluginContributesV2Schema } from '../v2.js';

describe('plugin UI contribution families', () => {
  it('accepts the canonical nested UI graph with structured-message and header-action consumers', () => {
    const parsed = PluginContributesV2Schema.parse({
      actions: [{
        id: 'roundtrip',
        title: 'Roundtrip',
        scopes: ['session'],
        surfaces: ['ui', 'agent', 'mcp', 'cli'],
        placement: 'commandPalette',
        dangerLevel: 'safe',
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
        actions: ['roundtrip'],
        fallback: { kind: 'summary', template: 'Preview: {message}' },
      }],
      sessionHeaderActions: [{
        id: 'roundtrip-header',
        title: 'Run roundtrip',
        action: 'roundtrip',
        order: 10,
      }],
      ui: {
        views: [{
          id: 'preview',
          placement: 'session.preview',
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
          requiredHostMethods: ['executeAction'],
        }],
        translations: [{
          locale: 'en',
          messages: { previewTitle: 'Preview' },
        }],
      },
    });

    expect(parsed.structuredMessages[0]).toMatchObject({
      id: 'roundtrip-result',
      renderer: 'roundtrip-card',
      actions: ['roundtrip'],
    });
    expect(parsed.tools[0]).toMatchObject({
      id: 'roundtrip-tool',
      action: 'roundtrip',
      surfaces: ['agent', 'mcp', 'cli'],
    });
    expect(parsed.sessionHeaderActions[0]).toMatchObject({
      id: 'roundtrip-header',
      action: 'roundtrip',
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

  it('rejects structured messages without a stable fallback and declared renderer reference', () => {
    const result = PluginContributesV2Schema.safeParse({
      structuredMessages: [{
        id: 'incomplete',
        title: 'Incomplete',
        kind: 'acme.preview/incomplete.v1',
        payloadSchema: { type: 'object' },
      }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toEqual(expect.arrayContaining([
        'structuredMessages.0.renderer',
        'structuredMessages.0.fallback',
      ]));
    }
  });
});
