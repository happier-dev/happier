import { createHash } from 'node:crypto';

import {
    ConnectedAccountAuthFailureRequestV1Schema,
    ConnectedAccountQuotaFailureRequestV1Schema,
    OAuthBearerLeaseV1Schema,
    QualifiedConnectedAccountPurposeV1Schema,
    RequestAuthFailureOutcomeV1Schema,
    qualifiedPurposeKey,
    type ConnectedAccountAuthFailureRequestV1,
    type ConnectedAccountQuotaFailureRequestV1,
    type OAuthBearerLeaseV1,
    type QualifiedConnectedAccountPurposeBindingV1,
    type QualifiedConnectedAccountPurposeV1,
    type QualifiedConnectedAccountRequestAuthUseV1,
    type QualifiedConnectedAccountRef,
    type RequestAuthFailureOutcomeV1,
    type RequestAuthRequiredHeadersV1,
} from '@happier-dev/protocol';

export type ConnectedAccountRequestAuthErrorCode =
    | 'request_auth_not_active'
    | 'request_auth_purpose_forbidden'
    | 'request_auth_binding_unavailable'
    | 'request_auth_credential_unavailable'
    | 'request_auth_currentness_unstable';

export class ConnectedAccountRequestAuthError extends Error {
    readonly code: ConnectedAccountRequestAuthErrorCode;

    constructor(code: ConnectedAccountRequestAuthErrorCode) {
        super(code);
        this.name = 'ConnectedAccountRequestAuthError';
        this.code = code;
    }
}

export type ConnectedAccountRequestAuthSubject = Readonly<{
    /** Diagnostic identity only. Authorization is the subject's exact live capability object. */
    subjectId: string;
    /**
     * Private issuance proof for the bounded service-keyed compatibility adapter. Only a
     * catalog-Agent foreground issuer may set this; absence fails closed to qualified ownership.
     */
    legacyServiceKeyedCompatibility?: true;
    isCurrent: () => boolean;
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

export type BearerMaterial = Readonly<{
    accessToken: string;
    requiredHeaders?: RequestAuthRequiredHeadersV1;
    expiresAt?: number;
}>;

type MaybePromise<T> = T | Promise<T>;

type CachedBearerMaterial = Readonly<{
    account: QualifiedConnectedAccountRef;
    accessToken: string;
    requiredHeaders?: Readonly<Record<string, string>>;
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
    materializeBearer: (
        input: Readonly<{
            subject: ConnectedAccountRequestAuthSubject;
            binding: QualifiedConnectedAccountPurposeBindingV1;
            resolved: ConnectedAccountRequestAuthResolvedBinding;
            materialization: QualifiedConnectedAccountRequestAuthUseV1['materialization'];
            signal: AbortSignal;
        }>,
    ) => Promise<BearerMaterial>;
    refreshAfterAuthFailure: (input: Readonly<{
        resolved: ConnectedAccountRequestAuthResolvedBinding;
        failure: ConnectedAccountAuthFailureRequestV1['normalizedFailure'];
        signal: AbortSignal;
    }>) => Promise<RequestAuthFailureOutcomeV1>;
    reportQuotaFailure: (input: Readonly<{
        resolved: ConnectedAccountRequestAuthResolvedBinding;
        failure: ConnectedAccountQuotaFailureRequestV1['normalizedFailure'];
        signal: AbortSignal;
    }>) => Promise<RequestAuthFailureOutcomeV1>;
    /** Internal owner deadline; it remains below the generated wrapper's 30 second transport wait. */
    operationDeadlineMs?: number;
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
    }>) => Promise<OAuthBearerLeaseV1>;
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

const MAX_CURRENTNESS_RETRIES = 8;
const MAX_CACHED_CREDENTIAL_LEASES = 64;
const DEFAULT_REQUEST_AUTH_OPERATION_DEADLINE_MS = 20_000;

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
    deadlineMs: number;
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
    const timeout = setTimeout(abort, input.deadlineMs);
    return Object.freeze({
        signal: controller.signal,
        abort,
        dispose: () => {
            clearTimeout(timeout);
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
): string {
    return JSON.stringify([
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
}>): string {
    return JSON.stringify([
        input.cacheKey,
        input.resolved.group?.groupId ?? null,
        input.resolved.group?.generation ?? null,
        input.failingAccessTokenFingerprint ?? null,
    ]);
}

function tokenFingerprint(accessToken: string): string {
    return `sha256:${createHash('sha256').update(accessToken, 'utf8').digest('hex')}`;
}

function sameAccount(left: QualifiedConnectedAccountRef, right: QualifiedConnectedAccountRef): boolean {
    return accountKey(left) === accountKey(right);
}

function sameResolvedBinding(
    left: ConnectedAccountRequestAuthResolvedBinding,
    right: ConnectedAccountRequestAuthResolvedBinding,
): boolean {
    if (!sameAccount(left.account, right.account)) return false;
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
        return sameAccount(binding.target.account, resolved.account) && resolved.group === undefined;
    }
    return serviceKey(binding.target.service) === serviceKey(resolved.account.service)
        && resolved.group?.groupId === binding.target.groupId;
}

function contextMatchesResolved(
    context: ConnectedAccountAuthFailureRequestV1['credentialContext'],
    resolved: ConnectedAccountRequestAuthResolvedBinding,
): boolean {
    if (!sameAccount(context.account, resolved.account)) return false;
    if (context.credentialRevision !== resolved.credentialRevision) return false;
    if (!context.group && !resolved.group) return true;
    return context.group?.groupId === resolved.group?.groupId
        && context.group?.generation === resolved.group?.generation;
}

function isExpired(value: CachedBearerMaterial, nowMs: number): boolean {
    return value.expiresAt !== undefined && value.expiresAt <= nowMs;
}

function cloneHeaders(
    headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
    return headers ? { ...headers } : undefined;
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
        : DEFAULT_REQUEST_AUTH_OPERATION_DEADLINE_MS;
    const leases = new Map<string, CachedBearerMaterial>();
    const fills = new Map<string, RequestAuthSharedOperation<CachedBearerMaterial>>();
    const authFailures = new Map<string, Readonly<{
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
    ): RequestAuthSharedOperation<T> => {
        const lifetime = createRequestAuthOperationLifetime({
            deadlineMs: operationDeadlineMs,
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
            throw new ConnectedAccountRequestAuthError('request_auth_binding_unavailable');
        }
        return { binding, use, resolved };
    };

    const getCachedOrFill = async (
        subject: ConnectedAccountRequestAuthSubject,
        binding: QualifiedConnectedAccountPurposeBindingV1,
        resolved: ConnectedAccountRequestAuthResolvedBinding,
        materialization: QualifiedConnectedAccountRequestAuthUseV1['materialization'],
        signal: AbortSignal,
    ): Promise<CachedBearerMaterial> => {
        pruneExpiredLeases();
        const key = leaseKey(resolved, materialization);
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
                () => dependencies.materializeBearer({
                    subject,
                    binding,
                    resolved,
                    materialization,
                    signal: ownerSignal,
                }),
            );
            const lease = OAuthBearerLeaseV1Schema.parse({
                accessToken: material.accessToken,
                ...(material.requiredHeaders ? { requiredHeaders: material.requiredHeaders } : {}),
                ...(material.expiresAt !== undefined ? { expiresAt: material.expiresAt } : {}),
                credentialContext: {
                    account: resolved.account,
                    ...(resolved.group ? { group: resolved.group } : {}),
                    credentialRevision: resolved.credentialRevision,
                },
            });
            const cached: CachedBearerMaterial = {
                account: Object.freeze({
                    service: Object.freeze({ ...resolved.account.service }),
                    accountId: resolved.account.accountId,
                }),
                accessToken: lease.accessToken,
                ...(lease.requiredHeaders ? { requiredHeaders: { ...lease.requiredHeaders } } : {}),
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
            while (leases.size > MAX_CACHED_CREDENTIAL_LEASES) {
                const oldestKey = leases.keys().next().value as string | undefined;
                if (oldestKey === undefined) break;
                leases.delete(oldestKey);
            }
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
        const lifetime = createRequestAuthOperationLifetime({
            signal: input.signal,
            deadlineMs: operationDeadlineMs,
        });
        try {
            for (let attempt = 0; attempt < MAX_CURRENTNESS_RETRIES; attempt += 1) {
                const before = await resolveAuthorizedBinding(
                    input.subject,
                    input.purpose,
                    lifetime.signal,
                );
                const beforeKey = leaseKey(before.resolved, before.use.materialization);
                const material = await getCachedOrFill(
                    input.subject,
                    before.binding,
                    before.resolved,
                    before.use.materialization,
                    lifetime.signal,
                );
                const after = await resolveAuthorizedBinding(
                    input.subject,
                    input.purpose,
                    lifetime.signal,
                );
                if (
                    leaseKey(after.resolved, after.use.materialization) !== beforeKey
                    || !sameResolvedBinding(before.resolved, after.resolved)
                ) continue;
                if (isExpired(material, nowMs())) {
                    if (leases.get(beforeKey) === material) leases.delete(beforeKey);
                    continue;
                }

                input.subject.registerRedaction(Object.freeze([
                    material.accessToken,
                    ...Object.values(material.requiredHeaders ?? {})
                        .filter((value) => value.length > 0),
                ]));
                return OAuthBearerLeaseV1Schema.parse({
                    accessToken: material.accessToken,
                    ...(material.requiredHeaders
                        ? { requiredHeaders: cloneHeaders(material.requiredHeaders) }
                        : {}),
                    ...(material.expiresAt !== undefined ? { expiresAt: material.expiresAt } : {}),
                    credentialContext: {
                        account: after.resolved.account,
                        ...(after.resolved.group ? { group: after.resolved.group } : {}),
                        credentialRevision: after.resolved.credentialRevision,
                        failingAccessTokenFingerprint: tokenFingerprint(material.accessToken),
                    },
                });
            }
            throw new ConnectedAccountRequestAuthError('request_auth_currentness_unstable');
        } catch (error) {
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
    ): Promise<Readonly<{
        resolved: ConnectedAccountRequestAuthResolvedBinding;
        cacheKey: string;
        failureKey: string;
    }> | null> => {
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
            if (!contextMatchesResolved(context, resolved)) continue;
            const cacheKey = leaseKey(resolved, currentUse.use.materialization);
            return {
                resolved,
                cacheKey,
                failureKey: authFailureOperationKey({
                    cacheKey,
                    resolved,
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
            || context.failingAccessTokenFingerprint !== tokenFingerprint(material.accessToken)
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
                failureKey !== context.failureKey
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
            deadlineMs: operationDeadlineMs,
        });
        try {
            const request = ConnectedAccountAuthFailureRequestV1Schema.parse(input.request);
            const context = await resolveCurrentFailureBinding(
                input.subject,
                request.credentialContext,
                lifetime.signal,
            );
            if (!context) return { status: 'stale_context' };
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
                !validateFailureLease(context, request.credentialContext)
                && !hasActiveRecoveryForEvictedLease(
                    context,
                    request.credentialContext,
                )
            ) {
                return { status: 'stale_context' };
            }

            const operation = createSharedOperation(async (ownerSignal) => {
                leases.delete(context.cacheKey);
                const outcome = await startRequestAuthOperation(
                    ownerSignal,
                    () => dependencies.refreshAfterAuthFailure({
                        resolved: context.resolved,
                        failure: request.normalizedFailure,
                        signal: ownerSignal,
                    }),
                );
                return RequestAuthFailureOutcomeV1Schema.parse(outcome);
            }, (settledOperation) => {
                const current = authFailures.get(context.failureKey);
                if (current?.operation === settledOperation) {
                    authFailures.delete(context.failureKey);
                }
            });
            const active = Object.freeze({
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
