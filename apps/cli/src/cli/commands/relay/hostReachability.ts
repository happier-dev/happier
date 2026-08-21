/**
 * Which address a freshly installed relay should be reached at.
 *
 * `relay host install` binds a port and hands back the URL it bound — usually
 * `http://127.0.0.1:<port>`. That URL is the one thing a phone cannot use, so
 * the install has to settle the reachable address before the relay profile is
 * written and `happier auth login` binds an account to it.
 *
 * Decision only: printing and profile writes stay with the command.
 */

import {
  collectCurrentMachineReachableServerUrlCandidates,
  type CurrentMachineReachableServerUrlCandidate,
} from '@/server/reachability/currentMachineReachableServerUrlCandidates';
import { promptForCurrentMachineReachableServerUrl } from '@/server/reachability/promptCurrentMachineReachableServerUrl';

/** Who the relay URL has to be reachable by. Shown inside the prompt. */
const RELAY_REMOTE_DESCRIPTION = 'your phone and your other computers';

export type RelayHostReachableServerUrlOutcome =
  | Readonly<{
    /** Nothing outside this computer can reach the relay. */
    kind: 'localOnly';
  }>
  | Readonly<{
    kind: 'selected';
    url: string;
    /** `default` covers both "nobody could be asked" and "nobody answered". */
    chosenBy: 'user' | 'default';
    candidates: readonly CurrentMachineReachableServerUrlCandidate[];
    /** An answer that could not be read as a URL, so the default was used. */
    rejectedAnswer?: string;
  }>;

function normalizeHttpUrl(raw: string): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function sameUrl(left: string, right: string): boolean {
  const normalizedLeft = normalizeHttpUrl(left);
  const normalizedRight = normalizeHttpUrl(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

/**
 * The address to fall back to when nobody picks one.
 *
 * A relay bound to a LAN or Tailscale address is already reachable at the URL
 * it reported, so `--lan` / `--host <ip>` installs keep exactly what they asked
 * for. Only a relay nothing can reach at its own URL — the loopback default and
 * `--expose`, which reports loopback too — adopts the best candidate instead.
 */
function resolveDefaultUrl(
  relayUrl: string,
  candidates: readonly CurrentMachineReachableServerUrlCandidate[],
): string {
  const selfCandidate = candidates.find((candidate) => sameUrl(candidate.url, relayUrl));
  return selfCandidate ? selfCandidate.url : candidates[0].url;
}

export async function resolveRelayHostReachableServerUrl(
  params: Readonly<{
    relayUrl: string;
    interactive: boolean;
  }>,
): Promise<RelayHostReachableServerUrlOutcome> {
  const candidates = await collectCurrentMachineReachableServerUrlCandidates({
    localServerUrl: params.relayUrl,
  }).catch((): readonly CurrentMachineReachableServerUrlCandidate[] => []);
  if (candidates.length === 0) return { kind: 'localOnly' };

  const defaultUrl = resolveDefaultUrl(params.relayUrl, candidates);
  if (!params.interactive) {
    return { kind: 'selected', url: defaultUrl, chosenBy: 'default', candidates };
  }

  const answer = await promptForCurrentMachineReachableServerUrl({
    localServerUrl: params.relayUrl,
    remoteDescription: RELAY_REMOTE_DESCRIPTION,
    localServerUrlIntro: 'The relay on this computer is installed at:',
    candidates,
  });

  const trimmed = String(answer ?? '').trim();
  if (!trimmed) {
    return { kind: 'selected', url: defaultUrl, chosenBy: 'default', candidates };
  }

  const normalized = normalizeHttpUrl(trimmed);
  if (!normalized) {
    return { kind: 'selected', url: defaultUrl, chosenBy: 'default', candidates, rejectedAnswer: trimmed };
  }

  return { kind: 'selected', url: normalized, chosenBy: 'user', candidates };
}
