import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks();

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

// The user's list density is a stored local setting (storage boundary); the density owner itself runs.
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

const { Item } = await import('./Item');
const { Text } = await import('react-native');

const NAME = 'SWEEP-A1 DJ28 private registry preview';

// The title floor for a passive end fact costs one measure per row (UI refinements 14:58Z, "measure the end fact"):
// the row commits once more when its name is measured, and never again for the same width.
it('measures a passive row title once and settles: one extra commit, none for a repeated width', async () => {
  let commits = 0;
  const screen = await renderScreen(
    <React.Profiler
      id="row"
      onRender={() => {
        commits += 1;
      }}
    >
      <Item
        testID="row"
        title={NAME}
        density="compact"
        showChevron={false}
        onPress={() => {}}
        rightElementPassive
        rightElement={<Text numberOfLines={1}>2 environments</Text>}
      />
    </React.Profiler>,
  );
  const measure = screen.findAll(
    (node) =>
      node.props != null && node.props['aria-hidden'] === true &&
      node.props.children === NAME &&
      typeof node.props.onLayout === 'function',
  )[0];
  expect(measure).toBeDefined();
  const mounted = commits;
  const layout = (width: number) =>
    act(() => {
      measure!.props.onLayout({
        nativeEvent: { layout: { width, height: 18, x: 0, y: 0 } },
      });
    });
  await layout(240);
  expect(commits - mounted).toBe(1);
  await layout(240);
  await layout(240.4);
  expect(commits - mounted).toBe(1);
});

it('measures nothing for a row whose end is a control or which has no end', async () => {
  const screen = await renderScreen(
    <>
      <Item testID="plain" title={NAME} showChevron={false} />
      <Item
        testID="control"
        title={NAME}
        showChevron={false}
        rightElement={<Text>Switch</Text>}
      />
    </>,
  );
  const measures = screen.findAll(
    (node) =>
      node.props != null && node.props['aria-hidden'] === true &&
      node.props.children === NAME &&
      typeof node.props.onLayout === 'function',
  );
  expect(measures).toHaveLength(0);
});
