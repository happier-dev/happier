import { readUnexpectedActionErrorDiagnosticV1, type ActionExecuteFailure } from '../actions/actionExecutionResult.js';
import { readActionCredentialScopeDeniedHttpFailureV1 } from '../actions/externalActionHttpError.js';
import { readHomeDomainConfirmedRollbackV1 } from '../actions/homeDomainHttpBinding.js';
import { AccountApiTokensServerErrorV1Schema } from '../auth/accountApiTokens.js';
import { AccountSecurityRouteErrorV1Schema } from '../auth/accountSecurity.js';

/**
 * Carry the Home's existing classified refusal through the Usage HTTP adapters.
 * The shared decoders allow only public authority, eligibility and storage causes.
 */
export function readUsageHomeHttpFailure(status: number, data: unknown): ActionExecuteFailure | null {
  if (status !== 403 && status !== 503) return null;
  if (status === 403) {
    const scope = readActionCredentialScopeDeniedHttpFailureV1(status, data);
    if (scope) return scope;
    const authorization = AccountApiTokensServerErrorV1Schema.safeParse(data);
    if (authorization.success && (authorization.data.error === 'credential_origin_denied'
      || authorization.data.error === 'present_user_required')) {
      const code = authorization.data.error;
      return { ok: false, errorCode: code, error: code };
    }
  }
  const eligibility = AccountSecurityRouteErrorV1Schema.safeParse(data);
  if (eligibility.success) {
    const code = eligibility.data.error;
    if ((status === 403 && code === 'not-eligible') || (status === 503 && code === 'upstream_error')) {
      return { ok: false, errorCode: code, error: code };
    }
    if (status === 403 && code === 'provider-required') {
      return { ok: false, errorCode: code, error: code, details: { provider: eligibility.data.provider } };
    }
  }
  if (status !== 503) return null;
  const rollback = readHomeDomainConfirmedRollbackV1(status, data);
  if (rollback) return { ok: false, errorCode: rollback.code, error: rollback.code, details: rollback.details };
  const { errorCode } = readUnexpectedActionErrorDiagnosticV1({ response: { status, data } });
  return errorCode ? { ok: false, errorCode, error: errorCode } : null;
}
