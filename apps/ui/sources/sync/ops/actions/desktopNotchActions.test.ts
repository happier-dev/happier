import { afterEach, expect, it, vi } from 'vitest';
import { createDefaultActionExecutor } from './defaultActionExecutor';
import { listenDesktopActivityOverlayPresentation } from '@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge';
import { buildCommandPaletteCommands } from '@/components/appShell/commandPalette/buildCommandPaletteCommands';

// Only native IPC/event delivery is substituted. Action admission, host and bridge stay real.
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
afterEach(() => { vi.unstubAllGlobals(); });

it('desktop.notch.set pinned asks the route owner to focus its first control and rest releases it', async () => {
    const delivered: unknown[] = [];
    let pending: unknown = { state: 'open', focus: true };
    const listeners = new Map<string, (payload: unknown) => void>();
    const events = await import('@tauri-apps/api/event');
    vi.spyOn(events, 'listen').mockImplementation(async (event, handler) => {
        listeners.set(event, payload => handler({ event, id: 1, payload }));
        return () => { listeners.delete(event); };
    });
    vi.stubGlobal('navigator', { userAgent: 'Tauri' });
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args: Record<string, unknown>) => {
        if (command === 'desktop_host_get_availability') return {
            activity: { kind: 'available' }, pet: { kind: 'available' }, windows: { kind: 'available' },
        };
        if (command === 'desktop_activity_overlay_request_presentation') {
            pending = { state: args.requestedState, focus: args.requestedState !== 'rest' };
            listeners.get('activityOverlay://presentation')?.(pending);
            return;
        }
        if (command === 'desktop_activity_overlay_take_presentation_request') {
            const request = pending;
            pending = null;
            return request;
        }
        throw new Error(`Unexpected command ${command}`);
    } });
    const dispose = await listenDesktopActivityOverlayPresentation(payload => delivered.push(payload));
    const executor = createDefaultActionExecutor();
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    const commands = buildCommandPaletteCommands({
        sessionsById: {}, isDev: false, activeSessionId: null,
        features: { executionRunsEnabled: false, voiceEnabled: false },
        nav: { push: () => {}, openNewSession: () => {}, navigateToSession: () => {} },
        actions: executor, alert: () => {},
    });
    const open = commands.find(command => command.actionSpecId === 'desktop.notch.set');
    expect(open).toBeDefined();
    await open!.action();
    expect(await executor.execute('desktop.notch.set', { state: 'rest' }, context)).toEqual({ ok: true, result: { applied: true } });
    expect(delivered).toEqual([{ state: 'open', focus: true }, { state: 'pinned', focus: true }, { state: 'rest', focus: false }]);
    dispose();
});
