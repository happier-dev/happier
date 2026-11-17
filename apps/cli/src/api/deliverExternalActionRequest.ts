import axios from '@/api/client/credentialAxios';
import { configuration } from '@/configuration';
import { runTracedExternalActionInnerStage } from '@/daemon/externalActions/externalActionPhase';
import { withAbortTimeout } from '@/diagnostics/httpClient';
import { PERSONAL_SAVED_SECRET_ACTION_IDS_V1 } from '@happier-dev/protocol/account/settings/personalSavedSecretActionIdsV1';
import { projectActionFailureCauseV1, type ActionExecuteFailure, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1, ExternalActionHttpErrorSchema, isExternalActionSubmittedUnknownHttpResponse,
  parseExternalActionResponseEnvelopeV1, readExternalActionResponseExecutionV1,
  type ExternalActionRequestEnvelope } from '@happier-dev/protocol/actions/externalActionApi';
import { openExternalActionResponseV2, type ExternalActionEncryptionBindingV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { projectExternalActionHttpFailureV1 } from '@happier-dev/protocol/actions/externalActionHttpError';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';

/** One response owner for original and installed Workflow Action delivery. */
export async function deliverExternalActionRequest(input: Readonly<{
  actionId: string; serverHttpBaseUrl: string; body: unknown; envelope: ExternalActionRequestEnvelope;
  headers: Readonly<Record<string, string>>; material?: Extract<AccountScopedCryptoMaterial, { type: 'dataKey' }>;
  binding?: ExternalActionEncryptionBindingV2; signal?: AbortSignal; isCurrent(): Promise<boolean>;
}>): Promise<ActionExecuteResult> {
  const fail = (errorCode: string, issuerPhase?: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode,
    ...(issuerPhase ? { failureCause: projectActionFailureCauseV1({ code: errorCode }, issuerPhase) } : {}) });
  input.signal?.throwIfAborted();
  if (!await input.isCurrent()) return fail('target_unavailable', 'dispatch.delivery.currentness');
  const finiteSavedSecret = PERSONAL_SAVED_SECRET_ACTION_IDS_V1.some(actionId => actionId === input.actionId);
  let deliverySignal = input.signal;
  try {
    const deliver = (signal?: AbortSignal) => {
      deliverySignal = signal;
      return axios.post<unknown>(`${input.serverHttpBaseUrl}${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${input.actionId}`, input.body, {
        headers: input.headers, ...(signal ? { signal } : {}), validateStatus: () => true,
      });
    };
    // Saved Secret commands consume the existing finite CLI HTTP budget. The whole
    // response is bounded, including a peer that keeps streaming an unfinished body.
    const response = await runTracedExternalActionInnerStage('dispatch.delivery', () => finiteSavedSecret
      ? withAbortTimeout(configuration.sessionControlHttpTimeoutMs, deliver, input.signal)
      : deliver(input.signal));
    // A received operation receipt remains true even when observation retired.
    if (isExternalActionSubmittedUnknownHttpResponse(response.status, response.data)) return fail('outcome_unknown');
    if (response.status < 200 || response.status >= 300) {
      const refusal = ExternalActionHttpErrorSchema.safeParse(response.data);
      if (refusal.success && 'requestId' in refusal.data && refusal.data.requestId !== undefined
        && refusal.data.requestId !== input.envelope.requestId) return fail('invalid_action_output');
      return refusal.success ? projectExternalActionHttpFailureV1(refusal.data) : fail('project_transport_unavailable');
    }
    if (input.envelope.v === 2 && input.material && input.binding) return openExternalActionResponseV2({ envelope: response.data,
      binding: input.binding, request: input.envelope, material: input.material }) ?? fail('invalid_action_output');
    const parsed = parseExternalActionResponseEnvelopeV1(response.data);
    return parsed && parsed.actionId === input.actionId && parsed.requestId === input.envelope.requestId
      ? readExternalActionResponseExecutionV1(parsed) : fail('invalid_action_output');
  } catch {
    // A dispatched write may have committed even when its response never arrives.
    // Return uncertainty without replaying it or asserting that the write failed.
    return finiteSavedSecret && deliverySignal?.aborted && !input.signal?.aborted
      ? { ...fail('outcome_unknown'), details: { category: 'transport_timeout' } }
      : fail('outcome_unknown');
  }
}
