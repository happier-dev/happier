import { normalizeServerUrl } from '../activeServerSwitch';
import { readWebServerUrlOverrideFromLocation } from './bootstrapActiveServerFromWebLocation';

export function shouldHoldUnauthenticatedShellForWebServerOverride(
    isAuthenticated: boolean,
    currentServerUrl: string | null | undefined,
): boolean {
    if (isAuthenticated) return false;

    const override = readWebServerUrlOverrideFromLocation();
    if (!override) return false;

    const desired = normalizeServerUrl(override.serverUrl);
    const current = normalizeServerUrl(String(currentServerUrl ?? ''));
    return Boolean(desired) && desired !== current;
}
