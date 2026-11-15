import * as React from 'react';

// Which message is being read aloud. Read-aloud and live voice share one playback controller, so
// whichever starts speaking stops the other.
const listeners = new Set<() => void>();
let activeKey: string | null = null;
// Read-aloud's own playback stoppers. Taking over from read-aloud stops these only: it is not a
// barge-in, so it must not advance the shared playback epoch that live voice turns captured.
const stoppers = new Set<() => void>();
// Identifies the current run, so a stopped run that finishes late cannot clear a newer one.
let activeRun = 0;

function setActive(next: string | null): void {
  if (activeKey === next) return;
  activeKey = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getReadAloudActiveKey(): string | null {
  return activeKey;
}

/** Whether this message is the one being read; other messages' hooks keep their value and do not rerender. */
export function useIsReadingAloud(key: string): boolean {
  return React.useSyncExternalStore(subscribe, () => activeKey === key, () => false);
}

export function startReadAloudRun(key: string): number {
  activeRun += 1;
  setActive(key);
  return activeRun;
}

export function finishReadAloudRun(run: number): void {
  if (activeRun === run) setActive(null);
}

/** Tracks a playback stopper that belongs to the message being read aloud. */
export function trackReadAloudStopper(stopper: () => void): () => void {
  stoppers.add(stopper);
  return () => {
    stoppers.delete(stopper);
  };
}

/** Stops the message being read aloud, if any, without touching live voice playback or its epoch. */
export function stopReadAloud(): void {
  if (activeKey === null) return;
  activeRun += 1;
  const toStop = [...stoppers];
  stoppers.clear();
  for (const stopper of toStop) {
    try {
      stopper();
    } catch {
      // A failing stopper must not prevent the remaining playbacks from stopping.
    }
  }
  setActive(null);
}
