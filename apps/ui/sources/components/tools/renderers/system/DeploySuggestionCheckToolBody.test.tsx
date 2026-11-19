import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { makeToolCall, makeToolViewProps, renderScreen } from '@/dev/testkit';
import { DEPLOYMENT_SUGGESTIONS_CHECK_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { DeploymentSuggestionActionInputSchemasV1 } from '@happier-dev/protocol/deployments/suggestions/actionsV1';
import {
  DeploySuggestionCatalogV1Schema,
  validateDeploySuggestionV1,
  type DeploySuggestionRecommendationV1,
} from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { execute, showModal } = vi.hoisted(() => ({ execute: vi.fn(), showModal: vi.fn() }));
// The Action transport boundary: rendering and choosing a checked suggestion must not call it (F7).
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>()),
  createFrontDoorActionExecute: () => execute,
}));
// The dialog presentation boundary: Use this setup opens Deploy an app through it.
vi.mock('@/modal', async () =>
  (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { show: showModal } }).module,
);

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

/** The check call's input exactly as the real Action schema admits it: a fixture field the schema rejects fails here. */
function checkInput(input: Readonly<{ description?: string; suggestion: unknown }>) {
  return DeploymentSuggestionActionInputSchemasV1[DEPLOYMENT_SUGGESTIONS_CHECK_ACTION_ID_V1].parse({ catalog, ...input });
}

function checkCall(suggestion: unknown, description?: string) {
  return makeToolCall({
    name: 'mcp__happier__action_execute',
    state: 'completed',
    input: {
      actionId: DEPLOYMENT_SUGGESTIONS_CHECK_ACTION_ID_V1,
      input: checkInput(description === undefined ? { suggestion } : { description, suggestion }),
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
    const tool = checkCall({ recommendations: [site, invented, analytics], questions: null }, '  Make me a bakery landing page  ');
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
        .toEqual(['A bakery landing page, Recommended, Runs on Cloudflare Pages', 'Self-hosted analytics, Runs on Own server', null]);
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

describe('Use this setup from a transcript card (deploy auto-mode U10, F4/F7)', () => {
  async function useFirstCard(description?: string) {
    execute.mockReset();
    showModal.mockReset();
    const { MCPToolView } = await import('./MCPToolView');
    const screen = await renderScreen(
      <MCPToolView {...makeToolViewProps(checkCall({ recommendations: [site, analytics], questions: null }, description),
        { detailLevel: 'summary' })} />,
    );
    try {
      expect(execute, 'rendering checked cards reads nothing (F7)').not.toHaveBeenCalled();
      await screen.pressByTestIdAsync('deploy-suggestion-check.use');
      expect(execute, 'choosing a card calls no Action; the dialog owns what follows (F7)').not.toHaveBeenCalled();
      expect(showModal).toHaveBeenCalledTimes(1);
      return (showModal.mock.calls[0]![0] as { props: { suggestion: { description: string; recommendation: unknown } } }).props.suggestion;
    } finally {
      await screen.unmount();
    }
  }

  it('hands the dialog the person\u2019s words from the check call, byte for byte', async () => {
    const suggestion = await useFirstCard('  Make me a bakery landing page\n');
    expect(suggestion.description).toBe('  Make me a bakery landing page\n');
    expect(suggestion.recommendation).toEqual(site);
  });

  it('without the person\u2019s words it hands over none, never the model\u2019s whatToBuild', async () => {
    const suggestion = await useFirstCard();
    expect(suggestion.description).toBe('');
  });
});

describe('a card\u2019s platform plan facts (deploy auto-mode U3, review D1)', () => {
  it('never shows plan prices copied into the agent\u2019s call input: plans come only from the Account\u2019s declared targets', async () => {
    const forged = DeploySuggestionCatalogV1Schema.parse({
      ...catalog,
      targets: catalog.targets.map((target) => target.id !== 'pages' ? target : { ...target, plans: [{
        id: 'free', title: 'Free', price: { amount: '0', currency: 'USD', unit: 'month' },
        facts: [{ label: 'Builds', value: '9999 a month' }],
        source: { url: 'https://forged.example.test/pricing', checkedAt: '2026-11-16' },
      }] }),
    });
    const { MCPToolView } = await import('./MCPToolView');
    const suggestion = { recommendations: [site, analytics], questions: null };
    const call = makeToolCall({ name: 'mcp__happier__action_execute', state: 'completed',
      input: { actionId: DEPLOYMENT_SUGGESTIONS_CHECK_ACTION_ID_V1,
        input: DeploymentSuggestionActionInputSchemasV1[DEPLOYMENT_SUGGESTIONS_CHECK_ACTION_ID_V1].parse({ catalog: forged, suggestion }) },
      result: { ok: true, result: validateDeploySuggestionV1(suggestion, forged) } });
    const screen = await renderScreen(<MCPToolView {...makeToolViewProps(call, { detailLevel: 'summary' })} />);
    try {
      expect(screen.findByTestId('deploy-suggestion-check'), screen.getTextContent()).not.toBeNull();
      const text = screen.getTextContent();
      expect(text).not.toContain('9999 a month');
      expect(text).not.toContain('forged.example.test');
      expect(screen.findByTestId('deploy-suggestion-check.card:suggestion-0:plans')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});

describe('a card takes its plans from the declared target it runs on', () => {
  it('reads the declared plans by the recommendation\u2019s target id, with the platform\u2019s name', async () => {
    const { presentDeploySuggestionCard } = await import('@/components/projects/starters/auto/DeploySuggestionCards');
    const declared = [{ id: 'free', title: 'Free', price: { amount: '0', currency: 'USD', unit: 'month' }, facts: [],
      source: { url: 'https://developers.cloudflare.com/pages/platform/limits/', checkedAt: '2026-11-16' } }];
    const lookup = (targetId: string) => targetId === 'pages' ? { plans: declared, platform: 'Cloudflare Pages' } : null;
    expect(presentDeploySuggestionCard(site, catalog, 0, null, lookup).plans).toEqual({ plans: declared, platform: 'Cloudflare Pages' });
    expect(presentDeploySuggestionCard(analytics, catalog, 1, null, lookup).plans).toBeNull();
  });
});
