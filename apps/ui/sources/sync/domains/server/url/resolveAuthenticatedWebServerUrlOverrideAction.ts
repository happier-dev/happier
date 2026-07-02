import { normalizeServerUrl } from '../activeServerSwitch';
import { getActiveServerUrl } from '../serverProfiles';
import { readWebServerUrlOverrideFromLocation } from './bootstrapActiveServerFromWebLocation';
import { shouldSwitchToServerUrl } from './serverUrlOverridePolicy';

type NoAuthenticatedWebServerUrlOverrideAction = Readonly<{
    kind: 'none';
}>;

type CleanupAuthenticatedWebServerUrlOverrideAction = Readonly<{
    kind: 'cleanup_only';
    cleanedRelativeUrl: string;
}>;

type RefreshAuthenticatedWebServerUrlOverrideAction = Readonly<{
    kind: 'refresh_auth';
    cleanedRelativeUrl: string;
}>;

type SwitchAuthenticatedWebServerUrlOverrideAction = Readonly<{
    kind: 'switch_server';
    cleanedRelativeUrl: string;
    serverUrl: string;
}>;

export type AuthenticatedWebServerUrlOverrideAction =
    | NoAuthenticatedWebServerUrlOverrideAction
    | CleanupAuthenticatedWebServerUrlOverrideAction
    | RefreshAuthenticatedWebServerUrlOverrideAction
    | SwitchAuthenticatedWebServerUrlOverrideAction;

export function resolveAuthenticatedWebServerUrlOverrideAction(
    params: Readonly<{
        isAuthenticated: boolean;
        bootstrappedServerUrl?: string | null;
    }>,
): AuthenticatedWebServerUrlOverrideAction {
    if (!params.isAuthenticated) return { kind: 'none' };

    const override = readWebServerUrlOverrideFromLocation();
    if (!override) return { kind: 'none' };

    const desired = normalizeServerUrl(override.serverUrl);
    if (!desired) return { kind: 'none' };

    if (shouldSwitchToServerUrl({ targetServerUrl: desired, activeServerUrl: getActiveServerUrl() })) {
        return {
            kind: 'switch_server',
            cleanedRelativeUrl: override.cleanedRelativeUrl,
            serverUrl: desired,
        };
    }

    if (!shouldSwitchToServerUrl({ targetServerUrl: desired, activeServerUrl: params.bootstrappedServerUrl })) {
        return {
            kind: 'refresh_auth',
            cleanedRelativeUrl: override.cleanedRelativeUrl,
        };
    }

    return {
        kind: 'cleanup_only',
        cleanedRelativeUrl: override.cleanedRelativeUrl,
    };
}
