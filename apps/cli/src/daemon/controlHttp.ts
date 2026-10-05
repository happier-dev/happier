import { deriveConnectedServiceRunMaterializeToken } from './connectedServices/runs/capabilityToken';
import { classifyActionTransportFailure } from '@/api/client/classifyServerEndpointError';

export type DaemonControlRequestOptions = {
  timeoutMs?: number | null;
  signal?: AbortSignal;
  target?: Readonly<{ pid: number; httpPort: number; controlToken?: string }>;
};

type DaemonPostOptions = DaemonControlRequestOptions & {
  mutation?: boolean;
  authScope?: 'daemon-control' | 'connected-service-run-materialize';
  authTokenOverride?: string;
};

function positiveTimeout(raw: string | number | undefined, fallback: number, max: number): number {
  const parsed = typeof raw === 'number' ? raw : raw?.trim() ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) ? Math.min(max, Math.max(100, Math.trunc(parsed))) : fallback;
}

async function resolveTimeout(path: string, options: DaemonControlRequestOptions): Promise<number | null> {
  if (options.timeoutMs === null) return null;
  if (options.timeoutMs !== undefined) {
    return positiveTimeout(options.timeoutMs, 10_000, path === '/connected-service-run/materialize' ? 600_000 : 300_000);
  }
  // Runner exit and terminal retirement belong to the daemon Stop lifecycle.
  // Explicit caller deadlines and cancellation still apply.
  if (path === '/stop-session') return null;
  if (path === '/spawn-session') {
    const { DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS } = await import('@happier-dev/protocol');
    const raw = process.env.HAPPIER_DAEMON_SPAWN_HTTP_TIMEOUT;
    return positiveTimeout(raw?.trim() ? raw : process.env.HAPPIER_DAEMON_HTTP_TIMEOUT, DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS, 300_000);
  }
  return positiveTimeout(process.env.HAPPIER_DAEMON_HTTP_TIMEOUT, 10_000, 300_000);
}

async function logControlError(message: string): Promise<void> {
  const { logger } = await import('@/ui/logger');
  logger.debug(`[CONTROL CLIENT] ${message}`);
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
  try {
    const timeout = await resolveTimeout(path, options);
    const authToken = options.authTokenOverride ?? (options.authScope === 'connected-service-run-materialize'
      ? deriveConnectedServiceRunMaterializeToken(state.controlToken) : state.controlToken);
    const timeoutSignal = timeout === null ? null : AbortSignal.timeout(timeout);
    const signal = options.signal && timeoutSignal ? AbortSignal.any([options.signal, timeoutSignal]) : options.signal ?? timeoutSignal ?? undefined;
    signal?.throwIfAborted();
    requestIssued = true;
    const response = await fetch(`http://127.0.0.1:${state.httpPort}${path}`, {
      method: 'POST', headers: buildDaemonControlHttpHeaders(authToken), body: JSON.stringify(body || {}),
      ...(signal ? { signal } : {}),
    });
    const raw = await response.text();
    let parsed: unknown = null;
    if (raw.trim()) {
      try { parsed = JSON.parse(raw); } catch { parsed = raw; }
    }
    if (response.ok) return parsed ?? {};
    const object = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    if (object && typeof object.success === 'boolean') return object;
    const errorCode = typeof object?.errorCode === 'string' ? object.errorCode : undefined;
    const detail = typeof object?.error === 'string' ? object.error : typeof object?.message === 'string' ? object.message : undefined;
    const suffix = [errorCode, detail].filter(Boolean).join(': ');
    const error = `Request failed: ${path}, HTTP ${response.status}${suffix ? ` (${suffix})` : ''}`;
    await logControlError(error);
    return { error, errorCode, response: parsed };
  } catch (cause) {
    const error = `Request failed: ${path}, ${cause instanceof Error ? cause.message : 'Unknown error'}`;
    await logControlError(error);
    const failure = classifyActionTransportFailure(cause, {
      mutation: options.mutation === true, requestIssued,
      cancelled: options.signal?.aborted === true,
    });
    return { error, ...(failure && failure !== 'network' ? { errorCode: failure } : {}) };
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
