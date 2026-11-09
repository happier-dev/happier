import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { hitAreaOverlap, readHitArea } from '@/dev/testkit/harness/hitFrameReach';
import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const { RepositoryTreeToolbar } = await import('./RepositoryTreeToolbar');

const DRAWN = { width: 32, height: 32 };

function renderToolbar(layout: 'row' | 'inline') {
  return renderScreen(
    <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
      <RepositoryTreeToolbar
        testIDPrefix="repository-tree"
        searchValue=""
        onSearchValueChange={() => {}}
        showSearch={false}
        layout={layout}
        changedOnly={false}
        changedCount="none"
        onChangedOnlyChange={() => {}}
        detailsMode={false}
        onDetailsModeChange={() => {}}
        onCollapseAll={null}
        onRefresh={() => {}}
        refreshing={false}
        onRequestClose={() => {}}
      />
    </HappierUiPlatformProvider>,
  );
}

describe('RepositoryTreeToolbar hit areas', () => {
  // 32 px View and Close sit 6 px apart (4 px inline): unbounded, each reaches 6 px sideways and they overlap.
  it.each([['row', 6], ['inline', 4]] as const)('splits the %s layout gap between the View menu and Close', async (layout, gap) => {
    const screen = await renderToolbar(layout);
    const view = readHitArea(screen.findByTestId('repository-tree-view')!, DRAWN);
    const close = readHitArea(screen.findByTestId('repository-tree-close')!, DRAWN);
    expect(hitAreaOverlap(view, close, { axis: 'horizontal', gap })).toBe(0);
    expect(view.drawn).toEqual(DRAWN);
  });
});
