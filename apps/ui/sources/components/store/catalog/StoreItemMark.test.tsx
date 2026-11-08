import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installPromptRegistriesCommonModuleMocks } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';
import type { StoreDiscoverItem } from '../discover/storeDiscoverModel';

installPromptRegistriesCommonModuleMocks({ storage: (original) => original() });
vi.mock('@react-navigation/native', async () =>
  (
    await import('@/dev/testkit/mocks/reactNavigation')
  ).createReactNavigationNativeMock(),
);
const { StoreDiscoverItemMark } =
  await import('../discover/StoreDirectorySection');
const { SoftwareMark } = await import('../StoreSoftwarePage');
const { STORE_KIND_GLYPHS, storeItemHasArtwork, storeMarkFactsOfReference } =
  await import('./StoreItemMark');
afterEach(standardCleanup);

type Screen = Awaited<ReturnType<typeof renderScreen>>;
/** What the mark draws: the glyph it names, and any text (an initial) it sets. */
function drawn(screen: Screen) {
  const glyphs = screen
    .findAll((node) => typeof node.props?.name === 'string')
    .map((node) => node.props.name as string);
  return { glyphs, text: screen.getTextContent().trim() };
}

const recipe = {
  pluginId: 'machine-recipes',
  recipeId: 'google-chrome',
  revision: '1',
} as const;

it("draws a software option's declared icon, and the Software glyph only when the descriptor declares none", async () => {
  const { resolvePluginUiIconName } = await import('@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken');
  // The Software page's option carries the recipe's own declared mark (machines.setup.software.available).
  const declared = await renderScreen(
    <SoftwareMark
      item={{ value: recipe, label: 'Google Chrome', icon: 'browser' } as never}
      pixelSize={26}
    />,
  );
  const onPage = drawn(declared);
  await declared.unmount();
  expect(onPage.text).toBe('');
  expect(onPage.glyphs).toEqual([resolvePluginUiIconName('browser')]);
  expect(onPage.glyphs).not.toEqual([STORE_KIND_GLYPHS.software]);

  // A reference without its descriptor (Discover) and an option declaring no icon keep the Software glyph, never an initial.
  const discoverItem: StoreDiscoverItem = {
    key: 'chrome',
    id: 'chrome',
    sourceId: 'curated',
    kind: 'software',
    reference: { type: 'software', value: recipe },
    title: 'Google Chrome',
    description: null,
  };
  const discover = await renderScreen(
    <StoreDiscoverItemMark item={discoverItem} />,
  );
  expect(drawn(discover)).toEqual({ glyphs: [STORE_KIND_GLYPHS.software], text: '' });
  await discover.unmount();
  const bare = await renderScreen(
    <SoftwareMark item={{ value: recipe, label: 'Google Chrome' } as never} pixelSize={26} />,
  );
  expect(drawn(bare)).toEqual({ glyphs: [STORE_KIND_GLYPHS.software], text: '' });
  await bare.unmount();
});

it('counts only real artwork as a mark for job strips', () => {
  expect(
    storeItemHasArtwork(
      storeMarkFactsOfReference('app', 'Uptime Kuma', {
        type: 'registryItem',
        kind: 'app',
        sourceId: 'curated',
        itemId: 'uptime-kuma',
      }),
    ),
  ).toBe(false);
  expect(
    storeItemHasArtwork(
      storeMarkFactsOfReference('software', 'Google Chrome', {
        type: 'software',
        value: recipe,
      }),
    ),
  ).toBe(false);
  expect(
    storeItemHasArtwork(
      storeMarkFactsOfReference('provider', 'Ollama', {
        type: 'providerContribution',
        contributionKey: 'ollama:ollama' as never,
      }),
    ),
  ).toBe(true);
});
