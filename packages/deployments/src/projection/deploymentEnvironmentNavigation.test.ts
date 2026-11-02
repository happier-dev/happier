import { describe, expect, it } from 'vitest';

import {
    DEPLOYMENT_ENVIRONMENT_SETTINGS_SECTIONS_V1,
    DEPLOYMENT_ENVIRONMENT_TABS_V1,
    resolveDeploymentEnvironmentDestinationV1,
} from './deploymentEnvironmentNavigation.js';

describe('Environment navigation destinations', () => {
    it('owns exactly six tabs and six Settings sections, in page order', () => {
        expect(DEPLOYMENT_ENVIRONMENT_TABS_V1).toEqual(['overview', 'history', 'variables', 'domains', 'permissions', 'settings']);
        expect(DEPLOYMENT_ENVIRONMENT_SETTINGS_SECTIONS_V1)
            .toEqual(['servers-build', 'controller', 'rollout', 'checks-alerts', 'backups', 'previews']);
    });

    it('keeps Variables, Domains and Permissions as tabs and lands an unknown or removed section on Settings', () => {
        expect(resolveDeploymentEnvironmentDestinationV1({ tab: 'settings', section: 'controller' }))
            .toEqual({ tab: 'settings', section: 'controller' });
        // Removed nine-section ids and tab names used as sections canonicalize to the Settings landing.
        for (const section of ['variables', 'domains', 'permissions', 'nope']) {
            expect(resolveDeploymentEnvironmentDestinationV1({ tab: 'settings', section }))
                .toEqual({ tab: 'settings', section: null });
        }
        // A section only belongs to Settings; any other tab drops it.
        expect(resolveDeploymentEnvironmentDestinationV1({ tab: 'variables', section: 'controller' }))
            .toEqual({ tab: 'variables', section: null });
        expect(resolveDeploymentEnvironmentDestinationV1({ tab: 'access', section: null }))
            .toEqual({ tab: 'overview', section: null });
        expect(resolveDeploymentEnvironmentDestinationV1({})).toEqual({ tab: 'overview', section: null });
    });
});
