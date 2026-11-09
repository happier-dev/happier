import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ATMOSPHERE_PICTURES } from '@happier-dev/brand/atmosphere';
import { DEFAULT_HOME_ATMOSPHERE } from '@happier-dev/protocol/account/settings/accountSettings';
import { renderScreen } from '@/dev/testkit';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>>;
afterEach(() => {
  browser?.restore();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('admits an overdue resettle only when the desktop window becomes visible', async () => {
  browser = await installBrowserRuntimeForTests({ url: 'http://localhost/' });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const selectedAtMs = 1_800_000_000_000;
  vi.setSystemTime(selectedAtMs);
  let visibility: DocumentVisibilityState = 'hidden';
  // The desktop bridge and document are host boundaries; visibility policy stays real.
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke: () => undefined });
  vi.spyOn(browser.document, 'visibilityState', 'get').mockImplementation(() => visibility);
  vi.spyOn(browser.document, 'hasFocus').mockReturnValue(false);
  const { storage } = await import('@/sync/domains/state/storageStore');
  const { pictureStore } = await import('./pictureStore');
  const { HomeIdleResettle } = await import('./HomeIdleResettle');
  const previous = storage.getState();
  const picture = ATMOSPHERE_PICTURES[0];
  const ensure = vi.spyOn(pictureStore, 'ensureBuiltin').mockImplementation(() => new Promise(() => {}));
  storage.setState(state => ({ ...state, settings: { ...state.settings, homeAtmosphere: {
    ...DEFAULT_HOME_ATMOSPHERE, source: 'picture', picture: {
      ...DEFAULT_HOME_ATMOSPHERE.picture, ref: { kind: 'builtin', id: picture.id },
      selectedAtMs,
    },
  } } }));
  const screen = await renderScreen(<HomeIdleResettle picture={picture.id} focused writing={false} sending={false} />);
  try {
    await act(async () => { vi.advanceTimersByTime(3_600_000); });
    expect(ensure).not.toHaveBeenCalled();
    await act(async () => {
      visibility = 'visible';
      browser.document.dispatchEvent(new browser.window.Event('visibilitychange'));
    });
    await act(async () => { vi.advanceTimersByTime(0); });
    expect(ensure).toHaveBeenCalledTimes(1);
  } finally {
    await screen.unmount();
    await act(async () => { storage.setState(previous, true); });
  }
});
