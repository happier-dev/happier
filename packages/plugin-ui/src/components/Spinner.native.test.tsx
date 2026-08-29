import * as React from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativePlatform = vi.hoisted(() => ({ OS: 'ios' }));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Platform: nativePlatform,
  View: 'View',
}));

import { PluginUiProvider } from './PluginUiProvider.js';
import { PluginUiProviderInternal } from './PluginUiProvider.js';
import { Spinner } from './Spinner.js';
import { HappierSpinner } from '../presentation/feedback/Spinner.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = null;
});

describe('native HappierSpinner presentation', () => {
  it('keeps an indeterminate spinner visible without rotation when the projected reduced-motion preference is on', async () => {
    const context = createSurfaceContext({ platform: 'ios', reducedMotion: true });

    await act(async () => {
      renderer = create(
        <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
          <HappierSpinner testID="reduced-motion-spinner" />
        </PluginUiProvider>,
      );
    });

    const spinner = renderer!.root.findByType('ActivityIndicator');
    expect(spinner.props.animating).toBe(false);
    expect(spinner.props.hidesWhenStopped).toBe(false);
  });

  it('pauses public Spinner animation while its retained surface is inactive', async () => {
    const context = createSurfaceContext({ platform: 'ios', reducedMotion: false });
    const renderSpinner = (active: boolean) => (
      <PluginUiProviderInternal
        hostApi={createHostApiStub(context)}
        context={context}
        surfaceActivity={{ active }}
      >
        <Spinner testID="public-spinner" />
      </PluginUiProviderInternal>
    );

    await act(async () => {
      renderer = create(renderSpinner(false));
    });
    let spinner = renderer!.root.findByType('ActivityIndicator');
    expect(spinner.props.animating).toBe(false);
    expect(spinner.props.hidesWhenStopped).toBe(false);

    await act(async () => {
      renderer!.update(renderSpinner(true));
    });
    spinner = renderer!.root.findByType('ActivityIndicator');
    // Leaving the prop undefined preserves React Native's default active
    // indicator; the adapter only needs to force it off for inactive mounts.
    expect(spinner.props.animating).not.toBe(false);
  });
});
