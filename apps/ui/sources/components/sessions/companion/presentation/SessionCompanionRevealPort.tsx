import * as React from 'react';

import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';

import type { SessionCompanionMutationOutcome } from '../state/useSessionCompanionController';
import { useResolveSessionCompanionPlacement } from '../layout/useSessionCompanionPlacement';
import { shouldOpenFullCompanionAfterShow } from '../sessionCompanionHeaderIntent';

/**
 * The Session shell's narrow presentation port for revealing Companion content.
 *
 * Preference mutation stays with `SessionCompanionController`; route/pane
 * presentation stays with the incumbent Session shell. The exact address on the
 * port prevents a retained same-id Session on another Home from borrowing the
 * active shell's navigation callback.
 */
export type SessionCompanionRevealPort = Readonly<{
    address: SessionAddress;
    openFullSurface: () => void;
    revealAfterMutation: (outcome: SessionCompanionMutationOutcome) => void;
    /** Reveals the exact current Board item through the mounted Session shell. */
    revealBoardItem: (itemId: string) => void;
    /** Current shell's admitted presentation Action; absent on surfaces without Chat. */
    showItemInChat?: (itemId: string, occurrenceId: string) => void;
}>;

const SessionCompanionRevealContext = React.createContext<SessionCompanionRevealPort | null>(null);

export function SessionCompanionRevealPortProvider(
    props: React.PropsWithChildren<Readonly<{
        address: SessionAddress | null;
        openFullSurface: () => void;
        revealAfterMutation: (outcome: SessionCompanionMutationOutcome) => void;
        revealBoardItem: (itemId: string) => void;
        showItemInChat?: SessionCompanionRevealPort['showItemInChat'];
    }>>,
): React.ReactElement {
    const value = React.useMemo<SessionCompanionRevealPort | null>(() => (
        props.address
            ? Object.freeze({
                address: props.address,
                openFullSurface: props.openFullSurface,
                revealAfterMutation: props.revealAfterMutation,
                revealBoardItem: props.revealBoardItem,
                showItemInChat: props.showItemInChat,
            })
            : null
    ), [props.address, props.openFullSurface, props.revealAfterMutation, props.revealBoardItem, props.showItemInChat]);
    return (
        <SessionCompanionRevealContext.Provider value={value}>
            {props.children}
        </SessionCompanionRevealContext.Provider>
    );
}

/**
 * Bind the exact shell navigation callback to the existing placement resolver.
 * This component must be mounted below `AppPaneScopeHost`, whose measured layout
 * is the authority for whether the Companion can reveal in place.
 */
export function SessionCompanionRevealOwner(
    props: React.PropsWithChildren<Readonly<{
        address: SessionAddress | null;
        paneScopeId: string;
        openFullSurface: () => void;
        revealBoardItem: (itemId: string) => void;
        showItemInChat?: SessionCompanionRevealPort['showItemInChat'];
    }>>,
): React.ReactElement {
    const resolvePlacement = useResolveSessionCompanionPlacement({
        sessionId: props.address?.sessionId ?? null,
        serverId: props.address?.serverId ?? null,
        paneScopeId: props.paneScopeId,
    });
    const revealAfterMutation = React.useCallback((outcome: SessionCompanionMutationOutcome) => {
        if (shouldOpenFullCompanionAfterShow({
            applied: outcome.applied,
            resolvePlacement,
        })) {
            props.openFullSurface();
        }
    }, [props.openFullSurface, resolvePlacement]);

    return (
        <SessionCompanionRevealPortProvider
            address={props.address}
            openFullSurface={props.openFullSurface}
            revealAfterMutation={revealAfterMutation}
            revealBoardItem={props.revealBoardItem}
            showItemInChat={props.showItemInChat}
        >
            {props.children}
        </SessionCompanionRevealPortProvider>
    );
}

export function useSessionCompanionRevealPort(
    address: SessionAddress | null,
): SessionCompanionRevealPort | null {
    const port = React.useContext(SessionCompanionRevealContext);
    if (!port || !address) return null;
    return sessionAddressKey(port.address) === sessionAddressKey(address) ? port : null;
}
