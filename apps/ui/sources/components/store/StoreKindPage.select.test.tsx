import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
const routerMock = await vi.hoisted(async () =>
  (await import('@/dev/testkit/mocks/router')).createExpoRouterMock(),
);
vi.mock('expo-router', () => routerMock.module);

const {
  StoreRegistryItemSelectContext,
  useOpenRegistryItem,
  useAddRegistryItem,
} = await import('./StoreKindPage');

afterEach(standardCleanup);

const item = {
  kind: 'app' as const,
  sourceId: 'happier',
  itemId: 'postgres',
  title: 'PostgreSQL',
  version: '17',
};

it('hands a row press and its + to the embedding host instead of opening the listing (Deployments → Add)', async () => {
  const select = vi.fn();
  let open: ((value: typeof item) => void) | null = null;
  let add: ((value: typeof item) => void) | null = null;
  function Probe() {
    open = useOpenRegistryItem();
    add = useAddRegistryItem();
    return null;
  }
  await renderScreen(
    <StoreRegistryItemSelectContext.Provider value={select}>
      <Probe />
    </StoreRegistryItemSelectContext.Provider>,
  );
  open!(item);
  add!(item);
  expect(select.mock.calls).toEqual([[item], [item]]);
  expect(routerMock.spies.push).not.toHaveBeenCalled();
});
