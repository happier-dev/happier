import { readFile, access } from 'node:fs/promises';

import { OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV } from '../../../runtime/server/managedServerState.js';

import {
  OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV,
  OPEN_CODE_BROKER_LOAD_NONCE_ENV,
  OPEN_CODE_BROKER_PROVIDERS,
  OPEN_CODE_BROKER_SELECTIONS_ENV,
  parseOpenCodeBrokerSelections,
  type OpenCodeBrokerProvider,
} from './env.js';
import { resolveOpenCodeBrokerPluginPath } from './assets.js';
import { OPEN_CODE_BROKER_LOADED_STATUS_PATH } from './loadHandshake.js';

export type OpenCodeBrokerReadiness =
  | Readonly<{ ready: true }>
  | Readonly<{ ready: false; reason: string }>;

type DaemonBridgeTarget = Readonly<{ httpPort: number; controlToken: string }>;

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

/**
 * Read the daemon-state file's bridge target (`httpPort` + master `controlToken`). The master token is
 * read here only by Happier's OWN trusted preflight (NOT the broker) to query the loaded-status endpoint
 * — distinct from the broker, which never reads the master.
 */
async function readDaemonBridgeTarget(path: string | undefined): Promise<DaemonBridgeTarget | null> {
  if (typeof path !== 'string' || path.trim().length === 0) return null;
  const content = await readFile(path, 'utf8').catch(() => null);
  if (content === null) return null;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed.httpPort !== 'number' || typeof parsed.controlToken !== 'string' || parsed.controlToken.length === 0) {
      return null;
    }
    return { httpPort: parsed.httpPort, controlToken: parsed.controlToken };
  } catch {
    return null;
  }
}

async function daemonStateUsable(path: string | undefined): Promise<boolean> {
  return (await readDaemonBridgeTarget(path)) !== null;
}

/**
 * Fail-closed preflight: verify the Happier broker is materialized + reachable for a connected
 * session before its first prompt. For NATIVE sessions (no selection identity) and direct-API-key
 * connected sessions (no brokered provider) it is a strict no-op (`ready: true`).
 *
 * For brokered sessions it confirms (a) each brokered provider's broker plugin `.js` file exists in
 * the connected config home's `opencode/plugin/` auto-load dir (the config home is the redirected
 * `XDG_CONFIG_HOME` the materializer emitted; live-verified that an absolute `OPENCODE_CONFIG_CONTENT.plugin`
 * path or a `.mjs` file does NOT load), and (b) the daemon-state bridge target is readable with a
 * control token. If any check fails the session MUST be failed with a clear materialization error —
 * never silently fall back to native/upstream auth (the marker is itself non-functional without the
 * plugin, so request-time failure is the backstop).
 */
export async function verifyOpenCodeBrokerReadyForConnectedSession(
  env: NodeJS.ProcessEnv,
): Promise<OpenCodeBrokerReadiness> {
  if (typeof env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV] !== 'string') {
    return { ready: true };
  }
  const selections = parseOpenCodeBrokerSelections(env[OPEN_CODE_BROKER_SELECTIONS_ENV]);
  const brokeredProviders: OpenCodeBrokerProvider[] = OPEN_CODE_BROKER_PROVIDERS.filter((provider) => selections[provider]);
  if (brokeredProviders.length === 0) {
    return { ready: true };
  }
  if (!(await daemonStateUsable(env[OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV]))) {
    return { ready: false, reason: 'broker_daemon_bridge_unreachable' };
  }
  const configHomeDir = typeof env.XDG_CONFIG_HOME === 'string' ? env.XDG_CONFIG_HOME : '';
  if (!configHomeDir) {
    return { ready: false, reason: 'broker_config_home_missing' };
  }
  for (const provider of brokeredProviders) {
    const pluginPath = resolveOpenCodeBrokerPluginPath(provider, configHomeDir);
    if (!(await fileExists(pluginPath))) {
      return { ready: false, reason: `broker_plugin_file_missing:${provider}` };
    }
  }
  return { ready: true };
}

/** Default bounded wait for the broker to announce it loaded (F4). */
export const OPEN_CODE_BROKER_LOAD_HANDSHAKE_WAIT_MS = 4_000;
const OPEN_CODE_BROKER_LOAD_HANDSHAKE_POLL_INTERVAL_MS = 200;

/**
 * Probe the daemon for the broker load handshake (F4). Injectable test seam; the default queries the
 * daemon's loaded-status endpoint over local HTTP using the master `controlToken` (Happier's own trusted
 * preflight query — the broad gate, distinct from the broker's scoped registration).
 */
export type OpenCodeBrokerLoadHandshakeProbe = (
  input: Readonly<{ selectionIdentity: string; loadNonce: string; httpPort: number; controlToken: string }>,
) => Promise<boolean>;

const defaultLoadHandshakeProbe: OpenCodeBrokerLoadHandshakeProbe = async ({ selectionIdentity, loadNonce, httpPort, controlToken }) => {
  const response = await fetch(`http://127.0.0.1:${httpPort}${OPEN_CODE_BROKER_LOADED_STATUS_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': controlToken },
    body: JSON.stringify({ selectionIdentity, loadNonce }),
    signal: AbortSignal.timeout(2_000),
  }).catch(() => null);
  if (!response || !response.ok) return false;
  const json = (await response.json().catch(() => null)) as { observed?: unknown } | null;
  return Boolean(json && json.observed === true);
};

/**
 * POST-SPAWN fail-closed verification that the broker plugin actually LOADED inside the now-healthy
 * OpenCode server (hardening finding F4). It complements the PRE-spawn `verifyOpenCodeBrokerReadyForConnectedSession`
 * (which only proves the assets are on disk + the daemon is reachable, NOT that the plugin loaded).
 *
 * In `../dev` the pre-spawn preflight runs in `assembly.ts` BEFORE the server is spawned, so it cannot
 * observe a handshake; this function is therefore a SEPARATE step the assembly runs AFTER
 * `waitUntilHealthy` (a deliberate divergence from remote-dev, whose single preflight runs post-spawn).
 *
 * No-op (`ready: true`) for native sessions (no selection identity) and direct-API-key connected sessions
 * (no brokered provider). For brokered sessions it polls the daemon (bounded by `waitMs`, default 4s) and
 * returns `broker_plugin_not_loaded` if the handshake never arrives — never silently falling back.
 */
export async function verifyOpenCodeBrokerLoadHandshakeForConnectedSession(
  env: NodeJS.ProcessEnv,
  options?: Readonly<{
    probe?: OpenCodeBrokerLoadHandshakeProbe;
    waitMs?: number;
    pollIntervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }>,
): Promise<OpenCodeBrokerReadiness> {
  const identity = env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV];
  if (typeof identity !== 'string' || identity.trim().length === 0) {
    return { ready: true };
  }
  const selections = parseOpenCodeBrokerSelections(env[OPEN_CODE_BROKER_SELECTIONS_ENV]);
  const brokeredProviders: OpenCodeBrokerProvider[] = OPEN_CODE_BROKER_PROVIDERS.filter((provider) => selections[provider]);
  if (brokeredProviders.length === 0) {
    return { ready: true };
  }
  const bridgeTarget = await readDaemonBridgeTarget(env[OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV]);
  if (!bridgeTarget) {
    return { ready: false, reason: 'broker_daemon_bridge_unreachable' };
  }
  const loadNonce = env[OPEN_CODE_BROKER_LOAD_NONCE_ENV];
  if (typeof loadNonce !== 'string' || loadNonce.trim().length === 0) {
    return { ready: false, reason: 'broker_load_nonce_missing' };
  }

  const probe = options?.probe ?? defaultLoadHandshakeProbe;
  const waitMs = options?.waitMs ?? OPEN_CODE_BROKER_LOAD_HANDSHAKE_WAIT_MS;
  const pollIntervalMs = options?.pollIntervalMs ?? OPEN_CODE_BROKER_LOAD_HANDSHAKE_POLL_INTERVAL_MS;
  const now = options?.now ?? (() => Date.now());
  const sleep = options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const probeInput = {
    selectionIdentity: identity.trim(),
    loadNonce: loadNonce.trim(),
    httpPort: bridgeTarget.httpPort,
    controlToken: bridgeTarget.controlToken,
  } as const;

  const deadline = now() + Math.max(0, waitMs);
  let observed = await probe(probeInput).catch(() => false);
  while (!observed && now() < deadline) {
    await sleep(Math.max(1, Math.min(pollIntervalMs, deadline - now())));
    observed = await probe(probeInput).catch(() => false);
  }
  return observed ? { ready: true } : { ready: false, reason: 'broker_plugin_not_loaded' };
}
