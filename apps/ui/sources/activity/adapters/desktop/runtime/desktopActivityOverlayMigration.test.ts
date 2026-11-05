import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearPersistenceStorage, getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { loadLocalSettings, saveLocalSettings } from '@/sync/domains/state/settingsPersistence';
import { resolveDesktopOverlayPolicy } from './resolveDesktopOverlayPolicy';
import { buildDesktopActivityOverlayQaModel } from './desktopActivityOverlayQaFixtures.mjs';
import { syncDesktopActivityOverlay } from './desktopActivityOverlayBridge';

const invoke = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>();
// Native event delivery is a transport boundary; settings, admission and sync stay real.
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
beforeEach(() => {
    clearPersistenceStorage();
    vi.stubGlobal('navigator', { userAgent: 'Tauri' });
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
        if (command === 'desktop_host_get_availability') return {
            activity: { kind: 'available' }, pet: { kind: 'available' }, windows: { kind: 'available' },
        };
        return invoke(command, args);
    } });
});
afterEach(() => { clearPersistenceStorage(); vi.unstubAllGlobals(); invoke.mockReset(); });

it('keeps the legacy dock mapping without retaining position receipts or retrying historical inputs', async () => {
    getPersistenceStorage().set('local-settings', JSON.stringify({ desktopOverlayAnchor: 'bottom_left' }));
    const settings = loadLocalSettings();
    expect(settings.desktopOverlayDock).toBe('floating');
    saveLocalSettings(settings);
    expect(JSON.parse(getPersistenceStorage().getString('local-settings')!)).not.toHaveProperty('desktopOverlayAnchor');
    const policy = resolveDesktopOverlayPolicy(settings);
    const model = buildDesktopActivityOverlayQaModel('active_session');
    if (!model) throw new Error('Expected the existing activity QA fixture');
    const payload = { visible: true, policy, model: { ...model, generatedAt: 0 } };
    invoke.mockRejectedValueOnce(new Error('Native persistence refused'));
    await expect(syncDesktopActivityOverlay(payload)).rejects.toThrow();
    expect(invoke.mock.calls.at(-1)).toEqual(['desktop_activity_overlay_sync', { payload }]);
    invoke.mockResolvedValueOnce(undefined);
    await syncDesktopActivityOverlay(payload);
    expect(invoke.mock.calls.at(-1)).toEqual(['desktop_activity_overlay_sync', { payload }]);
});
