import { readFile, access } from 'node:fs/promises';

import { CONNECTED_SERVICE_BROKER_LOADED_STATUS_PATH } from '@happier-dev/plugin-sdk/experimental/cloud/broker';

import {
  PI_BROKER_DAEMON_STATE_PATH_ENV,
  PI_BROKER_LOAD_NONCE_ENV,
  PI_BROKER_PROVIDERS,
  PI_BROKER_SELECTIONS_ENV,
  PI_BROKER_SELECTION_IDENTITY_ENV,
  parsePiBrokerSelections,
} from './env.js';
import { resolvePiBrokerExtensionPath } from './assets.js';

export type PiBrokerReadiness =
  | Readonly<{ ready: true }>
  | Readonly<{ ready: false; reason: string }>;

/** Bounded total wait for the broker's load handshake to arrive before failing closed. */
const DEFAULT_HANDSHAKE_WAIT_MS = 4_000;
const HANDSHAKE_POLL_INTERVAL_MS = 200;

type DaemonBridgeTarget = Readonly<{ httpPort: number; controlToken: string }>;

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

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

/**
 * Probe the daemon's PROVIDER-AGNOSTIC `/loaded-status` endpoint for the broker load handshake. The
 * registry is keyed by the stable selection identity plus per-spawn load nonce, so the SAME endpoint that
 * serves the OpenCode broker serves the Pi broker — no new daemon surface and no stale-process readiness
 * reuse. This is Happier's OWN trusted preflight query, so it authenticates with the master control token
 * (the broad gate), distinct from the broker's scoped registration. Bounded poll; fails closed on timeout.
 */
async function defaultVerifyLoadHandshake(
  selectionIdentity: string,
  loadNonce: string,
  target: DaemonBridgeTarget,
  deadlineMs: number,
): Promise<boolean> {
  const queryOnce = async (): Promise<boolean> => {
    const response = await fetch(`http://127.0.0.1:${target.httpPort}${CONNECTED_SERVICE_BROKER_LOADED_STATUS_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': target.controlToken },
      body: JSON.stringify({ selectionIdentity, loadNonce }),
      signal: AbortSignal.timeout(2_000),
    }).catch(() => null);
    if (!response || !response.ok) return false;
    const json = (await response.json().catch(() => null)) as { observed?: unknown } | null;
    return Boolean(json && json.observed === true);
  };
  for (;;) {
    if (await queryOnce().catch(() => false)) return true;
    if (Date.now() >= deadlineMs) return false;
    await new Promise((resolve) => setTimeout(resolve, HANDSHAKE_POLL_INTERVAL_MS));
  }
}

/**
 * Fail-closed preflight: verify the Happier Pi broker extension is materialized + reachable + LOADED for
 * a connected session before its first prompt. For NATIVE sessions (no selection identity) and direct-
 * API-key connected sessions (no brokered provider) it is a strict no-op (`ready: true`).
 *
 * For brokered sessions it confirms (a) the broker extension file exists in the agent dir's
 * `extensions/` auto-load dir, (b) the daemon-state bridge target is readable with a control token, and
 * (c) a real load handshake arrived (the extension pings the daemon on activation) within a bounded
 * wait. If any check fails the session MUST be failed with a clear materialization error — never
 * silently fall back to native/upstream auth (the brokered credential carries no real refresh token, so
 * request-time failure is the backstop regardless).
 */
export async function verifyPiBrokerReadyForConnectedSession(
  env: Readonly<Record<string, string | undefined>>,
  options?: Readonly<{
    /** The Happier-controlled Pi agent dir (`PI_CODING_AGENT_DIR`). Defaults to the env value. */
    agentDir?: string;
    /** Bounded total wait for the load handshake. Defaults to {@link DEFAULT_HANDSHAKE_WAIT_MS}. */
    handshakeWaitMs?: number;
    /** Injectable load-handshake verifier (test seam). Defaults to a bounded poll of the daemon. */
    verifyLoadHandshake?: (selectionIdentity: string, loadNonce: string, deadlineMs: number) => Promise<boolean>;
  }>,
): Promise<PiBrokerReadiness> {
  const selectionIdentity = env[PI_BROKER_SELECTION_IDENTITY_ENV];
  if (typeof selectionIdentity !== 'string' || selectionIdentity.trim().length === 0) {
    return { ready: true };
  }
  const selections = parsePiBrokerSelections(env[PI_BROKER_SELECTIONS_ENV]);
  const brokeredProviders = PI_BROKER_PROVIDERS.filter((provider) => selections[provider]);
  if (brokeredProviders.length === 0) {
    return { ready: true };
  }
  const bridgeTarget = await readDaemonBridgeTarget(env[PI_BROKER_DAEMON_STATE_PATH_ENV]);
  if (!bridgeTarget) {
    return { ready: false, reason: 'broker_daemon_bridge_unreachable' };
  }
  const agentDir = options?.agentDir ?? env.PI_CODING_AGENT_DIR;
  if (typeof agentDir !== 'string' || agentDir.trim().length === 0) {
    return { ready: false, reason: 'broker_agent_dir_missing' };
  }
  if (!(await fileExists(resolvePiBrokerExtensionPath(agentDir)))) {
    return { ready: false, reason: 'broker_extension_file_missing' };
  }
  const loadNonce = env[PI_BROKER_LOAD_NONCE_ENV];
  if (typeof loadNonce !== 'string' || loadNonce.trim().length === 0) {
    return { ready: false, reason: 'broker_load_nonce_missing' };
  }

  const waitMs = typeof options?.handshakeWaitMs === 'number' && options.handshakeWaitMs >= 0
    ? options.handshakeWaitMs
    : DEFAULT_HANDSHAKE_WAIT_MS;
  const verify = options?.verifyLoadHandshake
    ?? ((identity: string, nonce: string, deadlineMs: number) => defaultVerifyLoadHandshake(identity, nonce, bridgeTarget, deadlineMs));
  const observed = await verify(selectionIdentity.trim(), loadNonce.trim(), Date.now() + waitMs).catch(() => false);
  if (!observed) {
    return { ready: false, reason: 'broker_extension_not_loaded' };
  }

  return { ready: true };
}
