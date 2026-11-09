import { afterEach, expect, it, vi } from 'vitest';
import { createDefaultActionExecutor } from './defaultActionExecutor';

// Tauri's native event transport is the OS boundary; host availability and Action dispatch stay real.
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

afterEach(() => { vi.unstubAllGlobals(); });

it('the default answering-client executor reads the native display owner once and preserves unavailable', async () => {
    const result = { displays: [
        { storageKey: 'desk', name: 'Desk', builtIn: false, primary: true, connected: true, inUse: true },
    ], automaticResolvesTo: 'desk' };
    const commands: string[] = [];
    let available = true;
    const listeners = new Map<string, (event: { availability: unknown }) => void>();
    const eventBoundary = await import('@tauri-apps/api/event');
    vi.spyOn(eventBoundary, 'listen').mockImplementation(async (event, handler) => {
        listeners.set(event, payload => handler({ event, id: 1, payload }));
        return () => { listeners.delete(event); };
    });
    vi.stubGlobal('navigator', { userAgent: 'Tauri' });
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string) => {
        commands.push(command);
        if (command === 'desktop_host_get_availability') {
            return { activity: { kind: 'available' }, pet: { kind: 'available' }, windows: { kind: 'available' } };
        }
        if (command === 'desktop_displays_list' && available) return result;
        throw new Error(`Unexpected native command: ${command}`);
    } });
    const executor = createDefaultActionExecutor({ admittedClientActionId: 'desktop.displays.list' });
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    expect(commands.filter(command => command === 'desktop_displays_list')).toHaveLength(0);
    expect(await executor.execute('desktop.displays.list', {}, context)).toEqual({ ok: true, result });
    expect(commands.filter(command => command === 'desktop_displays_list')).toHaveLength(1);
    available = false;
    listeners.get('activityOverlay://state')?.({ availability: { activity: { kind: 'unavailable', reason: 'layer_shell_unavailable' } } });
    expect(await executor.execute('desktop.displays.list', {}, context)).toEqual({
        ok: false, errorCode: 'unavailable', error: 'layer_shell_unavailable',
    });
    expect(commands.filter(command => command === 'desktop_displays_list')).toHaveLength(1);
});
