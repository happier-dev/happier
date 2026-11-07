import { bindHomeDomainActionHttpRequestV1, bindPublicProfilePreparedHttpRequestV1, homeDomainActionOutputSchemaV1, readHomeDomainActionErrorV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ApprovalStaleFailureDetailsSchema } from '@happier-dev/protocol/approvals/approvalExecutionFailure';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { ExternalActionHttpErrorSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { ManagedControllerRequestFailureDetailsV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { MachineAvailabilityDiagnosticV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { SavedSecretResourceActionErrorV1Schema } from '@happier-dev/protocol/account/settings/savedSecretResourceActionsV1';
import { PluginSecretSourceFailureV1Schema } from '@happier-dev/protocol/plugins/contributions/public-types';
import {
    HomeGovernanceErrorCodeV1Schema,
    homeGovernanceErrorHttpStatusV1,
} from '@happier-dev/protocol/home/governance';
import {
    TeamCredentialErrorCodeV1Schema,
    teamCredentialErrorHttpStatusV1,
    TeamErrorCodeV1Schema,
    teamErrorHttpStatusV1,
} from '@happier-dev/protocol/teams';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import { homeDomainFailureKindForHttpStatus, requestHomeDomain, type HomeDomainFailure } from './homeServerActionTransport';

/**
 * The UI's Home family port.
 *
 * The shared Action executor owns admission, settings, approval and output
 * validation. This dependency owns exactly one thing the executor cannot know:
 * which Home the intent belongs to. Binding the scope here — rather than reading
 * a focused Home when the request is finally issued — is what makes an
 * administration screen for Home A immune to the user focusing Home B while a
 * mutation is in flight.
 */
export type HomeDomainActionExecutor = NonNullable<ActionExecutorDeps['homeDomainAction']>;

/**
 * Maps the transport's typed failure onto the shared Action failure envelope.
 *
 * The Home's own code is carried through untouched when it sent one, so a
 * surface can explain the real refusal. Transport-owned failures keep their
 * shared Action meanings: unsupported is the standard Action refusal,
 * post-dispatch uncertainty is the canonical unprefixed `outcome_unknown`, and
 * failures proven not to have reached the Home retain the Home-unreachable code.
 */
function toActionFailure(actionId: string, failure: HomeDomainFailure<string>): ActionExecuteFailure {
    const details = failure.httpStatus === undefined ? failure.details : {
        ...(typeof failure.details === 'object' && failure.details !== null ? failure.details : {}),
        httpStatus: failure.httpStatus,
    };
    if (failure.code) {
        return {
            ok: false,
            errorCode: failure.code,
            error: failure.code,
            ...(details === undefined ? {} : { details }),
        };
    }
    if (failure.kind === 'unsupported') {
        return {
            ok: false,
            errorCode: 'unsupported_action',
            error: `unsupported_action:${actionId}`,
            ...(details === undefined ? {} : { details }),
        };
    }
    if (failure.kind === 'outcome_unknown') {
        return { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' };
    }
    const code = `home_${failure.kind}`;
    return { ok: false, errorCode: code, error: code, ...(details === undefined ? {} : { details }) };
}

const HOME_DOMAIN_FAILURE_KINDS = [
    'unreachable',
    'unauthorized',
    'forbidden',
    'unsupported',
    'invalid',
    'conflict',
    'unknown',
] as const satisfies readonly HomeDomainFailure['kind'][];

/**
 * Reads a Home failure back out of the shared Action envelope.
 *
 * The envelope carries one code, so this is the exact inverse of the encoding
 * above and lives beside it: one module knows how a Home refusal is written into
 * an Action failure and how it is read back, rather than two that can drift.
 *
 * Transport retryability is re-derived from its code. A canonical domain error
 * may additionally carry schema-validated retryability and recovery details.
 */
export function homeDomainFailureFromActionFailure(
    failure: Readonly<{ errorCode?: string | undefined; details?: unknown }>,
    actionId?: ActionId,
): HomeDomainFailure<string> {
    const code = failure.errorCode ?? '';
    // Consent ended before dispatch. Preserve its exact Action disposition as
    // a refusal rather than describing it as an unknown Home/network failure.
    if (code === 'approval_rejected' || code === 'approval_canceled') {
        return Object.freeze({ kind: 'forbidden' as const, retryable: false, code });
    }
    if (code === 'approval_stale') {
        const details = ApprovalStaleFailureDetailsSchema.safeParse(failure.details);
        return Object.freeze({ kind: 'forbidden' as const, retryable: false, code,
            ...(details.success ? { details: details.data } : {}) });
    }
    // The shared Action executor emits this only after its mutation dependency
    // was dispatched and the result could not be confirmed. Preserve that
    // uncertainty: presenting it as a definite offline refusal invites a
    // second, non-idempotent mutation.
    if (code === 'outcome_unknown') {
        return Object.freeze({ kind: 'outcome_unknown' as const, retryable: false, code: null });
    }
    const rawDetails = failure.details;
    const status = typeof rawDetails === 'object' && rawDetails !== null && 'httpStatus' in rawDetails
        ? rawDetails.httpStatus : undefined;
    const httpStatus = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
    const domainDetails = httpStatus === undefined ? rawDetails : (() => {
        const { httpStatus: _httpStatus, ...domain } = rawDetails as Readonly<Record<string, unknown>>;
        return domain;
    })();
    const parsedDetails = readHomeDomainActionErrorV1(domainDetails);
    const externalDetails = ExternalActionHttpErrorSchema.safeParse(domainDetails);
    const controllerDetails = ManagedControllerRequestFailureDetailsV1Schema.safeParse(domainDetails);
    const availability = code === 'target_unavailable' ? MachineAvailabilityDiagnosticV1Schema.safeParse(domainDetails) : null;
    const sourceFailure = actionId?.startsWith('secrets.') && typeof domainDetails === 'object' && domainDetails !== null && 'repair' in domainDetails
        ? PluginSecretSourceFailureV1Schema.safeParse({ ok: false, code, repair: domainDetails.repair }) : null;
    const details = parsedDetails?.code === code ? parsedDetails.details
        : externalDetails.success && 'code' in externalDetails.data && externalDetails.data.code === code
            ? externalDetails.data : controllerDetails.success ? controllerDetails.data : availability?.success ? availability.data
                : sourceFailure?.success ? { repair: sourceFailure.data.repair } : undefined;
    const withDetails = (value: HomeDomainFailure<string>): HomeDomainFailure<string> => Object.freeze({
        ...value,
        ...(details === undefined ? {} : { details }),
        ...(httpStatus === undefined ? {} : { httpStatus }),
        ...(httpStatus !== undefined && (httpStatus >= 500 || httpStatus === 408 || httpStatus === 429) ? { retryable: true } : {}),
    });
    if (code === 'unsupported_action' || code.startsWith('unsupported_action:')) {
        return withDetails({ kind: 'unsupported' as const, retryable: false, code: null });
    }
    const transportKind = HOME_DOMAIN_FAILURE_KINDS.find((kind) => code === `home_${kind}`);
    if (transportKind) {
        return withDetails({
            kind: transportKind,
            retryable: transportKind === 'unreachable' || transportKind === 'unknown',
            code: null,
        });
    }
    const credential = TeamCredentialErrorCodeV1Schema.safeParse(code);
    // Discovery's per-Team error has no failed HTTP response. Its original
    // Action family supplies the same retry semantics as the single-Team route;
    // shared code names in ordinary Team operations retain their own policy.
    const credentialRetryable = actionId?.startsWith('teams.credentials.') === true
        && credential.success && teamCredentialErrorHttpStatusV1(credential.data) >= 500;
    const team = TeamErrorCodeV1Schema.safeParse(code);
    if (team.success) {
        return withDetails({
            kind: homeDomainFailureKindForHttpStatus(teamErrorHttpStatusV1(team.data), team.data),
            retryable: credentialRetryable,
            code: team.data,
        });
    }
    if (credential.success) {
        return withDetails({
            kind: homeDomainFailureKindForHttpStatus(teamCredentialErrorHttpStatusV1(credential.data), credential.data),
            retryable: credentialRetryable,
            code: credential.data,
        });
    }
    const parsed = HomeGovernanceErrorCodeV1Schema.safeParse(code);
    if (parsed.success) {
        // The Home named this refusal, so it is the Home's answer and stands.
        return withDetails({
            kind: homeDomainFailureKindForHttpStatus(homeGovernanceErrorHttpStatusV1(parsed.data), parsed.data),
            retryable: false,
            code: parsed.data,
        });
    }
    const savedSecret = SavedSecretResourceActionErrorV1Schema.safeParse(details);
    if (savedSecret.success && savedSecret.data.error === code
        && (code === 'settings_conflict' || code === 'references_conflict' && httpStatus === 409)) {
        // Settings CAS and the resource's reference census retain their canonical
        // currentness refusal through the Action envelope.
        return withDetails({ kind: 'conflict', retryable: false, code });
    }
    if (parsedDetails?.code === code) {
        const retryable = typeof parsedDetails.details === 'object'
            && parsedDetails.details !== null
            && 'retryable' in parsedDetails.details
            && parsedDetails.details.retryable === true;
        return withDetails({
            kind: 'unknown' as const,
            retryable,
            code: parsedDetails.code,
            details: parsedDetails.details,
        });
    }
    // An Action refused before the Home was asked — an unknown id, a disabled
    // surface, a policy denial. None of them is a Home outcome. Retain its
    // existing Action code rather than inventing a Home/network refusal.
    return withDetails({ kind: 'unknown' as const, retryable: false, code: code || null });
}

/**
 * Projects one decoded Home-family failure for clients whose public result uses
 * a single code instead of the richer transport union.
 *
 * Domain refusals retain the Home's own code. Transport outcomes use the same
 * stable codes the Action envelope carried, so a post-dispatch response loss
 * can never collapse into an ordinary `action_failed` result at a managed
 * administration client.
 */
export function homeDomainFailureCode(failure: HomeDomainFailure<string>): string {
    if (failure.code) return failure.code;
    if (failure.kind === 'outcome_unknown') return 'outcome_unknown';
    if (failure.kind === 'unsupported') return 'unsupported_action';
    return `home_${failure.kind}`;
}

export function createHomeDomainActionExecutorForScope(
    scope: ServerAccountScope,
    errorSchema?: Readonly<{
        safeParse: (value: unknown) => { success: true; data: string } | { success: false };
    }>,
    readCurrentness?: () => boolean,
): HomeDomainActionExecutor {
    return async ({ actionId, input, preparedRequest, signal }) => {
        const spec = getActionSpec(actionId);
        const request = preparedRequest ? bindPublicProfilePreparedHttpRequestV1(actionId, preparedRequest)
            : bindHomeDomainActionHttpRequestV1(actionId, input);
        // A snapshot's demand can end while Account settings/approval admit the
        // read. Recheck its owner immediately before issuing the transport.
        if (readCurrentness?.() === false) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
        const result = await requestHomeDomain<unknown, string>({
            scope,
            method: request.method,
            path: request.path,
            input: request.body,
            schema: homeDomainActionOutputSchemaV1(actionId, preparedRequest),
            effect: spec.sideEffectClass === 'read' ? 'read' : 'write',
            ...(errorSchema ? { errorSchema } : {}),
            ...(signal ? { signal } : {}),
        });
        return result.ok ? result.value : toActionFailure(actionId, result.failure);
    };
}
