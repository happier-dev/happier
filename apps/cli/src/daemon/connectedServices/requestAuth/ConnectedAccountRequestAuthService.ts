import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { readCredentialRedactionValues } from '@happier-dev/cli-common/plugins/http';
import { logger } from '@/ui/logger';
import type { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { QualifiedConnectedAccountMaterialFailureCode } from '../qualifiedConnectedAccountMaterialError';

import { ConnectedAccountAuthFailureRequestV1Schema, ConnectedAccountQuotaFailureRequestV1Schema, RequestAuthFailureOutcomeV1Schema } from '@happier-dev/protocol/connect/connected-account-request-auth';
import { QualifiedConnectedAccountPurposeV1Schema } from '@happier-dev/protocol/connect/connectedAccountPurposeIdentity';
import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { ConnectedAccountAuthFailureRequestV1, ConnectedAccountQuotaFailureRequestV1, RequestAuthHeadersV1, QualifiedConnectedAccountPurposeBindingV1, QualifiedConnectedAccountPurposeV1, QualifiedConnectedAccountRequestAuthUseV1, QualifiedConnectedAccountRef, RequestAuthFailureOutcomeV1, RequestAuthHeaderMapV1, RequestAuthFactsV1 } from '@happier-dev/protocol';

export type ConnectedAccountRequestAuthErrorCode =
    | 'request_auth_not_active'
    | 'request_auth_purpose_forbidden'
    | 'request_auth_binding_unavailable'
    | 'request_auth_credential_unavailable';

/** Host-file diagnostics only; never include arbitrary exception text or transport data. */
export type ConnectedAccountRequestAuthDiagnostic = Readonly<{
    causeCode: 'requester_context_unavailable' | 'requester_session_not_current' | 'requester_http_refused'
        | 'binding_resolver_unavailable' | 'binding_resolution_failed' | 'binding_http_refused'
        | 'binding_not_resolved' | 'binding_mismatch' | 'materialization_failed' | 'materialization_http_refused'
        | 'request_auth_materialization_invalid' | 'request_auth_oauth_bearer_required'
        | 'request_auth_established_runtime_unavailable' | 'request_auth_credential_superseded'
        | 'request_auth_revision_fence_required' | 'request_auth_service_unsupported'
        | 'encryption_material_unavailable'
        | 'connected_account_v4_contract_violation'
        | 'plugin_connected_account_binding_out_of_scope' | 'plugin_connected_account_settings_unavailable'
        | 'plugin_connected_account_binding_unavailable' | 'plugin_host_access_resource_not_selected'
        | 'plugin_host_access_operation_denied' | 'plugin_final_generation_retired'
        | 'plugin_connected_account_purpose_undeclared' | 'plugin_services_turn_authority_unavailable'
        | 'account_encryption_currentness_unavailable' | 'account_storage_currentness_unavailable'
        | QualifiedConnectedAccountMaterialFailureCode;
    httpStatus?: number;
    errorClass?: ReturnType<typeof readUnexpectedActionErrorDiagnosticV1>['errorClass'];
    exceptionCode?: string | null;
}>;

export class ConnectedAccountRequestAuthError extends Error {
    readonly code: ConnectedAccountRequestAuthErrorCode;
    readonly diagnostic?: ConnectedAccountRequestAuthDiagnostic;

    constructor(code: ConnectedAccountRequestAuthErrorCode, diagnostic?: ConnectedAccountRequestAuthDiagnostic) {
        super(code);
        this.name = 'ConnectedAccountRequestAuthError';
        this.code = code;
        this.diagnostic = diagnostic;
    }
}

/** Process-local ports captured from the exact purpose lease's owner at issuance. */
export type ConnectedAccountRequestAuthBindingAuthority = Readonly<{
    resolveCurrentBinding(input: Readonly<{ binding: QualifiedConnectedAccountPurposeBindingV1; signal: AbortSignal }>): Promise<ConnectedAccountRequestAuthResolvedBinding | null>;
    materializeHeaders(input: Readonly<{ binding: QualifiedConnectedAccountPurposeBindingV1; resolved: ConnectedAccountRequestAuthResolvedBinding;
        materialization: QualifiedConnectedAccountRequestAuthUseV1['materialization']; signal: AbortSignal }>): Promise<HeadersMaterial>;
}>;

export type ConnectedAccountRequestAuthSubject = Readonly<{
    /** Diagnostic identity only. Authorization is the subject's exact live capability object. */
    subjectId: string;
    /** Host-issued captured Session identity; never read from caller bodies or subjectId. */
    parentSessionId?: string;
    /** Issued by the host, retained only in memory; never accepted from a capability document. */
    bindingAuthority?: ConnectedAccountRequestAuthBindingAuthority;
    /**
     * Private issuance proof for the bounded service-keyed compatibility adapter. Only a
     * catalog-Agent foreground issuer may set this; absence fails closed to qualified ownership.
     */
    legacyServiceKeyedCompatibility?: true;
    isCurrent: () => boolean;
    /** Host currentness that requires an existing Account or Run transport read. */
    validateCurrent?: (signal: AbortSignal) => Promise<boolean>;
    /** Registers material with this exact live subject's bounded diagnostic owner. */
    registerRedaction: (values: readonly string[]) => void;
    resolvePurposeUse: (
        purpose: QualifiedConnectedAccountPurposeV1,
    ) => ConnectedAccountRequestAuthPurposeUse | null;
    listPurposeUses: () => readonly ConnectedAccountRequestAuthPurposeUse[];
}>;

export type ConnectedAccountRequestAuthPurposeUse = Readonly<{
    binding: QualifiedConnectedAccountPurposeBindingV1;
    use: QualifiedConnectedAccountRequestAuthUseV1;
}>;

export type ConnectedAccountRequestAuthResolvedBinding = Readonly<{
    account: QualifiedConnectedAccountRef;
    credentialRevision: string;
    /** Keeps an adapter-issued lease out of the qualified materialization/recovery path. */
    legacyServiceKeyedCompatibility?: true;
    group?: Readonly<{
        groupId: string;
        generation: number;
    }>;
}>;

export type HeadersMaterial = Readonly<{
    headers: RequestAuthHeaderMapV1;
    facts: RequestAuthFactsV1;
    expiresAt?: number;
}>;

type MaybePromise<T> = T | Promise<T>;

type CachedHeadersMaterial = Readonly<{
    account: QualifiedConnectedAccountRef;
    headers: RequestAuthHeaderMapV1;
    facts: RequestAuthFactsV1;
    expiresAt?: number;
    credentialRevision: string;
    legacyServiceKeyedCompatibility?: true;
}>;

export type ConnectedAccountRequestAuthServiceDependencies = Readonly<{
    resolveCurrentBinding: (
        input: Readonly<{
            subject: ConnectedAccountRequestAuthSubject;
            binding: QualifiedConnectedAccountPurposeBindingV1;
            signal: AbortSignal;
        }>,
    ) => MaybePromise<ConnectedAccountRequestAuthResolvedBinding | null>;
    materializeHeaders: (
        input: Readonly<{
            subject: ConnectedAccountRequestAuthSubject;
            binding: QualifiedConnectedAccountPurposeBindingV1;
            resolved: ConnectedAccountRequestAuthResolvedBinding;
            materialization: QualifiedConnectedAccountRequestAuthUseV1['materialization'];
            signal: AbortSignal;
        }>,
    ) => Promise<HeadersMaterial>;
    refreshAfterAuthFailure: (input: Readonly<{
        subject: ConnectedAccountRequestAuthSubject;
        resolved: ConnectedAccountRequestAuthResolvedBinding;
        failure: Extract<ConnectedAccountAuthFailureRequestV1['normalizedFailure'], { class: 'authentication' }>;
        signal: AbortSignal;
    }>) => Promise<RequestAuthFailureOutcomeV1>;
    /** A stale rejection cannot invalidate its replacement; only independent current expiry may refresh it. */
    refreshExpiredReplacement?: (input: Readonly<{
        subject: ConnectedAccountRequestAuthSubject;
        resolved: ConnectedAccountRequestAuthResolvedBinding;
        signal: AbortSignal;
    }>) => Promise<void>;
    reportScopeFailure?: (input: Readonly<{
        subject: ConnectedAccountRequestAuthSubject;
        resolved: ConnectedAccountRequestAuthResolvedBinding;
        failure: Extract<ConnectedAccountAuthFailureRequestV1['normalizedFailure'], { class: 'insufficient_scope' }>;
        signal: AbortSignal;
    }>) => Promise<RequestAuthFailureOutcomeV1>;
    reportQuotaFailure: (input: Readonly<{
        subject: ConnectedAccountRequestAuthSubject;
        resolved: ConnectedAccountRequestAuthResolvedBinding;
        failure: ConnectedAccountQuotaFailureRequestV1['normalizedFailure'];
        signal: AbortSignal;
    }>) => Promise<RequestAuthFailureOutcomeV1>;
    /** Explicit operation budget, when the containing operation supplies one. Otherwise cancellation owns the lifetime. */
    operationDeadlineMs?: number;
    /** OAuth rotation and provider evidence are bounded separately from ordinary lookup and quota operations. */
    authFailureOperationDeadlineMs?: number;
    nowMs?: () => number;
}>;

export type ConnectedAccountRequestAuthService = Readonly<{
    /**
     * Validates an immutable purpose snapshot against current account/group truth.
     * It performs no bearer materialization, refresh, cache fill, or selection.
     */
    validateRequestAuth: (input: Readonly<{
        subject: ConnectedAccountRequestAuthSubject;
        purpose: QualifiedConnectedAccountPurposeV1;
        signal?: AbortSignal;
    }>) => Promise<void>;
    lookupRequestAuth: (input: Readonly<{
        subject: ConnectedAccountRequestAuthSubject;
        purpose: QualifiedConnectedAccountPurposeV1;
        signal?: AbortSignal;
    }>) => Promise<RequestAuthHeadersV1>;
    refreshAfterAuthFailure: (input: Readonly<{
        subject: ConnectedAccountRequestAuthSubject;
        request: ConnectedAccountAuthFailureRequestV1;
        signal?: AbortSignal;
    }>) => Promise<RequestAuthFailureOutcomeV1>;
    reportQuotaFailure: (input: Readonly<{
        subject: ConnectedAccountRequestAuthSubject;
        request: ConnectedAccountQuotaFailureRequestV1;
        signal?: AbortSignal;
    }>) => Promise<RequestAuthFailureOutcomeV1>;
    reconcileCredentialLeases: (input: Readonly<{
        isCurrent: (
            account: QualifiedConnectedAccountRef,
            credentialRevision: string,
            legacyServiceKeyedCompatibility?: true,
        ) => boolean;
    }>) => void;
}>;

// A legacy Claude recovery may perform two sequential provider calls, each with the
// canonical 120-second ceiling, plus bounded account projection work. The generated
// client owns a slightly larger 310-second transport ceiling.
export const DEFAULT_REQUEST_AUTH_RECOVERY_DEADLINE_MS = 300_000;

class RequestAuthOperationAbortedError extends Error {
    constructor() {
        super('request_auth_operation_aborted');
        this.name = 'RequestAuthOperationAbortedError';
    }
}

type RequestAuthOperationLifetime = Readonly<{
    signal: AbortSignal;
    abort: () => void;
    dispose: () => void;
}>;

type RequestAuthSharedOperation<T> = {
    readonly signal: AbortSignal;
    readonly abort: () => void;
    readonly promise: Promise<T>;
    waiterCount: number;
    settled: boolean;
};

function createRequestAuthOperationLifetime(input: Readonly<{
    signal?: AbortSignal;
    deadlineMs?: number;
}>): RequestAuthOperationLifetime {
    const controller = new AbortController();
    const abort = (): void => {
        if (!controller.signal.aborted) {
            controller.abort(new RequestAuthOperationAbortedError());
        }
    };
    const parentSignal = input.signal;
    if (parentSignal?.aborted) {
        abort();
    } else {
        parentSignal?.addEventListener('abort', abort, { once: true });
    }
    const timeout = input.deadlineMs === undefined ? undefined : setTimeout(abort, input.deadlineMs);
    return Object.freeze({
        signal: controller.signal,
        abort,
        dispose: () => {
            if (timeout !== undefined) clearTimeout(timeout);
            parentSignal?.removeEventListener('abort', abort);
        },
    });
}

function isRequestAuthOperationAborted(error: unknown): boolean {
    return error instanceof RequestAuthOperationAbortedError;
}

function awaitRequestAuthOperation<T>(
    signal: AbortSignal,
    operation: MaybePromise<T>,
): Promise<T> {
    if (signal.aborted) {
        return Promise.reject(new RequestAuthOperationAbortedError());
    }
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        let onAbort: () => void = () => undefined;
        const finish = (callback: () => void): void => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            callback();
        };
        onAbort = (): void => {
            finish(() => reject(new RequestAuthOperationAbortedError()));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(operation).then(
            (value) => {
                if (signal.aborted) {
                    onAbort();
                    return;
                }
                finish(() => resolve(value));
            },
            (error: unknown) => finish(() => reject(error)),
        );
    });
}

function startRequestAuthOperation<T>(
    signal: AbortSignal,
    operation: () => MaybePromise<T>,
): Promise<T> {
    if (signal.aborted) {
        return Promise.reject(new RequestAuthOperationAbortedError());
    }
    try {
        return awaitRequestAuthOperation(signal, operation());
    } catch (error) {
        return Promise.reject(error);
    }
}

function serviceKey(service: Readonly<{ pluginId: string; localId: string }>): string {
    return JSON.stringify([service.pluginId, service.localId]);
}

function accountKey(account: QualifiedConnectedAccountRef): string {
    return JSON.stringify([
        account.service.pluginId,
        account.service.localId,
        account.accountId,
    ]);
}

function leaseKey(
    resolved: ConnectedAccountRequestAuthResolvedBinding,
    materialization: QualifiedConnectedAccountRequestAuthUseV1['materialization'],
    subject: ConnectedAccountRequestAuthSubject,
): string {
    return JSON.stringify([
        subject.parentSessionId ?? null,
        resolved.account.service.pluginId,
        resolved.account.service.localId,
        resolved.account.accountId,
        resolved.credentialRevision,
        resolved.legacyServiceKeyedCompatibility === true,
        materialization,
    ]);
}

/**
 * A completed bearer is account/revision scoped, but an in-flight cold fill runs under
 * exactly one subject's live authority: its materializer refuses once that subject
 * retires. Sharing the operation across subjects would let a retiring subject fail a
 * still-current one, so an in-flight fill is keyed by its owning subject as well.
 */
function fillKey(subjectId: string, cacheKey: string): string {
    return JSON.stringify([subjectId, cacheKey]);
}

/**
 * Bearer reuse is intentionally account/revision scoped. Recovery, however, can mutate
 * a group-bound binding, so its in-flight operation must remain scoped to the exact group
 * generation that observed the failure.
 */
function authFailureOperationKey(input: Readonly<{
    cacheKey: string;
    resolved: ConnectedAccountRequestAuthResolvedBinding;
    failingAccessTokenFingerprint: string | null | undefined;
    kind: 'failure' | 'replacement_freshness';
}>): string {
    return JSON.stringify([
        input.kind,
        input.cacheKey,
        input.resolved.group?.groupId ?? null,
        input.resolved.group?.generation ?? null,
        input.failingAccessTokenFingerprint ?? null,
    ]);
}

function materialFingerprint(headers: RequestAuthHeaderMapV1): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(Object.entries(headers).sort(([left], [right]) => left.localeCompare(right))), 'utf8').digest('hex')}`;
}

function sameResolvedBinding(
    left: ConnectedAccountRequestAuthResolvedBinding,
    right: ConnectedAccountRequestAuthResolvedBinding,
): boolean {
    if (!sameQualifiedConnectedAccountRef(left.account, right.account)) return false;
    if (left.credentialRevision !== right.credentialRevision) return false;
    if (
        left.legacyServiceKeyedCompatibility
        !== right.legacyServiceKeyedCompatibility
    ) return false;
    if (!left.group && !right.group) return true;
    return left.group?.groupId === right.group?.groupId
        && left.group?.generation === right.group?.generation;
}

function resolvedMatchesBinding(
    binding: QualifiedConnectedAccountPurposeBindingV1,
    resolved: ConnectedAccountRequestAuthResolvedBinding,
): boolean {
    if (binding.target.kind === 'account') {
        return sameQualifiedConnectedAccountRef(binding.target.account, resolved.account) && resolved.group === undefined;
    }
    return serviceKey(binding.target.service) === serviceKey(resolved.account.service)
        && resolved.group?.groupId === binding.target.groupId;
}

function contextMatchesResolved(
    context: ConnectedAccountAuthFailureRequestV1['credentialContext'],
    resolved: ConnectedAccountRequestAuthResolvedBinding,
    allowReplacedCredential = false,
): boolean {
    if (!sameQualifiedConnectedAccountRef(context.account, resolved.account)) return false;
    if (!allowReplacedCredential && context.credentialRevision !== resolved.credentialRevision) return false;
    if (!context.group && !resolved.group) return true;
    return context.group?.groupId === resolved.group?.groupId
        && context.group?.generation === resolved.group?.generation;
}

function isExpired(value: CachedHeadersMaterial, nowMs: number): boolean {
    return value.expiresAt !== undefined && value.expiresAt <= nowMs;
}

export function createConnectedAccountRequestAuthService(
    dependencies: ConnectedAccountRequestAuthServiceDependencies,
): ConnectedAccountRequestAuthService {
    const nowMs = dependencies.nowMs ?? (() => Date.now());
    const configuredOperationDeadlineMs = dependencies.operationDeadlineMs;
    const operationDeadlineMs = configuredOperationDeadlineMs !== undefined
        && Number.isSafeInteger(configuredOperationDeadlineMs)
        && configuredOperationDeadlineMs > 0
        ? configuredOperationDeadlineMs
        : undefined;
    const configuredAuthFailureOperationDeadlineMs =
        dependencies.authFailureOperationDeadlineMs;
    const authFailureOperationDeadlineMs =
        configuredAuthFailureOperationDeadlineMs !== undefined
        && Number.isSafeInteger(configuredAuthFailureOperationDeadlineMs)
        && configuredAuthFailureOperationDeadlineMs > 0
            ? configuredAuthFailureOperationDeadlineMs
            : DEFAULT_REQUEST_AUTH_RECOVERY_DEADLINE_MS;
    const leases = new Map<string, CachedHeadersMaterial>();
    const fills = new Map<string, RequestAuthSharedOperation<CachedHeadersMaterial>>();
    const authFailures = new Map<string, Readonly<{
        kind: 'failure' | 'replacement_freshness';
        cacheKey: string;
        failingAccessTokenFingerprint: string;
        operation: RequestAuthSharedOperation<RequestAuthFailureOutcomeV1>;
    }>>();
    let isCredentialLeaseCurrent = (
        _account: QualifiedConnectedAccountRef,
        _credentialRevision: string,
        _legacyServiceKeyedCompatibility?: true,
    ): boolean => true;

    const pruneExpiredLeases = (): void => {
        const now = nowMs();
        for (const [key, lease] of leases) {
            if (isExpired(lease, now)) leases.delete(key);
        }
    };

    const createSharedOperation = <T>(
        run: (signal: AbortSignal) => Promise<T>,
        onSettled: (operation: RequestAuthSharedOperation<T>) => void,
        deadlineMs = operationDeadlineMs,
    ): RequestAuthSharedOperation<T> => {
        const lifetime = createRequestAuthOperationLifetime({
            deadlineMs,
        });
        let operation!: RequestAuthSharedOperation<T>;
        const promise = startRequestAuthOperation(
            lifetime.signal,
            () => run(lifetime.signal),
        )
            .finally(() => {
                operation.settled = true;
                lifetime.dispose();
                onSettled(operation);
            });
        operation = {
            signal: lifetime.signal,
            abort: lifetime.abort,
            promise,
            waiterCount: 0,
            settled: false,
        };
        return operation;
    };

    const awaitSharedOperation = async <T>(
        operation: RequestAuthSharedOperation<T>,
        signal: AbortSignal,
        remove: () => void,
    ): Promise<T> => {
        operation.waiterCount += 1;
        try {
            return await awaitRequestAuthOperation(signal, operation.promise);
        } finally {
            operation.waiterCount -= 1;
            if (operation.waiterCount === 0 && !operation.settled) {
                operation.abort();
                remove();
            }
        }
    };

    const resolveAuthorizedBinding = async (
        subject: ConnectedAccountRequestAuthSubject,
        purposeLike: QualifiedConnectedAccountPurposeV1,
        signal: AbortSignal,
    ): Promise<Readonly<{
        binding: QualifiedConnectedAccountPurposeBindingV1;
        use: QualifiedConnectedAccountRequestAuthUseV1;
        resolved: ConnectedAccountRequestAuthResolvedBinding;
    }>> => {
        if (!subject.isCurrent()) {
            throw new ConnectedAccountRequestAuthError('request_auth_not_active');
        }
        if (subject.validateCurrent && !await startRequestAuthOperation(signal, () => subject.validateCurrent!(signal))) {
            throw new ConnectedAccountRequestAuthError('request_auth_not_active');
        }
        if (!subject.isCurrent()) throw new ConnectedAccountRequestAuthError('request_auth_not_active');
        const purpose = QualifiedConnectedAccountPurposeV1Schema.parse(purposeLike);
        const purposeUse = subject.resolvePurposeUse(purpose);
        if (
            !purposeUse
            || qualifiedPurposeKey(purposeUse.binding.purpose) !== qualifiedPurposeKey(purpose)
            || qualifiedPurposeKey(purposeUse.use.purpose) !== qualifiedPurposeKey(purpose)
        ) {
            throw new ConnectedAccountRequestAuthError('request_auth_purpose_forbidden');
        }
        const { binding, use } = purposeUse;
        const resolved = await startRequestAuthOperation(
            signal,
            () => dependencies.resolveCurrentBinding({
                subject,
                binding,
                signal,
            }),
        );
        if (!subject.isCurrent()) {
            throw new ConnectedAccountRequestAuthError('request_auth_not_active');
        }
        if (!resolved || !resolvedMatchesBinding(binding, resolved)) {
            throw new ConnectedAccountRequestAuthError('request_auth_binding_unavailable', {
                causeCode: resolved ? 'binding_mismatch' : 'binding_not_resolved',
            });
        }
        return { binding, use, resolved };
    };

    const getCachedOrFill = async (
        subject: ConnectedAccountRequestAuthSubject,
        binding: QualifiedConnectedAccountPurposeBindingV1,
        resolved: ConnectedAccountRequestAuthResolvedBinding,
        materialization: QualifiedConnectedAccountRequestAuthUseV1['materialization'],
        signal: AbortSignal,
    ): Promise<CachedHeadersMaterial> => {
        pruneExpiredLeases();
        const key = leaseKey(resolved, materialization, subject);
        const existing = leases.get(key);
        if (existing && !isExpired(existing, nowMs())) {
            leases.delete(key);
            leases.set(key, existing);
            return existing;
        }
        if (existing) leases.delete(key);

        const pendingKey = fillKey(subject.subjectId, key);
        const pending = fills.get(pendingKey);
        if (pending && !pending.signal.aborted) {
            return await awaitSharedOperation(pending, signal, () => {
                if (fills.get(pendingKey) === pending) fills.delete(pendingKey);
            });
        }
        if (pending && fills.get(pendingKey) === pending) fills.delete(pendingKey);

        const fill = createSharedOperation(async (ownerSignal) => {
            const material = await startRequestAuthOperation(
                ownerSignal,
                () => dependencies.materializeHeaders({
                    subject,
                    binding,
                    resolved,
                    materialization,
                    signal: ownerSignal,
                }),
            );
            const lease: RequestAuthHeadersV1 = {
                headers: material.headers,
                facts: material.facts,
                ...(material.expiresAt !== undefined ? { expiresAt: material.expiresAt } : {}),
                credentialContext: {
                    account: resolved.account,
                    ...(resolved.group ? { group: resolved.group } : {}),
                    credentialRevision: resolved.credentialRevision,
                },
            };
            const cached: CachedHeadersMaterial = {
                account: Object.freeze({
                    service: Object.freeze({ ...resolved.account.service }),
                    accountId: resolved.account.accountId,
                }),
                headers: Object.freeze({ ...lease.headers }),
                facts: Object.freeze({ ...lease.facts }),
                ...(lease.expiresAt !== undefined ? { expiresAt: lease.expiresAt } : {}),
                credentialRevision: resolved.credentialRevision,
                ...(resolved.legacyServiceKeyedCompatibility === true
                    ? { legacyServiceKeyedCompatibility: true as const }
                    : {}),
            };
            if (isExpired(cached, nowMs())) {
                throw new ConnectedAccountRequestAuthError('request_auth_credential_unavailable');
            }
            if (!isCredentialLeaseCurrent(
                cached.account,
                cached.credentialRevision,
                cached.legacyServiceKeyedCompatibility,
            )) {
                throw new ConnectedAccountRequestAuthError('request_auth_credential_unavailable');
            }
            leases.set(key, cached);
            return cached;
        }, (operation) => {
            if (fills.get(pendingKey) === operation) fills.delete(pendingKey);
        });
        fills.set(pendingKey, fill);
        return await awaitSharedOperation(fill, signal, () => {
            if (fills.get(pendingKey) === fill) fills.delete(pendingKey);
        });
    };

    const lookupRequestAuth: ConnectedAccountRequestAuthService['lookupRequestAuth'] = async (input) => {
        let phase: 'binding_before' | 'materialization' | 'binding_after' = 'binding_before';
        const lifetime = createRequestAuthOperationLifetime({
            signal: input.signal,
            deadlineMs: operationDeadlineMs,
        });
        try {
            while (true) {
                phase = 'binding_before';
                const before = await resolveAuthorizedBinding(
                    input.subject,
                    input.purpose,
                    lifetime.signal,
                );
                const beforeKey = leaseKey(before.resolved, before.use.materialization, input.subject);
                phase = 'materialization';
                const material = await getCachedOrFill(
                    input.subject,
                    before.binding,
                    before.resolved,
                    before.use.materialization,
                    lifetime.signal,
                );
                phase = 'binding_after';
                const after = await resolveAuthorizedBinding(
                    input.subject,
                    input.purpose,
                    lifetime.signal,
                );
                if (
                    leaseKey(after.resolved, after.use.materialization, input.subject) !== beforeKey
                    || !sameResolvedBinding(before.resolved, after.resolved)
                ) {
                    // Let containing-operation cancellation run even when the
                    // binding authority can resolve entirely from local state.
                    await startRequestAuthOperation(lifetime.signal, () => setImmediate());
                    continue;
                }
                if (isExpired(material, nowMs())) {
                    if (leases.get(beforeKey) === material) leases.delete(beforeKey);
                    await startRequestAuthOperation(lifetime.signal, () => setImmediate());
                    continue;
                }

                input.subject.registerRedaction(Object.freeze([
                    ...Object.entries(material.headers).flatMap(([name, value]) => readCredentialRedactionValues(
                        name.toLowerCase() === 'authorization' ? { authorizationValue: value } : { rawCredential: value },
                    )),
                    ...Object.values(material.facts).flatMap(value => typeof value === 'string'
                        ? readCredentialRedactionValues({ rawCredential: value }) : []),
                ]));
                return {
                    headers: { ...material.headers },
                    facts: { ...material.facts },
                    ...(material.expiresAt !== undefined ? { expiresAt: material.expiresAt } : {}),
                    credentialContext: {
                        account: after.resolved.account,
                        ...(after.resolved.group ? { group: after.resolved.group } : {}),
                        credentialRevision: after.resolved.credentialRevision,
                        failingAccessTokenFingerprint: materialFingerprint(material.headers),
                    },
                };
            }
        } catch (error) {
            logger.debug('[CONNECTED ACCOUNT] Request-auth lookup refused', {
                phase,
                errorCode: error instanceof ConnectedAccountRequestAuthError ? error.code
                    : isRequestAuthOperationAborted(error) ? 'request_auth_operation_aborted' : 'unexpected_error',
                ...(error instanceof ConnectedAccountRequestAuthError ? error.diagnostic : {}),
                ...(input.subject.parentSessionId ? { sessionId: input.subject.parentSessionId } : {}),
            });
            if (isRequestAuthOperationAborted(error)) {
                throw new ConnectedAccountRequestAuthError(
                    'request_auth_credential_unavailable',
                );
            }
            throw error;
        } finally {
            lifetime.dispose();
        }
    };

    const resolveCurrentFailureBinding = async (
        subject: ConnectedAccountRequestAuthSubject,
        context: ConnectedAccountAuthFailureRequestV1['credentialContext'],
        signal: AbortSignal,
        allowReplacedCredential = false,
    ): Promise<Readonly<{
        resolved: ConnectedAccountRequestAuthResolvedBinding;
        cacheKey: string;
        failureKey: string;
    }> | null> => {
        if (!subject.isCurrent()) return null;
        if (subject.validateCurrent && !await startRequestAuthOperation(signal, () => subject.validateCurrent!(signal))) return null;
        if (!subject.isCurrent()) return null;
        for (const purposeUse of subject.listPurposeUses()) {
            const currentUse = subject.resolvePurposeUse(purposeUse.binding.purpose);
            if (
                !currentUse
                || qualifiedPurposeKey(currentUse.binding.purpose)
                    !== qualifiedPurposeKey(purposeUse.binding.purpose)
                || qualifiedPurposeKey(currentUse.use.purpose)
                    !== qualifiedPurposeKey(purposeUse.use.purpose)
            ) {
                continue;
            }
            const resolved = await startRequestAuthOperation(
                signal,
                () => dependencies.resolveCurrentBinding({
                    subject,
                    binding: currentUse.binding,
                    signal,
                }),
            );
            if (!subject.isCurrent()) return null;
            if (!resolved || !resolvedMatchesBinding(currentUse.binding, resolved)) continue;
            if (!contextMatchesResolved(context, resolved, allowReplacedCredential)) continue;
            const cacheKey = leaseKey(resolved, currentUse.use.materialization, subject);
            return {
                resolved,
                cacheKey,
                failureKey: authFailureOperationKey({
                    cacheKey,
                    resolved,
                    kind: context.credentialRevision === resolved.credentialRevision ? 'failure' : 'replacement_freshness',
                    failingAccessTokenFingerprint:
                        context.failingAccessTokenFingerprint,
                }),
            };
        }
        return null;
    };

    const validateFailureLease = (
        current: Readonly<{
            resolved: ConnectedAccountRequestAuthResolvedBinding;
            cacheKey: string;
            failureKey: string;
        }>,
        context: ConnectedAccountAuthFailureRequestV1['credentialContext'],
    ): boolean => {
        const material = leases.get(current.cacheKey);
        if (!material || isExpired(material, nowMs())) {
            if (material) leases.delete(current.cacheKey);
            return false;
        }
        if (
            !context.failingAccessTokenFingerprint
            || context.failingAccessTokenFingerprint !== materialFingerprint(material.headers)
        ) {
            return false;
        }
        return true;
    };

    /**
     * A group generation intentionally shares its bearer cache with the other current
     * generations of the same account/revision. Once one exact generation starts recovery it
     * evicts that shared bearer, so a second current generation may no longer find the lease.
     * It may proceed only when the existing in-flight recovery proves the same cached bearer
     * was just evicted; a missing or different token fingerprint remains stale.
     */
    const hasActiveRecoveryForEvictedLease = (
        context: Readonly<{
            cacheKey: string;
            failureKey: string;
        }>,
        credentialContext: ConnectedAccountAuthFailureRequestV1['credentialContext'],
    ): boolean => {
        const fingerprint = credentialContext.failingAccessTokenFingerprint;
        if (!fingerprint) return false;
        for (const [failureKey, active] of authFailures) {
            if (
                active.kind === 'failure'
                && failureKey !== context.failureKey
                && active.cacheKey === context.cacheKey
                && active.failingAccessTokenFingerprint === fingerprint
                && !active.operation.signal.aborted
            ) {
                return true;
            }
        }
        return false;
    };

    const isFailureCallerCurrentAfterAwait = async (
        subject: ConnectedAccountRequestAuthSubject,
        credentialContext: ConnectedAccountAuthFailureRequestV1['credentialContext'],
        expected: Readonly<{
            cacheKey: string;
            failureKey: string;
        }>,
        allowOwnerEvictedLease: boolean,
        signal: AbortSignal,
    ): Promise<boolean> => {
        const current = await resolveCurrentFailureBinding(subject, credentialContext, signal);
        if (
            !current
            || current.cacheKey !== expected.cacheKey
            || current.failureKey !== expected.failureKey
        ) {
            return false;
        }
        if (!leases.has(current.cacheKey)) {
            return allowOwnerEvictedLease;
        }
        return validateFailureLease(current, credentialContext);
    };

    const refreshAfterAuthFailure: ConnectedAccountRequestAuthService['refreshAfterAuthFailure'] = async (input) => {
        const lifetime = createRequestAuthOperationLifetime({
            signal: input.signal,
            deadlineMs: authFailureOperationDeadlineMs,
        });
        try {
            const request = ConnectedAccountAuthFailureRequestV1Schema.parse(input.request);
            const context = await resolveCurrentFailureBinding(
                input.subject,
                request.credentialContext,
                lifetime.signal,
                request.normalizedFailure.class === 'authentication' && dependencies.refreshExpiredReplacement !== undefined,
            );
            if (!context) return { status: 'stale_context' };
            const isReplacement = context.resolved.credentialRevision !== request.credentialContext.credentialRevision;
            if (request.normalizedFailure.class === 'insufficient_scope') {
                if (!validateFailureLease(context, request.credentialContext)) return { status: 'stale_context' };
                if (!dependencies.reportScopeFailure) return { status: 'denied' };
                const failure = request.normalizedFailure;
                const outcome = await startRequestAuthOperation(lifetime.signal, () => dependencies.reportScopeFailure!({
                    subject: input.subject, resolved: context.resolved, failure, signal: lifetime.signal,
                }));
                return await isFailureCallerCurrentAfterAwait(input.subject, request.credentialContext, context, false, lifetime.signal)
                    ? RequestAuthFailureOutcomeV1Schema.parse(outcome) : { status: 'stale_context' };
            }
            const failure = request.normalizedFailure;
            const pending = authFailures.get(context.failureKey);
            if (pending && !pending.operation.signal.aborted) {
                const outcome = await awaitSharedOperation(
                    pending.operation,
                    lifetime.signal,
                    () => {
                        if (authFailures.get(context.failureKey) === pending) {
                            authFailures.delete(context.failureKey);
                        }
                    },
                );
                if (isReplacement) return { status: 'stale_context' };
                return await isFailureCallerCurrentAfterAwait(
                    input.subject,
                    request.credentialContext,
                    context,
                    true,
                    lifetime.signal,
                )
                    ? outcome
                    : { status: 'stale_context' };
            }
            if (pending && authFailures.get(context.failureKey) === pending) {
                authFailures.delete(context.failureKey);
            }
            if (
                !isReplacement && !validateFailureLease(context, request.credentialContext)
                && !hasActiveRecoveryForEvictedLease(
                    context,
                    request.credentialContext,
                )
            ) {
                return { status: 'stale_context' };
            }

            const operation = createSharedOperation(async (ownerSignal) => {
                if (isReplacement) {
                    await startRequestAuthOperation(ownerSignal, () => dependencies.refreshExpiredReplacement!({
                        subject: input.subject, resolved: context.resolved, signal: ownerSignal,
                    }));
                    return { status: 'stale_context' } as const;
                }
                leases.delete(context.cacheKey);
                const outcome = await startRequestAuthOperation(
                    ownerSignal,
                    () => dependencies.refreshAfterAuthFailure({
                        subject: input.subject,
                        resolved: context.resolved,
                        failure,
                        signal: ownerSignal,
                    }),
                );
                return RequestAuthFailureOutcomeV1Schema.parse(outcome);
            }, (settledOperation) => {
                const current = authFailures.get(context.failureKey);
                if (current?.operation === settledOperation) {
                    authFailures.delete(context.failureKey);
                }
            }, authFailureOperationDeadlineMs);
            const active = Object.freeze({
                kind: isReplacement ? 'replacement_freshness' as const : 'failure' as const,
                cacheKey: context.cacheKey,
                failingAccessTokenFingerprint:
                    request.credentialContext.failingAccessTokenFingerprint!,
                operation,
            });
            authFailures.set(context.failureKey, active);
            const outcome = await awaitSharedOperation(
                operation,
                lifetime.signal,
                () => {
                    if (authFailures.get(context.failureKey) === active) {
                        authFailures.delete(context.failureKey);
                    }
                },
            );
            if (isReplacement) return { status: 'stale_context' };
            return await isFailureCallerCurrentAfterAwait(
                input.subject,
                request.credentialContext,
                context,
                true,
                lifetime.signal,
            )
                ? outcome
                : { status: 'stale_context' };
        } catch (error) {
            if (isRequestAuthOperationAborted(error)) {
                return { status: 'denied' };
            }
            throw error;
        } finally {
            lifetime.dispose();
        }
    };

    const reportQuotaFailure: ConnectedAccountRequestAuthService['reportQuotaFailure'] = async (input) => {
        const lifetime = createRequestAuthOperationLifetime({
            signal: input.signal,
            deadlineMs: operationDeadlineMs,
        });
        try {
            const request = ConnectedAccountQuotaFailureRequestV1Schema.parse(input.request);
            const context = await resolveCurrentFailureBinding(
                input.subject,
                request.credentialContext,
                lifetime.signal,
            );
            if (!context || !validateFailureLease(context, request.credentialContext)) {
                return { status: 'stale_context' };
            }
            const outcome = await startRequestAuthOperation(
                lifetime.signal,
                () => dependencies.reportQuotaFailure({
                    subject: input.subject,
                    resolved: context.resolved,
                    failure: request.normalizedFailure,
                    signal: lifetime.signal,
                }),
            );
            const parsed = RequestAuthFailureOutcomeV1Schema.parse(outcome);
            return await isFailureCallerCurrentAfterAwait(
                input.subject,
                request.credentialContext,
                context,
                false,
                lifetime.signal,
            )
                ? parsed
                : { status: 'stale_context' };
        } catch (error) {
            if (isRequestAuthOperationAborted(error)) {
                return { status: 'denied' };
            }
            throw error;
        } finally {
            lifetime.dispose();
        }
    };

    const reconcileCredentialLeases:
        ConnectedAccountRequestAuthService['reconcileCredentialLeases'] = (input) => {
        isCredentialLeaseCurrent = input.isCurrent;
        pruneExpiredLeases();
        for (const [key, value] of leases) {
            if (!isCredentialLeaseCurrent(
                value.account,
                value.credentialRevision,
                value.legacyServiceKeyedCompatibility,
            )) {
                leases.delete(key);
            }
        }
    };

    return {
        async validateRequestAuth(input) {
            const lifetime = createRequestAuthOperationLifetime({
                signal: input.signal,
                deadlineMs: operationDeadlineMs,
            });
            try {
                await resolveAuthorizedBinding(input.subject, input.purpose, lifetime.signal);
            } catch (error) {
                if (isRequestAuthOperationAborted(error)) {
                    throw new ConnectedAccountRequestAuthError(
                        'request_auth_binding_unavailable',
                    );
                }
                throw error;
            } finally {
                lifetime.dispose();
            }
        },
        lookupRequestAuth,
        refreshAfterAuthFailure,
        reportQuotaFailure,
        reconcileCredentialLeases,
    };
}
