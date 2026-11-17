import * as React from 'react';
import { useRouter } from 'expo-router';

import { useStoredAccountServiceSignIn } from '@/components/account/auth/useAccountServiceSignedInName';
import { useHomeAccountServiceEntry } from '@/components/account/auth/useHomeAccountServiceEntry';
import { buildAuthenticatedAccountEntryHref } from '@/components/navigation/accountEntry/authenticatedAccountEntryRoute';
import {
    createAccountDirectoryServiceKey,
    createAccountDirectorySession,
    type AccountDirectorySession,
} from '@/sync/domains/accountDirectory/accountDirectorySession';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import type { HomeCarrier } from '@/sync/runtime/homeCarrier';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { resolveLinkCurrentHomeOffer } from './accountPopoverModel';

export type AccountEntryIntent = Parameters<typeof buildAuthenticatedAccountEntryHref>[0]['intent'];

/**
 * The account service the current Home points at, as the popover shows it: the entry and its name
 * (`useHomeAccountServiceEntry`), this device's stored sign-in and the signed-in Directory's Homes.
 * Its actions only launch Lane 02 intents (`enter`, `link`) or sign out of that one service; the
 * popover decides nothing about auth, the Directory, linking or persistence. Mounted only while the
 * popover is open.
 */
export function useAccountServicePopoverState(input: Readonly<{
    profile: ServerProfile | null;
    runtimeOrigin: string | null;
    homeCarrier: HomeCarrier | null;
    onClose: () => void;
}>) {
    const router = useRouter();
    const launchingRef = React.useRef(false);
    const { profile, onClose } = input;
    const { entry, namedService, policyReady, policyFailed } = useHomeAccountServiceEntry({
        profile,
        runtimeOrigin: input.runtimeOrigin,
        homeCarrier: input.homeCarrier,
    });
    const discovery = entry.status === 'ready' ? entry.discovery : null;
    const stored = useStoredAccountServiceSignIn({
        url: discovery?.endpointUrl ?? entry.endpoint.url,
        serverIdentityId: discovery?.serverIdentityId ?? entry.endpoint.serverIdentityId,
    });
    const signedIn = stored.signedIn === true;
    const currentHomeServerIdentityId = profile?.serverIdentityId?.trim() || null;
    const discoveredServiceKey = discovery ? createAccountDirectoryServiceKey({
        endpoint: discovery.endpointUrl,
        serverIdentityId: discovery.serverIdentityId,
    }) : null;
    const [directorySessionBinding, setDirectorySessionBinding] = React.useState<Readonly<{
        serviceKey: string;
        session: AccountDirectorySession;
    }> | null>(null);
    const directorySession = directorySessionBinding?.serviceKey === discoveredServiceKey
        ? directorySessionBinding.session
        : null;
    const subscribeDirectorySession = React.useCallback((listener: () => void) => (
        directorySession?.subscribe(() => listener()) ?? (() => {})
    ), [directorySession]);
    const getDirectorySnapshot = React.useCallback(() => directorySession?.snapshot ?? null, [directorySession]);
    const directorySnapshot = React.useSyncExternalStore(
        subscribeDirectorySession,
        getDirectorySnapshot,
        getDirectorySnapshot,
    );

    React.useEffect(() => {
        let cancelled = false;
        setDirectorySessionBinding(null);
        if (!signedIn || !discovery || !discoveredServiceKey) return () => { cancelled = true; };

        void (async () => {
            try {
                const target = {
                    endpoint: discovery.endpointUrl,
                    serverIdentityId: discovery.serverIdentityId,
                };
                const session = createAccountDirectorySession(target, {
                    capability: discovery.capability,
                    transport: entry.transport,
                });
                setDirectorySessionBinding({ serviceKey: discoveredServiceKey, session });
                await session.refresh();
            } catch {
                if (!cancelled) {
                    setDirectorySessionBinding(null);
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [discoveredServiceKey, discovery, entry.transport, signedIn]);

    const openEntry = React.useCallback((intent: AccountEntryIntent) => {
        if (!discovery || launchingRef.current) return;
        launchingRef.current = true;
        const href = buildAuthenticatedAccountEntryHref({
            service: {
                endpointUrl: discovery.endpointUrl,
                serverIdentityId: discovery.serverIdentityId,
            },
            intent,
            returnTo: '/',
        });
        onClose();
        const navigation = runGuardedNavigation(() => router.push(href));
        if (navigation !== true) {
            fireAndForget(navigation, { tag: 'AccountPopover.nav.accountEntry' });
        }
    }, [discovery, onClose, router]);

    const signOut = React.useCallback(async () => {
        if (!directorySession) return;
        const removed = await directorySession.logout();
        if (!removed) return;
        setDirectorySessionBinding(null);
    }, [directorySession]);

    const currentHomeIsLinked = currentHomeServerIdentityId
        ? directorySnapshot?.homes.some((home) => home.homeServerIdentityId === currentHomeServerIdentityId) === true
        : false;
    const selfService = entry.effectiveSignInService.kind === 'self';
    const linkOffer = resolveLinkCurrentHomeOffer({
        serviceReady: discovery !== null && stored.signedIn !== null,
        selfService,
        currentHomeServerIdentityId,
        signedIn,
        directoryReady: directorySnapshot?.status === 'ready',
        currentHomeIsLinked,
    });
    const linkedHomes = signedIn ? directorySnapshot?.homes ?? [] : [];

    return {
        entry,
        namedService,
        serviceUrl: discovery?.endpointUrl ?? entry.endpoint.url,
        advertisedServiceName: discovery?.accountServiceDisplayName ?? null,
        signedIn,
        credentialReadKind: stored.credentialReadKind,
        selfService,
        policyReady,
        policyFailed,
        linkedHomes,
        linkOffer,
        openEntry,
        signOut,
    };
}

export type AccountServicePopoverState = ReturnType<typeof useAccountServicePopoverState>;
