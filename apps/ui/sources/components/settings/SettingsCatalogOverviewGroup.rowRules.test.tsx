import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks();

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
// The user's list density is a stored local setting (storage boundary).
vi.mock('@/sync/store/hooks', async () => {
  const { createUseLocalSettingMock } =
    await import('@/dev/testkit/mocks/storage');
  return {
    useLocalSetting: createUseLocalSettingMock({
      values: { uiItemDensity: 'cozy', uiFontScale: 1 },
    }),
    useActiveServerAccountScope: () => null,
    useUser: () => null,
  };
});
vi.mock('@/sync/domains/state/storage', async () => {
  const { createStorageModuleStub, createUseLocalSettingMock } =
    await import('@/dev/testkit/mocks/storage');
  return createStorageModuleStub({
    useLocalSetting: createUseLocalSettingMock({
      values: { uiContentWidthMode: 'compact' },
    }),
  });
});
vi.mock('@/sync/domains/state/storageStore', async () => {
  const { createStorageStoreMock } =
    await import('@/dev/testkit/mocks/storage');
  const storage = createStorageStoreMock({});
  return { storage, getStorage: () => storage };
});

afterEach(() => {
  standardCleanup();
});

const [{ SettingsCatalogOverviewGroup }, { ListPresentationProvider }] =
  await Promise.all([
    import('./SettingsCatalogOverviewGroup'),
    import('@/components/ui/lists/listPresentation'),
  ]);

describe('SettingsCatalogOverviewGroup row rules', () => {
  // G1 (lab settings-row-icon-1110 B, owner 2026-11-17 23:52Z): the Settings sheet's two-line rows are ruled. The rows
  // came from one wrapper element, so the group handed that wrapper "first and last" and every row dropped its hairline.
  it('rules every two-line destination row of the real catalog group but the last', async () => {
    const screen = await renderScreen(
      <ListPresentationProvider value="page">
        <SettingsCatalogOverviewGroup
          groupId="groupProfileAndAccount"
          router={{ push: () => {} } as never}
        />
      </ListPresentationProvider>,
    );
    const rows = screen.tree.root.findAll(
      (node) =>
        typeof node.type === 'string' &&
        typeof node.props.testID === 'string' &&
        node.props.testID.startsWith('settings-catalog-page-item.'),
    );
    expect(rows.length).toBeGreaterThan(2);
    const ruled = rows.map(
      (row) =>
        row.findAll(
          (node) =>
            typeof node.type === 'string' &&
            node.props.role === 'separator' &&
            flattenTestStyle(node.props.style).backgroundColor !== undefined,
        ).length > 0,
    );
    expect(ruled).toEqual(rows.map((_, index) => index < rows.length - 1));
  });
});
