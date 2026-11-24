/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLaunchCurtainState } from '@/boot/launchCurtain';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { HomeHubLoading } from '@/components/hub/HomeHubLoading';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';

import { AppLaunchState, LaunchCurtain } from './AppLaunchState';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
// The platform's reduced-motion setting: the curtain shows its Still frame, so no WebGL surface loads.
vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
  useReducedMotionPreference: () => true,
}));

/** The first frame owns launch while the lazy pane loads independently. */
type Stage = 'boot' | 'restore' | 'home-loading' | 'home';

function CurtainProbe() {
  return React.createElement('CurtainProbe', { state: useLaunchCurtainState() });
}

function App({ stage, paneLoading = false }: Readonly<{ stage: Stage; paneLoading?: boolean }>) {
  return (
    <>
      {stage === 'boot' ? <AppLaunchState testID="app-boot-loading" /> : null}
      {stage === 'restore' ? (
        <AppLaunchState testID="workspace-account-restoring" />
      ) : null}
      {paneLoading ? <PaneLoadingFallback testID="lazy-pane-loading" /> : null}
      {stage === 'home-loading' ? (
        <HomeHubLoading testID="home-hub.loading" />
      ) : null}
      <CurtainProbe />
      <LaunchCurtain />
    </>
  );
}

async function frame() {
  await act(async () => {
    vi.advanceTimersByTime(16);
  });
}

describe('launch curtain', () => {
  beforeEach(() => {
    // The HTML shell starts the curtain; the store reads it on first use.
    document.documentElement.classList.add('launch-planet');
    vi.useFakeTimers({
      toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.classList.remove('launch-planet');
    standardCleanup();
  });

  it('hands the curtain from boot through restore to Home, then releases it while a lazy pane is still loading', async () => {
    const screen = await renderScreen(<App stage="boot" />);
    const curtain = () => screen.findAllHostsByTestId('launch-curtain');
    expect(curtain()).toHaveLength(1);
    expect(screen.findAllHostsByTestId('launch-curtain-still')).toHaveLength(1);
    const firstCurtain = curtain()[0];
    const readCurtain = () => screen.root.findByType('CurtainProbe').props.state;
    const pendingPane = () => screen.findHostByTestId('lazy-pane-loading');
    for (const stage of ['restore', 'home-loading'] as const) {
      await screen.update(<App stage={stage} paneLoading />);
      await frame();
      await frame();
      // The same curtain instance, still up: no surface swap shows the page behind it.
      expect(curtain()).toEqual([firstCurtain]);
      // A mounted destination remains interactive even when another loading surface holds the layer.
      expect(curtain()[0]!.props.pointerEvents).toBe('none');
      expect(curtain()[0]!.props.inert).toBe(true);
    }
    expect(readCurtain()).toBe('up');
    expect(pendingPane()).not.toBeNull();
    await screen.update(<App stage="home" paneLoading />);
    await frame();
    expect(curtain()).toHaveLength(1);
    await frame();
    // The DOM has no Web Animations, so LaunchCurtain completes its fade at once.
    expect(readCurtain()).toBe('gone');
    expect(curtain()).toHaveLength(0);
    expect(pendingPane()).not.toBeNull();
    expect(document.documentElement.classList.contains('launch-planet')).toBe(
      false,
    );
    await screen.update(<App stage="home" />);
    expect(pendingPane()).toBeNull();
    expect(readCurtain()).toBe('gone');
  });
});
