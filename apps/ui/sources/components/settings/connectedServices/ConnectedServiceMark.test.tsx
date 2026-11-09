import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createValidPluginBrandPngFixture, renderScreen } from '@/dev/testkit';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import { Icon } from '@/components/ui/icons/Icon';

import { ConnectedServiceMark } from './ConnectedServiceMark';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

// Packaged inventory bytes are the app/Expo asset boundary; brand admission stays real.
const bundledBrands = vi.hoisted(
  () =>
    [] as {
      pluginId: string;
      resourceId: string;
      releaseVersion: string;
      displayName: string;
      digest: string;
      bytes: Uint8Array;
    }[],
);
vi.mock(
  '@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts',
  () => ({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS: [],
    BUNDLED_PLUGIN_UI_APP_DECLARATIONS: [],
    BUNDLED_PLUGIN_BRAND_MARKS: bundledBrands,
  }),
);

describe('ConnectedServiceMark', () => {
  it('draws a plugin service’s packaged brand instead of the key glyph', async () => {
    bundledBrands.splice(0, bundledBrands.length, {
      pluginId: 'happier.machine.hetzner',
      resourceId: 'brand-icon',
      releaseVersion: '1.0.0',
      displayName: 'Hetzner',
      digest: `sha256:${'a'.repeat(64)}`,
      bytes: createValidPluginBrandPngFixture(),
    });
    const screen = await renderScreen(
      <ConnectedServiceMark
        legacyServiceId={null}
        pluginId="happier.machine.hetzner"
        size="row"
      />,
    );
    expect(screen.tree.findAllByType(HappierBrandMark)).toHaveLength(1);
    expect(screen.tree.findAllByType(Icon)).toHaveLength(0);
  });

  it('keeps the key glyph for a service that declares no mark', async () => {
    bundledBrands.splice(0, bundledBrands.length);
    const screen = await renderScreen(
      <ConnectedServiceMark
        legacyServiceId={null}
        pluginId="happier.example.unbranded"
        size="row"
      />,
    );
    expect(screen.tree.findAllByType(HappierBrandMark)).toHaveLength(0);
    expect(screen.tree.findAllByType(Icon)).toHaveLength(1);
  });
});
