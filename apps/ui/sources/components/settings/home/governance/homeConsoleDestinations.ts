import type { HomeGovernanceProjectionV1, HomeRoleV1 } from '@happier-dev/protocol/home/governance';

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
    homeAdministrationUsagePath,
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
    | 'activity'
    | 'usage';

/** What the console's navigation reads of the viewer: its role, capabilities and whether the Home has an owner. */
export type HomeConsoleViewerAccess = Pick<HomeGovernanceProjectionV1, 'viewer' | 'capabilities' | 'setupState'>;

export type HomeConsoleDestination = Readonly<{
    id: HomeConsoleDestinationId;
    titleKey: TranslationKeyNoParams;
    icon: IconName;
    path: (serverId: string) => string;
    /** Whether this viewer's projected capabilities back the page. */
    available: (projection: HomeConsoleViewerAccess) => boolean;
}>;

const always = () => true;
const viewsAdministration = (projection: HomeConsoleViewerAccess) => projection.capabilities.viewAdministration;

/**
 * The Home console's pages, in rail order (plan §3.10, r3): who uses the Home · how it is reached and
 * run · what happened. The one declaration of the console's destinations: the rail beside the page,
 * the header menu that replaces it on narrower windows and the phone index all render this list, so
 * none of them can offer a page the others do not.
 */
export const HOME_CONSOLE_DESTINATION_GROUPS: readonly (readonly HomeConsoleDestination[])[] = [
    [
        { id: 'overview', titleKey: 'homeGovernance.overview', icon: 'house', path: homeAdministrationOverviewPath, available: always },
        { id: 'people', titleKey: 'homeGovernance.people', icon: 'user-circle', path: homeAdministrationPeoplePath, available: (p) => p.capabilities.manageAccounts },
        // Team administration is governance, not content access. A Home with Teams turned off says so on the page.
        { id: 'teams', titleKey: 'homeGovernance.teams', icon: 'users', path: homeAdministrationTeamsPath, available: (p) => p.capabilities.manageAllTeams },
        { id: 'policies', titleKey: 'homeGovernance.policies', icon: 'shield-check', path: homeAdministrationPoliciesPath, available: (p) => p.capabilities.manageTeamCreationPolicy || p.capabilities.manageAuthentication },
        { id: 'sign-in-providers', titleKey: 'homeGovernance.signInProviders.title', icon: 'key', path: homeAdministrationSignInProvidersPath, available: viewsAdministration },
    ],
    [
        // Owners change these; admins read them.
        { id: 'reach', titleKey: 'homeGovernance.reach.title', icon: 'globe', path: homeAdministrationReachPath, available: viewsAdministration },
        { id: 'email', titleKey: 'homeGovernance.email.title', icon: 'envelope', path: homeAdministrationEmailPath, available: viewsAdministration },
        { id: 'features', titleKey: 'homeGovernance.features.title', icon: 'flask', path: homeAdministrationFeaturesPath, available: viewsAdministration },
        { id: 'data', titleKey: 'homeGovernance.data.title', icon: 'hard-drives', path: homeAdministrationDataPath, available: viewsAdministration },
        { id: 'runtime', titleKey: 'homeGovernance.runtime.title', icon: 'cpu', path: homeAdministrationRuntimePath, available: viewsAdministration },
        { id: 'server-settings', titleKey: 'homeGovernance.console.serverSettings', icon: 'sliders-horizontal', path: homeAdministrationServerSettingsPath, available: viewsAdministration },
    ],
    [
        { id: 'activity', titleKey: 'homeGovernance.activity.title', icon: 'clock-counter-clockwise', path: homeAdministrationActivityPath, available: viewsAdministration },
        { id: 'usage', titleKey: 'teams.credentials.usage.title', icon: 'chart-bar', path: homeAdministrationUsagePath, available: viewsAdministration },
    ],
];

const OVERVIEW_ONLY: readonly (readonly HomeConsoleDestination[])[] = [[HOME_CONSOLE_DESTINATION_GROUPS[0]![0]!]];

/**
 * The destinations this viewer can open, grouped as the rail draws them. Before the Home has answered,
 * and while it has no owner yet (claim), only Overview is offered: nothing else can be used until then.
 */
export function resolveHomeConsoleDestinations(
    projection: HomeConsoleViewerAccess | null,
): readonly (readonly HomeConsoleDestination[])[] {
    if (!projection || projection.setupState === 'setup_required') return OVERVIEW_ONLY;
    return HOME_CONSOLE_DESTINATION_GROUPS
        .map((group) => group.filter((destination) => destination.available(projection)))
        .filter((group) => group.length > 0);
}

/**
 * The console's role line and destinations. Until the Home answers they stand on how it answered last on this device
 * (`access` not current), so the rail neither grows nor shifts when the answer is the same; with nothing known the
 * role line is held (`pending`) and only Overview, which every viewer has, is offered. A fresh answer replaces it at
 * once: a withdrawn role (`access` null once answered) leaves Overview alone. Navigation only offers; every page and
 * request is still authorized by the Home.
 */
export function resolveHomeConsoleViewer(input: Readonly<{
    /** The Home has answered this process's read (with a projection, an ownerless Home or a refusal). */
    answered: boolean;
    setupRequired: boolean;
    access: HomeConsoleViewerAccess | null;
}>): Readonly<{
    role: Extract<HomeRoleV1, 'owner' | 'admin'> | 'noOwner' | 'pending' | null;
    destinations: readonly (readonly HomeConsoleDestination[])[];
}> {
    if (input.setupRequired) return { role: 'noOwner', destinations: OVERVIEW_ONLY };
    const homeRole = input.access?.viewer.homeRole ?? null;
    const role = homeRole === 'owner' || homeRole === 'admin' ? homeRole
        : input.access || input.answered ? null : 'pending';
    return { role, destinations: resolveHomeConsoleDestinations(input.access) };
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
