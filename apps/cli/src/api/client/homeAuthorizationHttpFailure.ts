import { projectActionFailureCauseV1, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ExternalActionHttpErrorSchema } from '@happier-dev/protocol/actions/externalActionHttpError';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER } from '@happier-dev/protocol/actions';
import { createHttpStatusError } from './httpStatusError';

/** Redacted recovery for a signed request whose admitted HTTP purpose was not matched. */
export function readHomeAuthorizationRefusalDetails(phase: string): Readonly<{
    requiredFact: 'verification_purpose' | 'deployment_child_http'; remedy: string;
}> | undefined {
    return phase === 'verification_purpose' || phase === 'deployment_child_http' ? { requiredFact: phase,
        remedy: 'Update the Home server and this Machine, then retry the action' } : undefined;
}

/** Classify Home's rejection using the credential actually sent, never untrusted prose. */
export function projectHomeAuthorizationHttpFailure(status: 401 | 403, headers: Readonly<Record<string, string>>, payload: unknown): ActionExecuteFailure {
    const forbidden = (reason: string): ActionExecuteFailure => ({ ok: false, errorCode: 'action_forbidden',
        error: `action_forbidden (${reason})` });
    const signed = Object.entries(headers).some(([name, value]) => name.toLowerCase() === EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER
        && value.length > 0);
    if (signed) {
        const parsed = ExternalActionHttpErrorSchema.safeParse(payload);
        const phase = parsed.success && 'authorizationRefusal' in parsed.data ? parsed.data.authorizationRefusal : undefined;
        const details = parsed.success && 'details' in parsed.data && parsed.data.details !== undefined
            ? parsed.data.details : phase ? readHomeAuthorizationRefusalDetails(phase) : undefined;
        const failureCause = parsed.success && 'failureCause' in parsed.data ? parsed.data.failureCause : undefined;
        const reason = phase ? `home_signed_authorization_rejected:${phase}`
            : status === 401 ? 'home_signed_authorization_rejected' : 'home_deployment_http_forbidden';
        return { ...forbidden(reason), ...(details === undefined ? {} : { details }),
            failureCause: failureCause ?? projectActionFailureCauseV1(createHttpStatusError(status, 'action_forbidden', 'action_forbidden'),
                phase ? `home.authorization.${phase}` : 'home.authorization.signed_request') };
    }
    return status === 401 ? { ok: false, errorCode: 'action_home_signed_out', error: 'action_home_signed_out' }
        : forbidden('home_deployment_http_forbidden');
}
