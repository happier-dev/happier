import { prepareExternalActionResponseEnvelopeV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { ExternalActionResponseEnvelopeV1 } from '@happier-dev/protocol/actions';
import type { ExecuteExternalActionResult } from './executeExternalAction';

export function preparedResponse(response: ExternalActionResponseEnvelopeV1): ExecuteExternalActionResult {
  const prepared = prepareExternalActionResponseEnvelopeV1(response);
  return { kind: 'response', response: prepared.response, prepared };
}

/** Only the daemon before its executor handoff may establish this refusal fact. */
export function beforeEffectResponse(response: ExternalActionResponseEnvelopeV1): ExternalActionResponseEnvelopeV1 {
  return response.execution.ok ? response : {
    ...response, execution: { ...response.execution, effectAttempted: false },
  };
}
