import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ExternalActionExecutionAuthorizationBindingV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { markRpcRequestDisposition } from '@happier-dev/sync-client';

/**
 * The requester's full sign-in may be sealed only to a Machine held by the
 * requester, or by the first-hop custodian the requester already confirmed
 * that disclosure to. Nobody can confirm a further disclosure at this hop, so
 * any other custodian (or an unknown one) is refused before sealing or sending.
 */
export function assertRequesterCredentialRecipient(
  binding: Pick<
    ExternalActionExecutionAuthorizationBindingV1,
    'accountId' | 'custodianAccountId'
  >,
  recipientCustodianAccountId: string | undefined,
  error: string,
): void {
  if (
    recipientCustodianAccountId !== undefined &&
    (recipientCustodianAccountId === binding.accountId ||
      recipientCustodianAccountId === binding.custodianAccountId)
  )
    return;
  throw markRpcRequestDisposition(
    createActionExecuteFailureError({
      ok: false,
      errorCode: 'requester_credential_disclosure_required',
      error,
    }),
    'notSent',
  );
}
