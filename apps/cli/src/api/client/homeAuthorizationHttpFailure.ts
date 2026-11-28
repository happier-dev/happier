import { readActionFailureCauseV1, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ExternalActionAuthorizationRefusalPhaseSchema, ExternalActionHttpErrorSchema,
    projectExternalActionHttpFailureV1, type ExternalActionAuthorizationRefusalPhase } from '@happier-dev/protocol/actions/externalActionHttpError';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_VERIFY_HTTP_PATH_TEMPLATE_V1 } from '@happier-dev/protocol/actions/externalActionHttpTransportV1';
import { HttpStatusError } from './httpStatusError';

const verifyPath = new RegExp(`^${EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_VERIFY_HTTP_PATH_TEMPLATE_V1.replace(':actionId', '[^/]+')}$`);
type SignedHomeRefusalCode = 'action_forbidden' | 'credential_scope_denied' | 'invalid_token';

/** Redacted recovery for a signed request whose admitted HTTP purpose was not matched. */
export function readHomeAuthorizationRefusalDetails(phase: string): Readonly<{
    requiredFact: 'verification_purpose' | 'deployment_child_http'; remedy: string;
}> | undefined {
    return phase === 'verification_purpose' || phase === 'deployment_child_http' ? { requiredFact: phase,
        remedy: 'Home refused a request outside the scope of this approved Action. If the refusal repeats, report the Action ID.' } : undefined;
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
    get code(): SignedHomeRefusalCode {
        return this.failure.errorCode;
    }

    constructor(
        status: 401 | 403,
        readonly failure: ActionExecuteFailure & { errorCode: SignedHomeRefusalCode },
        readonly authorizationRefusal: ExternalActionAuthorizationRefusalPhase | undefined,
    ) {
        super(status, failure.error);
        Object.assign(this, failure, { cause: failure });
    }
}

/** Project Home's refusal after the transport identifies the signed request. */
export function readSignedHomeAuthorizationHttpError(status: 401 | 403, payload: unknown, requestUrl?: string): SignedHomeAuthorizationHttpError | undefined {
    const parsed = ExternalActionHttpErrorSchema.safeParse(payload);
    const response = parsed.success ? parsed.data : undefined;
    const path = requestUrl === undefined ? undefined : URL.parse(requestUrl, 'http://localhost')?.pathname;
    const responseCode = response?.error;
    const parsedPhase = ExternalActionAuthorizationRefusalPhaseSchema.safeParse(
        payload && typeof payload === 'object' && 'authorizationRefusal' in payload ? payload.authorizationRefusal : undefined,
    );
    const phase = parsedPhase.success ? parsedPhase.data : undefined;
    const domainPreparationRefusal = phase === 'deployment_domain_preparation'
        && status === 403 && responseCode === 'credential_scope_denied';
    const bindingRefusal = path && verifyPath.test(path) && (
        (status === 403 && responseCode === 'credential_scope_denied')
        || (status === 401 && responseCode === 'invalid_token')
    );
    const errorCode = domainPreparationRefusal || bindingRefusal ? responseCode : 'action_forbidden';
    if (response && (status === 403 && responseCode === 'credential_scope_denied' && phase === 'credential_action_admission'
        || status === 401 && responseCode === 'invalid_token' && phase === 'principal')) {
        return new SignedHomeAuthorizationHttpError(status, {
            ...projectExternalActionHttpFailureV1(response), errorCode: responseCode,
        }, phase);
    }
    // A route can reject admitted work with its own 403. Only Home's refusal phase
    // or the verify endpoint's explicit scope result identifies an authorization refusal.
    if (status === 403 && phase === undefined && errorCode !== 'credential_scope_denied') return undefined;
    const details = response && 'details' in response && response.details !== undefined
        ? response.details : phase ? readHomeAuthorizationRefusalDetails(phase) : undefined;
    const cause = response && 'failureCause' in response ? response.failureCause : undefined;
    const failureCause = readActionFailureCauseV1({
        errorClass: 'HttpStatusError', errorCode: domainPreparationRefusal ? responseCode : 'action_forbidden',
        ...cause, httpStatus: status,
        phase: phase ? `${homeAuthorizationPhasePrefix}${phase}` : cause?.phase ?? `${homeAuthorizationPhasePrefix}signed_request`,
    });
    return new SignedHomeAuthorizationHttpError(status, {
        ...forbidden(signedRefusalReason(status, phase)), ...(details === undefined ? {} : { details }), failureCause,
        errorCode,
    }, phase);
}

/** Pre-open daemon replies have only the existing code and failure cause fields. */
export function projectRelayedHomeAuthorizationFailure(failure: ActionExecuteFailure): ActionExecuteFailure {
    const cause = failure.failureCause;
    if (failure.errorCode !== 'action_forbidden' || !cause?.phase.startsWith(homeAuthorizationPhasePrefix)
        || (cause.httpStatus !== 401 && cause.httpStatus !== 403)) return failure;
    const phase = ExternalActionAuthorizationRefusalPhaseSchema.safeParse(cause.phase.slice(homeAuthorizationPhasePrefix.length));
    const refusal = forbidden(signedRefusalReason(cause.httpStatus, phase.success ? phase.data : undefined));
    const details = failure.details === undefined && phase.success ? readHomeAuthorizationRefusalDetails(phase.data) : undefined;
    return { ...failure, ...refusal, ...(details ? { details } : {}) };
}

export function projectUnsignedHomeAuthorizationHttpFailure(status: 401 | 403): ActionExecuteFailure {
    return status === 401 ? { ok: false, errorCode: 'action_home_signed_out', error: 'action_home_signed_out' }
        : forbidden('home_deployment_http_forbidden');
}
