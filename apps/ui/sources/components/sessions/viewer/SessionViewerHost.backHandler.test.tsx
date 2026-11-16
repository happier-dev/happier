import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithAppProviders } from '@/dev/testkit/render/renderWithAppProviders';
import { invokeTestInstanceHandler } from '@/dev/testkit/render/renderScreen';

import { useOptionalSessionViewerController, type SessionViewerController } from './SessionViewerController';
import { SessionViewerControllerProvider } from './SessionViewerControllerProvider';
import { SessionViewerHost } from './SessionViewerHost';

const platform = vi.hoisted(() => ({ os: 'android' as 'android' | 'web' }));
const nativeBack = vi.hoisted(() => ({
  addEventListener: vi.fn((_eventName: string, _handler: () => boolean) => ({ remove: () => {} })),
}));

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    Platform: {
      get OS() { return platform.os; },
      select: (spec: Record<string, unknown>) => spec[platform.os] ?? spec.default,
    },
    BackHandler: nativeBack,
  });
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mountExpanded(wrap: (children: React.ReactElement) => React.ReactElement = children => children) {
  const harness: { controller: SessionViewerController | null } = { controller: null };
  function Probe() {
    harness.controller = useOptionalSessionViewerController();
    return null;
  }
  const result = await renderWithAppProviders(wrap(
    <SessionViewerControllerProvider
      sessionId="session-a"
      serverId="home-a"
      phone={false}
      canPresentSource={() => true}
      openDocked={() => {}}
    >
      <Probe />
      <SessionViewerHost sessionId="session-a" serverId="home-a" />
    </SessionViewerControllerProvider>,
  ));
  await act(async () => {
    harness.controller!.port.apply({ kind: 'viewer.open', source: 'computer' });
  });
  await act(async () => {
    invokeTestInstanceHandler(
      result.tree.root.findByProps({ testID: 'session-viewer-host' }),
      'onLayout',
      { nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 800 } } },
    );
  });
  await act(async () => {
    harness.controller!.port.apply({ kind: 'viewer.expand' });
  });
  expect(harness.controller!.state.mode).toBe('expanded');
  return Object.assign(result, { controller: () => harness.controller! });
}

describe('SessionViewerHost hardware Back', () => {
  beforeEach(() => {
    nativeBack.addEventListener.mockClear();
  });

  it('listens for hardware Back on Android while expanded', async () => {
    platform.os = 'android';
    const result = await mountExpanded();
    expect(nativeBack.addEventListener).toHaveBeenCalledWith('hardwareBackPress', expect.any(Function));
    await result.unmount();
  });

  it('leaves hardware Back to the shown Session while its retained Session is hidden on the phone stack', async () => {
    platform.os = 'android';
    const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
    const retained = (focused: boolean) => (children: React.ReactElement) => <DestinationInstanceHost stackOwned
      tabId="phone-session:a" ref={{ kind: 'probe', params: {} }} pathname="" focused={focused} visible={focused}>{children}</DestinationInstanceHost>;
    const pressBack = () => {
      const calls = nativeBack.addEventListener.mock.calls;
      return calls[calls.length - 1][1]();
    };
    const hidden = await mountExpanded(retained(false));
    const handledWhileHidden = await act(async () => pressBack());
    const modeWhileHidden = hidden.controller().state.mode;
    await hidden.unmount();
    nativeBack.addEventListener.mockClear();
    const shown = await mountExpanded(retained(true));
    const handledWhileShown = await act(async () => pressBack());
    await shown.unmount();
    expect({ handledWhileHidden, modeWhileHidden, handledWhileShown })
      .toEqual({ handledWhileHidden: false, modeWhileHidden: 'expanded', handledWhileShown: true });
  });

  it('never reaches the platform Back listener on web, where React Native reports it unsupported', async () => {
    platform.os = 'web';
    const result = await mountExpanded();
    expect(nativeBack.addEventListener).not.toHaveBeenCalled();
    await result.unmount();
  });
});
