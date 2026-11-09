import { canonicalizeServerUrl as normalizeServerUrl } from './serverUrlCanonical';
import { getActiveServerUrl, resolveUniqueServerProfileByUrl } from '../serverProfiles';
import { readWebServerUrlOverrideFromLocation, type WebServerUrlOverrideAction } from './bootstrapActiveServerFromWebLocation';
import { shouldSwitchToServerUrl } from './serverUrlOverridePolicy';

type NoAuthenticatedWebServerUrlOverrideAction = Readonly<{
    kind: 'none';
}>;

export type AuthenticatedWebServerUrlOverrideAction =
    | NoAuthenticatedWebServerUrlOverrideAction
    | WebServerUrlOverrideAction;

export function resolveWebServerUrlOverrideAction(
    params: Readonly<{
        bootstrappedServerUrl?: string | null;
        /** Native app links carry the same supplied Home in their route parameters. */
        serverUrlOverride?: string | null;
    }>,
): AuthenticatedWebServerUrlOverrideAction {
    const override = params.serverUrlOverride === undefined
        ? readWebServerUrlOverrideFromLocation()
        : params.serverUrlOverride ? { serverUrl: params.serverUrlOverride } : null;
    if (!override) return { kind: 'none' };

    const desired = normalizeServerUrl(override.serverUrl);
    if (!desired) return { kind: 'none' };

    if (!resolveUniqueServerProfileByUrl(desired)
        || shouldSwitchToServerUrl({ targetServerUrl: desired, activeServerUrl: getActiveServerUrl() })) {
        return {
            kind: 'switch_server',
            serverUrl: desired,
        };
    }

    if (!shouldSwitchToServerUrl({ targetServerUrl: desired, activeServerUrl: params.bootstrappedServerUrl })) {
        return {
            kind: 'refresh_auth',
            serverUrl: desired,
        };
    }

    return {
        kind: 'cleanup_only',
        serverUrl: desired,
    };
}
