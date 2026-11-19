import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  DeploySuggestionCatalogV1Schema,
  type DeploySuggestionRecommendationV1,
} from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';
import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(
    {},
  ),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

const { DeploySuggestionCardTiles, presentDeploySuggestionCard } =
  await import('./DeploySuggestionCards');

const catalog = DeploySuggestionCatalogV1Schema.parse({
  starters: [
    {
      id: 'static',
      title: 'Static website',
      deploy: { framework: 'html', output: 'static' },
    },
  ],
  apps: [],
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
      accepts: ['static'],
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
/** Cloudflare Pages' declared plan, as its plugin dates it (Protocol DeploymentTargetPlanV1). */
const pagesPlans = {
  platform: 'Cloudflare Pages',
  plans: [
    {
      id: 'free',
      title: 'Free',
      price: { amount: '0', currency: 'USD', unit: 'month' },
      facts: [{ label: 'Builds', value: '500 a month' }],
      source: {
        url: 'https://developers.cloudflare.com/pages/platform/limits/',
        checkedAt: '2026-11-16',
      },
    },
  ],
};

describe('a suggestion card’s accessible name (deploy auto-mode QA: title + target + plan)', () => {
  it('names the card by its title, badge, target and the plans it shows, from the same facts it draws', async () => {
    const cards = [
      presentDeploySuggestionCard(site, catalog, 0, null, (id) =>
        id === 'pages' ? pagesPlans : null,
      ),
      presentDeploySuggestionCard(
        { ...site, targetId: 'own', whatToBuild: 'On your own server' },
        catalog,
        1,
        null,
        () => null,
      ),
    ];
    const screen = await renderScreen(
      <DeploySuggestionCardTiles
        cards={cards}
        value="suggestion-0"
        onChange={() => {}}
        phone={false}
        testIdPrefix="card"
      />,
    );
    try {
      const name = (index: number) =>
        screen.findByTestId(`card:suggestion-${index}`)?.props
          .accessibilityLabel as string | undefined;
      expect(name(0)).toContain('A bakery landing page');
      expect(name(0)).toContain('Recommended');
      expect(name(0)).toContain('Cloudflare Pages');
      expect(name(0)).toContain('Free $0.00 a month');
      expect(name(1)).toContain('Own server');
    } finally {
      await screen.unmount();
    }
  });
});
