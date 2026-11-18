import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { makeToolCall, makeToolViewProps, renderScreen } from '@/dev/testkit';
import { DEPLOYMENT_SUGGESTIONS_CHECK_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import {
  DeploySuggestionCatalogV1Schema,
  validateDeploySuggestionV1,
  type DeploySuggestionRecommendationV1,
} from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../shell/presentation/ToolSectionView', () => ({
  ToolSectionView: ({ children }: any) =>
    React.createElement(React.Fragment, null, children),
}));

await import('./MCPToolView');

const catalog = DeploySuggestionCatalogV1Schema.parse({
  starters: [
    {
      id: 'static',
      title: 'Static website',
      deploy: { framework: 'html', output: 'static' },
    },
  ],
  apps: [{ id: 'umami', title: 'Umami', sourceId: 'catalog', itemId: 'umami' }],
  targets: [
    {
      id: 'pages',
      title: 'Cloudflare Pages',
      targetClass: 'platform',
      availability: 'available',
      accepts: ['static'],
      needs: ['repository'],
      sources: { gitIntegration: ['github'], upload: false },
    },
    {
      id: 'own',
      title: 'Own server',
      targetClass: 'ownServer',
      availability: 'available',
      accepts: ['compose', 'static'],
      needs: [],
      sources: { gitIntegration: ['github'], upload: false },
    },
  ],
  machines: [],
  stores: [],
  forges: [{ providerKind: 'github', title: 'GitHub' }],
});
const site = {
  source: { kind: 'starter', starterId: 'static' },
  targetId: 'pages',
  repositoryProviderKind: 'github',
  whatToBuild: 'A bakery landing page',
  stack: { framework: 'html', output: 'static' },
  data: { kind: 'none' },
  variables: [],
} satisfies DeploySuggestionRecommendationV1;
const analytics = {
  source: { kind: 'catalogApp', appId: 'umami' },
  targetId: 'own',
  whatToBuild: 'Self-hosted analytics',
  stack: { framework: 'docker', output: 'container' },
  data: { kind: 'none' },
  variables: [],
} satisfies DeploySuggestionRecommendationV1;
/** The model's raw proposal: one invented target the validator drops. */
const invented = {
  ...site,
  targetId: 'netlify',
  whatToBuild: 'An invented host',
};

function checkCall(suggestion: unknown) {
  return makeToolCall({
    name: 'mcp__happier__action_execute',
    state: 'completed',
    input: {
      actionId: DEPLOYMENT_SUGGESTIONS_CHECK_ACTION_ID_V1,
      input: { catalog, suggestion },
    },
    result: {
      ok: true,
      result: validateDeploySuggestionV1(suggestion, catalog),
    },
  });
}

async function render(suggestion: unknown) {
  const { MCPToolView } = await import('./MCPToolView');
  return renderScreen(
    <MCPToolView
      {...makeToolViewProps(checkCall(suggestion), { detailLevel: 'summary' })}
    />,
  );
}

describe('a Session agent’s checked deploy suggestion (deploy auto-mode U10, F7)', () => {
  it('reads a completed check call into the validator’s recommendations and the checked catalog', async () => {
    const { readTranscriptDeploySuggestionCheck } = await import('@/components/sessions/transcript/references/transcriptDeploySuggestionReference');
    const tool = { ...checkCall({ recommendations: [site, invented, analytics], questions: null }), input: {
      actionId: DEPLOYMENT_SUGGESTIONS_CHECK_ACTION_ID_V1,
      input: { description: '  Make me a bakery landing page  ', catalog, suggestion: { recommendations: [site, invented, analytics], questions: null } },
    } };
    const read = readTranscriptDeploySuggestionCheck(tool);
    expect(read?.recommendations.map((row) => row.whatToBuild)).toEqual(['A bakery landing page', 'Self-hosted analytics']);
    expect(read?.catalog.targets.map((row) => row.id)).toEqual(['pages', 'own']);
    expect(read?.description).toBe('  Make me a bakery landing page  ');
  });

  it('renders the validator’s admitted recommendations as setup cards, the first recommended and chosen, never the dropped ones', async () => {
    const screen = await render({
      recommendations: [site, invented, analytics],
      questions: null,
    });
    try {
      expect(screen.findByTestId('deploy-suggestion-check'), screen.getTextContent()).not.toBeNull();
      const card = (index: number) => screen.findByTestId(`deploy-suggestion-check.card:suggestion-${index}`);
      expect([0, 1, 2].map((index) => card(index)?.props.accessibilityLabel ?? null))
        .toEqual(['A bakery landing page, Recommended', 'Self-hosted analytics', null]);
      expect([0, 1].map((index) => card(index)?.props.accessibilityState?.checked)).toEqual([true, false]);
      const text = screen.getTextContent();
      expect(text).toContain('Static website');
      expect(text).toContain('Cloudflare Pages');
      expect(text).toContain('Umami');
      expect(text).not.toContain('An invented host');
    } finally {
      await screen.unmount();
    }
  });

  it('a result that admitted nothing stays the ordinary tool row, with no cards', async () => {
    const screen = await render({
      recommendations: [invented],
      questions: null,
    });
    try {
      expect(screen.findByTestId('deploy-suggestion-check')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
