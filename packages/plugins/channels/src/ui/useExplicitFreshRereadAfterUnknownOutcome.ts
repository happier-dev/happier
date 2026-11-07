import * as React from 'react';

import type { ResourcePresentation } from './conversationRows.js';

type UnknownOutcomeReconciliationPhase =
  | 'waitingForExistingRead'
  | 'waitingForRequestedRead';

/** Keep an ambiguous mutation locked until an explicit fresh Resource reread finishes. */
export function useExplicitFreshRereadAfterUnknownOutcome(input: Readonly<{
  outcomeUnknown: boolean;
  resource: ResourcePresentation;
  onRefresh: () => void | Promise<void>;
  onReconciled: () => void;
}>): () => void {
  const [phase, setPhase] = React.useState<UnknownOutcomeReconciliationPhase | undefined>();
  const sawRequestedRead = React.useRef(false);
  const [requestedReadCompleted, setRequestedReadCompleted] = React.useState(false);
  const refresh = React.useCallback(() => {
    setRequestedReadCompleted(false);
    const completion = input.onRefresh();
    // Resource refresh owns completion even when React batches away its pending
    // presentation. Account-local readers schedule their read with a void
    // callback, so their existing rendered settlement remains the signal.
    if (completion !== undefined) {
      void completion.then(() => setRequestedReadCompleted(true), () => {
        // A rejected reread never reconciles the ambiguous mutation.
      });
    }
  }, [input.onRefresh]);

  const requestRefresh = React.useCallback(() => {
    if (!input.outcomeUnknown) {
      input.onRefresh();
      return;
    }
    sawRequestedRead.current = false;
    setRequestedReadCompleted(false);
    if (input.resource.pending !== 'idle') {
      setPhase('waitingForExistingRead');
      return;
    }
    setPhase('waitingForRequestedRead');
    refresh();
  }, [input.onRefresh, input.outcomeUnknown, input.resource.pending, refresh]);

  React.useEffect(() => {
    if (phase === undefined) return;
    if (phase === 'waitingForExistingRead') {
      if (input.resource.pending !== 'idle') return;
      sawRequestedRead.current = false;
      setPhase('waitingForRequestedRead');
      refresh();
      return;
    }
    if (input.resource.pending !== 'idle'
      || input.resource.freshness !== 'fresh'
      || input.resource.error !== undefined) {
      sawRequestedRead.current = true;
      return;
    }
    if (!sawRequestedRead.current && !requestedReadCompleted) return;
    sawRequestedRead.current = false;
    setPhase(undefined);
    input.onReconciled();
  }, [
    input.onReconciled,
    refresh,
    requestedReadCompleted,
    input.resource.error,
    input.resource.freshness,
    input.resource.pending,
    phase,
  ]);

  return requestRefresh;
}

