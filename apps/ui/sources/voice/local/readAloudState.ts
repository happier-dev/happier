import * as React from 'react';

import { localVoicePlaybackController } from '@/voice/runtime/VoicePlaybackController';

// Which message is being read aloud. Read-aloud and live voice share one playback controller, so
// whichever starts speaking stops the other.
const listeners = new Set<() => void>();
let activeKey: string | null = null;
// Identifies the current run, so a stopped run that finishes late cannot clear a newer one.
let activeRun = 0;

function setActive(next: string | null): void {
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

/** Stops the message being read aloud, if any. Live voice replies are untouched when nothing is being read. */
export function stopReadAloud(): void {
  if (activeKey === null) return;
  activeRun += 1;
  localVoicePlaybackController.interrupt();
  setActive(null);
}
