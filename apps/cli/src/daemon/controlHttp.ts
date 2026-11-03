import { deriveConnectedServiceRunMaterializeToken } from './connectedServices/runs/capabilityToken';
import { classifyActionTransportFailure, isNetworkConnectionErrorCode, readNormalizedConnectionErrorCode } from '@/api/client/classifyServerEndpointError';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { armDeadlineTimer } from '@happier-dev/protocol/common/deadlineTimer';
import { sanitizeConnectedServiceDiagnosticString } from './connectedServices/runtimeAuth/sanitizeConnectedServiceDiagnosticString';
import { loadUndici } from '@/utils/loadUndici';

export type DaemonControlRequestOptions = {
  timeoutMs?: number | null;
  signal?: AbortSignal;
  target?: Readonly<{ pid: number; httpPort: number; controlToken?: string }>;
};

type DaemonPostOptions = DaemonControlRequestOptions & {
  authorityCeiling?: 'account_automation';
  mutation?: boolean;
  authScope?: 'daemon-control' | 'connected-service-run-materialize';
  authTokenOverride?: string;
  includeFailureDiagnostics?: true;
};

/** The containing operation owns the deadline, including human approval waits. */
export async function readDaemonControlHttpResponse(params: Readonly<{
  httpPort: number;
  path: string;
  body: unknown;
  headers: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}>): Promise<Readonly<{ ok: boolean; status: number; body: string }>> {
  params.signal?.throwIfAborted();
  const { Agent } = await loadUndici();
  params.signal?.throwIfAborted();
  const dispatcher = new Agent({ connect: { timeout: 0 }, headersTimeout: 0, bodyTimeout: 0 });
  try {
    const options = {
      method: 'POST', headers: params.headers, body: JSON.stringify(params.body),
    };
    // Node fetch consumes the package-owned dispatcher and the actual caller
    // signal even when ambient Node/DOM declarations come from different graphs.
    Object.assign(options, { dispatcher, ...(params.signal ? { signal: params.signal } : {}) });
    const response = await fetch(`http://127.0.0.1:${params.httpPort}${params.path}`, options);
    return { ok: response.ok, status: response.status, body: await response.text() };
  } finally {
    await dispatcher.close();
  }
}

function positiveTimeout(raw: string | number | undefined, fallback: number, max: number): number {
  const parsed = typeof raw === 'number' ? raw : raw?.trim() ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) ? Math.min(max, Math.max(100, Math.trunc(parsed))) : fallback;
}

async function resolveTimeout(path: string, options: DaemonControlRequestOptions): Promise<number | null> {
  if (options.timeoutMs === null) return null;
  if (options.timeoutMs !== undefined) {
    // An explicit deadline belongs to the containing caller, not this phase.
    return Math.max(0, Math.trunc(options.timeoutMs));
  }
  // Runner exit and terminal retirement belong to the daemon Stop lifecycle.
  // Explicit caller deadlines and cancellation still apply.
  if (path === '/stop-session') return null;
  // Catalog preparation follows its request lifetime. A loaded daemon may
  // take longer than the generic control wait without being unavailable.
  if (path === '/plugins/catalog/read') return null;
  // Source reconciliation may await current Account rules and Home reads.
  // Its operation lifetime, not the generic control wait, bounds completion.
  if (path === '/session-activity-changed') return null;
  // Applied Account/currentness reads serve the containing Session or Run
  // operation. A generic control wait is not evidence of retired authority.
  if (path === '/connected-service-run/applied-parent-selection'
    || path === '/connected-service-run/generation-current') return null;
  if (path === '/spawn-session') {
    const { DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS } = await import('@happier-dev/protocol/sessions/creation/sessionSpawnBudget');
    const raw = process.env.HAPPIER_DAEMON_SPAWN_HTTP_TIMEOUT;
    return positiveTimeout(raw?.trim() ? raw : process.env.HAPPIER_DAEMON_HTTP_TIMEOUT, DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS, 300_000);
  }
  return positiveTimeout(process.env.HAPPIER_DAEMON_HTTP_TIMEOUT, 10_000, 300_000);
}

async function logControlError(message: string): Promise<void> {
  const { logger } = await import('@/ui/logger');
  logger.debug(`[CONTROL CLIENT] ${sanitizeConnectedServiceDiagnosticString(message)}`);
}

// HTTP JSON is an untyped external boundary. Existing control callers validate
// their own domain responses; new callers must do the same before consuming it.
export async function daemonPost(path: string, body?: unknown, options: DaemonPostOptions = {}): Promise<any> {
  const state = options.target ?? await (await import('@/persistence')).readDaemonState();
  if (!state?.httpPort) {
    const error = 'No daemon running, no state file found';
    await logControlError(error);
    return { error };
  }
  let requestIssued = false;
  let cancelDeadline: (() => void) | undefined;
  try {
    const timeout = await resolveTimeout(path, options);
    const authToken = options.authTokenOverride ?? (options.authScope === 'connected-service-run-materialize'
      ? deriveConnectedServiceRunMaterializeToken(state.controlToken) : state.controlToken);
    // Native Node timers cannot represent delays beyond signed-32 milliseconds.
    // Chunk the timer through the shared owner without shortening the deadline.
    const longDeadline = timeout !== null && timeout > 2_147_483_647 ? new AbortController() : null;
    if (longDeadline && timeout !== null) {
      cancelDeadline = armDeadlineTimer(Date.now() + timeout, () => longDeadline.abort(new DOMException('Timed out', 'TimeoutError')), { unref: true });
    }
    const timeoutSignal = longDeadline?.signal ?? (timeout === null ? null : AbortSignal.timeout(timeout));
    const signal = options.signal && timeoutSignal ? AbortSignal.any([options.signal, timeoutSignal]) : options.signal ?? timeoutSignal ?? undefined;
    signal?.throwIfAborted();
    requestIssued = true;
    const response = await readDaemonControlHttpResponse({ httpPort: state.httpPort, path, body: body || {}, headers: {
        ...buildDaemonControlHttpHeaders(authToken),
        ...(options.authorityCeiling ? { [AUTHORITY_CEILING_HEADER_V1]: options.authorityCeiling } : {}),
      },
      ...(signal ? { signal } : {}),
    });
    const raw = response.body;
    let parsed: unknown = null;
    if (raw.trim()) {
      try { parsed = JSON.parse(raw); } catch { parsed = raw; }
    }
    if (response.ok) return parsed ?? {};
    const object = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    const diagnostic = options.includeFailureDiagnostics ? { httpStatus: response.status } : {};
    if (object && typeof object.success === 'boolean') return { ...object, ...diagnostic };
    const errorCode = typeof object?.errorCode === 'string' ? object.errorCode : undefined;
    const detail = typeof object?.error === 'string' ? object.error : typeof object?.message === 'string' ? object.message : undefined;
    const suffix = [errorCode, detail].filter(Boolean).join(': ');
    const error = `Request failed: ${path}, HTTP ${response.status}${suffix ? ` (${suffix})` : ''}`;
    await logControlError(error);
    return { error, errorCode, response: parsed, ...diagnostic };
  } catch (cause) {
    const error = `Request failed: ${path}, ${cause instanceof Error ? cause.message : 'Unknown error'}`;
    await logControlError(error);
    const failure = classifyActionTransportFailure(cause, {
      mutation: options.mutation === true, requestIssued,
      cancelled: options.signal?.aborted === true,
    });
    const connectionCode = readNormalizedConnectionErrorCode(cause);
    const transportErrorCode = isNetworkConnectionErrorCode(connectionCode) ? connectionCode : failure;
    return { error, ...(failure && failure !== 'network' ? { errorCode: failure } : {}),
      ...(options.includeFailureDiagnostics && transportErrorCode ? { transportErrorCode } : {}),
    };
  } finally {
    cancelDeadline?.();
  }
}

export function buildDaemonControlHttpHeaders(
  controlToken?: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Connection: 'close',
  };
  if (controlToken) {
    headers['x-happier-daemon-token'] = controlToken;
  }
  return headers;
}
