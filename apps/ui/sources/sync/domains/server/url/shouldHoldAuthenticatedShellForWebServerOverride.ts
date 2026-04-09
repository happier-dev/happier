import { getActiveServerUrl } from '../serverProfiles';
import { createServerUrlComparableKey } from './serverUrlCanonical';
import { readWebServerUrlOverrideFromLocation } from './bootstrapActiveServerFromWebLocation';

export function shouldHoldAuthenticatedShellForWebServerOverride(isAuthenticated: boolean): boolean {
    if (!isAuthenticated) return false;
    const override = readWebServerUrlOverrideFromLocation();
    if (!override) return false;

    const desired = createServerUrlComparableKey(override.serverUrl);
    const current = createServerUrlComparableKey(getActiveServerUrl());
    return Boolean(desired && current && desired !== current);
}
