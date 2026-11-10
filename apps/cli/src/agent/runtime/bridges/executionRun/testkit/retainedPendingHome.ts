import type { SessionMessageContent } from '@/api/types';
import type { SessionInputAdmissionReceiptV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import {
  SESSION_PENDING_ADMISSION_SETTLEMENT_EVENT_V1,
  SessionPendingAdmissionSettlementRequestV1Schema,
  SessionPendingAdmissionSettlementResponseV1Schema,
} from '@happier-dev/protocol/sessions/messages/sessionPendingAdmissionSettlementV1';
import {
  SESSION_PENDING_EXECUTION_RUN_MATERIALIZE_NEXT_EVENT_V2,
  SESSION_PENDING_EXECUTION_RUN_ACCEPTED_EVENT_V2,
  SessionExecutionRunPendingEnqueueRequestV1Schema,
  SessionPendingExecutionRunMaterializeNextRequestV2Schema,
  SessionPendingExecutionRunMaterializeNextResponseV2Schema,
  SessionPendingExecutionRunAcceptedRequestV2Schema,
  SessionPendingExecutionRunAcceptedResponseV2Schema,
  type SessionPendingExecutionRunMaterializeNextRequestV2,
} from '@happier-dev/protocol/sessions/messages/sessionPendingExecutionRunMachineAdmissionV2';
import type { PendingRequestedActionV1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import type { SessionMessageDeliveryResolutionV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageDeliveryResolutionV1';

type PendingInput = {
  localId: string;
  content: SessionMessageContent;
  requestedAction?: PendingRequestedActionV1;
};
type CommittedInput = PendingInput & { id: string; seq: number; createdAt: number; updatedAt: number;
  deliveryResolution?: SessionMessageDeliveryResolutionV1 };

/** Home HTTP/Socket.IO boundary extracted from the retained-target recovery
 * fixture. SessionClient still owns admission, materialization and native custody. */
export function createRetainedPendingHome(options: Readonly<{
  sessionId: string;
  authorAccountId: string | null;
  inputAdmissionReceipt: SessionInputAdmissionReceiptV1;
  onEnqueued(runId: string, pendingVersion: number): void;
  commit(input: PendingInput & { sidechainId: string; deliveryResolution?: SessionMessageDeliveryResolutionV1 }): CommittedInput;
  onAccepted?(): void;
  onMaterialize?(request: SessionPendingExecutionRunMaterializeNextRequestV2): void;
  onRejected?(code: string): void;
}>) {
  const targets = new Map<string, { pending?: PendingInput; claimed?: PendingInput; version: number; claimCount: number }>();
  const target = (runId: string) => {
    let current = targets.get(runId);
    if (!current) {
      current = { version: 0, claimCount: 0 };
      targets.set(runId, current);
    }
    return current;
  };
  const assertSession = (sessionId: string) => {
    if (sessionId !== options.sessionId) throw new Error('Pending request belongs to another fixture Session');
  };
  const admit = (runId: string, input: PendingInput) => {
    const state = target(runId);
    state.pending = { localId: input.localId, content: input.content, requestedAction: input.requestedAction };
    state.version += 1;
    options.onEnqueued(runId, state.version);
    return { didWrite: true, terminal: false };
  };
  return {
    readPending: (runId: string) => target(runId).pending,
    readClaimed: (runId: string) => target(runId).claimed,
    readClaimCount: (runId: string) => target(runId).claimCount,
    admit,
    enqueue(runId: string, raw: unknown) {
      const input = SessionExecutionRunPendingEnqueueRequestV1Schema.parse(raw);
      return admit(runId, input);
    },
    answer(event: string, raw: unknown): unknown | null {
      if (event === SESSION_PENDING_EXECUTION_RUN_MATERIALIZE_NEXT_EVENT_V2) {
        const request = SessionPendingExecutionRunMaterializeNextRequestV2Schema.parse(raw);
        assertSession(request.sessionId);
        options.onMaterialize?.(request);
        const state = target(request.recipient.runId);
        const input = state.pending;
        const base = { v: 2, ok: true, recipient: request.recipient, sidechainId: request.sidechainId,
          authorAccountId: options.authorAccountId, pendingCount: 0, pendingBlockedCount: 0,
          pendingVersion: state.version, deliveryState: { mode: 'provider', unresolved: Boolean(input) } };
        if (!input) return SessionPendingExecutionRunMaterializeNextResponseV2Schema.parse({ ...base, didMaterialize: false });
        if (!state.claimed) state.claimCount += 1;
        state.claimed = input;
        return SessionPendingExecutionRunMaterializeNextResponseV2Schema.parse({ ...base,
          didMaterialize: true, didWrite: false, message: { id: null, seq: null, ...input,
            inputAdmissionReceipt: options.inputAdmissionReceipt, messageRole: 'user', providerAction: 'send',
            requestedAction: input.requestedAction ?? { v: 1, kind: 'enqueue' }, createdAt: 1, updatedAt: 1 } });
      }
      if (event === SESSION_PENDING_ADMISSION_SETTLEMENT_EVENT_V1) {
        const request = SessionPendingAdmissionSettlementRequestV1Schema.parse(raw);
        assertSession(request.sessionId);
        if (request.decision.kind === 'reject') {
          options.onRejected?.(request.decision.code);
          return SessionPendingAdmissionSettlementResponseV1Schema.parse({ v: 1,
            result: { status: 'rejected', code: request.decision.code } });
        }
        const state = [...targets.values()].find(value => value.pending?.localId === request.localId);
        if (state?.pending) state.pending.content = request.decision.finalContent;
        if (state?.claimed) state.claimed.content = request.decision.finalContent;
        return SessionPendingAdmissionSettlementResponseV1Schema.parse({ v: 1,
          result: { status: 'accepted', localId: request.localId } });
      }
      if (event === SESSION_PENDING_EXECUTION_RUN_ACCEPTED_EVENT_V2) {
        const request = SessionPendingExecutionRunAcceptedRequestV2Schema.parse(raw);
        assertSession(request.sessionId);
        const state = target(request.recipient.runId);
        if (!state.claimed) throw new Error('Expected accepted delivery content');
        // Mirror pendingMessageService's committed provider acceptance. The real
        // durable reader must see the host's facts on the stored transcript row.
        const message = options.commit({ ...state.claimed, localId: request.localId, sidechainId: request.sidechainId,
          ...(request.acceptedDelivery === undefined ? {} : { deliveryResolution: {
            v: 1, kind: 'provider_accepted', content: request.acceptedDelivery,
          } }) });
        state.pending = undefined;
        state.version += 1;
        options.onAccepted?.();
        return SessionPendingExecutionRunAcceptedResponseV2Schema.parse({ v: 2,
          recipient: request.recipient, sidechainId: request.sidechainId,
          result: { ok: true, didResolve: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: state.version,
            message: { ...message, providerAction: 'send', requestedAction: state.claimed.requestedAction ?? { v: 1, kind: 'enqueue' } } } });
      }
      return null;
    },
  };
}
