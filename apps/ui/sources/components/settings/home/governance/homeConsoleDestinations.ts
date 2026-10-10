import type { HomeGovernanceProjectionV1 } from '@happier-dev/protocol/home/governance';

import type { IconName } from '@/components/ui/icons/Icon';
import type { TranslationKeyNoParams } from '@/text';

import {
    homeAdministrationActivityPath,
    homeAdministrationDataPath,
    homeAdministrationEmailPath,
    homeAdministrationFeaturesPath,
    homeAdministrationOverviewPath,
    homeAdministrationPeoplePath,
    homeAdministrationPoliciesPath,
    homeAdministrationReachPath,
    homeAdministrationRuntimePath,
    homeAdministrationServerSettingsPath,
    homeAdministrationSignInProvidersPath,
    homeAdministrationTeamsPath,
} from './homeAdministrationRoutes';

export type HomeConsoleDestinationId =
    | 'overview'
    | 'people'
    | 'teams'
    | 'policies'
    | 'sign-in-providers'
    | 'reach'
    | 'email'
    | 'features'
    | 'data'
    | 'runtime'
    | 'server-settings'
    | 'activity';

export type HomeConsoleDestination = Readonly<{
    id: HomeConsoleDestinationId;
    titleKey: TranslationKeyNoParams;
    /** What the page is for: the phone index row's second line. */
    subtitleKey: TranslationKeyNoParams;
    icon: IconName;
    path: (serverId: string) => string;
    /** Whether this viewer's projected capabilities back the page. */
    available: (projection: HomeGovernanceProjectionV1) => boolean;
}>;

const always = () => true;
const viewsAdministration = (projection: HomeGovernanceProjectionV1) => projection.capabilities.viewAdministration;

/**
 * The Home console's pages, in rail order (plan §3.10, r3): who uses the Home · how it is reached and
 * run · what happened. The one declaration of the console's destinations: the rail beside the page,
 * the header menu that replaces it on narrower windows and the phone index all render this list, so
 * none of them can offer a page the others do not.
 */
export const HOME_CONSOLE_DESTINATION_GROUPS: readonly (readonly HomeConsoleDestination[])[] = [
    [
        { id: 'overview', titleKey: 'homeGovernance.overview', subtitleKey: 'homeGovernance.pages.overview', icon: 'house', path: homeAdministrationOverviewPath, available: always },
        { id: 'people', titleKey: 'homeGovernance.people', subtitleKey: 'homeGovernance.pages.people', icon: 'user-circle', path: homeAdministrationPeoplePath, available: (p) => p.capabilities.manageAccounts },
        // Team administration is governance, not content access. A Home with Teams turned off says so on the page.
        { id: 'teams', titleKey: 'homeGovernance.teams', subtitleKey: 'homeGovernance.pages.teams', icon: 'users', path: homeAdministrationTeamsPath, available: (p) => p.capabilities.manageAllTeams },
        { id: 'policies', titleKey: 'homeGovernance.policies', subtitleKey: 'homeGovernance.pages.policies', icon: 'shield-check', path: homeAdministrationPoliciesPath, available: (p) => p.capabilities.manageTeamCreationPolicy || p.capabilities.manageAuthentication },
        { id: 'sign-in-providers', titleKey: 'homeGovernance.signInProviders.title', subtitleKey: 'homeGovernance.signInProviders.description', icon: 'key', path: homeAdministrationSignInProvidersPath, available: viewsAdministration },
    ],
    [
        // Owners change these; admins read them.
        { id: 'reach', titleKey: 'homeGovernance.reach.title', subtitleKey: 'homeGovernance.pages.reach', icon: 'globe', path: homeAdministrationReachPath, available: viewsAdministration },
        { id: 'email', titleKey: 'homeGovernance.email.title', subtitleKey: 'homeGovernance.pages.email', icon: 'envelope', path: homeAdministrationEmailPath, available: viewsAdministration },
        { id: 'features', titleKey: 'homeGovernance.features.title', subtitleKey: 'homeGovernance.pages.features', icon: 'flask', path: homeAdministrationFeaturesPath, available: viewsAdministration },
        { id: 'data', titleKey: 'homeGovernance.data.title', subtitleKey: 'homeGovernance.pages.data', icon: 'hard-drives', path: homeAdministrationDataPath, available: viewsAdministration },
        { id: 'runtime', titleKey: 'homeGovernance.runtime.title', subtitleKey: 'homeGovernance.pages.runtime', icon: 'cpu', path: homeAdministrationRuntimePath, available: viewsAdministration },
        { id: 'server-settings', titleKey: 'homeGovernance.console.serverSettings', subtitleKey: 'homeGovernance.console.serverSettingsDescription', icon: 'sliders-horizontal', path: homeAdministrationServerSettingsPath, available: viewsAdministration },
    ],
    [
        { id: 'activity', titleKey: 'homeGovernance.activity.title', subtitleKey: 'homeGovernance.pages.activity', icon: 'clock-counter-clockwise', path: homeAdministrationActivityPath, available: viewsAdministration },
    ],
];

const OVERVIEW_ONLY: readonly (readonly HomeConsoleDestination[])[] = [[HOME_CONSOLE_DESTINATION_GROUPS[0]![0]!]];

/**
 * The destinations this viewer can open, grouped as the rail draws them. Before the Home has answered,
 * and while it has no owner yet (claim), only Overview is offered: nothing else can be used until then.
 */
export function resolveHomeConsoleDestinations(
    projection: HomeGovernanceProjectionV1 | null,
): readonly (readonly HomeConsoleDestination[])[] {
    if (!projection || projection.setupState === 'setup_required') return OVERVIEW_ONLY;
    return HOME_CONSOLE_DESTINATION_GROUPS
        .map((group) => group.filter((destination) => destination.available(projection)))
        .filter((group) => group.length > 0);
}

/**
 * The console page a pathname belongs to: the destination whose path is the longest prefix of it, so a
 * person belongs to People and an identity provider to Sign-in providers. Every other path of this Home
 * (and the Home's own root) is Overview.
 */
export function resolveActiveHomeConsoleDestination(pathname: string, serverId: string): HomeConsoleDestinationId {
    const normalized = pathname.replace(/\/+$/, '');
    let active: HomeConsoleDestination | null = null;
    for (const group of HOME_CONSOLE_DESTINATION_GROUPS) {
        for (const destination of group) {
            const path = destination.path(serverId);
            if (normalized !== path && !normalized.startsWith(`${path}/`)) continue;
            if (!active || path.length > active.path(serverId).length) active = destination;
        }
    }
    return active?.id ?? 'overview';
}
