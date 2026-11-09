import { afterEach, expect, it, vi } from 'vitest';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { SETTING_VALUE_UNAVAILABLE } from '@/components/settings/catalog/settingDeclarations';
import { desktopCapturePreferenceBinding, recordDesktopCaptureShortcut } from './desktopCapturePreferenceBinding';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
afterEach(() => vi.unstubAllGlobals());

it('edits the native window-shadow preference through the existing Settings owner without writing renderer local settings', async () => {
    let enabled = false;
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
        if (command !== 'desktop_capture_window_shadow') throw new Error('unexpected desktop effect');
        if (typeof args?.enabled === 'boolean') enabled = args.enabled;
        return { enabled, supported: true };
    } });
    const binding = desktopCapturePreferenceBinding('includeWindowShadow');
    if (binding.scope !== 'local' || !('kind' in binding) || binding.kind !== 'localOwner') throw new Error('expected native owner');
    const writeLocal = vi.fn();
    expect(await binding.read(localSettingsDefaults)).toBe(false);
    expect(binding.parse(true)).toEqual({ success: true, value: true });
    expect(binding.parse('true')).toEqual({ success: false });
    await binding.commit(localSettingsDefaults, true, writeLocal);
    expect(await binding.read(localSettingsDefaults)).toBe(true);
    expect(writeLocal).not.toHaveBeenCalled();
});

it('suppresses native capture for the recorder lifetime and releases it after cancellation or failure', async () => {
    const effects: string[] = [];
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args: Record<string, unknown>) => {
        if (command !== 'desktop_capture_shortcut_editing') throw new Error('unexpected desktop effect');
        effects.push(args.editing ? 'suppress' : 'resume');
    } });
    expect(await recordDesktopCaptureShortcut(async () => { effects.push('prompt'); return null; })).toBeNull();
    expect(effects).toEqual(['suppress', 'prompt', 'resume']);
    effects.length = 0;
    await expect(recordDesktopCaptureShortcut(async () => { effects.push('prompt'); throw new Error('closed'); })).rejects.toThrow('closed');
    expect(effects).toEqual(['suppress', 'prompt', 'resume']);
});

it('refuses an unsettled native binding edit and accepts the ready owner result', async () => {
    let ready = false;
    let saved: string | null = 'CmdOrCtrl+Shift+2';
    // Only desktop IPC is replaced; the Settings binding and native adapter are real.
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args: Record<string, unknown>) => {
        if (command === 'desktop_capture_preference') return saved;
        if (command === 'desktop_capture_set_shortcut') {
            if (ready) saved = typeof args.binding === 'string' ? args.binding : null;
            return { backend: 'native', availability: ready ? 'ready' : 'pending', configureSupported: false,
                editing: false, bindings: [{ key: 'captureShortcut', requested: null, active: null, failure: null }] };
        }
        throw new Error('unexpected desktop effect');
    } });
    const binding = desktopCapturePreferenceBinding('captureShortcut');
    if (binding.scope !== 'local' || !('kind' in binding) || binding.kind !== 'localOwner') {
        throw new Error('capture preference must use the native local owner');
    }
    expect(await binding.commit(localSettingsDefaults, null, () => undefined)).toBe(SETTING_VALUE_UNAVAILABLE);
    expect(await binding.read(localSettingsDefaults)).toBe('CmdOrCtrl+Shift+2');
    ready = true;
    expect(await binding.commit(localSettingsDefaults, null, () => undefined)).toBeUndefined();
    expect(await binding.read(localSettingsDefaults)).toBeNull();
});

it('converts the recorder primary-modifier token at the native binding boundary', async () => {
    let saved: string | null = 'CmdOrCtrl+Shift+2';
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args: Record<string, unknown>) => {
        if (command === 'desktop_capture_preference') return saved;
        if (command === 'desktop_capture_set_shortcut') {
            const requested = String(args.binding);
            const failure = requested.includes('Mod') ? 'invalid' : null;
            if (!failure) saved = requested;
            return { backend: 'native', availability: 'ready', configureSupported: false, editing: false,
                bindings: [{ key: 'captureShortcut', requested, active: saved, failure }] };
        }
        throw new Error('unexpected desktop effect');
    } });
    const binding = desktopCapturePreferenceBinding('captureShortcut');
    if (binding.scope !== 'local' || !('kind' in binding) || binding.kind !== 'localOwner') throw new Error('expected native owner');
    expect(await binding.commit(localSettingsDefaults, 'Mod+Shift+2', () => undefined)).toBeUndefined();
    expect(await binding.read(localSettingsDefaults)).toBe('CmdOrCtrl+Shift+2');
});
