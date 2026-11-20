import { Linking, Platform } from 'react-native';
import { openExternalUrl } from '@/utils/url/openExternalUrl';

export type OAuthBrowserHandoff = Readonly<{ cancel: () => Promise<void> }>;

/** A negotiated desktop return reaches the renderer that holds this OAuth attempt. */
export async function openExternalAuthenticationUrl(url: string, desktopAttemptId?: string): Promise<'same_tab' | 'system_browser'> {
    if (Platform.OS === 'web') {
        if (desktopAttemptId) {
            if (!await openExternalUrl(url)) throw new Error('Could not open OAuth in the system browser');
            return 'system_browser';
        }
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
