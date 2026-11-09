import * as React from 'react';

import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { ServerCredentialAccountScopeBindingProvider, useServerCredentialAccountScopeBinding, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

import { CLOSED_SESSION_VIEWER, type SessionViewerPresentationState } from './sessionViewerPresentation';
import { SessionBoardControllerProvider } from '@/components/sessions/board/SessionBoardControllerProvider';

function createPresentationState(isCurrent: () => boolean = () => true) {
    let state = CLOSED_SESSION_VIEWER;
    const listeners = new Set<() => void>();
    return {
        getSnapshot: () => isCurrent() ? state : CLOSED_SESSION_VIEWER,
        setState(next: SessionViewerPresentationState) {
            if (!isCurrent() || next === state) return;
            state = next;
            for (const listener of listeners) listener();
        },
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
}

type DestinationViewerScope = Readonly<{
    sessionId: string;
    accountLifetime: ServerCredentialAccountScopeBinding;
    presentation: ReturnType<typeof createPresentationState>;
}>;

type DestinationSessionOwner = Readonly<{
    sessionId: string;
    serverId: string | null;
    scope: DestinationViewerScope | null;
}>;

const DestinationViewerContext = React.createContext<DestinationSessionOwner | null>(null);

/**
 * Session Account authority, Board execution and viewer presentation outlive route/shell replacement.
 * The destination owns their lifetime; the shell still owns pane callbacks, and the retained
 * source owns its stream.
 */
export function SessionViewerDestinationScope(props: React.PropsWithChildren<Readonly<{
    sessionId: string;
    serverId: string | null;
}>>): React.ReactElement {
    const credentialScope = useServerCredentialAccountScopeBinding(props.serverId);
    const { binding } = credentialScope;
    const scope = React.useMemo<DestinationViewerScope | null>(() => binding ? {
        sessionId: props.sessionId,
        accountLifetime: binding,
        presentation: createPresentationState(binding.isCurrent),
    } : null, [binding, props.sessionId]);
    const owner = React.useMemo<DestinationSessionOwner>(() => ({ sessionId: props.sessionId, serverId: props.serverId, scope }),
        [props.serverId, props.sessionId, scope]);
    // The Session's Board, approval, plugin and hosted-HTML runtimes share this one Home resolution.
    return <DestinationViewerContext.Provider value={owner}>
        <ServerCredentialAccountScopeBindingProvider serverId={props.serverId} state={credentialScope}>
            <SessionBoardControllerProvider sessionId={props.sessionId} serverId={props.serverId}>
                {props.children}
            </SessionBoardControllerProvider>
        </ServerCredentialAccountScopeBindingProvider>
    </DestinationViewerContext.Provider>;
}

function useMatchingSessionDestinationOwner(sessionId: string, serverId: string | null): DestinationSessionOwner | null {
    const owner = React.useContext(DestinationViewerContext);
    return owner?.sessionId === sessionId && owner.serverId !== null && serverId !== null
        && areServerProfileIdentifiersEquivalent(owner.serverId, serverId) ? owner : null;
}

/** Undefined means standalone; null means the matching destination has no current authority yet. */
export function useSessionDestinationAccountBinding(sessionId: string, serverId: string | null): ServerCredentialAccountScopeBinding | null | undefined {
    const owner = useMatchingSessionDestinationOwner(sessionId, serverId);
    if (!owner) return undefined;
    const binding = owner.scope?.accountLifetime;
    return binding?.isCurrent() ? binding : null;
}

export function useSessionViewerDestinationScope(sessionId: string, serverId: string | null): DestinationViewerScope | null {
    const scope = useMatchingSessionDestinationOwner(sessionId, serverId)?.scope;
    return scope?.accountLifetime.isCurrent() ? scope : null;
}

/** A standalone/embedded Session keeps its existing local owner; a destination supplies the same one across shells. */
export function useSessionViewerPresentationState(sessionId: string, serverId: string | null) {
    const destination = useSessionViewerDestinationScope(sessionId, serverId);
    const local = React.useMemo(() => createPresentationState(), [serverId, sessionId]);
    const owner = destination?.presentation ?? local;
    const state = React.useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
    return { state, setState: owner.setState, readState: owner.getSnapshot };
}

/**
 * Whether the Session's viewer is presented now, read on demand by a caller that must not follow
 * presentation changes (a cockpit deciding where to land as it mounts). Standalone and embedded
 * Sessions have no destination owner and read as not presenting.
 */
export function useSessionViewerPresentingReader(sessionId: string, serverId: string | null): () => boolean {
    const destination = useSessionViewerDestinationScope(sessionId, serverId);
    return React.useCallback(
        () => destination !== null && destination.presentation.getSnapshot().mode !== 'closed',
        [destination],
    );
}
