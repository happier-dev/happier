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

type CapturedCursor = Readonly<{ sessionId: string; seq: number | null }>;

function readStoredCursor(sessionId: string): number | null {
  const stored = storage.getState().sessions[sessionId];
  return stored ? resolveLastViewedSessionSeq(stored) ?? null : null;
}

/**
 * The Session's read cursor as it stood when this surface was opened (each time it becomes visible and
 * focused). Opening marks the Session viewed and moves the live cursor to the end, so the divider keeps
 * the value from before that mark; it is read from the Session read-state owner, never stored.
 */
function useOpenedReadCursor(session: Session): number | null {
  const signal = useOptionalSessionSurfacePresenceSignal();
  const sessionRef = React.useRef(session);
  sessionRef.current = session;
  const readCursor = React.useCallback(
    (): CapturedCursor => ({
      sessionId: sessionRef.current.id,
      // The stored Session, never the prop: the Session view's shell projection keeps one reference while
      // only read-state facts move, and a list-row stand-in carries no read cursor. Not stored yet = unknown.
      seq: readStoredCursor(sessionRef.current.id),
    }),
    [],
  );
  const [captured, setCaptured] = React.useState<CapturedCursor | null>(() =>
    !signal || isOpened(signal.get()) ? readCursor() : null,
  );
  if (captured !== null && captured.sessionId !== session.id) {
    setCaptured(!signal || isOpened(signal.get()) ? readCursor() : null);
  } else if (captured !== null && captured.seq === null) {
    // Opened before the Session's read state hydrated: take its first known cursor once. If the open's own
    // mark already moved it to the end, that only means no divider.
    const next = readCursor();
    if (next.seq !== null) setCaptured(next);
  }
  React.useLayoutEffect(() => {
    if (!signal) return;
    let wasOpened = isOpened(signal.get());
    return signal.subscribe(() => {
      const opened = isOpened(signal.get());
      if (opened && !wasOpened) {
        const next = readCursor();
        setCaptured((previous) =>
          previous?.sessionId === next.sessionId && previous.seq === next.seq
            ? previous
            : next,
        );
      }
      wasOpened = opened;
    });
  }, [readCursor, signal]);
  return captured?.sessionId === session.id ? captured.seq : null;
}

/** The transcript markers' inputs: the opened read cursor and, while "Show turn duration" is on, settled turn ends. */
export function useTranscriptMarkerInputs(
  session: Session,
): TranscriptMarkerInputs {
  const showTurnDuration = useSetting('transcriptShowTurnDuration') !== false;
  const turns = session.sessionTurns?.turns ?? null;
  const turnEnds = React.useMemo(
    () => (showTurnDuration ? projectTranscriptTurnEnds(turns) : NO_TURN_ENDS),
    [showTurnDuration, turns],
  );
  const newDividerAfterSeq = useOpenedReadCursor(session);
  return React.useMemo(
    () => ({ newDividerAfterSeq, turnEnds }),
    [newDividerAfterSeq, turnEnds],
  );
}
