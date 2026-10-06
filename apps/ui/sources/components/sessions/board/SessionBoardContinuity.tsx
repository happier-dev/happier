import * as React from 'react';

import {
    normalizeSessionAddress,
    sessionAddressKey,
    type SessionAddress,
} from '@/sync/domains/session/sessionAddress';

import type {
    SessionBoardCommandOutcome,
    SessionBoardHostedHtmlDraft,
    SessionBoardNoteDraft,
    SessionBoardRetainedMutation,
} from './useSessionBoardController';

export type SessionBoardPresentationPosition = Readonly<{
    anchorItemId: string | null;
    offsetWithinItem: number;
    absoluteOffset: number;
}>;

type StateCell<T> = readonly [T, React.Dispatch<React.SetStateAction<T>>];
type GuardedTransition = (transition: () => void | Promise<void>) => Promise<boolean>;
type EditorDraftFlush = () => void | Promise<void>;

export function sessionBoardNoteDraftBufferKey(itemId: string, expectedRevision: string | null): string {
    return `note:${JSON.stringify([itemId, expectedRevision])}`;
}

export function sessionBoardHostedHtmlDraftBufferKey(itemId: string): string {
    return `hosted-html:${JSON.stringify([itemId])}`;
}

export type SessionBoardContinuity = Readonly<{
    address: SessionAddress;
    focusedItemId: StateCell<string | null>;
    controller: Readonly<{
        requestedViewId: StateCell<string | null>;
        viewRemovalFocusRequest: StateCell<Readonly<{ removedViewId: string; requestId: number }> | null>;
        noteDraft: StateCell<SessionBoardNoteDraft | null>;
        headingFocusRequest: StateCell<Readonly<{ itemId: string; requestId: number }> | null>;
        hostedHtmlDraft: StateCell<SessionBoardHostedHtmlDraft | null>;
        lastOutcome: StateCell<SessionBoardCommandOutcome | null>;
        retainedMutation: StateCell<SessionBoardRetainedMutation | null>;
        announcement: StateCell<string | null>;
        busy: StateCell<boolean>;
    }>;
    viewSelection: Readonly<{
        read: () => string | null;
        request: (viewId: string) => void;
        clear: (viewId?: string) => void;
    }>;
    editorDrafts: Readonly<{
        read: <T>(key: string) => T | null;
        write: <T>(key: string, value: T) => void;
        clear: (key: string) => void;
    }>;
    draftGuard: Readonly<{
        register: (guard: GuardedTransition) => () => void;
        run: GuardedTransition;
    }>;
    /**
     * Transfers the one live editor between retained Board placements. The old
     * placement remains mounted until its editor-held value has reached
     * `editorDrafts`; only then may the next placement mount an editor.
     */
    editorHandoff: Readonly<{
        activeOwnerId: string | null;
        activate: (ownerId: string) => void;
        deactivate: (ownerId: string) => void;
        registerFlush: (ownerId: string, flush: EditorDraftFlush) => () => void;
    }>;
    presentationPositions: Readonly<{
        read: (key: string) => SessionBoardPresentationPosition | null;
        write: (key: string, position: SessionBoardPresentationPosition) => void;
        clear: (key: string) => void;
    }>;
}>;

const SessionBoardContinuityContext = React.createContext<SessionBoardContinuity | null>(null);

/**
 * Viewer-local continuity for one exact Home-qualified Session.
 *
 * The ordinary Session route layout owns this provider, so responsive host and
 * nested-route changes replace only a projection of the Board. Nothing here is
 * persisted, module-global, or shared across windows, Accounts, Homes or
 * Sessions.
 */
export function SessionBoardContinuityProvider(props: React.PropsWithChildren<Readonly<{
    sessionId: string;
    serverId?: string | null;
}>>): React.ReactElement {
    const address = React.useMemo(
        () => normalizeSessionAddress(props.serverId ?? null, props.sessionId),
        [props.serverId, props.sessionId],
    );
    if (!address) return <>{props.children}</>;
    return <QualifiedSessionBoardContinuityProvider key={sessionAddressKey(address)} address={address}>{props.children}</QualifiedSessionBoardContinuityProvider>;
}

function QualifiedSessionBoardContinuityProvider(props: React.PropsWithChildren<Readonly<{
    address: SessionAddress;
}>>): React.ReactElement {
    const focusedItemId = React.useState<string | null>(null);
    const requestedViewId = React.useState<string | null>(null);
    // The imperative read of the one selection state. A command's Undo captured the
    // provider value from the render that published it, so reading the state tuple
    // through that closure answered the pre-command selection forever. Requests and
    // clears move this ref synchronously; the render keeps it equal to the state.
    const requestedViewIdRef = React.useRef(requestedViewId[0]);
    requestedViewIdRef.current = requestedViewId[0];
    const viewRemovalFocusRequest = React.useState<Readonly<{ removedViewId: string; requestId: number }> | null>(null);
    const noteDraft = React.useState<SessionBoardNoteDraft | null>(null);
    const headingFocusRequest = React.useState<Readonly<{ itemId: string; requestId: number }> | null>(null);
    const hostedHtmlDraft = React.useState<SessionBoardHostedHtmlDraft | null>(null);
    const lastOutcome = React.useState<SessionBoardCommandOutcome | null>(null);
    const retainedMutation = React.useState<SessionBoardRetainedMutation | null>(null);
    const announcement = React.useState<string | null>(null);
    const busy = React.useState(false);
    const editorDraftsRef = React.useRef(new Map<string, unknown>());
    const mountedRef = React.useRef(true);
    React.useLayoutEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);
    const presentationPositionsRef = React.useRef(new Map<string, SessionBoardPresentationPosition>());
    const activeGuardRef = React.useRef<GuardedTransition | null>(null);
    const [activeEditorOwnerId, setActiveEditorOwnerId] = React.useState<string | null>(null);
    const activeEditorOwnerRef = React.useRef<string | null>(null);
    const desiredEditorOwnerRef = React.useRef<string | null>(null);
    const editorFlushesRef = React.useRef(new Map<string, EditorDraftFlush>());
    const editorHandoffRef = React.useRef<Promise<void>>(Promise.resolve());

    const applyEditorHandoff = React.useCallback(() => {
        const handoff = async () => {
            const currentOwnerId = activeEditorOwnerRef.current;
            const desiredOwnerId = desiredEditorOwnerRef.current;
            if (currentOwnerId === desiredOwnerId) return;

            if (currentOwnerId) {
                await editorFlushesRef.current.get(currentOwnerId)?.();
            }

            // Another placement may have become active while the prior editor
            // was flushing (notably the native WebView round-trip). Commit the
            // latest requested owner, never the stale request.
            const nextOwnerId = desiredEditorOwnerRef.current;
            activeEditorOwnerRef.current = nextOwnerId;
            setActiveEditorOwnerId(nextOwnerId);
        };
        editorHandoffRef.current = editorHandoffRef.current.then(handoff, handoff);
    }, []);
    const activateEditor = React.useCallback((ownerId: string) => {
        desiredEditorOwnerRef.current = ownerId;
        applyEditorHandoff();
    }, [applyEditorHandoff]);
    const deactivateEditor = React.useCallback((ownerId: string) => {
        // A stale retained placement must not clear a newer placement's request
        // when React runs sibling effects in a different order.
        if (desiredEditorOwnerRef.current !== ownerId
            && activeEditorOwnerRef.current !== ownerId) return;
        if (desiredEditorOwnerRef.current === ownerId) {
            desiredEditorOwnerRef.current = null;
        }
        applyEditorHandoff();
    }, [applyEditorHandoff]);
    const registerEditorFlush = React.useCallback((ownerId: string, flush: EditorDraftFlush) => {
        editorFlushesRef.current.set(ownerId, flush);
        return () => {
            if (editorFlushesRef.current.get(ownerId) === flush) {
                editorFlushesRef.current.delete(ownerId);
            }
        };
    }, []);

    const value = React.useMemo<SessionBoardContinuity>(() => {
        const request = (viewId: string) => {
            requestedViewIdRef.current = viewId;
            requestedViewId[1](viewId);
        };
        const clear = (viewId?: string) => {
            if (viewId === undefined || requestedViewIdRef.current === viewId) requestedViewIdRef.current = null;
            requestedViewId[1]((current) => (
                viewId === undefined || current === viewId ? null : current
            ));
        };
        return {
            address: props.address,
            focusedItemId,
            controller: {
                requestedViewId,
                viewRemovalFocusRequest,
                noteDraft,
                headingFocusRequest,
                hostedHtmlDraft,
                lastOutcome,
                retainedMutation,
                announcement,
                busy,
            },
            viewSelection: {
                read: () => requestedViewIdRef.current,
                request,
                clear,
            },
            editorDrafts: {
                // Pending editor results may outlive the Session shell, but may
                // not retire a draft or publish notices into its replacement.
                read: <T,>(key: string) => mountedRef.current
                    ? (editorDraftsRef.current.get(key) as T | undefined) ?? null : null,
                write: <T,>(key: string, draft: T) => { editorDraftsRef.current.set(key, draft); },
                clear: (key: string) => { editorDraftsRef.current.delete(key); },
            },
            draftGuard: {
                register: (guard) => {
                    activeGuardRef.current = guard;
                    return () => {
                        if (activeGuardRef.current === guard) activeGuardRef.current = null;
                    };
                },
                run: async (transition) => {
                    const guard = activeGuardRef.current;
                    if (guard) return await guard(transition);
                    await transition();
                    return true;
                },
            },
            editorHandoff: {
                activeOwnerId: activeEditorOwnerId,
                activate: activateEditor,
                deactivate: deactivateEditor,
                registerFlush: registerEditorFlush,
            },
            presentationPositions: {
                read: (key) => presentationPositionsRef.current.get(key) ?? null,
                write: (key, position) => { presentationPositionsRef.current.set(key, position); },
                clear: (key) => { presentationPositionsRef.current.delete(key); },
            },
        };
    }, [
        // React state tuples are fresh on every render; their values and stable
        // setters define the published continuity, not the tuple wrappers.
        announcement[0],
        activeEditorOwnerId,
        activateEditor,
        busy[0],
        deactivateEditor,
        focusedItemId[0],
        hostedHtmlDraft[0],
        headingFocusRequest[0],
        lastOutcome[0],
        retainedMutation[0],
        noteDraft[0],
        props.address,
        registerEditorFlush,
        requestedViewId[0],
        viewRemovalFocusRequest[0],
    ]);

    return (
        <SessionBoardContinuityContext.Provider value={value}>
            {props.children}
        </SessionBoardContinuityContext.Provider>
    );
}

/** Returns continuity only when the caller names the provider's exact Session. */
export function useSessionBoardContinuity(address: SessionAddress | null): SessionBoardContinuity | null {
    const continuity = React.useContext(SessionBoardContinuityContext);
    if (!continuity || !address) return null;
    return sessionAddressKey(continuity.address) === sessionAddressKey(address) ? continuity : null;
}

/** Editors are already nested beneath an exact-qualified Board pane. */
export function useMountedSessionBoardContinuity(): SessionBoardContinuity | null {
    return React.useContext(SessionBoardContinuityContext);
}
