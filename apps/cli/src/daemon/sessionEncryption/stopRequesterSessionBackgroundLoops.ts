import type { SingleFlightIntervalLoopHandle } from '../lifecycle/singleFlightIntervalLoop';

/** Cancel observations without joining work that can release this requester. */
export function stopRequesterSessionBackgroundLoops(input: Readonly<{
  loops: readonly (Pick<SingleFlightIntervalLoopHandle, 'stop'> | null | undefined)[];
  onError(error: unknown): void;
}>): void {
  // stop() withdraws wake subscriptions and aborts synchronously. A committed
  // refresh can be inside withSessionAccountContext's final release, awaiting
  // this same disposal. Joining its task here would make both wait forever.
  // The loop still owns that task's completion; durable custody is joined by
  // the requester separately, so already admitted effects are not abandoned.
  for (const loop of input.loops) {
    void loop?.stop().catch(input.onError);
  }
}
