import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { Icon } from './Icon.js';
import { PluginUiProvider } from './PluginUiProvider.js';

describe('portable semantic Icon', () => {
  it('uses a closed semantic name and preserves decorative versus named accessibility', () => {
    const context = createSurfaceContext();
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <Icon name="search" accessibilityLabel="Search" testID="search-icon" />
        <Icon name="check" testID="decorative-icon" />
      </PluginUiProvider>,
    );

    expect(mount.container.querySelector('[aria-label="Search"]')).not.toBeNull();
    expect(mount.container.querySelector('[data-testid="decorative-icon"]')?.getAttribute('aria-hidden')).toBe('true');
    mount.unmount();
  });
});
