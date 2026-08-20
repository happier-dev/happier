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
}>;

export function parseTailscaleStatusSnapshot(value: unknown): TailscaleStatusSnapshot {
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
    loggedIn: hasLoggedInEvidence && !explicitLoginRequired,
    running,
  };
}

export function parseTailscaleStatusJson(text: string): TailscaleStatusSnapshot {
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

  return parseTailscaleStatusSnapshot(parsed);
}
