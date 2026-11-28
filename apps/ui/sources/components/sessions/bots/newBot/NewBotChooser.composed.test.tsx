import * as React from 'react';
import { expect, it, onTestFinished, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import {
  COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1,
  DEFAULT_CURATED_MARKETPLACE_SOURCE_URL,
  deriveMarketplaceSourceId,
} from '@happier-dev/protocol/marketplace';
import { createRegistryPluginCatalogFixture } from '@/dev/testkit/fixtures/registryPluginCatalog';
import { installPromptRegistriesCommonModuleMocks } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';

vi.mock('@/components/ui/popover/measure', () => ({
  measureInWindow: async () => ({ x: 0, y: 0, width: 800, height: 600 }),
}));
installPromptRegistriesCommonModuleMocks({ storage: (original) => original() });
vi.mock('@react-navigation/native', async () =>
  (
    await import('@/dev/testkit/mocks/reactNavigation')
  ).createReactNavigationNativeMock(),
);
const { createPlainPromptLibraryCatalogHomeFixture } =
  await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');
const { waitForHomeGovernance } =
  await import('@/dev/testkit/harness/homeGovernanceHarness');
const { NewBotChooser } = await import('./NewBotChooser');
const { listBundledBotTemplates } = await import('@happier-dev/plugins-bot-templates/catalog');
const { BotTemplateRecipientScreen } =
  await import('@/components/sessions/bots/templates/BotTemplateRecipientScreen');

it('lists the ways in and every Store template, and a picked template opens its own page at the read version (lab N1)', async () => {
  const serverUrl = 'https://new-bot-chooser.test';
  const sourceUrl = `${serverUrl}/catalog.json`;
  const sourceId = deriveMarketplaceSourceId(sourceUrl);
  const catalog = createRegistryPluginCatalogFixture({
    sourceUrl,
    entries: [
      {
        pluginId: 'garden.bot',
        title: 'Garden',
        botTemplates: [{ id: 'gardener', path: './templates/garden.json' }],
      },
      { pluginId: 'ordinary.plugin', title: 'Ordinary' },
    ],
  });
  const fixture = await createPlainPromptLibraryCatalogHomeFixture(
    serverUrl,
    {
      key: 'registry-sources',
      value: {
        v: 2,
        // The chooser lists every enabled catalog; the built-in ones are off so only this fixture answers.
        disabledSourceIds: [COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1, deriveMarketplaceSourceId(DEFAULT_CURATED_MARKETPLACE_SOURCE_URL)],
        sources: [
          {
            id: sourceId,
            title: 'Garden catalog',
            format: 'happier-catalog',
            kinds: ['plugin'],
            url: sourceUrl,
            enabled: true,
            addedAt: 1,
          },
        ],
      },
    },
    'updated',
    {
      handleRequest: async (href) =>
        href === '/catalog.json' ? Response.json(catalog) : null,
    },
  );
  onTestFinished(async () => {
    await standardCleanup();
    await fixture.dispose();
  });
  const onClose = vi.fn();
  const screen = await renderScreen(<NewBotChooser onClose={onClose} />);
  // The split measures its width before it lays out both panes.
  const layout = async () => {
    await act(async () => {
      for (const node of screen.root.findAll(
        (candidate) =>
          typeof candidate.type === 'string' &&
          typeof candidate.props.onLayout === 'function',
      )) {
        node.props.onLayout({
          nativeEvent: { layout: { x: 0, y: 0, width: 840, height: 640 } },
        });
      }
    });
  };
  await layout();
  const recipient = () =>
    screen.root.findAll(
      (node) => node.type === BotTemplateRecipientScreen,
    )[0] ?? null;
  expect(screen.findByTestId('new-bot.blank')).not.toBeNull();
  expect(screen.findByTestId('new-bot.ask')).not.toBeNull();
  const rowId = `new-bot.template.plugin|${sourceId}|garden.bot`;
  await waitForHomeGovernance(() =>
    expect(screen.findByTestId(rowId)).not.toBeNull(),
  );
  // Only plugins that carry Bot templates are offered.
  expect(
    screen.findByTestId(`new-bot.template.plugin|${sourceId}|ordinary.plugin`),
  ).toBeNull();
  expect(recipient()).toBeNull();
  await screen.pressByTestIdAsync(rowId);
  await layout();
  await waitForHomeGovernance(() => expect(recipient()).not.toBeNull());
  expect(recipient()!.props.source).toEqual({
    kind: 'plugin',
    registryItem: { sourceId, itemId: 'garden.bot', version: '1.2.3' },
    contributionId: 'gardener',
  });
  // Nothing installs from the chooser itself.
  expect(
    fixture.requests.some(
      (request) => request.method !== 'GET' && request.path.includes('plugins'),
    ),
  ).toBe(false);
  // The templates that ship with Happier lead the list; one opens its exact shipped release.
  const shipped = listBundledBotTemplates();
  const shippedRows = screen.root.findAll((node) => typeof node.props.testID === 'string'
    && node.props.testID.startsWith('new-bot.template.bundled.') && typeof node.props.onPress === 'function');
  expect(new Set(shippedRows.map((node) => node.props.testID)).size).toBe(shipped.length);
  await screen.pressByTestIdAsync(`new-bot.template.bundled.${shipped[0]!.source.contributionId}`);
  await layout();
  await waitForHomeGovernance(() => expect(recipient()!.props.source).toEqual(shipped[0]!.source));
  await screen.pressByTestIdAsync('new-bot.close');
  expect(onClose).toHaveBeenCalledTimes(1);
});
