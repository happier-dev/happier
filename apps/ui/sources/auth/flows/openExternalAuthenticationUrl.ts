import { Linking, Platform } from 'react-native';

export type OAuthBrowserHandoff = Readonly<{ cancel: () => Promise<void> }>;

/** Web keeps the OAuth return in the tab that holds the pending sign-in. */
export async function openExternalAuthenticationUrl(url: string): Promise<'same_tab' | 'system_browser'> {
    if (Platform.OS === 'web') {
        const location = typeof window !== 'undefined' ? window.location : null;
        if (location && typeof location.assign === 'function') {
            location.assign(url);
        } else if (location && typeof location.href === 'string') {
            location.href = url;
        } else {
            await Linking.openURL(url);
        }
        return 'same_tab';
    }
    await Linking.openURL(url);
    return 'system_browser';
}
