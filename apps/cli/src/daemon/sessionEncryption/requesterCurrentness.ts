import { parseActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PluginError, isPluginError } from '@happier-dev/plugin-sdk/errors';
import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import { resolveOfflineReconnectionBackoffDelayMs } from '@/api/offline/serverConnectionErrors';
import { delayUnrefAbortable } from '@/utils/time';
import { AsyncLocalStorage } from 'node:async_hooks';

const REQUESTER_SESSION_CUSTODY_REFUSAL_CODES = [
  'requester_session_custody_binding_mismatch',
  'requester_session_custody_record_read_failed',
  'requester_session_custody_runtime_unavailable',
] as const;
export type RequesterSessionCustodyRefusalCode = typeof REQUESTER_SESSION_CUSTODY_REFUSAL_CODES[number];

export function readRequesterSessionCustodyRefusalCode(value: unknown): RequesterSessionCustodyRefusalCode | undefined {
  return REQUESTER_SESSION_CUSTODY_REFUSAL_CODES.find(code => code === value);
}

/** Labels for existing local decisions, never credentials or another admission check. */
export const REQUESTER_CURRENTNESS_REFUSAL_BRANCHES = [
  'local_abort_signal', 'installation_custody', 'observed_account_encryption_currentness', 'currentness_exception',
  // The admitted carrier declined a purpose it cannot spend.
  'forwarded_child_purpose', 'native_incumbent_source',
  ...REQUESTER_SESSION_CUSTODY_REFUSAL_CODES,
] as const;
export type RequesterCurrentnessRefusalBranch = typeof REQUESTER_CURRENTNESS_REFUSAL_BRANCHES[number];
const currentnessRefusal = new AsyncLocalStorage<{ branch?: RequesterCurrentnessRefusalBranch }>();

export function recordRequesterCurrentnessRefusal(branch: RequesterCurrentnessRefusalBranch): false {
  const diagnostic = currentnessRefusal.getStore();
  if (diagnostic && diagnostic.branch === undefined) diagnostic.branch = branch;
  return false;
}

/** Scope diagnostics to one request while the underlying owner keeps its existing result contract. */
export async function captureRequesterCurrentnessRefusal<T>(read: () => Promise<T>): Promise<Readonly<{
  value: T; branch?: RequesterCurrentnessRefusalBranch;
}>> {
  const diagnostic: { branch?: RequesterCurrentnessRefusalBranch } = {};
  const value = await currentnessRefusal.run(diagnostic, read);
  return { value, ...(diagnostic.branch ? { branch: diagnostic.branch } : {}) };
}

/** Keep named Home refusals typed; unavailable evidence retains the existing
 * runner failure/respawn policy's retryable disposition and safe code. */
export function rethrowRequesterHomeReadFailure(error: unknown): void {
  const failure = parseActionExecuteFailure(error);
  if (failure?.errorCode === 'credential_scope_denied' || failure?.errorCode === 'invalid_token') throw error;
  if (isPluginError(error) && error.code === 'project_requester_home_unavailable') throw error;
  const unavailableActionRead = error !== null && typeof error === 'object'
    && 'ok' in error && error.ok === false
    && 'errorCode' in error && error.errorCode === 'server_unreachable';
  if (unavailableActionRead || classifyServerEndpointError(error).retryable) {
    throw new PluginError({ code: 'project_requester_home_unavailable',
      retryable: true,
      message: 'Requester Home is temporarily unavailable. Retry when it is available.' });
  }
}
/** Only preparation reads may re-enter here, never an admitted Action effect.
 * The accepted Action owns the lifetime; the shared backoff supplies pacing,
 * without adding a competing request deadline or attempt ceiling. Callers
 * without that lifetime retain their existing failure/recovery owner.
 */
export async function readRequesterHomeWithinActionLifetime<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await read();
  let failures = 0;
  while (true) {
    signal.throwIfAborted();
    try { return await read(); }
    catch (error) {
      signal.throwIfAborted();
      try { rethrowRequesterHomeReadFailure(error); }
      catch (classified) {
        if (!isPluginError(classified) || classified.code !== 'project_requester_home_unavailable'
          || classified.retryable !== true) throw classified;
        await delayUnrefAbortable(resolveOfflineReconnectionBackoffDelayMs(++failures), signal);
        continue;
      }
      throw error;
    }
  }
}
