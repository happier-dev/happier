import type { AdmittedRequesterSessionBootstrap, RequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/requesterSessionCredentials';

/** Connected-service consumers borrow the requester selected by runner identity.
 * Detached Workflows have no Session id; they must not fall back to its custodian. */
export function createExecutionRunRequesterAccountAccess(input: Readonly<{
  resolveSession(sessionId: string | null, attribution?: RequesterSessionRuntimeContext['bootstrap']['attribution'], signal?: AbortSignal): Promise<RequesterSessionRuntimeContext | null>;
  releaseSession(context: RequesterSessionRuntimeContext | null): Promise<void>;
  assertSession(sessionId: string | null, context: RequesterSessionRuntimeContext | null,
    attribution?: RequesterSessionRuntimeContext['bootstrap']['attribution'], signal?: AbortSignal): Promise<void>;
  createRequester?: (bootstrap: AdmittedRequesterSessionBootstrap, options?: Readonly<{ bootstrapOwnership?: 'borrowed' }>) => Promise<RequesterSessionRuntimeContext | null>;
}>) {
  const resolve = async (sessionId: string | null, bootstrap?: AdmittedRequesterSessionBootstrap, signal?: AbortSignal) => {
    if (!bootstrap) return await input.resolveSession(sessionId, undefined, signal);
    signal?.throwIfAborted();
    const context = await input.createRequester?.(bootstrap, { bootstrapOwnership: 'borrowed' });
    if (!context) throw new Error('requester_session_not_current');
    return context;
  };
  const release = async (context: RequesterSessionRuntimeContext | null) => {
    if (context?.bootstrap.getBoundSessionId() === null) await context.dispose();
    else await input.releaseSession(context);
  };
  const assertCurrent = async (sessionId: string | null, context: RequesterSessionRuntimeContext | null,
    attribution?: RequesterSessionRuntimeContext['bootstrap']['attribution'], signal?: AbortSignal) => {
    if (sessionId !== null || !context) return await input.assertSession(sessionId, context, attribution, signal);
    if (!await context.isCurrent(signal)) throw new Error('requester_session_not_current');
  };
  return { resolve, release, assertCurrent,
    withContext: async <T>(sessionId: string | null, operation: (context: RequesterSessionRuntimeContext | null) => Promise<T>,
      attribution?: RequesterSessionRuntimeContext['bootstrap']['attribution'], signal?: AbortSignal,
      bootstrap?: AdmittedRequesterSessionBootstrap): Promise<T> => {
      const context = await resolve(sessionId, bootstrap, signal);
      try { return await operation(context); }
      finally { await release(context); }
    },
  };
}
