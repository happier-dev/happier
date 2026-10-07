import { bindHomeDomainActionHttpRequestV1, homeDomainActionOutputSchemaV1, readHomeDomainActionErrorV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
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
    if (failure.code) {
        return {
            ok: false,
            errorCode: failure.code,
            error: failure.code,
            ...(failure.details === undefined ? {} : { details: failure.details }),
        };
    }
    if (failure.kind === 'unsupported') {
        return {
            ok: false,
            errorCode: 'unsupported_action',
            error: `unsupported_action:${actionId}`,
        };
    }
    if (failure.kind === 'outcome_unknown') {
        return { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' };
    }
    const code = `home_${failure.kind}`;
    return { ok: false, errorCode: code, error: code };
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
): HomeDomainFailure {
    const code = failure.errorCode ?? '';
    // The shared Action executor emits this only after its mutation dependency
    // was dispatched and the result could not be confirmed. Preserve that
    // uncertainty: presenting it as a definite offline refusal invites a
    // second, non-idempotent mutation.
    if (code === 'outcome_unknown') {
        return Object.freeze({ kind: 'outcome_unknown' as const, retryable: false, code: null });
    }
    const parsedDetails = readHomeDomainActionErrorV1(failure.details);
    const details = parsedDetails?.code === code ? parsedDetails.details : undefined;
    const withDetails = (value: HomeDomainFailure): HomeDomainFailure => Object.freeze({
        ...value,
        ...(details === undefined ? {} : { details }),
    });
    if (code === 'unsupported_action' || code.startsWith('unsupported_action:')) {
        return Object.freeze({ kind: 'unsupported' as const, retryable: false, code: null });
    }
    const transportKind = HOME_DOMAIN_FAILURE_KINDS.find((kind) => code === `home_${kind}`);
    if (transportKind) {
        return Object.freeze({
            kind: transportKind,
            retryable: transportKind === 'unreachable' || transportKind === 'unknown',
            code: null,
        });
    }
    const team = TeamErrorCodeV1Schema.safeParse(code);
    if (team.success) {
        return withDetails({
            kind: homeDomainFailureKindForHttpStatus(teamErrorHttpStatusV1(team.data)),
            retryable: false,
            code: team.data,
        });
    }
    const credential = TeamCredentialErrorCodeV1Schema.safeParse(code);
    if (credential.success) {
        return withDetails({
            kind: homeDomainFailureKindForHttpStatus(teamCredentialErrorHttpStatusV1(credential.data)),
            retryable: false,
            code: credential.data,
        });
    }
    const parsed = HomeGovernanceErrorCodeV1Schema.safeParse(code);
    if (parsed.success) {
        // The Home named this refusal, so it is the Home's answer and stands.
        return withDetails({
            kind: homeDomainFailureKindForHttpStatus(homeGovernanceErrorHttpStatusV1(parsed.data)),
            retryable: false,
            code: parsed.data,
        });
    }
    if (parsedDetails?.code === code) {
        const retryable = typeof parsedDetails.details === 'object'
            && parsedDetails.details !== null
            && 'retryable' in parsedDetails.details
            && parsedDetails.details.retryable === true;
        return Object.freeze({
            kind: 'unknown' as const,
            retryable,
            code: parsedDetails.code,
            details: parsedDetails.details,
        });
    }
    // An Action refused before the Home was asked — an unknown id, a disabled
    // surface, a policy denial. None of them is a Home outcome.
    return Object.freeze({ kind: 'unknown' as const, retryable: false, code: null });
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
export function homeDomainFailureCode(failure: HomeDomainFailure): string {
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
): HomeDomainActionExecutor {
    return async ({ actionId, input, signal }) => {
        const spec = getActionSpec(actionId);
        const request = bindHomeDomainActionHttpRequestV1(actionId, input);
        const result = await requestHomeDomain<unknown, string>({
            scope,
            method: request.method,
            path: request.path,
            input: request.body,
            schema: homeDomainActionOutputSchemaV1(actionId),
            effect: spec.sideEffectClass === 'read' ? 'read' : 'write',
            ...(errorSchema ? { errorSchema } : {}),
            ...(signal ? { signal } : {}),
        });
        return result.ok ? result.value : toActionFailure(actionId, result.failure);
    };
}
