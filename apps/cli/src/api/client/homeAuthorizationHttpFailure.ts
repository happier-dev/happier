import { readActionFailureCauseV1, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ExternalActionAuthorizationRefusalPhaseSchema, ExternalActionHttpErrorSchema,
    type ExternalActionAuthorizationRefusalPhase } from '@happier-dev/protocol/actions/externalActionHttpError';
import { HttpStatusError } from './httpStatusError';

/** Redacted recovery for a signed request whose admitted HTTP purpose was not matched. */
export function readHomeAuthorizationRefusalDetails(phase: string): Readonly<{
    requiredFact: 'verification_purpose' | 'deployment_child_http'; remedy: string;
}> | undefined {
    return phase === 'verification_purpose' || phase === 'deployment_child_http' ? { requiredFact: phase,
        remedy: 'Update the Home server and this Machine, then retry the action' } : undefined;
}

const forbidden = (reason: string): ActionExecuteFailure => ({ ok: false, errorCode: 'action_forbidden',
    error: `action_forbidden (${reason})` });
const homeAuthorizationPhasePrefix = 'home.authorization.';

function signedRefusalReason(status: 401 | 403, phase?: ExternalActionAuthorizationRefusalPhase): string {
    return phase ? `home_signed_authorization_rejected:${phase}`
        : status === 401 ? 'home_signed_authorization_rejected' : 'home_deployment_http_forbidden';
}

/** Carries the public Action failure and HTTP status without Axios request data. */
export class SignedHomeAuthorizationHttpError extends HttpStatusError {
    readonly code = 'action_forbidden';

    constructor(
        status: 401 | 403,
        readonly failure: ActionExecuteFailure,
        readonly authorizationRefusal: ExternalActionAuthorizationRefusalPhase | undefined,
    ) {
        super(status, failure.error);
        Object.assign(this, failure, { cause: failure });
    }
}

/** Project Home's closed refusal phase after the transport identifies the signed request. */
export function createSignedHomeAuthorizationHttpError(status: 401 | 403, payload: unknown): SignedHomeAuthorizationHttpError {
    const parsed = ExternalActionHttpErrorSchema.safeParse(payload);
    const response = parsed.success ? parsed.data : undefined;
    const phase = response && 'authorizationRefusal' in response ? response.authorizationRefusal : undefined;
    const details = response && 'details' in response && response.details !== undefined
        ? response.details : phase ? readHomeAuthorizationRefusalDetails(phase) : undefined;
    const cause = response && 'failureCause' in response ? response.failureCause : undefined;
    const failureCause = readActionFailureCauseV1({
        errorClass: 'HttpStatusError', errorCode: 'action_forbidden', ...cause, httpStatus: status,
        phase: phase ? `${homeAuthorizationPhasePrefix}${phase}` : cause?.phase ?? `${homeAuthorizationPhasePrefix}signed_request`,
    });
    return new SignedHomeAuthorizationHttpError(status, {
        ...forbidden(signedRefusalReason(status, phase)), ...(details === undefined ? {} : { details }), failureCause,
    }, phase);
}

/** Pre-open daemon replies have only the existing code and failure cause fields. */
export function projectRelayedHomeAuthorizationFailure(failure: ActionExecuteFailure): ActionExecuteFailure {
    const cause = failure.failureCause;
    if (failure.errorCode !== 'action_forbidden' || !cause?.phase.startsWith(homeAuthorizationPhasePrefix)
        || (cause.httpStatus !== 401 && cause.httpStatus !== 403)) return failure;
    const phase = ExternalActionAuthorizationRefusalPhaseSchema.safeParse(cause.phase.slice(homeAuthorizationPhasePrefix.length));
    const refusal = forbidden(signedRefusalReason(cause.httpStatus, phase.success ? phase.data : undefined));
    const details = phase.success ? readHomeAuthorizationRefusalDetails(phase.data) : undefined;
    return { ...failure, ...refusal, ...(details ? { details } : {}) };
}

export function projectUnsignedHomeAuthorizationHttpFailure(status: 401 | 403): ActionExecuteFailure {
    return status === 401 ? { ok: false, errorCode: 'action_home_signed_out', error: 'action_home_signed_out' }
        : forbidden('home_deployment_http_forbidden');
}
