import { access } from 'node:fs/promises';

import { isConnectedServiceBrokerStateFileUsable } from '@/daemon/connectedServices/broker/connectedServiceBrokerStateFile';
import {
  PI_BROKER_STATE_PATH_ENV,
  PI_BROKER_LOAD_NONCE_ENV,
  PI_BROKER_PROVIDERS,
  PI_BROKER_SELECTIONS_ENV,
  PI_BROKER_SELECTION_IDENTITY_ENV,
  parsePiBrokerSelections,
} from './piBrokerExtensionEnv';
import { resolvePiBrokerExtensionPath } from './piBrokerExtensionAssets';
import { PI_BROKER_EXTENSION_VERSION } from './piBrokerExtensionSource';

export type PiBrokerReadinessFailureReason =
  | 'broker_daemon_bridge_unreachable'
  | 'broker_load_nonce_missing'
  | 'broker_agent_dir_missing'
  | 'broker_extension_file_missing'
  | 'broker_readiness_cancelled'
  | 'broker_process_exited'
  | 'broker_extension_not_loaded';

export type PiBrokerReadinessFailure = Readonly<{
  classification: 'pi_broker_readiness_failure';
  reason: PiBrokerReadinessFailureReason;
  code: 'pi_broker_readiness_failure';
  sanitizedPreview: 'Pi connected-service broker was not ready before provider send';
}>;

export type PiBrokerReadiness =
  | Readonly<{ ready: true }>
  | Readonly<{ ready: false; reason: PiBrokerReadinessFailureReason }>;

export class PiBrokerReadinessError extends Error {
  readonly piBrokerReadinessFailure: PiBrokerReadinessFailure;

  constructor(reason: PiBrokerReadinessFailureReason) {
    const sanitizedPreview = 'Pi connected-service broker was not ready before provider send' as const;
    super(`${sanitizedPreview} (${reason})`);
    this.name = 'PiBrokerReadinessError';
    this.piBrokerReadinessFailure = Object.freeze({
      classification: 'pi_broker_readiness_failure',
      reason,
      code: 'pi_broker_readiness_failure',
      sanitizedPreview,
    });
  }
}

const HANDSHAKE_POLL_INTERVAL_MS = 200;

type PiBrokerReadinessLifecycle = Readonly<{
  deadlineMs: number;
  signal?: AbortSignal;
  isProcessActive?: () => boolean;
}>;

function resolveLifecycleFailure(
  lifecycle: PiBrokerReadinessLifecycle,
): PiBrokerReadinessFailureReason | null {
  if (lifecycle.signal?.aborted === true) return 'broker_readiness_cancelled';
  if (lifecycle.isProcessActive?.() === false) return 'broker_process_exited';
  if (!Number.isFinite(lifecycle.deadlineMs) || Date.now() >= lifecycle.deadlineMs) {
    return 'broker_extension_not_loaded';
  }
  return null;
}

async function waitForNextHandshakePoll(lifecycle: PiBrokerReadinessLifecycle): Promise<void> {
  const waitMs = Math.min(HANDSHAKE_POLL_INTERVAL_MS, Math.max(0, lifecycle.deadlineMs - Date.now()));
  if (waitMs <= 0 || lifecycle.signal?.aborted === true) return;

  await new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      lifecycle.signal?.removeEventListener('abort', onAbort);
      resolve();
    }, waitMs);
    timeout.unref?.();
    lifecycle.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function defaultVerifyLoadHandshake(
  selectionIdentity: string,
  loadNonce: string,
  providers: readonly string[],
  pluginVersion: string,
  lifecycle: PiBrokerReadinessLifecycle,
): Promise<boolean> {
  // The daemon load-handshake registry is provider-agnostic (keyed by selection identity plus load
  // nonce), so the existing loaded-status control-client query serves the Pi broker too — no new daemon
  // surface or stale-process readiness reuse.
  const { queryDaemonOpenCodeBrokerLoadHandshake } = await import('@/daemon/controlClient');
  for (;;) {
    if (resolveLifecycleFailure(lifecycle)) return false;
    const remainingMs = Math.max(1, lifecycle.deadlineMs - Date.now());
    if (await queryDaemonOpenCodeBrokerLoadHandshake(
      selectionIdentity,
      loadNonce,
      providers,
      pluginVersion,
      'pi_rpc_process',
      {
        timeoutMs: Math.min(10_000, remainingMs),
        signal: lifecycle.signal,
      },
    ).catch(() => false)) return true;
    if (resolveLifecycleFailure(lifecycle)) return false;
    await waitForNextHandshakePoll(lifecycle);
  }
}

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(() => true).catch(() => false);
}

/**
 * Fail-closed preflight: verify the Happier Pi broker extension is materialized + reachable for a
 * connected session before startup/prompt commands. For NATIVE sessions (no selection identity) and
 * direct-API-key connected sessions (no brokered provider) it is a strict no-op (`ready: true`).
 *
 * For brokered sessions it confirms (a) the broker extension file exists at the path the launcher passes
 * to Pi's `--extension` arg, (b) the minimal broker-state target is readable with a scoped broker
 * capability, and
 * (c) a real load handshake arrived (the extension pings the daemon on activation) within a bounded
 * wait. If any check fails the session MUST be failed with a clear materialization error — never
 * silently fall back to native/upstream auth (the brokered credential carries no real refresh token, so
 * request-time failure is the backstop regardless).
 */
export async function verifyPiBrokerReadyForConnectedSession(
  env: Readonly<Record<string, string>>,
  options: Readonly<{
    /** Absolute deadline owned by the enclosing Pi session-open lifecycle. */
    deadlineMs: number;
    /** Cancellation owned by the enclosing runner/session-open lifecycle. */
    signal?: AbortSignal;
    /** Direct liveness check for the exact Pi child whose extension must report readiness. */
    isProcessActive?: () => boolean;
    /** The Happier-controlled Pi agent dir (`PI_CODING_AGENT_DIR`). Defaults to the env value. */
    agentDir?: string;
    /** Injectable load-handshake verifier (test seam). Defaults to a bounded poll of the daemon. */
    verifyLoadHandshake?: (
      selectionIdentity: string,
      loadNonce: string,
      providers: readonly string[],
      pluginVersion: string,
      deadlineMs: number,
    ) => Promise<boolean>;
  }>,
): Promise<PiBrokerReadiness> {
  const selectionIdentity = env[PI_BROKER_SELECTION_IDENTITY_ENV];
  if (typeof selectionIdentity !== 'string') {
    return { ready: true };
  }
  const selections = parsePiBrokerSelections(env[PI_BROKER_SELECTIONS_ENV]);
  const brokeredProviders = PI_BROKER_PROVIDERS.filter((provider) => selections[provider]);
  if (brokeredProviders.length === 0) {
    return { ready: true };
  }
  if (!(await isConnectedServiceBrokerStateFileUsable(env[PI_BROKER_STATE_PATH_ENV]))) {
    return { ready: false, reason: 'broker_daemon_bridge_unreachable' };
  }
  const loadNonce = env[PI_BROKER_LOAD_NONCE_ENV];
  if (typeof loadNonce !== 'string' || loadNonce.trim().length === 0) {
    return { ready: false, reason: 'broker_load_nonce_missing' };
  }
  const agentDir = options.agentDir ?? env.PI_CODING_AGENT_DIR;
  if (typeof agentDir !== 'string' || agentDir.trim().length === 0) {
    return { ready: false, reason: 'broker_agent_dir_missing' };
  }
  if (!(await fileExists(resolvePiBrokerExtensionPath(agentDir)))) {
    return { ready: false, reason: 'broker_extension_file_missing' };
  }

  const lifecycle: PiBrokerReadinessLifecycle = {
    deadlineMs: options.deadlineMs,
    signal: options.signal,
    isProcessActive: options.isProcessActive,
  };
  const lifecycleFailure = resolveLifecycleFailure(lifecycle);
  if (lifecycleFailure) return { ready: false, reason: lifecycleFailure };

  const observed = await (options.verifyLoadHandshake
    ? options.verifyLoadHandshake(
        selectionIdentity,
        loadNonce.trim(),
        brokeredProviders,
        PI_BROKER_EXTENSION_VERSION,
        lifecycle.deadlineMs,
      )
    : defaultVerifyLoadHandshake(
        selectionIdentity,
        loadNonce.trim(),
        brokeredProviders,
        PI_BROKER_EXTENSION_VERSION,
        lifecycle,
      )).catch(() => false);
  const failureAfterVerification = resolveLifecycleFailure(lifecycle);
  if (failureAfterVerification) return { ready: false, reason: failureAfterVerification };
  if (!observed) {
    return { ready: false, reason: 'broker_extension_not_loaded' };
  }

  return { ready: true };
}
