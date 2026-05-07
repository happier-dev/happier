import type { Page } from '@playwright/test';
import { describe, expect, it } from 'vitest';

import {
  applyFakeTauriDesktopCommand,
  createFakeTauriDesktopState,
  installFakeTauriDesktopBridge,
  invokeFakeTauriDesktopCommand,
  readFakeTauriDesktopState,
} from './fakeTauriDesktop';

type BrowserScript = (state: ReturnType<typeof createFakeTauriDesktopState>) => void;

function createBridgeHarness() {
  const browserWindow: Record<string, unknown> = {};
  const previousWindow = (globalThis as Record<string, unknown>).window;
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const page = {
    addInitScript: async (script: BrowserScript, state: ReturnType<typeof createFakeTauriDesktopState>) => {
      (globalThis as Record<string, unknown>).window = browserWindow;
      const isolatedScript = new Function('state', `return (${script.toString()})(state);`) as BrowserScript;
      isolatedScript(state);
    },
    evaluate: async <Result, Arg>(
      callback: (arg: Arg) => Result | Promise<Result>,
      arg?: Arg,
    ): Promise<Result> => {
      (globalThis as Record<string, unknown>).window = browserWindow;
      return await callback(arg as Arg);
    },
    url: () => 'about:blank',
  };

  return {
    page: page as unknown as Page,
    restore: () => {
      if (hadWindow) {
        (globalThis as Record<string, unknown>).window = previousWindow;
      } else {
        delete (globalThis as Record<string, unknown>).window;
      }
    },
  };
}

describe('fakeTauriDesktop', () => {
  it('returns the canonical window chrome policy for the active Tauri window', async () => {
    const initial = createFakeTauriDesktopState({
      isMaximized: false,
      platform: 'windows',
      strategy: 'custom-controls',
    });

    const mainWindowPolicy = await applyFakeTauriDesktopCommand(
      initial,
      'desktop_get_window_chrome_policy',
    );

    const overlayWindowPolicy = await applyFakeTauriDesktopCommand(
      {
        ...initial,
        currentWindowLabel: 'pet_overlay',
      },
      'desktop_get_window_chrome_policy',
    );

    expect(mainWindowPolicy.result).toEqual({
      strategy: 'custom-controls',
    });
    expect(overlayWindowPolicy.result).toEqual({
      strategy: 'none',
    });
  });

  it('tracks the canonical desktop window bridge commands and maximize state', async () => {
    const initial = createFakeTauriDesktopState({
      isMaximized: false,
      platform: 'windows',
      strategy: 'custom-controls',
    });

    const minimizeResult = await applyFakeTauriDesktopCommand(
      initial,
      'desktop_minimize_window',
    );
    const maximizeResult = await applyFakeTauriDesktopCommand(
      minimizeResult.state,
      'desktop_toggle_window_maximize',
    );
    const dragResult = await applyFakeTauriDesktopCommand(
      maximizeResult.state,
      'desktop_start_window_dragging',
    );
    const closeResult = await applyFakeTauriDesktopCommand(
      dragResult.state,
      'desktop_close_window',
    );
    const maximizedState = await applyFakeTauriDesktopCommand(
      closeResult.state,
      'desktop_get_window_state',
    );

    expect(minimizeResult.result).toBe(true);
    expect(maximizeResult.result).toBe(true);
    expect(dragResult.result).toBe(true);
    expect(closeResult.result).toBe(true);
    expect(maximizedState.result).toEqual({
      isMaximized: true,
    });
    expect(maximizedState.state.controls).toEqual({
      closeCount: 1,
      dragCount: 1,
      minimizeCount: 1,
      toggleMaximizeCount: 1,
    });
    expect(maximizedState.state.invokeLog.map((entry) => entry.command)).toEqual([
      'desktop_minimize_window',
      'desktop_toggle_window_maximize',
      'desktop_start_window_dragging',
      'desktop_close_window',
      'desktop_get_window_state',
    ]);
  });

  it('persists autostart settings and desktop update install state', async () => {
    const initial = createFakeTauriDesktopState({
      autostartEnabled: false,
      updateAvailable: {
        version: '1.2.3',
      },
    });

    const autostartEnabled = await applyFakeTauriDesktopCommand(
      initial,
      'desktop_set_autostart_enabled',
      { enabled: true },
    );
    const autostartState = await applyFakeTauriDesktopCommand(
      autostartEnabled.state,
      'desktop_get_autostart_enabled',
    );
    const installResult = await applyFakeTauriDesktopCommand(
      autostartState.state,
      'desktop_install_update',
    );
    const updateState = await applyFakeTauriDesktopCommand(
      installResult.state,
      'desktop_fetch_update',
    );

    expect(autostartEnabled.result).toBe(true);
    expect(autostartState.result).toBe(true);
    expect(installResult.result).toBe(true);
    expect(updateState.result).toEqual({
      installed: true,
      version: '1.2.3',
    });
  });

  it('emits desktop window state events from installed bridge commands', async () => {
    const harness = createBridgeHarness();
    try {
      await installFakeTauriDesktopBridge(harness.page, {
        state: {
          platform: 'windows',
          strategy: 'custom-controls',
        },
      });

      const observed: unknown[] = [];
      await harness.page.evaluate(async () => {
        const win = window as Window & {
          __TAURI_INTERNALS__?: {
            invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
            transformCallback?: (callback: (event: unknown) => void) => number;
          };
        };
        const handler = win.__TAURI_INTERNALS__?.transformCallback?.((event) => {
          (window as Window & { __OBSERVED_EVENTS__?: unknown[] }).__OBSERVED_EVENTS__ = [
            ...((window as Window & { __OBSERVED_EVENTS__?: unknown[] }).__OBSERVED_EVENTS__ ?? []),
            event,
          ];
        });
        await win.__TAURI_INTERNALS__?.invoke('plugin:event|listen', {
          event: 'desktopWindow://state',
          handler,
        });
      });

      await invokeFakeTauriDesktopCommand(harness.page, 'desktop_toggle_window_maximize');

      observed.push(...await harness.page.evaluate(() => {
        return (window as Window & { __OBSERVED_EVENTS__?: unknown[] }).__OBSERVED_EVENTS__ ?? [];
      }));

      expect(observed).toEqual([
        expect.objectContaining({
          event: 'desktopWindow://state',
          payload: { isMaximized: true },
        }),
      ]);
      await expect(readFakeTauriDesktopState(harness.page)).resolves.toMatchObject({
        isMaximized: true,
      });
    } finally {
      harness.restore();
    }
  });
});
