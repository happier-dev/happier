/**
 * Publishing a freshly installed local relay on the user's tailnet.
 *
 * A relay bound to loopback is the one address a phone cannot use. When the
 * machine already runs Tailscale, one `tailscale serve` turns that into an HTTPS
 * tailnet address — and everything downstream already knows what to do with it:
 * `collectCurrentMachineReachableServerUrlCandidates` ranks a Serve URL first,
 * and `relay host install` writes the chosen address into the relay profile.
 *
 * This is deliberately the only new decision. Enabling Serve itself belongs to
 * `runTailscaleServeEnable` in `cli-common`, deriving the HTTPS URL belongs to
 * the candidate collector, and adopting it belongs to the install command.
 *
 * Decision only; prompting and the command live in `host.ts`.
 */

import type { TailscaleServeRootSlot, TailscaleStatusSnapshot } from '@happier-dev/cli-common/tailscale';

import { isLoopbackServerHost } from '@/server/serverUrlClassification';

export type TailscaleServeOfferDecision =
  | Readonly<{
    kind: 'skip';
    reason: 'not-interactive' | 'tailscale-not-running' | 'already-published' | 'not-loopback' | 'status-unavailable';
  }>
  | Readonly<{
    kind: 'skip';
    reason: 'slot-conflict';
    exposure: 'serve' | 'funnel';
    httpsUrl: string | null;
  }>
  | Readonly<{ kind: 'offer'; upstreamUrl: string }>;

/**
 * Whether it is worth asking Tailscale anything at all.
 *
 * Answerable from what the command already knows, and checked first so an
 * install that could never offer — non-interactive, `--yes`, or a relay that
 * already bound a reachable address — never spawns `tailscale`. Probing costs a
 * subprocess on every install otherwise, including the ones that skip.
 */
export function shouldProbeTailscaleForServeOffer(
  params: Readonly<{ interactive: boolean; relayUrl: string }>,
): boolean {
  if (!params.interactive) return false;
  return isLoopbackServerHost(params.relayUrl);
}

export function decideTailscaleServeOffer(
  params: Readonly<{
    interactive: boolean;
    /** `tailscale status` for this machine, or null when Tailscale is absent. */
    tailscale: TailscaleStatusSnapshot | null;
    /** The address the relay actually bound. */
    relayUrl: string;
    /** Existing ownership of the root HTTPS mount this command would change. */
    serveSlot: TailscaleServeRootSlot | null;
  }>,
): TailscaleServeOfferDecision {
  if (!params.interactive) return { kind: 'skip', reason: 'not-interactive' };

  // Absent and stopped are one answer here: neither can carry traffic now, and
  // installing or starting Tailscale is a larger ask that setup already owns.
  if (!params.tailscale?.running) return { kind: 'skip', reason: 'tailscale-not-running' };

  if (params.serveSlot === null) return { kind: 'skip', reason: 'status-unavailable' };
  if (params.serveSlot.kind === 'exact') return { kind: 'skip', reason: 'already-published' };
  if (params.serveSlot.kind === 'conflict') {
    return {
      kind: 'skip',
      reason: 'slot-conflict',
      exposure: params.serveSlot.exposure,
      httpsUrl: params.serveSlot.httpsUrl,
    };
  }

  // A relay that bound a LAN or tailnet address was asked for by `--lan` or
  // `--host <ip>` and is already reachable there.
  if (!isLoopbackServerHost(params.relayUrl)) return { kind: 'skip', reason: 'not-loopback' };

  return { kind: 'offer', upstreamUrl: params.relayUrl };
}

/**
 * What happened when we tried to publish the relay on the tailnet.
 *
 * `approvalNeeded` is its own outcome because `tailscale serve` succeeds at the
 * command level while the tailnet withholds the address until an admin approves
 * it. Treating that as success would adopt an address nothing answers on.
 */
export type TailscaleServePublishOutcome =
  | Readonly<{ kind: 'skipped' }>
  | Readonly<{ kind: 'declined' }>
  | Readonly<{ kind: 'published' }>
  | Readonly<{ kind: 'approvalNeeded'; approvalUrl: string }>
  | Readonly<{ kind: 'failed'; message: string }>
  | Readonly<{ kind: 'conflict'; exposure: 'serve' | 'funnel'; httpsUrl: string | null }>;

/**
 * Ask, then publish.
 *
 * Default yes: reaching this point means Tailscale is installed, signed in and
 * running, so the user has already opted into a tailnet. `tailscale serve` is
 * scoped to that tailnet and is undone with `tailscale serve --https=443 off`.
 *
 * The HTTPS URL the enable call returns is deliberately ignored — it is derived
 * with a looser rule than the candidate collector uses, and the collector
 * re-derives it a moment later. Only `approvalUrl` is read.
 */
export async function offerAndPublishRelayOnTailnet(
  params: Readonly<{
    decision: TailscaleServeOfferDecision;
    confirm: (question: string) => Promise<boolean>;
    enableServe: (upstreamUrl: string) => Promise<Readonly<{ approvalUrl: string | null }>>;
  }>,
): Promise<TailscaleServePublishOutcome> {
  if (params.decision.kind !== 'offer') {
    return params.decision.reason === 'slot-conflict'
      ? {
          kind: 'conflict',
          exposure: params.decision.exposure,
          httpsUrl: params.decision.httpsUrl,
        }
      : { kind: 'skipped' };
  }

  const wanted = await params.confirm(
    'Publish this relay on your tailnet so your phone can reach it?',
  );
  if (!wanted) return { kind: 'declined' };

  try {
    const result = await params.enableServe(params.decision.upstreamUrl);
    if (result.approvalUrl) {
      return { kind: 'approvalNeeded', approvalUrl: result.approvalUrl };
    }
    return { kind: 'published' };
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}
