import { describe, expect, it, vi } from 'vitest';

import { projectExecutablePluginToolCatalog } from './toolCatalog';

function createRegistry(
  outcome: 'visible' | 'denied',
  toolAvailability: Readonly<Record<string, unknown>> = {
    when: { fact: 'plugin.enabled', operator: 'equals', value: true },
  },
) {
  const action = {
    provenance: 'external',
    pluginId: 'acme.review.plugin',
    definition: {
      id: 'acme.review.plugin/review-start',
    },
  };
  return {
    contributes: {
      tools: [{
        provenance: 'external',
        pluginId: 'acme.review.plugin',
        definition: {
          id: 'review-tool',
          actionId: 'acme.review.plugin/review-start',
          name: 'acme_review_start',
          title: { key: 'review.start', fallback: 'Acme Review Start' },
          description: { key: 'review.description', fallback: 'Start a review' },
          inputSchema: { type: 'object', additionalProperties: false },
          outputSchema: {
            type: 'object',
            properties: { completed: { type: 'boolean' } },
            required: ['completed'],
            additionalProperties: false,
          },
          inputHints: {
            fields: [{
              path: 'scope',
              title: { fallback: 'Scope' },
              widget: 'select',
              options: [{ value: 'diff', label: { fallback: 'Diff' } }],
            }],
          },
          safety: 'danger',
          examples: { mcp: { argsExample: '{"scope":"diff"}' } },
          promptSnippet: 'Start an Acme review when the user asks for review.',
          promptGuidelines: ['Choose the narrowest applicable scope.'],
          availability: toolAvailability,
          surfaces: ['agent', 'mcp', 'cli'],
        },
      }],
      actionsById: new Map([['acme.review.plugin/review-start', action]]),
    },
    targetActionInvocations: {
      evaluateCatalogPolicy: vi.fn(() => (
        outcome === 'visible'
          ? { outcome: 'visible' as const }
          : { outcome: 'denied' as const }
      )),
    },
  } as never;
}

describe('projectExecutablePluginToolCatalog', () => {
  it('serializes the normalized external tool declaration targeting a visible current action', () => {
    const registry = createRegistry('visible');

    expect(projectExecutablePluginToolCatalog(registry)).toEqual([{
      toolId: 'acme.review.plugin/review-tool',
      actionId: 'acme.review.plugin/review-start',
      name: 'acme_review_start',
      title: 'Acme Review Start',
      description: 'Start a review',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: {
        type: 'object',
        properties: { completed: { type: 'boolean' } },
        required: ['completed'],
        additionalProperties: false,
      },
      inputHints: {
        fields: [{
          path: 'scope',
          title: { fallback: 'Scope' },
          widget: 'select',
          options: [{ value: 'diff', label: { fallback: 'Diff' } }],
        }],
      },
      safety: 'danger',
      examples: { mcp: { argsExample: '{"scope":"diff"}' } },
      promptSnippet: 'Start an Acme review when the user asks for review.',
      promptGuidelines: ['Choose the narrowest applicable scope.'],
      availability: { when: { fact: 'plugin.enabled', operator: 'equals', value: true } },
      surfaces: ['agent', 'mcp', 'cli'],
    }]);
  });

  it('does not publish a tool whose target action policy is not visible', () => {
    expect(projectExecutablePluginToolCatalog(createRegistry('denied'))).toEqual([]);
  });

  it('does not publish a tool whose own availability policy is not visible', () => {
    expect(projectExecutablePluginToolCatalog(createRegistry('visible', {
      when: { fact: 'plugin.enabled', operator: 'equals', value: false },
    }))).toEqual([]);
  });
});
