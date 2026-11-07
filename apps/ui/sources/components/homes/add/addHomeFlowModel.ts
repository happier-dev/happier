import type { AccountServiceEntryOptions } from '@/components/account/auth/useAccountServiceEntryOptions';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';

export type AddHomePath = 'service' | 'other_service' | 'direct' | 'use_service_as_home' | 'server_home';
export type AddHomePane =
    | Readonly<{ pane: 'service' | 'use_service_as_home' | 'server_home' }>
    | Readonly<{ pane: 'other_service' | 'direct'; initialAddress?: string }>
    | Readonly<{ pane: 'home_sign_in'; profile: ServerProfile; initialAddress?: string }>;
export type AddHomePathAvailability =
    | Readonly<{ id: 'service'; state: 'ready' | 'checking' }>
    | Readonly<{ id: 'service'; state: 'unavailable'; reason: 'unreachable' | 'unsupported' }>
    | Readonly<{ id: Exclude<AddHomePath, 'service'>; state: 'ready' }>;
export type AddHomeAvailabilityInput = Readonly<{
    serviceStatus: AccountServiceEntryOptions['status'];
    serviceHostsHome: boolean;
    canSetUpServerHome: boolean;
}>;

export function resolveAddHomePaths(input: AddHomeAvailabilityInput): readonly AddHomePathAvailability[] {
    const paths: AddHomePathAvailability[] = [];
    if (input.serviceStatus === 'ready') paths.push({ id: 'service', state: 'ready' });
    else if (input.serviceStatus === 'loading') paths.push({ id: 'service', state: 'checking' });
    else if (input.serviceStatus !== 'not_offered') paths.push({ id: 'service', state: 'unavailable', reason: input.serviceStatus === 'unsupported' ? 'unsupported' : 'unreachable' });
    paths.push({ id: 'other_service', state: 'ready' });
    paths.push({ id: 'direct', state: 'ready' });
    if (input.serviceHostsHome) paths.push({ id: 'use_service_as_home', state: 'ready' });
    if (input.canSetUpServerHome) paths.push({ id: 'server_home', state: 'ready' });
    return paths;
}

export type AddHomeTransition =
    | Readonly<{ kind: 'choose_path'; path: AddHomePath }>
    | Readonly<{ kind: 'connect_as_home'; address: string }>
    | Readonly<{ kind: 'home_connected'; profile: ServerProfile }>
    | Readonly<{ kind: 'back' }>;

export function transitionAddHomePane(state: AddHomePane, transition: AddHomeTransition): AddHomePane {
    switch (transition.kind) {
        case 'choose_path': return { pane: transition.path };
        case 'connect_as_home': return { pane: 'direct', initialAddress: transition.address };
        case 'home_connected': return { pane: 'home_sign_in', profile: transition.profile };
        case 'back': return { pane: 'direct' };
    }
}

export function addHomePathOfPane(pane: AddHomePane['pane']): AddHomePath {
    return pane === 'home_sign_in' ? 'direct' : pane;
}

export function shouldFocusConnectedHome(
    usableHomesAtEntry: readonly string[] | null,
    connectedHomeId?: string,
): boolean {
    return usableHomesAtEntry !== null && (
        usableHomesAtEntry.length === 0
        || (connectedHomeId !== undefined && usableHomesAtEntry.includes(connectedHomeId))
    );
}
