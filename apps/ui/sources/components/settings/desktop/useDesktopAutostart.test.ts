import { describe, expect, it, vi, afterEach } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, flushHookEffects } from '@/dev/testkit';

const desktopState = vi.hoisted(() => ({ value: false }));
const invokeMock = vi.hoisted(() => vi.fn<(command: string, args?: Record<string, unknown>) => Promise<boolean>>(
    async () => false,
));

vi.mock('@/utils/platform/tauri', async () => {
    const actual = await vi.importActual<typeof import('@/utils/platform/tauri')>('@/utils/platform/tauri');
    return {
        ...actual,
        isTauriDesktop: () => desktopState.value,
        invokeTauri: invokeMock,
    };
});

describe('useDesktopAutostart', () => {
    afterEach(() => {
        desktopState.value = false;
        invokeMock.mockReset();
        invokeMock.mockResolvedValue(false);
    });

    it('stays unsupported and does not call Tauri outside the desktop shell', async () => {
        const { useDesktopAutostart } = await import('./useDesktopAutostart');
        const hook = await renderHook(() => useDesktopAutostart());

        await flushHookEffects();

        expect(hook.getCurrent().supported).toBe(false);
        expect(hook.getCurrent().enabled).toBe(false);
        expect(invokeMock).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('loads the current autostart state from Tauri on desktop', async () => {
        desktopState.value = true;
        invokeMock.mockImplementation(async (command: string) => {
            if (command === 'desktop_get_autostart_enabled') {
                return true;
            }
            throw new Error(`Unexpected command: ${command}`);
        });

        const { useDesktopAutostart } = await import('./useDesktopAutostart');
        const hook = await renderHook(() => useDesktopAutostart());

        await flushHookEffects();

        expect(hook.getCurrent().supported).toBe(true);
        expect(hook.getCurrent().enabled).toBe(true);
        expect(hook.getCurrent().loading).toBe(false);

        await hook.unmount();
    });

    it('toggles autostart through the desktop command surface', async () => {
        desktopState.value = true;
        invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
            if (command === 'desktop_get_autostart_enabled') {
                return false;
            }
            if (command === 'desktop_set_autostart_enabled') {
                return Boolean(args?.enabled);
            }
            throw new Error(`Unexpected command: ${command}`);
        });

        const { useDesktopAutostart } = await import('./useDesktopAutostart');
        const hook = await renderHook(() => useDesktopAutostart());

        await flushHookEffects();
        await act(async () => {
            await hook.getCurrent().setEnabled(true);
        });
        await flushHookEffects();

        expect(invokeMock).toHaveBeenCalledWith('desktop_set_autostart_enabled', { enabled: true });
        expect(hook.getCurrent().enabled).toBe(true);
        expect(hook.getCurrent().loading).toBe(false);

        await hook.unmount();
    });
});
