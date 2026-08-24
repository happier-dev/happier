import { afterEach, describe, expect, it } from 'vitest';

import {
  createDesktopPetOverlayBridgeProbeInitScript,
  createDesktopPetOverlayWindowState,
  desktopPetOverlayBridgeInvocationKey,
  type DesktopPetOverlayProbeWindow,
} from './desktopPetOverlayBridgeProbe';

const originalWindow = Reflect.get(globalThis, 'window') as DesktopPetOverlayProbeWindow | undefined;

afterEach(() => {
  if (originalWindow) {
    Reflect.set(globalThis, 'window', originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
});

describe('desktop pet overlay bridge probe', () => {
  it('records Tauri invocations while preserving an existing invoke implementation', async () => {
    const forwarded: Array<Readonly<{ command: string; args?: Record<string, unknown> }>> = [];
    const fakeWindow = {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args?: Record<string, unknown>) => {
          forwarded.push({ command, args });
          return { forwarded: command };
        },
      },
    } as unknown as DesktopPetOverlayProbeWindow;
    Reflect.set(globalThis, 'window', fakeWindow);

    createDesktopPetOverlayBridgeProbeInitScript()();

    const result = await fakeWindow.__TAURI_INTERNALS__?.invoke?.('desktop_pet_overlay_apply_drag_delta', {
      payload: { pointerId: '7', dx: 12, dy: 4, coordinateSpace: 'screen' },
    });

    expect(result).toEqual({ forwarded: 'desktop_pet_overlay_apply_drag_delta' });
    expect(forwarded).toEqual([
      {
        command: 'desktop_pet_overlay_apply_drag_delta',
        args: { payload: { pointerId: '7', dx: 12, dy: 4, coordinateSpace: 'screen' } },
      },
    ]);
    expect(fakeWindow[desktopPetOverlayBridgeInvocationKey]).toEqual([
      {
        command: 'desktop_pet_overlay_apply_drag_delta',
        args: { payload: { pointerId: '7', dx: 12, dy: 4, coordinateSpace: 'screen' } },
      },
    ]);
  });

  it('provides null for read-window-state when no Tauri invoke exists', async () => {
    const fakeWindow = {} as unknown as DesktopPetOverlayProbeWindow;
    Reflect.set(globalThis, 'window', fakeWindow);

    createDesktopPetOverlayBridgeProbeInitScript()();

    await expect(fakeWindow.__TAURI_INTERNALS__?.invoke?.('desktop_pet_overlay_read_window_state')).resolves.toBeNull();
  });

  it('provides the configured native window state to the overlay route', async () => {
    const fakeWindow = {} as unknown as DesktopPetOverlayProbeWindow;
    Reflect.set(globalThis, 'window', fakeWindow);
    const windowState = createDesktopPetOverlayWindowState();

    createDesktopPetOverlayBridgeProbeInitScript({ windowState })();

    await expect(fakeWindow.__TAURI_INTERNALS__?.invoke?.('desktop_pet_overlay_read_window_state')).resolves.toEqual(
      windowState,
    );
  });

  it('builds a native tray activity payload for a session', () => {
    expect(createDesktopPetOverlayWindowState({ sessionId: 'session-1', title: 'Session one' })).toMatchObject({
      activity: {
        state: 'running',
        reason: 'running',
        sessionId: 'session-1',
        trayItems: [{ sessionId: 'session-1', title: 'Session one', status: 'running' }],
      },
    });
  });
});
