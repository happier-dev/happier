import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

import { invokeTauri, isTauriDesktop } from '@/utils/platform/tauri';

import { findAppIconByNativeName, type AppIconDefinition } from './appIcons';

/** The `expo-alternate-app-icons` native module (iOS `setAlternateIconName`, Android activity aliases). */
type AlternateAppIconsModule = Readonly<{
    supportsAlternateIcons?: boolean;
    getAppIconName: () => string | null;
    setAlternateAppIcon: (name: string | null) => Promise<string | null>;
}>;

export type AppIconHost = Readonly<{
    kind: 'native' | 'desktop';
    /** The catalog id of the icon showing now; null when the OS reports one this build does not know. */
    readCurrentIconId: () => Promise<string | null>;
    apply: (icon: AppIconDefinition) => Promise<void>;
}>;

function nativeHost(): AppIconHost | null {
    // Optional: a JS update running on a binary built before the module existed has no module, and
    // must report unsupported instead of throwing on pick (plan 04, native capability read).
    const module = requireOptionalNativeModule<AlternateAppIconsModule>('ExpoAlternateAppIcons');
    if (!module || module.supportsAlternateIcons !== true) return null;
    return {
        kind: 'native',
        readCurrentIconId: async () => findAppIconByNativeName(module.getAppIconName())?.id ?? null,
        apply: async (icon) => {
            await module.setAlternateAppIcon(icon.nativeName);
        },
    };
}

/** Desktop keeps the choice itself (device-local) and re-applies it at launch, before the window shows. */
const desktopHost: AppIconHost = {
    kind: 'desktop',
    readCurrentIconId: () => invokeTauri<string | null>('desktop_get_app_icon'),
    apply: (icon) => invokeTauri<void>('desktop_set_app_icon', { iconId: icon.id }),
};

/**
 * The one owner of "can this device change its icon, and how". Web has no picker (plan 04: no web
 * frame); tests and old binaries have no module.
 */
export function resolveAppIconHost(): AppIconHost | null {
    if (Platform.OS === 'web') return isTauriDesktop() ? desktopHost : null;
    if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
    return nativeHost();
}
