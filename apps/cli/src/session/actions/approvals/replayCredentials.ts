import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { StoredCredentials } from '@/persistence';

/** A mutable profile may refresh credentials, but cannot replace replay custody. */
export function selectApprovalReplayCredentials(
  captured: StoredCredentials | null,
  current: StoredCredentials | null,
  expectedAccountId?: string,
): Readonly<{ ok: true; credentials: StoredCredentials }> | ActionExecuteFailure {
  const capturedAccountId = captured ? readAccountIdFromToken(captured.token) : null;
  if (!captured || !current || (expectedAccountId && capturedAccountId !== expectedAccountId)) {
    return {
      ok: false, effectAttempted: false, errorCode: 'account_mismatch',
      error: 'Approval replay credentials are unavailable for the original Account. Sign in to its recorded origin profile and retry this approval.',
    };
  }
  return {
    ok: true,
    credentials: capturedAccountId && readAccountIdFromToken(current.token) === capturedAccountId ? current : captured,
  };
}
