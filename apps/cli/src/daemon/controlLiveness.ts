import { isPidPresent } from '@happier-dev/cli-common/process';
import { CredentialRequestRedirectError, fetchWithCredentialRedirectRefusal } from '@happier-dev/cli-common/homeTarget';
import { buildDaemonControlHttpHeaders, DAEMON_CONTROL_TOKEN_HEADER } from './controlHttp';

export type DaemonControlLivenessProbeResult =
  | 'running'
  | 'control_not_running'
  | 'unauthorized'
  | 'unreachable';

async function pingAuthenticatedControl(input: Readonly<{
  httpPort: number;
  controlToken: string;
  timeoutMs: number;
}>): Promise<DaemonControlLivenessProbeResult> {
  try {
    const response = await fetchWithCredentialRedirectRefusal(`http://127.0.0.1:${input.httpPort}/ping`, {
      method: 'POST',
      headers: buildDaemonControlHttpHeaders(input.controlToken),
      body: '{}',
      signal: AbortSignal.timeout(input.timeoutMs),
    }, undefined, new Set([DAEMON_CONTROL_TOKEN_HEADER]));
    if (response.status === 401 || response.status === 403) return 'unauthorized';
    if (!response.ok) return 'unreachable';
    const payload = await response.json() as unknown;
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      && (payload as Readonly<{ status?: unknown }>).status === 'ok'
      ? 'running'
      : 'unreachable';
  } catch (error) {
    if (error instanceof CredentialRequestRedirectError) throw error;
    const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : error;
    return cause && typeof cause === 'object' && 'code' in cause
      && (cause.code === 'ECONNREFUSED' || cause.code === 'ConnectionRefused')
      ? 'control_not_running'
      : 'unreachable';
  }
}

/**
 * Proves that persisted daemon coordinates still name a live Happier daemon.
 * The authenticated ping defeats PID/port reuse; neither PID liveness nor a
 * stale state-file generation is execution authority by itself.
 *
 * A PID the caller cannot see (ESRCH) is not proof of absence either: containers
 * and host boundaries hide the daemon's pid namespace while its control endpoint
 * stays reachable. The probe preserves unknown transport failures separately from a refused endpoint;
 * neither a refused endpoint nor an unobservable PID proves lifecycle cleanup completed.
 */
export async function probeDaemonAuthenticatedControl(input: Readonly<{
  pid: number;
  httpPort: number;
  controlToken: string;
  timeoutMs: number;
}>): Promise<DaemonControlLivenessProbeResult> {
  try {
    process.kill(input.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ESRCH') {
      return 'unreachable';
    }
    return await pingAuthenticatedControl(input);
  }

  return await pingAuthenticatedControl(input);
}

export type DaemonPublicationPresenceInspection = Readonly<
  | { status: 'running'; hiddenPid: boolean }
  | { status: 'not_running' | 'unverified' }
>;

/** Coarse publication presence, shared by status projections and confirmed stop. */
export async function inspectDaemonPublicationPresence(input: Readonly<{
  pid: number;
  httpPort: number;
  controlToken?: string;
  timeoutMs: number;
}>): Promise<DaemonPublicationPresenceInspection> {
  if (isPidPresent(input.pid)) return { status: 'running', hiddenPid: false };
  if (!input.controlToken) return { status: 'not_running' };
  const liveness = await probeDaemonAuthenticatedControl({ ...input, controlToken: input.controlToken });
  if (liveness === 'running') return { status: 'running', hiddenPid: true };
  return { status: liveness === 'unreachable' ? 'unverified' : 'not_running' };
}
