import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { ScreenCaptureOpenResultSchema } from '@happier-dev/protocol/actions/actionSpecs';
import type { SessionSelectionCandidate } from '@/components/sessions/selection/projectSessionSelectionRows';
import { isWritableSessionSelectionCandidate } from '@/components/sessions/selection/sessionSelectionCandidates';
import { listSessionListLookupServerSessions } from '@/sync/domains/session/listing/sessionListLookupState';
import { buildServerScopedSessionKey, buildVisibleSessionNavigationEntries, findVisibleSessionNavigationEntryByScope,
    resolveSessionMruNavigation } from '@/sync/domains/session/navigation/sessionNavigationOrder';
import { getFocusedSessionAddress } from '@/sync/domains/session/sessionSurfaceVisibility';
import { readSessionMruOrder, readLastCaptureSessionPick, readLastFocusedSessionVisit,
    rememberCaptureSessionPick as rememberCapturePick, type SessionRecentTarget } from '@/sync/domains/session/navigation/recentSessions';
import { storage } from '@/sync/domains/state/storageStore';

export type CaptureDefaultReason = NonNullable<ReturnType<typeof ScreenCaptureOpenResultSchema.parse>['defaultReason']>;
export type CaptureDefaultSelection = Readonly<{ address: SessionAddress | null; defaultReason: CaptureDefaultReason | null }>;

type CaptureDefaultInput = Readonly<{
    candidates: readonly SessionSelectionCandidate[];
    focusedSession: SessionAddress | null;
    mruOrder: readonly string[];
    explicitSession?: SessionAddress | null;
    lastCapturePick?: SessionRecentTarget | null;
    lastFocusedVisit?: SessionRecentTarget | null;
}>;

function chooseCaptureDefaultSelection(input: CaptureDefaultInput): CaptureDefaultSelection {
    if (input.explicitSession) return { address: input.explicitSession, defaultReason: null };
    const entries = buildVisibleSessionNavigationEntries(input.candidates
        .filter(isWritableSessionSelectionCandidate)
        .map(session => ({ type: 'session', sessionId: session.id, serverId: session.serverId })));
    const focused = input.focusedSession && findVisibleSessionNavigationEntryByScope(entries,
        input.focusedSession.sessionId, input.focusedSession.serverId);
    const lastPick = input.lastCapturePick && entries.find(entry => entry.sessionKey === input.lastCapturePick?.sessionKey);
    const lastFocus = input.lastFocusedVisit && entries.find(entry => entry.sessionKey === input.lastFocusedVisit?.sessionKey);
    if (lastPick?.serverId && (!lastFocus || input.lastCapturePick!.timestamp > input.lastFocusedVisit!.timestamp)) {
        return { address: { serverId: lastPick.serverId, sessionId: lastPick.sessionId }, defaultReason: 'lastCapturePick' };
    }
    const target = focused ?? resolveSessionMruNavigation({ order: input.mruOrder, knownSessionEntries: entries,
        activeSessionKey: null, cursorSessionKey: null, direction: 'previous' });
    return { address: target?.serverId ? { serverId: target.serverId, sessionId: target.sessionId } : null,
        defaultReason: target ? (focused ? 'focusedSession' : 'lastUsed') : null };
}

export function chooseCaptureDefaultTarget(input: CaptureDefaultInput): SessionAddress | null {
    return chooseCaptureDefaultSelection(input).address;
}

export function rememberCaptureSessionPick(address: SessionAddress): void {
    rememberCapturePick(buildServerScopedSessionKey(address.sessionId, address.serverId));
}

export function resolveCaptureDefaultSelection(input: Readonly<{
    targetSession?: SessionAddress | null;
    candidates?: readonly SessionSelectionCandidate[];
}> = {}): CaptureDefaultSelection {
    if (input.targetSession) return { address: input.targetSession, defaultReason: null };
    return chooseCaptureDefaultSelection({
        candidates: input.candidates ?? listSessionListLookupServerSessions(storage.getState())
            .map(({ session, serverId }) => ({ ...session, serverId })),
        focusedSession: getFocusedSessionAddress(), mruOrder: readSessionMruOrder(),
        lastCapturePick: readLastCaptureSessionPick(), lastFocusedVisit: readLastFocusedSessionVisit(),
    });
}

/** An explicit requesting/attach target is already admitted by its caller. */
export function resolveCaptureDefaultTarget(input: Readonly<{ targetSession?: SessionAddress | null }> = {}): SessionAddress | null {
    return resolveCaptureDefaultSelection(input).address;
}
