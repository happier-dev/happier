/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

/** A cold start's loading chain: boot → Account restore → a pane loading → Home loading → Home drawn. */
type Stage = 'boot' | 'restore' | 'pane' | 'home-loading' | 'home';

function App({ stage }: Readonly<{ stage: Stage }>) {
  return (
    <>
      {stage === 'boot' ? <AppLaunchState testID="app-boot-loading" /> : null}
      {stage === 'restore' ? (
        <AppLaunchState testID="workspace-account-restoring" />
      ) : null}
      {stage === 'pane' ? <PaneLoadingFallback /> : null}
      {stage === 'home-loading' ? (
        <HomeHubLoading testID="home-hub.loading" />
      ) : null}
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

  it('keeps one Loading planet from boot through restore and loading panes until the destination has drawn', async () => {
    const screen = await renderScreen(<App stage="boot" />);
    const curtain = () => screen.findAllHostsByTestId('launch-curtain');
    expect(curtain()).toHaveLength(1);
    expect(screen.findAllHostsByTestId('launch-curtain-still')).toHaveLength(1);
    const firstCurtain = curtain()[0];
    for (const stage of ['restore', 'pane', 'home-loading'] as const) {
      await screen.update(<App stage={stage} />);
      await frame();
      await frame();
      // The same curtain instance, still up: no surface swap shows the page behind it.
      expect(curtain()).toEqual([firstCurtain]);
      expect(curtain()[0]!.props.pointerEvents).toBe('auto');
    }
    // Home has drawn: nothing holds the curtain across a painted frame, so it leaves (this DOM has no Web
    // Animations, so the fade completes at once) and takes the shell's Still frame with it.
    await screen.update(<App stage="home" />);
    await frame();
    expect(curtain()).toHaveLength(1);
    await frame();
    expect(curtain()).toHaveLength(0);
    expect(document.documentElement.classList.contains('launch-planet')).toBe(
      false,
    );
    // A loading pane later in the session never raises it again.
    await screen.update(<App stage="pane" />);
    await frame();
    expect(curtain()).toHaveLength(0);
  });
});
