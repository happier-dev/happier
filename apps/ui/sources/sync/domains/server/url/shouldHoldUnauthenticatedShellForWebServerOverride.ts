import { readWebServerUrlOverrideFromLocation } from './bootstrapActiveServerFromWebLocation';
import { shouldSwitchToServerUrl } from './serverUrlOverridePolicy';

export function shouldHoldUnauthenticatedShellForWebServerOverride(
    isAuthenticated: boolean,
    currentServerUrl: string | null | undefined,
): boolean {
    if (isAuthenticated) return false;

    const override = readWebServerUrlOverrideFromLocation();
    if (!override) return false;

    return shouldSwitchToServerUrl({
        targetServerUrl: override.serverUrl,
        activeServerUrl: currentServerUrl,
    });
}
