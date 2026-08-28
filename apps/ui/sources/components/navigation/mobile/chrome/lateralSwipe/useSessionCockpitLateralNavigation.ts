/**
 * The single step-decision for the cockpit's lateral session navigation.
 *
 * Every input that can move the user sideways — the band pan gesture, the picker it
 * opens, and the VoiceOver/TalkBack "Previous session" / "Next session" actions — calls
 * `navigate` here, so there is exactly one answer to what lies each way, what "next"
 * means, and what the user is told about the landing.
 *
 * Ordering itself is NOT decided here: the frozen order and the walk belong to
 * `sessionNavigationCursor`. This hook only resolves the anchor inside that order,
 * dresses each neighbour with what the readout has to paint, and navigates.
 */

import * as React from 'react';

import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { t } from '@/text';
import { SESSION_LATERAL_PICKER_MAX_REACHABLE_ENTRIES } from './sessionLateralPickerState';
import {
    resolveSessionNavigationCursorStep,
    type SessionNavigationCursor,
} from '@/sync/domains/session/navigation/sessionNavigationCursor';
import { useSessionNavigationCursor } from '@/sync/domains/session/navigation/sessionNavigationCursorStore';
import {
    buildServerScopedSessionKey,
    type SessionNavigationDirection,
    type VisibleSessionNavigationEntry,
} from '@/sync/domains/session/navigation/sessionNavigationOrder';
import { storage } from '@/sync/domains/state/storage';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';

export type SessionLateralNavigationTarget = Readonly<{
    sessionId: string;
    serverId?: string;
    /**
     * The session's open presentation Agent identity from the canonical
     * layout-aware view — exact for a novel external Agent, `null` when
     * unknown. Consumers render the catalog owner's neutral mark; this path
     * never substitutes a default or bundled Agent.
     */
    agentId: string | null;
    /** The session's own machine fact, scoping catalog identity resolution. */
    machineId: string | null;
    title: string;
    /** 1-based position inside the captured order, for the readout and its announcement. */
    position: number;
    total: number;
}>;

export type SessionCockpitLateralNavigation = Readonly<{
    previous: SessionLateralNavigationTarget | null;
    next: SessionLateralNavigationTarget | null;
    /**
     * The session the neighbours are measured FROM. Exposed because a consumer that caches
     * resolved targets has to invalidate on this as well as on the direction — the anchor
     * moves on every commit, and a cache keyed on direction alone silently keeps describing
     * the session you just left.
     */
    anchorSessionKey: string | null;
    /**
     * How many sessions lie that way, capped at the picker's reach. Deliberately cheap —
     * it walks the captured order and reads no metadata — because the gesture needs it
     * for every direction before it knows which one the finger will choose.
     */
    availableCount: (direction: SessionNavigationDirection) => number;
    /**
     * The picker's rows, nearest first, capped at the picker's reach.
     *
     * Imperative rather than a memo: it reads session metadata, and the only moment that
     * is worth doing is when the picker opens. Calling it per frame — or holding it as a
     * subscription in a host mounted on every route — is the thing this shape exists to
     * prevent.
     */
    resolveTargets: (direction: SessionNavigationDirection) => readonly SessionLateralNavigationTarget[];
    /**
     * Steps and announces. `index` is 1-based into the direction and defaults to the
     * immediate neighbour. Returns false when that direction has no entry there.
     */
    navigate: (direction: SessionNavigationDirection, index?: number) => boolean;
}>;

/**
 * The active session's key inside the captured order. The scoped key is preferred so
 * the same session id on two servers cannot collide; a bare-key cursor (captured from
 * a list with no server scope) still resolves by session id.
 */
function resolveAnchorSessionKey(
    cursor: SessionNavigationCursor | null,
    sessionId: string | null,
    serverId: string | null | undefined,
): string | null {
    if (!cursor || !sessionId) return null;
    const scopedKey = buildServerScopedSessionKey(sessionId, serverId ?? null);
    if (cursor.entries.some((entry) => entry.sessionKey === scopedKey)) return scopedKey;
    return cursor.entries.find((entry) => entry.sessionId === sessionId)?.sessionKey ?? null;
}

/**
 * Walks the captured order up to `count` steps that way, nearest first, and stops at the
 * edge. One walk serves the immediate neighbour, the picker's rows and the count, so
 * "what lies that way" cannot develop two answers that disagree by one.
 */
function resolveEntriesInDirection(
    cursor: SessionNavigationCursor | null,
    anchorSessionKey: string | null,
    direction: SessionNavigationDirection,
    count: number,
): readonly VisibleSessionNavigationEntry[] {
    const entries: VisibleSessionNavigationEntry[] = [];
    let anchor = anchorSessionKey;
    while (entries.length < count) {
        const step = resolveSessionNavigationCursorStep({ cursor, anchorSessionKey: anchor, direction });
        if (step.kind !== 'target') break;
        entries.push(step.entry);
        anchor = step.cursorSessionKey;
    }
    return entries;
}

/** Non-reactive metadata read; see the call site for why this is not a subscription. */
function readSessionMetadata(sessionId: string | undefined) {
    if (!sessionId) return null;
    return storage.getState().sessions[sessionId]?.metadata ?? null;
}

/**
 * One non-reactive presentation-identity read per target, through the same
 * canonical layout-aware view Session rows and the tab bar read: the exact
 * open Agent identity (a novel external Agent included), `null` when unknown —
 * never a flavor/default substitution — plus the machine fact that scopes
 * catalog resolution.
 */
function readSessionIdentityView(sessionId: string | undefined): Readonly<{
    agentId: string | null;
    machineId: string | null;
}> {
    if (!sessionId) return { agentId: null, machineId: null };
    const session = storage.getState().sessions[sessionId];
    if (!session) return { agentId: null, machineId: null };
    return {
        agentId: readSessionPresentationAgentId(session),
        machineId: readSessionOwnerMetadataView(session)?.machineId ?? null,
    };
}

function buildTarget(
    cursor: SessionNavigationCursor | null,
    entry: VisibleSessionNavigationEntry | null,
    metadata: ReturnType<typeof readSessionMetadata>,
    identity: ReturnType<typeof readSessionIdentityView>,
): SessionLateralNavigationTarget | null {
    if (!cursor || !entry) return null;
    const position = cursor.entries.findIndex((candidate) => candidate.sessionKey === entry.sessionKey) + 1;
    if (position <= 0) return null;
    return {
        sessionId: entry.sessionId,
        ...(entry.serverId ? { serverId: entry.serverId } : null),
        agentId: identity.agentId,
        machineId: identity.machineId,
        title: getSessionName({ id: entry.sessionId, metadata: metadata ?? null }),
        position,
        total: cursor.entries.length,
    };
}

export function useSessionCockpitLateralNavigation(params: Readonly<{
    sessionId: string | null;
    serverId?: string | null;
}>): SessionCockpitLateralNavigation {
    const { sessionId, serverId } = params;
    const cursor = useSessionNavigationCursor();
    const navigateToSession = useNavigateToSession();

    const anchorSessionKey = React.useMemo(
        () => resolveAnchorSessionKey(cursor, sessionId, serverId),
        [cursor, serverId, sessionId],
    );
    const previousEntry = React.useMemo(
        () => resolveEntriesInDirection(cursor, anchorSessionKey, 'previous', 1)[0] ?? null,
        [anchorSessionKey, cursor],
    );
    const nextEntry = React.useMemo(
        () => resolveEntriesInDirection(cursor, anchorSessionKey, 'next', 1)[0] ?? null,
        [anchorSessionKey, cursor],
    );

    // Metadata is read imperatively at build time rather than through `useSessionMetadata`,
    // because this hook runs inside `MobileBottomChromeHost` — which is mounted on EVERY route,
    // including ones with no session at all. Two subscriptions per app render (plus a hard
    // dependency on the storage module in every route suite) bought nothing: the title and agent
    // are only ever read to paint the readout during a drag and to announce the landing.
    const previous = React.useMemo(
        () => buildTarget(
            cursor,
            previousEntry,
            readSessionMetadata(previousEntry?.sessionId),
            readSessionIdentityView(previousEntry?.sessionId),
        ),
        [cursor, previousEntry],
    );
    const next = React.useMemo(
        () => buildTarget(
            cursor,
            nextEntry,
            readSessionMetadata(nextEntry?.sessionId),
            readSessionIdentityView(nextEntry?.sessionId),
        ),
        [cursor, nextEntry],
    );

    // The gesture reads `navigate` from a worklet's JS callback and from a memoised
    // gesture chain, so its identity has to survive every cursor change.
    const orderRef = React.useRef({ cursor, anchorSessionKey });
    orderRef.current = { cursor, anchorSessionKey };

    const resolveTargets = React.useCallback((
        direction: SessionNavigationDirection,
    ): readonly SessionLateralNavigationTarget[] => {
        const { cursor: currentCursor, anchorSessionKey: currentAnchor } = orderRef.current;
        return resolveEntriesInDirection(
            currentCursor,
            currentAnchor,
            direction,
            SESSION_LATERAL_PICKER_MAX_REACHABLE_ENTRIES,
        )
            .map((entry) => buildTarget(
                currentCursor,
                entry,
                readSessionMetadata(entry.sessionId),
                readSessionIdentityView(entry.sessionId),
            ))
            .filter((target): target is SessionLateralNavigationTarget => target !== null);
    }, []);

    const availableCount = React.useMemo(() => (direction: SessionNavigationDirection): number => (
        resolveEntriesInDirection(
            cursor,
            anchorSessionKey,
            direction,
            SESSION_LATERAL_PICKER_MAX_REACHABLE_ENTRIES,
        ).length
    ), [anchorSessionKey, cursor]);

    const navigate = React.useCallback((direction: SessionNavigationDirection, index = 1): boolean => {
        const target = resolveTargets(direction)[Math.max(1, Math.floor(index)) - 1] ?? null;
        if (!target) return false;
        fireAndForget(navigateToSession(target.sessionId, { serverId: target.serverId ?? undefined }));
        announceAccessibilityMessage(t('workspaceCockpit.switchedToSession', {
            name: target.title,
            position: target.position,
            total: target.total,
        }));
        return true;
    }, [navigateToSession, resolveTargets]);

    return React.useMemo(
        () => ({ previous, next, anchorSessionKey, availableCount, navigate, resolveTargets }),
        [anchorSessionKey, availableCount, navigate, next, previous, resolveTargets],
    );
}
