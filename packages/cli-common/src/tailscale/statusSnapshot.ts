import { isIP } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
function readNonEmptyString(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text : null;
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeDnsName(value: string | null): string | null {
  if (!value) {
    return null;
  }
  return value.replace(/\.+$/, '') || null;
}

export type TailscaleStatusSnapshot = Readonly<{
  backendState: string | null;
  authUrl: string | null;
  dnsName: string | null;
  tailnetName: string | null;
  tailscaleIps: readonly string[];
  /** Network-level capability, not proof of a container's DNS configuration. */
  magicDnsEnabled: boolean | null;
  /** Actual native scope, unavailable for userspace/stopped/unobserved interfaces. */
  interfaceName: string | null;
  sourceRanges: readonly string[];
  loggedIn: boolean;
  /**
   * Whether the local backend is actually up and carrying traffic.
   *
   * `loggedIn` cannot answer this. `tailscale status --json` exits 0 for every
   * backend state, so `Stopped` and `NeedsMachineAuth` arrive as ordinary data
   * — and because both retain node identity, both report `loggedIn: true`.
   * A caller asking "can this machine reach its tailnet right now?" wants
   * `running`; a caller asking "has this machine ever been signed in?" wants
   * `loggedIn`.
   */
  running: boolean;
  /**
   * Whether `tailscale status` actually reached the local tailscaled backend.
   *
   * False only when the CLI ran but could not talk to the daemon at all, so no
   * backend state exists to report. It separates "installed, signed in, daemon
   * down" from "needs login" — both of which otherwise look like
   * `loggedIn: false, running: false`.
   */
  daemonReachable: boolean;
}>;

export function parseTailscaleStatusSnapshot(value: unknown, nativeInterfaces: NativeInterfaces = {}): TailscaleStatusSnapshot {
  const record = readRecord(value);
  const self = readRecord(record?.Self);
  const currentTailnet = readRecord(record?.CurrentTailnet);

  const backendState = readNonEmptyString(record?.BackendState);
  const authUrl = readNonEmptyString(record?.AuthURL);
  const dnsName = normalizeDnsName(readNonEmptyString(self?.DNSName));
  const tailnetName = readNonEmptyString(currentTailnet?.Name);
  const tailscaleIps = readStringArray(record?.TailscaleIPs);
  const haveNodeKey = record?.HaveNodeKey === true;
  const explicitLoginRequired = authUrl !== null || Boolean(backendState && /login/i.test(backendState));
  const hasLoggedInEvidence = haveNodeKey || dnsName !== null || tailnetName !== null || tailscaleIps.length > 0;

  // Tailscale's BackendState is one of NoState, InUseOtherUser, NeedsLogin,
  // NeedsMachineAuth, Stopped, Starting, Running. Only the last one means
  // traffic can flow.
  const running = backendState !== null && backendState.toLowerCase() === 'running';

  return {
    backendState,
    authUrl,
    dnsName,
    tailnetName,
    tailscaleIps,
    magicDnsEnabled: typeof currentTailnet?.MagicDNSEnabled === 'boolean' ? currentTailnet.MagicDNSEnabled : null,
    ...readNativeScope(running && record?.TUN === true ? tailscaleIps : [], nativeInterfaces),
    loggedIn: hasLoggedInEvidence && !explicitLoginRequired,
    running,
    daemonReachable: true,
  };
}

/**
 * The snapshot for a machine whose tailscaled never answered.
 *
 * `tailscale status --json` exits non-zero and prints no JSON in this case, so
 * there is nothing to parse — but "the daemon is down" is a state callers must
 * render, not an exception they must catch.
 */
export function tailscaleStatusSnapshotForUnreachableDaemon(): TailscaleStatusSnapshot {
  return {
    backendState: null,
    authUrl: null,
    dnsName: null,
    tailnetName: null,
    tailscaleIps: [],
    magicDnsEnabled: null,
    interfaceName: null,
    sourceRanges: [],
    loggedIn: false,
    running: false,
    daemonReachable: false,
  };
}

// Tailscale reports an unreachable local backend through its CLI output rather
// than a distinct exit code, and the wording differs per platform. These stay
// deliberately narrow so a missing binary keeps surfacing as a thrown error —
// "not installed" and "installed but stopped" are different user problems.
const DAEMON_UNREACHABLE_PATTERNS: readonly RegExp[] = [
  /failed to connect to local (?:tailscaled|backend)/i,
  /(?:doesn't|does not) appear to be running/i,
  /is (?:the )?tailscaled? (?:service )?running\?/i,
  /unable to connect to the tailscale service/i,
];

export function isTailscaleDaemonUnreachableOutput(text: string): boolean {
  const normalized = String(text ?? '').trim();
  if (!normalized) {
    return false;
  }
  return DAEMON_UNREACHABLE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function parseTailscaleStatusJson(text: string, nativeInterfaces: NativeInterfaces = {}): TailscaleStatusSnapshot {
  const raw = String(text ?? '').trim();
  if (!raw) {
    throw new Error('Received an empty tailscale status payload.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error && error.message.trim()
      ? error.message.trim()
      : 'Invalid tailscale status JSON.';
    throw new Error(message);
  }

  return parseTailscaleStatusSnapshot(parsed, nativeInterfaces);
}

type NativeInterfaces = Readonly<Record<string,
  readonly Pick<NetworkInterfaceInfo, 'address' | 'family' | 'internal'>[] | undefined>>;

export function parseTailscaleCurrentProfileId(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  let selectedId: string | null = null;
  for (const candidate of value) {
    const profile = readRecord(candidate);
    if (profile?.selected !== true) continue;
    const id = readNonEmptyString(profile.id);
    if (!id || selectedId !== null) return null;
    selectedId = id;
  }
  return selectedId;
}

function normalizeIp(address: string): string | null {
  const family = isIP(address);
  if (family === 4) return address;
  if (family === 6 && !address.includes('%')) return new URL(`http://[${address}]`).hostname;
  return null;
}

function readNativeScope(addresses: readonly string[], interfaces: NativeInterfaces): Pick<TailscaleStatusSnapshot, 'interfaceName' | 'sourceRanges'> {
  const assigned = new Set(addresses.map(normalizeIp).filter(address => address !== null));
  const matches = Object.entries(interfaces).flatMap(([name, entries]) => {
    const families = new Set((entries ?? [])
      .filter(entry => {
        const address = normalizeIp(entry.address);
        return !entry.internal && address !== null && assigned.has(address);
      })
      .map(entry => entry.family));
    return families.size ? [{ name, families }] : [];
  });
  const match = matches.length === 1 ? matches[0] : undefined;
  return {
    interfaceName: match?.name ?? null,
    // Tailscale's documented source spaces; only observed address families apply.
    // https://tailscale.com/docs/reference/faq/other-vpns#split-tunnels
    sourceRanges: match ? [
      ...(match.families.has('IPv4') ? ['100.64.0.0/10'] : []),
      ...(match.families.has('IPv6') ? ['fd7a:115c:a1e0::/48'] : []),
    ] : [],
  };
}
