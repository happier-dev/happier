import { isDeepStrictEqual } from 'node:util';

import { PluginError } from '@happier-dev/plugin-sdk';

import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { TrackedSession } from '../types';

import {
  assertRequesterSessionAccountContextCurrent,
  type ReleaseRequesterSessionRuntimeContext,
  type RequesterSessionRuntimeContext,
  type ResolveRequesterSessionRuntimeContext,
} from './requesterSessionCredentials';
import type { ReadonlyTrackedSessionMap } from '@/daemon/sessions/sessionTrackingKey';

type RetainedAttribution = TrackedSession['requesterWorkAttributionV1'];

/**
 * Machine core's one requester-custody view for Session-scoped work. Sessions,
 * devices (computer, browser, simulator) and the broker all consume it, so no
 * role re-derives which Account a Session's work runs as. Selecting a requester
 * and validating its returned context are one read-only resolution phase; the
 * callers' later effects stay outside.
 */
export type RequesterSessionAccountContextCustody = Readonly<{
  resolveSessionAccountContext: (sessionId: string | null, retainedAttribution?: RetainedAttribution,
    signal?: AbortSignal) => Promise<RequesterSessionRuntimeContext | null>;
  withSessionAccountContext: <T>(sessionId: string | null,
    operation: (context: RequesterSessionRuntimeContext | null) => Promise<T>,
    retainedAttribution?: RetainedAttribution, signal?: AbortSignal) => Promise<T>;
  assertSessionAccountCurrent: (sessionId: string | null, expected: RequesterSessionRuntimeContext | null,
    retainedAttribution?: RetainedAttribution, signal?: AbortSignal) => Promise<void>;
  withSessionAccountHome: <T>(context: RequesterSessionRuntimeContext | null, operation: () => Promise<T>) => Promise<T>;
  releaseSessionAccountContext: (context: RequesterSessionRuntimeContext | null) => Promise<void>;
}>;

export function findTrackedSessionByHappySessionId(
  trackedSessions: Iterable<TrackedSession>,
  sessionIdRaw: string,
): TrackedSession | null {
  const sessionId = sessionIdRaw.trim();
  if (!sessionId) return null;
  for (const tracked of trackedSessions) {
    if (tracked.happySessionId?.trim() === sessionId) return tracked;
  }
  return null;
}

export function createRequesterSessionAccountContextCustody(params: Readonly<{
  trackedSessions: ReadonlyTrackedSessionMap;
  resolveRequesterSessionRuntimeContext?: ResolveRequesterSessionRuntimeContext;
  releaseRequesterSessionRuntimeContext?: ReleaseRequesterSessionRuntimeContext;
  externalActionAccountId?: string | null;
  serverId: string;
  machineId: string;
  /** True once the owning runtime is disposed or quiescing: no new requester-less work is admitted. */
  isRetired: () => boolean;
}>): RequesterSessionAccountContextCustody {
  const resolve = params.resolveRequesterSessionRuntimeContext;
  const releaseSessionAccountContext = async (context: RequesterSessionRuntimeContext | null): Promise<void> => {
    if (context && resolve && params.releaseRequesterSessionRuntimeContext) await params.releaseRequesterSessionRuntimeContext(context);
  };
  const resolveSessionAccountContext: RequesterSessionAccountContextCustody['resolveSessionAccountContext'] = async (
    sessionId, retainedAttribution, signal,
  ) => {
    if (sessionId === null) return null;
    const tracked = findTrackedSessionByHappySessionId(params.trackedSessions.values(), sessionId);
    const attribution = retainedAttribution ?? tracked?.requesterWorkAttributionV1 ?? tracked?.spawnOptions?.requesterWorkAttributionV1;
    const context = (await resolve?.(sessionId, attribution, signal)) ?? null;
    if (context) {
      try {
        // The resolver returns only a context whose currentness it just read.
        if (attribution && !isDeepStrictEqual(context.bootstrap.attribution, attribution)) {
          throw new PluginError({ code: 'requester_session_not_current' });
        }
        return context;
      } catch (error) {
        await releaseSessionAccountContext(context);
        throw error;
      }
    }
    if (attribution && (attribution.accountId !== params.externalActionAccountId
      || attribution.serverId !== params.serverId || attribution.machineId !== params.machineId)) {
      throw new PluginError({ code: 'requester_session_not_current' });
    }
    return null;
  };
  return {
    resolveSessionAccountContext,
    releaseSessionAccountContext,
    withSessionAccountContext: async (sessionId, operation, retainedAttribution, signal) => {
      const context = await resolveSessionAccountContext(sessionId, retainedAttribution, signal);
      try {
        return await operation(context);
      } finally {
        await releaseSessionAccountContext(context);
      }
    },
    assertSessionAccountCurrent: async (sessionId, expected, retainedAttribution, signal) => {
      if (sessionId === null) {
        if (expected || params.isRetired()) throw new Error('requester_session_not_current');
        return;
      }
      await assertRequesterSessionAccountContextCurrent({
        expected,
        signal,
        resolveCurrent: () => resolveSessionAccountContext(sessionId, retainedAttribution, signal),
        readTrackedContext: () => findTrackedSessionByHappySessionId(params.trackedSessions.values(), sessionId)
          ?.requesterSessionRuntimeContext ?? null,
      });
    },
    withSessionAccountHome: (context, operation) => context
      ? runWithServerHttpBaseUrl(context.bootstrap.serverHttpBaseUrl, operation)
      : operation(),
  };
}
