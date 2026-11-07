import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

const routerBack = vi.hoisted(() => vi.fn());
const routerReplace = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({
    router: { back: routerBack, replace: routerReplace },
  }).module;
});

vi.mock('@expo/vector-icons', async () => {
  const { createExpoVectorIconsMock } =
    await import('@/dev/testkit/mocks/icons');
  return createExpoVectorIconsMock();
});

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});

import { withSessionsFallbackBack } from './sessionsFallbackBack';

type Navigation = Parameters<
  ReturnType<typeof withSessionsFallbackBack>
>[0]['navigation'];

async function pressBack(navigation: Navigation) {
  const options = withSessionsFallbackBack(
    { headerShown: true, headerTitle: '' },
    'home-back',
  )({ navigation });
  expect(options).toMatchObject({ headerShown: true, headerTitle: '' });
  const renderBack = options.headerLeft as (props: {
    tintColor?: string;
  }) => React.ReactNode;
  const header = await renderScreen(<>{renderBack({})}</>);
  await header.pressByTestIdAsync('home-back');
}

describe('withSessionsFallbackBack', () => {
  beforeEach(() => {
    routerBack.mockReset();
    routerReplace.mockReset();
  });

  // J-HOME: a browser reload of the phone Home left nothing below it, and the page had no way back.
  it('returns to Sessions when a reload left nothing behind the page', async () => {
    await pressBack({
      canGoBack: () => false,
      getState: () => ({ index: 0, routes: [{}] }),
    });
    expect(routerReplace).toHaveBeenCalledWith('/');
    expect(routerBack).not.toHaveBeenCalled();
  });

  it('goes back to the page that opened it when there is one', async () => {
    const goBack = vi.fn();
    await pressBack({
      canGoBack: () => true,
      goBack,
      getState: () => ({ index: 1, routes: [{}, {}] }),
    });
    expect(goBack).toHaveBeenCalledOnce();
    expect(routerReplace).not.toHaveBeenCalled();
  });
});
