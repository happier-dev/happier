import type { RequesterSessionRuntimeContext } from '../../sessionEncryption/requesterSessionCredentials';
import type { QualifiedConnectedAccountEstablishedRuntimeOwner } from '../qualifiedConnectedAccountEstablishedRuntimeOwner';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { QUALIFIED_CONNECTED_ACCOUNT_MATERIAL_FAILURE_CODES } from '../qualifiedConnectedAccountMaterialError';
import {
    ConnectedAccountRequestAuthError,
    type ConnectedAccountRequestAuthDiagnostic,
    type ConnectedAccountRequestAuthErrorCode,
    type ConnectedAccountRequestAuthServiceDependencies,
} from './ConnectedAccountRequestAuthService';

const ownerCauseCodes = [
    ...QUALIFIED_CONNECTED_ACCOUNT_MATERIAL_FAILURE_CODES,
    'encryption_material_unavailable', 'connected_account_v4_contract_violation',
    'plugin_connected_account_binding_out_of_scope', 'plugin_connected_account_settings_unavailable',
    'plugin_connected_account_binding_unavailable', 'plugin_host_access_resource_not_selected',
    'plugin_host_access_operation_denied', 'plugin_final_generation_retired',
    'plugin_connected_account_purpose_undeclared', 'plugin_services_turn_authority_unavailable',
    'account_encryption_currentness_unavailable', 'account_storage_currentness_unavailable',
] as const satisfies readonly ConnectedAccountRequestAuthDiagnostic['causeCode'][];

function requestAuthFailure(error: unknown, phase: 'requester' | 'binding' | 'materialization', code: ConnectedAccountRequestAuthErrorCode) {
    if (error instanceof ConnectedAccountRequestAuthError) return error;
    let ownerCode: typeof ownerCauseCodes[number] | undefined;
    try {
        const errorCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        ownerCode = ownerCauseCodes.find(candidate => candidate === errorCode);
    } catch { /* Untrusted accessors never replace the original refusal. */ }
    const { errorClass, errorCode: exceptionCode, httpStatus } = readUnexpectedActionErrorDiagnosticV1(error);
    const requesterRetired = error instanceof Error && error.message === 'requester_session_not_current';
    return new ConnectedAccountRequestAuthError(code, {
        causeCode: ownerCode ?? (httpStatus ? phase === 'requester' ? 'requester_http_refused'
            : phase === 'binding' ? 'binding_http_refused' : 'materialization_http_refused'
            : requesterRetired ? 'requester_session_not_current'
                : phase === 'requester' ? 'requester_context_unavailable'
                    : phase === 'binding' ? 'binding_resolution_failed' : 'materialization_failed'),
        ...(httpStatus ? { httpStatus } : {}),
        ...(!ownerCode && !httpStatus && !requesterRetired ? { errorClass, exceptionCode } : {}),
    });
}

/** The daemon's existing qualified purpose callbacks; legacy ingress stays at its caller. */
type RequestAuthAccountContext = Readonly<{
    bootstrap: Pick<RequesterSessionRuntimeContext['bootstrap'], 'serverHttpBaseUrl'>;
    qualifiedConnectedAccountEstablishedRuntimeOwner?: Pick<QualifiedConnectedAccountEstablishedRuntimeOwner, 'recordScopeChallenge'>;
}> & Pick<RequesterSessionRuntimeContext, 'isCurrent'>;

export function createDaemonQualifiedRequestAuthCallbacks<T extends RequestAuthAccountContext>(params: Readonly<{
    recordScopeChallenge?: QualifiedConnectedAccountEstablishedRuntimeOwner['recordScopeChallenge'];
    withSessionAccountContext?: <Result>(sessionId: string | null, operation: (context: T | null) => Promise<Result>) => Promise<Result>;
    /** The Session owner verifies both captured-context identity and fresh
     * admission. Direct context checks serve only the assertion-free adapter. */
    assertSessionAccountCurrent?: (sessionId: string, expected: T | null) => Promise<void>;
}>): Pick<ConnectedAccountRequestAuthServiceDependencies, 'resolveCurrentBinding' | 'materializeBearer' | 'reportScopeFailure'> {
    const withSessionAccountContext = async <Result>(sessionId: string | null, operation: (context: T | null) => Promise<Result>) => {
        if (sessionId && params.withSessionAccountContext) {
            return await params.withSessionAccountContext(sessionId, operation);
        }
        return await operation(null);
    };
    return {
        reportScopeFailure: async ({ subject, resolved, failure, signal }) => {
            signal.throwIfAborted();
            if (!subject.isCurrent()) return { status: 'stale_context' };
            return await withSessionAccountContext(subject.parentSessionId ?? null, async context => {
                if (subject.parentSessionId) {
                    // Null is the existing daemon-Account projection only when the
                    // Session admission owner proves it; missing requester custody
                    // must not borrow the Machine's writer.
                    if (!context && !params.assertSessionAccountCurrent) return { status: 'stale_context' as const };
                    await params.assertSessionAccountCurrent?.(subject.parentSessionId, context);
                }
                if (context && !params.assertSessionAccountCurrent && !await context.isCurrent()) return { status: 'stale_context' as const };
                const record = context ? context.qualifiedConnectedAccountEstablishedRuntimeOwner?.recordScopeChallenge : params.recordScopeChallenge;
                if (!record) return { status: 'denied' as const };
                const write = () => record({ account: resolved.account, expectedCredentialRevision: resolved.credentialRevision,
                    requiredScopes: failure.requiredScopes, signal });
                const result = await (context ? runWithServerHttpBaseUrl(context.bootstrap.serverHttpBaseUrl, write) : write());
                signal.throwIfAborted();
                if (!subject.isCurrent()) return { status: 'stale_context' as const };
                return result;
            });
        },
        resolveCurrentBinding: async ({ subject, binding, signal }) => {
            signal.throwIfAborted();
            if (!subject.isCurrent()) return null;
            let phase: 'requester' | 'binding' = 'requester';
            try {
                return await withSessionAccountContext(subject.parentSessionId ?? null, async context => {
                    if (subject.parentSessionId && !context && !params.assertSessionAccountCurrent) {
                        throw new ConnectedAccountRequestAuthError('request_auth_binding_unavailable', { causeCode: 'requester_context_unavailable' });
                    }
                    const authority = subject.bindingAuthority;
                    if (!authority) throw new ConnectedAccountRequestAuthError('request_auth_binding_unavailable', { causeCode: 'binding_resolver_unavailable' });
                    if (subject.parentSessionId) await params.assertSessionAccountCurrent?.(subject.parentSessionId, context);
                    if (context && !params.assertSessionAccountCurrent && !await context.isCurrent()) throw new Error('requester_session_not_current');
                    phase = 'binding';
                    // A recovered Account runtime has a different process-local lease map.
                    // Keep the issuer's owner; requester custody still fences every read.
                    const read = () => authority.resolveCurrentBinding({ binding, signal });
                    const resolved = await (context ? runWithServerHttpBaseUrl(context.bootstrap.serverHttpBaseUrl, read) : read());
                    signal.throwIfAborted();
                    phase = 'requester';
                    if (!subject.isCurrent() || !resolved) return null;
                    return Object.freeze({ account: resolved.account, credentialRevision: resolved.credentialRevision,
                        ...(resolved.group ? { group: resolved.group } : {}) });
                });
            } catch (error) {
                signal.throwIfAborted();
                throw requestAuthFailure(error, phase, 'request_auth_binding_unavailable');
            }
        },
        materializeBearer: async ({ subject, binding, resolved, materialization, signal }) => {
            signal.throwIfAborted();
            if (!subject.isCurrent()) throw new ConnectedAccountRequestAuthError('request_auth_not_active');
            let phase: 'requester' | 'materialization' = 'requester';
            try {
                return await withSessionAccountContext(subject.parentSessionId ?? null, async context => {
                    if (subject.parentSessionId && !context && !params.assertSessionAccountCurrent) {
                        throw new ConnectedAccountRequestAuthError('request_auth_binding_unavailable', { causeCode: 'requester_context_unavailable' });
                    }
                    const authority = subject.bindingAuthority;
                    if (!authority) throw new ConnectedAccountRequestAuthError('request_auth_binding_unavailable', { causeCode: 'binding_resolver_unavailable' });
                    if (subject.parentSessionId) await params.assertSessionAccountCurrent?.(subject.parentSessionId, context);
                    if (context && !params.assertSessionAccountCurrent && !await context.isCurrent()) throw new ConnectedAccountRequestAuthError('request_auth_not_active');
                    phase = 'materialization';
                    const read = () => authority.materializeBearer({ binding, resolved, materialization, signal });
                    const result = await (context ? runWithServerHttpBaseUrl(context.bootstrap.serverHttpBaseUrl, read) : read());
                    signal.throwIfAborted();
                    phase = 'requester';
                    if (!subject.isCurrent()) throw new ConnectedAccountRequestAuthError('request_auth_not_active');
                    return result;
                });
            } catch (error) {
                signal.throwIfAborted();
                throw requestAuthFailure(error, phase, 'request_auth_credential_unavailable');
            }
        },
    };
}
