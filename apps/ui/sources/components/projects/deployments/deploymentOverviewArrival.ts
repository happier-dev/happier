type ReadState = 'loading' | 'ready' | 'unavailable' | 'idle' | 'partial';

/**
 * Where the Environment Overview paints as its reads arrive (PAGE-ACCEPT-176 R12-D3: nothing moves on arrival).
 * - Agent actions keep one slot for the page's life: the primary slot before anything serves, the secondary one after;
 *   the slot follows whether a deployment serves (the Environment read's own fact), never deploy availability.
 * - Below the definition, the deployed definition depends on the latest Receipt: until it settles the body below is
 *   held, so it is appended rather than inserted above painted content.
 * - Recent activity depends on history; it and what follows are held until history settles, then appended.
 */
export function deploymentOverviewArrival(
  input: Readonly<{
    deployed: boolean;
    receipt: ReadState;
    history: ReadState;
  }>,
): Readonly<{
  agentActions: 'primary' | 'secondary';
  body: 'held' | 'shown';
  tail: 'held' | 'shown';
}> {
  const settling = (state: ReadState) =>
    state === 'loading' || state === 'idle';
  const body = input.deployed && settling(input.receipt) ? 'held' : 'shown';
  return {
    agentActions: input.deployed ? 'secondary' : 'primary',
    body,
    tail: body === 'held' || settling(input.history) ? 'held' : 'shown',
  };
}
