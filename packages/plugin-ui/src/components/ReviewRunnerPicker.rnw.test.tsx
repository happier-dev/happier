import { describe, expect, it } from 'vitest';
import { ConnectedAccountPurposeTargetChooser, ReviewRunnerPicker } from '@happier-dev/plugin-ui/components';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';

describe('review authoring on an unsupported presentation host', () => {
  it('keeps runner and account selection explicitly unavailable', () => {
    const context = createSurfaceContext();
    const mounted = mountThroughReactNativeWeb(<PluginUiProvider context={context} hostApi={createHostApiStub(context)}>
      <ReviewRunnerPicker testID="runner" title="Agent" options={[]} selectedId={null} onSelect={() => {}} />
      <ConnectedAccountPurposeTargetChooser testID="account" localizedTextPluginId="com.acme.review"
        declaration={{ purpose: 'review', service: { pluginId: 'com.acme.review', localId: 'account' } }}
        value={null} onChange={() => {}} />
    </PluginUiProvider>);
    expect(mounted.container.querySelector('[data-testid="runner-unavailable"]')?.textContent).toContain('unavailable');
    expect(mounted.container.querySelector('[data-testid="account-unavailable"]')?.textContent).toContain('unavailable');
    expect(mounted.container.querySelector('[role="button"]')).toBeNull();
    mounted.unmount();
  });
});
