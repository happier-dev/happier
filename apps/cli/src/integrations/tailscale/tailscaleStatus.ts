/**
 * This machine's Tailscale state, as the CLI asks for it.
 *
 * Thin glue over the `cli-common` primitives, shared so every CLI surface draws
 * the same distinction: a missing binary means Tailscale is not installed, while
 * a binary that resolves but does not answer is an installed Tailscale we cannot
 * confirm is running. Those need different things said to the user, and getting
 * them the same way everywhere is the point of this module.
 */

import {
  resolveTailscaleBin,
  runTailscaleStatusJson,
  tailscaleStatusSnapshotForUnreachableDaemon,
  type TailscaleStatusSnapshot,
} from '@happier-dev/cli-common/tailscale';

/**
 * A one-shot interactive command can afford a slower probe than the background
 * reachability scan. A cold `tailscaled` answering late must not be reported to
 * the user as "not running".
 */
export const TAILSCALE_STATUS_TIMEOUT_MS = 3_000;

/**
 * `tailscale status` for this machine, or null when Tailscale is not installed.
 */
export async function readTailscaleStatusSnapshot(
  params: Readonly<{ timeoutMs?: number }> = {},
): Promise<TailscaleStatusSnapshot | null> {
  try {
    await resolveTailscaleBin();
  } catch {
    return null;
  }
  try {
    return await runTailscaleStatusJson({
      timeoutMs: params.timeoutMs ?? TAILSCALE_STATUS_TIMEOUT_MS,
    });
  } catch {
    return tailscaleStatusSnapshotForUnreachableDaemon();
  }
}
