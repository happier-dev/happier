import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { updateSessionMetadataForTarget } from '@/session/services/updateSessionMetadataForTarget';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readSessionMemoryCeilingOverride, SessionGuardNoticeResponseV1Schema, type SessionGuardNoticeStateV1 } from '@happier-dev/protocol/machines/guard/sessionGuardStateV1';
import type { TrackedSession } from '../types';
import type { ResolveRequesterSessionRuntimeContext, ReleaseRequesterSessionRuntimeContext } from '../sessionEncryption/requesterSessionCredentials';
import { withTrackedSessionRpc } from '../sessionEncryption/withTrackedSessionRpc';
import { createGuardSessionStopReceipt } from './sessionStopReceipt';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { SessionStopRecordV1 } from '@happier-dev/protocol/machines/guard/sessionGuardStateV1';

type GuardAccess = Parameters<typeof withTrackedSessionRpc>[0];

/** Guard operations borrow requester custody only for their actual transport operation. */
export function createGuardSessionAccess(input: Readonly<{
  readAccess(): Omit<GuardAccess, 'tracked' | 'requesterBootstrap' | 'isTrackedCurrent' | 'signal' | 'timeoutMs'>;
  resolveRequesterSessionRuntimeContext: ResolveRequesterSessionRuntimeContext;
  releaseRequesterSessionRuntimeContext: ReleaseRequesterSessionRuntimeContext;
  isTrackedCurrent(tracked: TrackedSession): boolean;
  onStopped?(input: Readonly<{ record: SessionStopRecordV1; sessionId: string;
    accountId: string | null; serverHttpBaseUrl: string }>): void;
}>) {
  const withAccess = async <T>(tracked: TrackedSession,
    operation: (access: GuardAccess) => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const requester = tracked.happySessionId
      ? await input.resolveRequesterSessionRuntimeContext(tracked.happySessionId, tracked.requesterWorkAttributionV1) : null;
    try {
      return await operation({ ...input.readAccess(), tracked,
        ...(requester ? { requesterBootstrap: requester.bootstrap } : {}),
        isTrackedCurrent: () => input.isTrackedCurrent(tracked), ...(signal ? { signal } : {}) });
    } finally {
      if (requester) await input.releaseRequesterSessionRuntimeContext(requester);
    }
  };
  const sendNotice = async (tracked: TrackedSession, state: SessionGuardNoticeStateV1, signal?: AbortSignal) => {
    if (state.kind === 'clear') await tracked.guardStopReceipt?.settle('cancelled');
    const response = await withAccess(tracked, guardAccess => withTrackedSessionRpc({
      ...guardAccess, timeoutMs: null,
    }, async (callRpc, access) => {
      if (state.kind === 'stopped') {
        // Retain the admitted requester before publication; even an acknowledgement failure may have committed intent.
        tracked.guardStopReceipt = createGuardSessionStopReceipt({ records: access.systemRecords,
          at: state.at,
          onStopped: record => input.onStopped?.({ record, sessionId: access.sessionId,
            accountId: readAccountIdFromToken(access.credentials.token), serverHttpBaseUrl: access.serverHttpBaseUrl }),
          onSettled: async record => {
            const written = await runWithServerHttpBaseUrl(access.serverHttpBaseUrl, () => updateSessionMetadataForTarget({
              credentials: access.credentials, idOrPrefix: access.sessionId, expectedSessionId: access.sessionId,
              currentness: { verifyCurrent: access.isRecordCurrent },
              updater: metadata => {
                const current = metadata.sessionGuardStateV1;
                if (!current || typeof current !== 'object' || !('at' in current) || current.at !== record.at
                  || !('kind' in current) || current.kind !== 'requested') return metadata;
                if (record.status === 'stopped') return { ...metadata, sessionGuardStateV1: { ...current, kind: 'stopped' } };
                const { sessionGuardStateV1: _previous, ...rest } = metadata;
                const ceilingBytes = readSessionMemoryCeilingOverride(metadata);
                return ceilingBytes === undefined ? rest : { ...rest, sessionGuardStateV1: { v: 1, kind: 'configured', ceilingBytes } };
              },
            }));
            if (!written.ok) throw new Error('guard_stop_metadata_settlement_unavailable');
          },
        });
      }
      return await callRpc(SESSION_RPC_METHODS.SESSION_GUARD_NOTICE, { sessionId: tracked.happySessionId, state });
    }), signal ?? input.readAccess().retainedRecordSignal);
    const result = SessionGuardNoticeResponseV1Schema.safeParse(response);
    return result.success && result.data.ok;
  };
  return { withAccess, sendNotice };
}
