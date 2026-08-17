import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
} from '@happier-dev/plugin-sdk/testing';
import type { RenderSurface } from '@happier-dev/plugin-sdk/ui';
import { describe, expect, it, vi } from 'vitest';

import { renderSurface as renderDevelopmentSurface } from '../../../plugin-sdk/examples/react-native-dev-hot-reload/ui/panel.native.tsx';
import { renderSurface as renderInstalledSurface } from '../../../plugin-sdk/examples/react-native-installed/ui/panel.native.tsx';
import { renderSurface as renderFallbackSurface } from '../../../plugin-sdk/examples/multi-mode-fallback/ui/panel.tsx';
import { createPluginUiRnwSemanticSurfaceAdapter } from './rnwSemanticAdapter.testSupport.js';

const publicExampleSurfaces = [
  {
    id: 'react-native-installed',
    surface: renderInstalledSurface,
    renderedText: 'Installed React Native example',
    copyLabel: 'Copy example title',
    copiedValue: 'Installed React Native example',
  },
  {
    id: 'react-native-dev-hot-reload',
    surface: renderDevelopmentSurface,
    renderedText: 'React Native development example',
    copyLabel: 'Copy rebuild status',
    copiedValue: 'Development artifact rebuilt',
  },
  {
    id: 'multi-mode-fallback',
    surface: renderFallbackSurface,
    renderedText: 'Multi-mode fallback example',
    copyLabel: 'Copy selected renderer',
    copiedValue: 'reactNative',
  },
] as const satisfies readonly Readonly<{
  id: string;
  surface: RenderSurface;
  renderedText: string;
  copyLabel: string;
  copiedValue: string;
}>[];

describe('public React Native authoring examples', () => {
  it.each(publicExampleSurfaces)(
    'mounts $id through the semantic fixture and invokes its declared host action',
    async ({ id, surface, renderedText, copyLabel, copiedValue }) => {
      const writeClipboard = vi.fn(async () => undefined);
      const fixture = await createPluginUiTestkit({
        identity: {
          pluginId: `examples.${id}`,
          pluginVersion: '0.1.0',
          viewId: 'example-panel',
          generation: `${id}-semantic-example`,
        },
        surface,
        surfaceContext: createSurfaceContextFixture(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        handlers: { writeClipboard },
      });

      try {
        await expect(fixture.getByText(renderedText)).resolves.toEqual({ content: renderedText });
        await fixture.press(await fixture.getByRole('button', { name: copyLabel }));
        expect(writeClipboard).toHaveBeenCalledWith(expect.objectContaining({
          value: copiedValue,
          signal: expect.any(AbortSignal),
        }));
      } finally {
        await fixture.dispose();
      }
    },
  );
});
