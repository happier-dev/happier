import type { PluginConnectedAccountAuthenticationModeV2 } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';

import { resolveProjectedLocalizedText } from '@/components/plugins/surfaces/resolvePluginDisplayString';
import { t } from '@/text';

/**
 * The name of one way to sign in to a service. A mode the plugin titled keeps its title; an untitled
 * one is named by what it asks of the user. A mode id ("oauth", "device") is never shown.
 */
export function resolveConnectedAccountModeTitle(
    mode: Pick<PluginConnectedAccountAuthenticationModeV2, 'kind' | 'title'>,
    localize?: (value: Parameters<typeof resolveProjectedLocalizedText>[0]) => string,
): string {
    const projected = resolveProjectedLocalizedText(mode.title, localize);
    if (projected) return projected;
    if (mode.kind === 'manual') return t('connectedServicesSettings.modeManual');
    if (mode.kind === 'oauthDeviceCode') return t('connectedServicesSettings.modeDeviceCode');
    return t('connectedServicesSettings.modeBrowser');
}

/**
 * The same choice in a setup picker, where an untitled sign-in reads as how it happens ("With a browser").
 * A declared title always wins, so two browser modes of one service never read the same.
 */
export function resolveConnectedAccountSetupMethodTitle(
    mode: Pick<PluginConnectedAccountAuthenticationModeV2, 'kind' | 'title'>,
    localize?: (value: Parameters<typeof resolveProjectedLocalizedText>[0]) => string,
): string {
    const projected = resolveProjectedLocalizedText(mode.title, localize);
    if (projected) return projected;
    if (mode.kind === 'oauthAuthorizationCode') return t('connectedServicesSettings.methodBrowser');
    if (mode.kind === 'oauthDeviceCode') return t('connectedServicesSettings.methodCode');
    return resolveConnectedAccountModeTitle(mode, localize);
}
