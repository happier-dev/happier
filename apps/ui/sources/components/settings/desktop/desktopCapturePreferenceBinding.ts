import { SETTING_VALUE_UNAVAILABLE, type SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
import { readNativeCapturePreference, setCaptureLibraryFolder, setNativeCaptureShortcut, setNativeCaptureShortcutEditing,
    readNativeWindowShadowPreference, setNativeWindowShadowPreference,
    type NativeCapturePreferenceKey } from '@/desktop/capture/nativeCapture';
import { throwIfAborted } from '@/utils/runtime/abortSignals';

/** Admit the native suppression before showing the recorder, and release it on every close path. */
export async function recordDesktopCaptureShortcut(present: () => Promise<string | null>): Promise<string | null> {
    await setNativeCaptureShortcutEditing(true);
    try { return await present(); }
    finally { await setNativeCaptureShortcutEditing(false); }
}

/** Generic Settings Actions delegate each device key to the native capture record. */
export function desktopCapturePreferenceBinding(key: NativeCapturePreferenceKey | 'includeWindowShadow'): SettingStorageBinding {
    if (key === 'includeWindowShadow') return {
        scope: 'local', kind: 'localOwner', access: 'read_write', resetValue: false,
        read: async () => (await readNativeWindowShadowPreference()).enabled,
        parse: (value: unknown) => typeof value === 'boolean' ? { success: true, value } : { success: false },
        commit: async (_local, value, _writeLocal, context) => {
            throwIfAborted(context?.signal);
            if (context?.isCurrent() === false) return SETTING_VALUE_UNAVAILABLE;
            await setNativeWindowShadowPreference(value === true);
        },
    };
    return {
        scope: 'local', kind: 'localOwner', access: 'read_write', resetValue: key === 'captureShortcut' ? 'CmdOrCtrl+Shift+2' : null,
        read: () => readNativeCapturePreference(key),
        parse: (value: unknown) => value === null || typeof value === 'string'
            ? { success: true, value } : { success: false },
        commit: async (_local, value, _writeLocal, context) => {
            throwIfAborted(context?.signal);
            if (context?.isCurrent() === false) return SETTING_VALUE_UNAVAILABLE;
            if (key === 'libraryFolder') { await setCaptureLibraryFolder(typeof value === 'string' ? value : null); return; }
            // The shared recorder spells the primary modifier Mod; Tauri spells that token CmdOrCtrl.
            const requested = typeof value === 'string' ? value.split('+').map(token => token === 'Mod' ? 'CmdOrCtrl' : token).join('+') : null;
            const result = await setNativeCaptureShortcut(key, requested);
            const binding = result.bindings.find(binding => binding.key === key);
            if (result.availability !== 'ready' || !binding || binding.failure || binding.requested !== requested) return SETTING_VALUE_UNAVAILABLE;
        },
    };
}
