import { Pressable, Text } from 'react-native';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { PageHeader } from './PageHeader.js';

describe('public PageHeader composition', () => {
  it('shows a column summary after the identity row and retains an actionable control', () => {
    const context = createSurfaceContext();
    let refreshed = false;
    const view = mountThroughReactNativeWeb(<PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <PageHeader testID="header" title="Personal" compactPresentation="centered" detailsPlacement="column" details={<Text testID="summary">2 accounts need attention</Text>} actions={<Pressable accessibilityRole="button" testID="refresh" onPress={() => { refreshed = true; }}><Text>Refresh</Text></Pressable>} />
    </PluginUiProvider>);
    try {
      expect(view.container.querySelector('[data-testid="summary"]')?.textContent).toBe('2 accounts need attention');
      expect(view.container.querySelector('[data-testid="header-title-row"] [data-testid="summary"]')).toBeNull();
      act(() => view.container.querySelector<HTMLElement>('[data-testid="refresh"]')?.click());
      expect(refreshed).toBe(true);
    } finally {
      view.unmount();
    }
  });
});
