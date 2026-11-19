import * as React from 'react';

import {
  type SessionSurfacePresence,
  useOptionalSessionSurfacePresenceSignal,
} from '@/components/sessions/shell/sessionSurfacePresence';
import { resolveLastViewedSessionSeq } from '@/sync/domains/session/readCursor/resolveLastViewedSessionSeq';
import type { Session } from '@/sync/domains/state/storageTypes';
import { storage, useSetting } from '@/sync/domains/state/storage';

import {
  projectTranscriptTurnEnds,
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
 * - `turnsKnown`: whether the Session's turn facts were already present. When they arrive later, the turns
 *   that were already settled draw no line for this visit (inserting them would move the transcript after
 *   first paint); turns that settle while the person is here still do.
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

function useOpenedFacts(session: Session, settledTurnEnds: readonly TranscriptTurnEndFact[] | null): CapturedOpen | null {
  const signal = useOptionalSessionSurfacePresenceSignal();
  const sessionRef = React.useRef(session);
  sessionRef.current = session;
  const capture = React.useCallback(
    (): CapturedOpen => ({
      sessionId: sessionRef.current.id,
      // The stored Session, never the prop: the Session view's shell projection keeps one reference while
      // only read-state facts move, and a list-row stand-in carries no read cursor. Not stored yet = unknown.
      ...readStoredCursor(sessionRef.current.id),
      turnsKnown: sessionRef.current.sessionTurns != null,
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
    // Turn facts that arrive after the open: remember which turns were already settled, once.
    const lateSettled = captured.turnsKnown || captured.lateSettled !== null || settledTurnEnds === null
      ? captured.lateSettled
      : new Set(settledTurnEnds.map((fact) => fact.turnId));
    if (cursor.stored !== captured.stored || lateSettled !== captured.lateSettled) {
      setCaptured({ ...captured, stored: cursor.stored, seq: cursor.seq, lateSettled });
    }
  }
  React.useLayoutEffect(() => {
    if (!signal) return;
    let wasOpened = isOpened(signal.get());
    return signal.subscribe(() => {
      const opened = isOpened(signal.get());
      if (opened && !wasOpened) {
        // Showing the surface again re-reads only the cursor; the transcript renders only when it moved.
        const next = capture();
        setCaptured((previous) => {
          if (previous?.sessionId !== next.sessionId) return next;
          return previous.seq === next.seq && previous.stored === next.stored ? previous : { ...previous, seq: next.seq, stored: next.stored };
        });
      }
      wasOpened = opened;
    });
  }, [capture, signal]);
  return captured?.sessionId === session.id ? captured : null;
}

/** The transcript markers' inputs: the opened read cursor and, while "Show turn duration" is on, settled turn ends. */
export function useTranscriptMarkerInputs(
  session: Session,
): TranscriptMarkerInputs {
  const showTurnDuration = useSetting('transcriptShowTurnDuration') !== false;
  const turns = session.sessionTurns?.turns ?? null;
  const settledTurnEnds = React.useMemo(
    () => (showTurnDuration && turns ? projectTranscriptTurnEnds(turns) : null),
    [showTurnDuration, turns],
  );
  const opened = useOpenedFacts(session, settledTurnEnds);
  const lateSettled = opened?.lateSettled ?? null;
  const turnEnds = React.useMemo(() => {
    if (!settledTurnEnds) return NO_TURN_ENDS;
    if (!lateSettled) return settledTurnEnds;
    const settledHere = settledTurnEnds.filter((fact) => !lateSettled.has(fact.turnId));
    return settledHere.length === 0 ? NO_TURN_ENDS : settledHere;
  }, [lateSettled, settledTurnEnds]);
  const newDividerAfterSeq = opened?.seq ?? null;
  return React.useMemo(
    () => ({ newDividerAfterSeq, turnEnds }),
    [newDividerAfterSeq, turnEnds],
  );
}
