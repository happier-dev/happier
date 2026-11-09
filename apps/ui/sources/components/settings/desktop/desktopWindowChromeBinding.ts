import { SETTING_VALUE_UNAVAILABLE, type SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
import { getDesktopWindowChromePolicy, setDesktopNativeTitleBar } from '@/utils/platform/desktopWindowBridge';
import { throwIfAborted } from '@/utils/runtime/abortSignals';

/** Settings admission delegates storage and the applied frame to the native process. */
export const desktopWindowChromeBinding = {
    scope: 'local', kind: 'localOwner', access: 'read_write', allowedValues: [true, false],
    read: async () => {
        const policy = await getDesktopWindowChromePolicy();
        return policy.canSetNativeTitleBar === true
            ? policy.useNativeTitleBar ?? (policy.strategy === 'native-windows-frame')
            : SETTING_VALUE_UNAVAILABLE;
    },
    parse: (value: unknown) => typeof value === 'boolean' ? { success: true, value } : { success: false },
    commit: async (_local, value, _writeLocal, context) => {
        throwIfAborted(context?.signal);
        if (context?.isCurrent() === false) return SETTING_VALUE_UNAVAILABLE;
        const policy = await getDesktopWindowChromePolicy();
        throwIfAborted(context?.signal);
        if (context?.isCurrent() === false || policy.canSetNativeTitleBar !== true) return SETTING_VALUE_UNAVAILABLE;
        const applied = await setDesktopNativeTitleBar(value === true);
        return applied.nativeTitleBarPersistenceError ? SETTING_VALUE_UNAVAILABLE : undefined;
    },
} satisfies SettingStorageBinding;
