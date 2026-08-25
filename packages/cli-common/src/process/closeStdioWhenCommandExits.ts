import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';

/**
 * Check-phase turns to let pass after the command exits, before its pipes are closed.
 *
 * This is a loop-phase count, deliberately NOT a timer. A timer is measured against the wall clock,
 * and the defect this whole boundary exists to remove is that on a stalled event loop the timers
 * phase runs BEFORE poll — so a drain timer could fire and destroy the pipes in exactly the stall
 * that matters, discarding output the command had already written and handing back the empty
 * "success" we are here to eliminate. A `setImmediate` chain cannot: each turn runs in the check
 * phase, after the poll phase has had its chance to deliver whatever the kernel holds.
 *
 * Two turns is not a guess about volume. A pipe holds one buffer (64 KB), and a command cannot exit
 * while it still has unwritten output, because a full pipe blocks the writer until the reader
 * drains it — so at most one buffer can be outstanding when `'exit'` arrives, and libuv drains a
 * readable pipe to `EAGAIN` within a single poll phase. Measured here: 1.28 MB, twenty times the
 * buffer, was already fully delivered by the time `'exit'` fired. The count is about notification
 * ORDER, not size: the first turn covers the poll phase that carried the exit notification, and the
 * second covers a one-batch skew between that notification and the pipe-readable one, which no
 * platform orders by contract and which cannot be measured for linux/windows from this host.
 *
 * The count is fixed rather than "keep waiting while bytes still arrive" on purpose: the adaptive
 * form never terminates for a survivor that keeps writing (`some-server &` logging to the inherited
 * pipe), which is the unbounded wait this bound exists to prevent.
 */
const QUIET_CHECK_PHASE_TURNS = 2;

/**
 * Stop waiting on a command's stdio once the command itself has exited.
 *
 * A child's stdout/stderr pipes are inherited by everything it spawns, so a command that leaves a
 * process running — `some-server &`, a pipeline whose tail outlives its head, or any command we had
 * to kill, since a signal reaches only the direct child — keeps the write end open after it is
 * gone. Both of Node's completion signals wait for that: `child_process.execFile` reports through
 * the child's `'close'` event, and `'close'` requires every stdio stream closed as well as the
 * process exited. Measured on this corridor: a shell command whose survivor slept 5 s settled at
 * 5,015 ms instead of 303 ms, and a killed `sh -c 'echo X; sleep 60'` never settled at all — so a
 * remote shell request was answered never rather than late.
 *
 * Waiting on that pipe is not part of the contract any caller wants. A caller asked for THE
 * COMMAND: its output and its exit status. The command's own exit is a sound bound for the pipe
 * wait, because after it no further byte can come from the command; anything arriving later belongs
 * to a process it left running, which is not the command's output.
 *
 * The child's `'close'` then fires with everything the command produced and its real exit status,
 * so a consumer still never receives the truncated-to-empty "success" that destroying the streams
 * early — which is what Node's own `timeout` option does — would produce.
 *
 * Intended for a consumer that reads these streams (both callers do). It does not attach listeners
 * and so does not change what that consumer receives.
 */
export function closeStdioWhenCommandExits(child: ChildProcess): void {
  const streams = [child.stdout, child.stderr].filter((stream): stream is Readable => Boolean(stream));
  if (streams.length === 0) {
    return;
  }

  child.once('exit', () => {
    let remainingTurns = QUIET_CHECK_PHASE_TURNS;
    const closeOnceDrained = (): void => {
      remainingTurns -= 1;
      if (remainingTurns > 0) {
        setImmediate(closeOnceDrained);
        return;
      }

      for (const stream of streams) {
        stream.destroy();
      }
    };
    setImmediate(closeOnceDrained);
  });
}
