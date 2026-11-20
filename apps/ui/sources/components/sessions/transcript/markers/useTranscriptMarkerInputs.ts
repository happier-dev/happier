import * as React from 'react';

import {
  type SessionSurfacePresence,
  useOptionalSessionSurfacePresenceSignal,
} from '@/components/sessions/shell/sessionSurfacePresence';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { resolveLastViewedSessionSeq } from '@/sync/domains/session/readCursor/resolveLastViewedSessionSeq';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { Session } from '@/sync/domains/state/storageTypes';
import { storage, useSetting } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';

import {
  type TranscriptMarkerInputs,
  type TranscriptTurnEndFact,
} from './transcriptMarkers';

const NO_TURN_ENDS: readonly TranscriptTurnEndFact[] = Object.freeze([]);

function isOpened(presence: SessionSurfacePresence): boolean {
  return presence.visible && presence.focused;
}

/**
 * What this surface knew when it was opened (each time it becomes visible and focused):
 * - `seq`: the Session's read cursor before the open marked it viewed;
 * - `turnsKnown`: whether the Session's turn facts have arrived for this visit.
 * - `lateSettled`: ends already in the committed transcript when their facts arrived. These lines wait for
 *   the next visit, while ends entering through paging can draw with their rows.
 */
type CapturedOpen = Readonly<{
  sessionId: string;
  seq: number | null;
  /** The stored Session existed at the open; when it did not (a list-row stand-in), its cursor is taken once it is stored. */
  stored: boolean;
  turnsKnown: boolean;
  lateSettled: ReadonlySet<string> | null;
}>;

/** A caught-up cursor (nothing after it) draws no divider, so it reads as null and showing again changes nothing. */
function readStoredCursor(sessionId: string): Readonly<{ stored: boolean; seq: number | null }> {
  const stored = storage.getState().sessions[sessionId];
  if (!stored) return { stored: false, seq: null };
  const seq = resolveLastViewedSessionSeq(stored) ?? null;
  return { stored: true, seq: seq !== null && seq < stored.seq ? seq : null };
}

function readCommittedCoverage(sessionId: string) {
  const state = storage.getState();
  const transcript = state.sessionMessages[sessionId];
  return {
    sessionId,
    messagesById: transcript?.messagesById,
    latestNonRenderableSeq: transcript?.latestNonRenderableMessageSeq,
    window: sync.getSessionTargetWindowState(sessionId),
    tailBoundary: state.sessionTailContiguousBoundary?.[sessionId],
  };
}

function findLateSettled(
  turnEnds: readonly TranscriptTurnEndFact[],
  coverage: ReturnType<typeof readCommittedCoverage>,
): ReadonlySet<string> | null {
  const { messagesById, latestNonRenderableSeq, window, tailBoundary } = coverage;
  const { windowMinSeq, windowMaxSeq } = window;
  const windowCovers = window.isWindowMode && windowMinSeq !== null && windowMaxSeq !== null
    ? (seq: number) => seq >= windowMinSeq && seq <= windowMaxSeq : null;
  const rowSeqs = windowCovers ? null : new Set(Object.values(messagesById ?? {}).map((row) => row.seq));
  const tailMin = tailBoundary?.kind === 'seq' ? tailBoundary.seq : -Infinity;
  const late = new Set<string>();
  for (const { endSeq, turnId } of turnEnds) {
    if (endSeq === null) continue;
    const covered = windowCovers?.(endSeq)
      ?? (endSeq >= tailMin && (rowSeqs?.has(endSeq) || endSeq === latestNonRenderableSeq));
    if (covered) late.add(turnId);
  }
  return late.size > 0 ? late : null;
}

function useOpenedFacts(
  session: Session,
  settledTurnEnds: readonly TranscriptTurnEndFact[] | null,
  hasTranscriptRows: boolean,
  appTranscript: boolean,
): CapturedOpen | null {
  const signal = useOptionalSessionSurfacePresenceSignal();
  const committedCoverage = React.useRef<ReturnType<typeof readCommittedCoverage> | null>(null);
  const current = React.useRef({ session, hasTranscriptRows, appTranscript });
  current.current = { session, hasTranscriptRows, appTranscript };
  const rememberPendingRows = React.useCallback(() => {
    const { session, hasTranscriptRows, appTranscript } = current.current;
    committedCoverage.current = appTranscript && hasTranscriptRows && session.sessionTurns == null
      ? readCommittedCoverage(session.id)
      : null;
  }, []);
  React.useLayoutEffect(() => {
    if (!signal || signal.get().presented) rememberPendingRows();
  });
  const capture = React.useCallback(
    (): CapturedOpen => ({
      sessionId: current.current.session.id,
      // The stored Session, never the prop: the Session view's shell projection keeps one reference while
      // only read-state facts move, and a list-row stand-in carries no read cursor. Not stored yet = unknown.
      ...readStoredCursor(current.current.session.id),
      turnsKnown: current.current.session.sessionTurns != null,
      lateSettled: null,
    }),
    [],
  );
  const [captured, setCaptured] = React.useState<CapturedOpen | null>(() =>
    !signal || isOpened(signal.get()) ? capture() : null,
  );
  if (captured !== null && captured.sessionId !== session.id) {
    setCaptured(!signal || isOpened(signal.get()) ? capture() : null);
  } else if (captured !== null) {
    // Opened before the Session was stored: take its cursor once it is. A read-state update while viewing
    // (the open's own mark) never moves the divider and never renders the transcript.
    const cursor = captured.stored ? captured : readStoredCursor(session.id);
    const turnsKnown = captured.turnsKnown || settledTurnEnds !== null;
    const coverage = committedCoverage.current;
    const lateSettled = !captured.turnsKnown && settledTurnEnds !== null && coverage?.sessionId === session.id
      ? findLateSettled(settledTurnEnds, coverage)
      : captured.lateSettled;
    if (cursor.stored !== captured.stored || turnsKnown !== captured.turnsKnown) {
      setCaptured({ ...captured, stored: cursor.stored, seq: cursor.seq, turnsKnown, lateSettled });
    }
  }
  React.useLayoutEffect(() => {
    if (!signal) return;
    let previousPresence = signal.get();
    return signal.subscribe(() => {
      const presence = signal.get();
      if (!presence.presented && previousPresence.presented) {
        // Prepare the retained transcript while it is hidden, before the next visible commit.
        committedCoverage.current = null;
        setCaptured((previous) => previous?.lateSettled ? { ...previous, lateSettled: null } : previous);
      }
      if (isOpened(presence) && !isOpened(previousPresence)) {
        rememberPendingRows();
        const next = capture();
        setCaptured((previous) => {
          if (previous?.sessionId !== next.sessionId) return next;
          return previous.seq === next.seq && previous.stored === next.stored && previous.turnsKnown === next.turnsKnown
            ? previous : next;
        });
      }
      previousPresence = presence;
    });
  }, [capture, rememberPendingRows, signal]);
  return captured?.sessionId === session.id ? captured : null;
}

/** The transcript markers' inputs: the opened read cursor and, while "Show turn duration" is on, settled turn ends. */
export function useTranscriptMarkerInputs(
  session: Session,
  hasTranscriptRows: boolean,
  viewerScope: ServerAccountScope | null,
  projectedTurnEnds: readonly TranscriptTurnEndFact[],
): TranscriptMarkerInputs {
  const showTurnDuration = useSetting('transcriptShowTurnDuration') !== false;
  const appTranscript = useSessionTranscriptSource().kind === 'app';
  const settledTurnEnds = session.sessionTurns != null ? projectedTurnEnds : null;
  const opened = useOpenedFacts(session, settledTurnEnds, hasTranscriptRows, appTranscript);
  const lateSettled = opened?.lateSettled ?? null;
  const turnEnds = React.useMemo(() => {
    if (!showTurnDuration || !settledTurnEnds) return NO_TURN_ENDS;
    if (!lateSettled) return settledTurnEnds;
    const settledHere = settledTurnEnds.filter((fact) => !lateSettled.has(fact.turnId));
    return settledHere.length === 0 ? NO_TURN_ENDS : settledHere;
  }, [lateSettled, settledTurnEnds, showTurnDuration]);
  const trackAbsorbedEnd = appTranscript && turnEnds.length > 0;
  const latestNonRenderableSeq = storage((state) => trackAbsorbedEnd
    ? state.sessionMessages[session.id]?.latestNonRenderableMessageSeq ?? null
    : null, { sessionMessages: trackAbsorbedEnd ? [session.id] : [] });
  const newDividerAfterSeq = opened?.seq ?? null;
  return React.useMemo(
    () => ({ newDividerAfterSeq, viewerScope, turnEnds, latestNonRenderableSeq }),
    [newDividerAfterSeq, viewerScope, turnEnds, latestNonRenderableSeq],
  );
}
