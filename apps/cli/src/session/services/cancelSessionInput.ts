import { isAxiosError } from 'axios';

import type { StoredCredentials } from '@/persistence';
import { discardPendingQueueV2Messages } from '@/api/session/pendingQueueV2Transport';
import { resolveSessionTransportContext } from './resolveSessionTransportContext';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SessionInputCancelExactTurnResultV1Schema } from '@happier-dev/protocol/sessions/control/exactTurnCancellationV1';
import type { SessionInputCancelExactTurnResultV1 } from '@happier-dev/protocol';

export type CancelSessionInputResult =
  | Readonly<{ kind: 'pending_retired' }>
  | Readonly<{ kind: 'turn_cancel_requested' }>
  | Readonly<{ kind: 'turn_cancel_refused'; status: Extract<SessionInputCancelExactTurnResultV1, { ok: false }>['status']; code: string }>
  | Readonly<{ kind: 'turn_cancel_unavailable'; code: string }>;

/**
 * Retires one exact Session input without broadening to whole-Session stop.
 * Pending custody is durable server state; only an already-materialized input
 * crosses to the loaded Session's exact-turn cancellation owner.
 */
export async function cancelSessionInput(params: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  localId: string;
}>): Promise<CancelSessionInputResult> {
  try {
    await discardPendingQueueV2Messages({
      token: params.credentials.token,
      sessionId: params.sessionId,
      localIds: [params.localId],
      reason: 'session_input_cancelled',
    });
    return { kind: 'pending_retired' };
  } catch (error) {
    if (!isAxiosError(error) || error.response?.status !== 404) throw error;
    const responseData: unknown = error.response.data;
    if (!responseData || typeof responseData !== 'object'
      || !('error' in responseData) || typeof responseData.error !== 'string') {
      throw error;
    }
    // The server deliberately collapses absence and denied submit authority.
    // Neither is evidence that this exact input has stopped.
    if (responseData.error === 'session-not-found') return { kind: 'turn_cancel_unavailable', code: responseData.error };
    if (responseData.error !== 'not-found') throw error;
  }

  try {
    const transport = await resolveSessionTransportContext({
      credentials: params.credentials,
      idOrPrefix: params.sessionId,
    });
    if (!transport.ok || transport.sessionId !== params.sessionId) {
      return { kind: 'turn_cancel_unavailable', code: transport.ok ? 'session_identity_mismatch' : transport.code };
    }
    const rpc = {
      token: params.credentials.token,
      sessionId: transport.sessionId,
      method: `${transport.sessionId}:${SESSION_RPC_METHODS.SESSION_INPUT_CANCEL_EXACT_TURN_V1}`,
      request: { sessionId: transport.sessionId, localId: params.localId },
    };
    const response = transport.mode === 'plain'
      ? await callSessionRpc({ ...rpc, mode: 'plain' })
      : await callSessionRpc({ ...rpc, mode: 'e2ee', ctx: transport.ctx });
    const parsed = SessionInputCancelExactTurnResultV1Schema.safeParse(response);
    if (!parsed.success) return { kind: 'turn_cancel_unavailable', code: 'session_input_cancel_invalid_result' };
    if (parsed.data.sessionId !== params.sessionId || parsed.data.localId !== params.localId) {
      return { kind: 'turn_cancel_unavailable', code: 'session_input_cancel_identity_mismatch' };
    }
    if (!parsed.data.ok) {
      return { kind: 'turn_cancel_refused', status: parsed.data.status, code: parsed.data.errorCode ?? parsed.data.status };
    }
    return { kind: 'turn_cancel_requested' };
  } catch (error) {
    return {
      kind: 'turn_cancel_unavailable',
      code: error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : 'session_input_cancel_unavailable',
    };
  }
}
