import type { AuthenticatedAccountEntryRequest } from '@/components/navigation/accountEntry/authenticatedAccountEntryRoute';
import { requestDesktopCredentialJourney, type DesktopCredentialJourney } from '@/desktop/window/accountWindowAuthBoundary';
import { resolveDesktopWindowContext } from '@/desktop/window/isDesktopAuxiliaryWindowContext';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';

export type AccountCredentialJourney =
    | Readonly<{ kind: 'account_directory'; request: AuthenticatedAccountEntryRequest }>
    | Readonly<{ kind: 'home'; profileRef: string; returnTo: string }>
    | Readonly<{ kind: 'team'; profileRef: string; teamId: string }>;

/** Decide the realm once, before a form mounts or an external ceremony starts. */
export function prepareAccountCredentialJourney(journey: AccountCredentialJourney): (() => Promise<void>) | null {
    if (resolveDesktopWindowContext().role !== 'secondary') return null;
    const source = getActiveServerSnapshot();
    return async () => {
        const entry: DesktopCredentialJourney['entry'] = journey.kind === 'account_directory'
            ? { kind: 'account_directory', params: (await import('@/components/navigation/accountEntry/authenticatedAccountEntryRoute')).buildAuthenticatedAccountEntryHref(journey.request).params }
            : journey;
        await requestDesktopCredentialJourney({ sourceHome: { serverId: source.serverId, serverUrl: source.serverUrl }, entry });
    };
}

export async function moveAccountCredentialJourneyToMain(journey: AccountCredentialJourney): Promise<boolean> {
    const move = prepareAccountCredentialJourney(journey);
    if (!move) return false;
    await move();
    return true;
}

/** Main's existing Auth listener is the sole receiver and owns focus/auth publication. */
export async function openDesktopCredentialJourneyInMain(data: DesktopCredentialJourney, refreshAuth: () => Promise<void>): Promise<void> {
    const profile = getServerProfileById(data.sourceHome.serverId);
    if (!profile || createServerUrlComparableKey(profile.serverUrl) !== createServerUrlComparableKey(data.sourceHome.serverUrl)) {
        throw new Error('Account sign-in Home is unavailable');
    }
    const entry = data.entry;
    let href: ReturnType<typeof import('@/components/navigation/accountEntry/authenticatedAccountEntryRoute').buildAuthenticatedAccountEntryHref>
        | ReturnType<typeof import('@/components/settings/server/navigation/serverSettingsRouteParams').buildHomeRecoveryHref>
        | ReturnType<typeof import('@/components/teams/entry/teamSignInHome').teamSignInReturnPath>;
    if (entry.kind === 'account_directory') {
        const routes = await import('@/components/navigation/accountEntry/authenticatedAccountEntryRoute');
        const request = routes.parseAuthenticatedAccountEntryRoute(entry.params);
        if (!request) throw new Error('Account sign-in route is invalid');
        href = routes.buildAuthenticatedAccountEntryHref(request);
    } else {
        if (!getServerProfileById(entry.profileRef)) throw new Error('Account sign-in target is unavailable');
        href = entry.kind === 'team'
            ? (await import('@/components/teams/entry/teamSignInHome')).teamSignInReturnPath({ teamId: entry.teamId, serverId: entry.profileRef })
            : (await import('@/components/settings/server/navigation/serverSettingsRouteParams')).buildHomeRecoveryHref(entry);
    }
    await (await import('@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge')).showDesktopMainWindow();
    const switched = await (await import('@/sync/domains/server/activeServerSwitch')).setActiveServerAndSwitch({
        serverId: profile.id, scope: 'tab', refreshAuth,
    });
    if (switched === 'blocked') throw new Error('Account sign-in Home could not be focused');
    (await import('expo-router')).router.push(href);
}
