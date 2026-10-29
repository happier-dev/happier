import { UserMessageSchema } from '@/api/types';
import { vi } from 'vitest';
import { createApiSessionSocketStub, createSessionRuntimeActivityHomeStub, resolveApiSessionSocketDefaultAck } from '@/testkit/backends/apiSessionSocketHarness';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { SESSION_PENDING_ADMISSION_SETTLEMENT_EVENT_V1,
  SessionPendingAdmissionSettlementRequestV1Schema,
  SessionPendingAdmissionSettlementResponseV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingAdmissionSettlementV1';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { createAccountSessionClientTransport } from '@/api/client/createAccountSessionClientTransport';
import {
  buildTrustedHostSessionInputAdmissionV1,
  SessionInputAdmissionReceiptV1Schema,
  SessionInputRequestV1Schema,
  settleSessionInputRequestV1,
  withSessionInputAuthorityV1,
} from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import {
  deriveSessionFollowInputLocalIdV1,
  SessionFollowInputV1Schema,
} from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { SessionFollowAdmittedInputObservationV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { resolveSessionFollowActionRequest } from '@happier-dev/protocol/sessions/follow/actionTransport';
import type { FeaturesResponse, SessionFollowFrontierV1 } from '@happier-dev/protocol';

export function installFollowHomeReadinessBoundary(features: FeaturesResponse) {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async request => {
    const url = new URL(request instanceof Request ? request.url : String(request));
    if (url.pathname !== '/v1/features') throw new Error(`Unexpected Follow readiness request: ${url.pathname}`);
    return Response.json(features);
  });
  return () => fetch.mockRestore();
}

/** The database admission receipt is the boundary; immutable authority and queue input stay real. */
export function createAdmittedFollowInputFixture(input: Readonly<{
  destinationSessionId: string;
  sourceSessionId: string;
  sourceLocalId: string;
  delivered: SessionFollowFrontierV1;
  observed: SessionFollowFrontierV1;
  relation?: 'follower' | 'manager';
  delivery?: 'wake' | 'next_turn';
}>) {
  const delivery = SessionFollowInputV1Schema.parse({ v: 1, delivery: input.delivery ?? 'wake',
    original: { sourceSessionId: input.sourceSessionId,
      sourceMessage: { localId: input.sourceLocalId, seq: input.observed.transcriptSeq } },
    event: { kind: 'person_wrote' } });
  const localId = deriveSessionFollowInputLocalIdV1({ destinationSessionId: input.destinationSessionId, original: delivery.original });
  const admission = buildTrustedHostSessionInputAdmissionV1('agent');
  const request = SessionInputRequestV1Schema.parse({ ...admission.request, followDeliveryV1: delivery });
  const receipt = SessionInputAdmissionReceiptV1Schema.parse({ v: 1, issuer: 'authenticatedMachine',
    admittedTarget: { homeId: 'follow-home', accountId: 'follow-account', sessionId: input.destinationSessionId,
      machineId: 'machine-1', installationId: 'installation-1' },
    followDeliveryV1: delivery,
    followRelations: [{ relation: input.relation ?? 'follower', ...(input.relation === 'manager' ? { attachedAt: 100 } : {}) }],
  });
  const authority = settleSessionInputRequestV1({ request, currentSessionPermissionCeiling: 'default', inputAdmissionReceipt: receipt });
  const message = UserMessageSchema.parse({ role: 'user', localId,
    content: { type: 'text', text: 'Followed source changed. Read the original source context.' },
    meta: withSessionInputAuthorityV1({}, authority), inputAdmissionReceipt: receipt });
  let withdrawn = false;
  const activity = createSessionRuntimeActivityHomeStub({ machineId: 'machine-1' });
  const socket = createApiSessionSocketStub({ connected: true, emitWithAck: (event, payload) => {
    if (event !== SESSION_PENDING_ADMISSION_SETTLEMENT_EVENT_V1) {
      return activity.answer(event, payload) ?? resolveApiSessionSocketDefaultAck(event, payload);
    }
    const settlement = SessionPendingAdmissionSettlementRequestV1Schema.parse(payload);
    if (withdrawn) return SessionPendingAdmissionSettlementResponseV1Schema.parse({ v: 1,
      result: { status: 'rejected', code: 'session_input_cancelled' } });
    return SessionPendingAdmissionSettlementResponseV1Schema.parse({ v: 1, result: settlement.decision.kind === 'admit'
      ? { status: 'accepted', localId: settlement.localId }
      : { status: 'rejected', code: settlement.decision.code } });
  } });
  const accountSocket = createApiSessionSocketStub();
  return {
    localId,
    message,
    mutePath: resolveSessionFollowActionRequest('session.delivery.mute.list', {
      receiver: { kind: 'session', sessionId: input.destinationSessionId },
    }).path,
    withdraw: () => { withdrawn = true; },
    lookupPath: `/v2/sessions/${encodeURIComponent(input.destinationSessionId)}/messages/by-local-id/${encodeURIComponent(localId)}`,
    lookupResponse: { status: 200, data: { message: { id: 'committed-follow-original', seq: 41, localId,
      sidechainId: null, createdAt: 1, updatedAt: 1, content: { t: 'plain', v: message },
      messageRole: 'user', inputAdmissionReceipt: receipt } } },
    transport: (home: ReturnType<ApiSessionClient['getServerBinding']>, access: Parameters<typeof createAccountSessionClientTransport>[0]) => ({
      ...createAccountSessionClientTransport(access), ...home,
      // Socket.IO is the system boundary; initialize/reconcile/settle stay production owners.
      createAccountUpdatesSocket: () => accountSocket as never,
      createSessionSocketTransport: () => ({ socket: socket as never, transport: createSocketTransportAdapter(socket as never) }),
    }),
    observation: SessionFollowAdmittedInputObservationV1Schema.parse({ kind: 'admitted_input', localInputId: localId,
      sourceSessionId: input.sourceSessionId, destinationSessionId: input.destinationSessionId,
      delivered: input.delivered, observed: input.observed, delivery, effectiveDelivery: delivery.delivery }),
  };
}
