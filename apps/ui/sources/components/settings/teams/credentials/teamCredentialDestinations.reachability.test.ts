import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    teamCredentialAccessPath,
    teamCredentialActivityPath,
    teamCredentialCreatePath,
    teamCredentialDetailPath,
    teamCredentialEditPath,
    teamCredentialExternalApiPath,
    teamCredentialLimitsPath,
    teamCredentialRequestPolicyPath,
    teamCredentialUsagePath,
    teamCredentialAggregateUsagePath,
    teamCredentialsPath,
} from '../teamsRoutes';

const UI_SOURCES_ROOT = join(__dirname, '..', '..', '..', '..');
const SETTINGS_ROUTES_ROOT = join(UI_SOURCES_ROOT, 'app', '(app)', 'settings');

const ADDRESS = { serverId: 'home-a', teamId: 'team-1' } as const;
const RESOURCE_ID = 'resource-1';

/**
 * Every destination a shared-credential surface can navigate to.
 *
 * The path builders are the surfaces' own owner, so this list cannot drift from
 * what a press actually pushes: a builder that exists is enough for a row to
 * appear, and nothing else in the codebase proves that pressing it lands on a
 * screen rather than on a route Expo Router has never heard of.
 */
const DESTINATIONS = [
    teamCredentialsPath(ADDRESS),
    teamCredentialCreatePath(ADDRESS),
    teamCredentialDetailPath(ADDRESS, RESOURCE_ID),
    teamCredentialEditPath(ADDRESS, RESOURCE_ID),
    teamCredentialAccessPath(ADDRESS, RESOURCE_ID),
    teamCredentialRequestPolicyPath(ADDRESS, RESOURCE_ID),
    teamCredentialActivityPath(ADDRESS, RESOURCE_ID),
    teamCredentialLimitsPath(ADDRESS, RESOURCE_ID),
    teamCredentialUsagePath(ADDRESS, RESOURCE_ID),
    teamCredentialAggregateUsagePath(ADDRESS),
    teamCredentialExternalApiPath(ADDRESS, RESOURCE_ID),
] as const;

/**
 * The Expo Router segment a destination resolves to, with the concrete Home,
 * Team and resource put back into their dynamic segments.
 */
function toRouteName(destination: string): string {
    return destination.split('?')[0]!
        .replace('/settings/', '')
        .replace(`/${ADDRESS.serverId}/`, '/[serverId]/')
        .replace(`/${ADDRESS.teamId}/`, '/[teamId]/')
        .replace(`/${RESOURCE_ID}`, '/[resourceId]');
}

function routeFileCandidates(routeName: string): readonly string[] {
    return [
        join(SETTINGS_ROUTES_ROOT, `${routeName}.tsx`),
        join(SETTINGS_ROUTES_ROOT, routeName, 'index.tsx'),
    ];
}

describe('team credential destinations', () => {
    it('lands every navigable credential destination on a real Expo Router screen', () => {
        const unreachable = DESTINATIONS
            .map(toRouteName)
            .filter((routeName) => !routeFileCandidates(routeName).some((path) => existsSync(path)));

        // A row whose press pushes a route with no screen is an inert control
        // with extra steps, which the plan forbids outright.
        expect(unreachable).toEqual([]);
    });

    it('registers every credential destination with the settings stack chrome', async () => {
        const { resolveSettingsNestedRouteName } = await import('@/components/settings/navigation/settingsRouteRegistry');
        // Team destinations live in the Teams collection's nested navigator; each one must resolve to
        // the registered screen of its own route file, or it falls back to the raw router segment
        // for its title and Back affordance instead of the Settings chrome.
        const unregistered = DESTINATIONS
            .map((destination) => {
                const routeName = toRouteName(destination);
                const expected = (existsSync(join(SETTINGS_ROUTES_ROOT, routeName, 'index.tsx'))
                    ? `${routeName}/index`
                    : routeName).replace(/^teams\//, '');
                return { expected, resolved: resolveSettingsNestedRouteName('teams', destination.split('?')[0]) };
            })
            .filter(({ expected, resolved }) => resolved !== expected);

        expect(unregistered).toEqual([]);
    });
});
