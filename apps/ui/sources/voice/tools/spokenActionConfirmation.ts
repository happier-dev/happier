type PendingSpokenAction = object;

/** One playback identity on a live carrier; the Action owner retains its operation. */
export function createSpokenActionConfirmation() {
  let pending: PendingSpokenAction | null = null;
  return {
    prepare(): void {
      pending = {};
    },
    readPending(): PendingSpokenAction | null { return pending; },
    // Capture the pending object before awaiting playback. A superseded speech
    // completion must never claim it read a replacement operation aloud.
    completeReadBack(spoken: PendingSpokenAction | null): boolean {
      if (!spoken || spoken !== pending) return false;
      pending = null;
      return true;
    },
    clear(): void { pending = null; },
  };
}

export type SpokenActionConfirmation = ReturnType<typeof createSpokenActionConfirmation>;
