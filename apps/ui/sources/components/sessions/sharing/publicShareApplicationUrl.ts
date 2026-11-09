import { Platform } from 'react-native';
import { buildPublicShareApplicationUrlV1 } from '@happier-dev/protocol/sharing/storedContentPublicShareV1';
import { resolveBuildDefaultProfile, resolveDefaultWebappUrl } from '@happier-dev/cli-common/happierCloud';

import { sanitizeServerUrlForShareableLink } from '@/sync/domains/server/url/shareableServerUrl';

export function buildPublicShareApplicationUrl(params: Readonly<{
    applicationBaseUrl: string;
    token: string;
    serverUrl?: string | null;
}>): string {
    return buildPublicShareApplicationUrlV1({ ...params, serverUrl: sanitizeServerUrlForShareableLink(params.serverUrl) });
}

/**
 * The app origin a public link opens in: this web app's own origin, or the configured web app on
 * native (where there is no page origin to reuse).
 */
export function resolvePublicShareApplicationBaseUrl(): string {
    if (Platform.OS === 'web') {
        return typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '';
    }
    const configuredWebAppUrl = (process.env.EXPO_PUBLIC_HAPPY_WEBAPP_URL || '').trim();
    return configuredWebAppUrl || resolveDefaultWebappUrl(resolveBuildDefaultProfile().home?.url ?? '');
}
