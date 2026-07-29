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
    group?: Readonly<{
        groupId: string;
        generation: number;
    }>;
}>;

type BearerMaterial = Readonly<{
    accessToken: string;
    requiredHeaders?: RequestAuthRequiredHeadersV1;
    expiresAt?: number;
}>;

type CachedBearerMaterial = Readonly<{
    account: QualifiedConnectedAccountRef;
    accessToken: string;
    requiredHeaders?: Readonly<Record<string, string>>;
    expiresAt?: number;
    credentialRevision: string;
}>;

export type ConnectedAccountRequestAuthServiceDependencies = Readonly<{
    resolveCurrentBinding: (
        binding: QualifiedConnectedAccountPurposeBindingV1,
    ) => ConnectedAccountRequestAuthResolvedBinding | null;
    materializeBearer: (
        input: Readonly<{
            resolved: ConnectedAccountRequestAuthResolvedBinding;
            materialization: QualifiedConnectedAccountRequestAuthUseV1['materialization'];
        }>,
    ) => Promise<BearerMaterial>;
    refreshAfterAuthFailure: (input: Readonly<{
        resolved: ConnectedAccountRequestAuthResolvedBinding;
        failure: ConnectedAccountAuthFailureRequestV1['normalizedFailure'];
    }>) => Promise<RequestAuthFailureOutcomeV1>;
    reportQuotaFailure: (input: Readonly<{
        resolved: ConnectedAccountRequestAuthResolvedBinding;
        failure: ConnectedAccountQuotaFailureRequestV1['normalizedFailure'];
    }>) => Promise<RequestAuthFailureOutcomeV1>;
    nowMs?: () => number;
}>;

export type ConnectedAccountRequestAuthService = Readonly<{
    /**
     * Synchronously validates an immutable purpose snapshot against current account/group truth.
     * It performs no bearer materialization, refresh, cache fill, or selection.
     */
    validateRequestAuth: (input: Readonly<{
        subject: ConnectedAccountRequestAuthSubject;
        purpose: QualifiedConnectedAccountPurposeV1;
    }>) => void;
    lookupRequestAuth: (input: Readonly<{
        subject: ConnectedAccountRequestAuthSubject;
        purpose: QualifiedConnectedAccountPurposeV1;
    }>) => Promise<OAuthBearerLeaseV1>;
    refreshAfterAuthFailure: (input: Readonly<{
        subject: ConnectedAccountRequestAuthSubject;
        request: ConnectedAccountAuthFailureRequestV1;
    }>) => Promise<RequestAuthFailureOutcomeV1>;
    reportQuotaFailure: (input: Readonly<{
        subject: ConnectedAccountRequestAuthSubject;
        request: ConnectedAccountQuotaFailureRequestV1;
    }>) => Promise<RequestAuthFailureOutcomeV1>;
    reconcileCredentialLeases: (input: Readonly<{
        isCurrent: (
            account: QualifiedConnectedAccountRef,
            credentialRevision: string,
        ) => boolean;
    }>) => void;
}>;

const MAX_CURRENTNESS_RETRIES = 8;
const MAX_CACHED_CREDENTIAL_LEASES = 64;

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
        materialization,
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
    const leases = new Map<string, CachedBearerMaterial>();
    const fills = new Map<string, Promise<CachedBearerMaterial>>();
    const authFailures = new Map<string, Promise<RequestAuthFailureOutcomeV1>>();
    let isCredentialLeaseCurrent = (
        _account: QualifiedConnectedAccountRef,
        _credentialRevision: string,
    ): boolean => true;

    const pruneExpiredLeases = (): void => {
        const now = nowMs();
        for (const [key, lease] of leases) {
            if (isExpired(lease, now)) leases.delete(key);
        }
    };

    const resolveAuthorizedBinding = (
        subject: ConnectedAccountRequestAuthSubject,
        purposeLike: QualifiedConnectedAccountPurposeV1,
    ): Readonly<{
        binding: QualifiedConnectedAccountPurposeBindingV1;
        use: QualifiedConnectedAccountRequestAuthUseV1;
        resolved: ConnectedAccountRequestAuthResolvedBinding;
    }> => {
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
        const resolved = dependencies.resolveCurrentBinding(binding);
        if (!resolved || !resolvedMatchesBinding(binding, resolved)) {
            throw new ConnectedAccountRequestAuthError('request_auth_binding_unavailable');
        }
        return { binding, use, resolved };
    };

    const getCachedOrFill = async (
        resolved: ConnectedAccountRequestAuthResolvedBinding,
        materialization: QualifiedConnectedAccountRequestAuthUseV1['materialization'],
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

        const pending = fills.get(key);
        if (pending) return await pending;

        const fill = (async (): Promise<CachedBearerMaterial> => {
            const material = await dependencies.materializeBearer({
                resolved,
                materialization,
            });
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
            };
            if (isExpired(cached, nowMs())) {
                throw new ConnectedAccountRequestAuthError('request_auth_credential_unavailable');
            }
            if (!isCredentialLeaseCurrent(cached.account, cached.credentialRevision)) {
                throw new ConnectedAccountRequestAuthError('request_auth_credential_unavailable');
            }
            leases.set(key, cached);
            while (leases.size > MAX_CACHED_CREDENTIAL_LEASES) {
                const oldestKey = leases.keys().next().value as string | undefined;
                if (oldestKey === undefined) break;
                leases.delete(oldestKey);
            }
            return cached;
        })();
        fills.set(key, fill);
        try {
            return await fill;
        } finally {
            if (fills.get(key) === fill) fills.delete(key);
        }
    };

    const lookupRequestAuth: ConnectedAccountRequestAuthService['lookupRequestAuth'] = async (input) => {
        for (let attempt = 0; attempt < MAX_CURRENTNESS_RETRIES; attempt += 1) {
            const before = resolveAuthorizedBinding(input.subject, input.purpose);
            const beforeKey = leaseKey(before.resolved, before.use.materialization);
            const material = await getCachedOrFill(
                before.resolved,
                before.use.materialization,
            );
            const after = resolveAuthorizedBinding(input.subject, input.purpose);
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
    };

    const resolveCurrentFailureBinding = (
        subject: ConnectedAccountRequestAuthSubject,
        context: ConnectedAccountAuthFailureRequestV1['credentialContext'],
    ): Readonly<{
        resolved: ConnectedAccountRequestAuthResolvedBinding;
        cacheKey: string;
        failureKey: string;
    }> | null => {
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
            const resolved = dependencies.resolveCurrentBinding(currentUse.binding);
            if (!resolved || !resolvedMatchesBinding(currentUse.binding, resolved)) continue;
            if (!contextMatchesResolved(context, resolved)) continue;
            const cacheKey = leaseKey(resolved, currentUse.use.materialization);
            return {
                resolved,
                cacheKey,
                failureKey: JSON.stringify([
                    cacheKey,
                    context.failingAccessTokenFingerprint ?? null,
                ]),
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

    const isFailureCallerCurrentAfterAwait = (
        subject: ConnectedAccountRequestAuthSubject,
        credentialContext: ConnectedAccountAuthFailureRequestV1['credentialContext'],
        expected: Readonly<{
            cacheKey: string;
            failureKey: string;
        }>,
        allowOwnerEvictedLease: boolean,
    ): boolean => {
        const current = resolveCurrentFailureBinding(subject, credentialContext);
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
        const request = ConnectedAccountAuthFailureRequestV1Schema.parse(input.request);
        const context = resolveCurrentFailureBinding(input.subject, request.credentialContext);
        if (!context) return { status: 'stale_context' };
        const pending = authFailures.get(context.failureKey);
        if (pending) {
            const outcome = await pending;
            return isFailureCallerCurrentAfterAwait(
                input.subject,
                request.credentialContext,
                context,
                true,
            )
                ? outcome
                : { status: 'stale_context' };
        }
        if (!validateFailureLease(context, request.credentialContext)) return { status: 'stale_context' };

        const operation = (async () => {
            leases.delete(context.cacheKey);
            const outcome = await dependencies.refreshAfterAuthFailure({
                resolved: context.resolved,
                failure: request.normalizedFailure,
            });
            return RequestAuthFailureOutcomeV1Schema.parse(outcome);
        })();
        authFailures.set(context.failureKey, operation);
        try {
            const outcome = await operation;
            return isFailureCallerCurrentAfterAwait(
                input.subject,
                request.credentialContext,
                context,
                true,
            )
                ? outcome
                : { status: 'stale_context' };
        } finally {
            if (authFailures.get(context.failureKey) === operation) {
                authFailures.delete(context.failureKey);
            }
        }
    };

    const reportQuotaFailure: ConnectedAccountRequestAuthService['reportQuotaFailure'] = async (input) => {
        const request = ConnectedAccountQuotaFailureRequestV1Schema.parse(input.request);
        const context = resolveCurrentFailureBinding(input.subject, request.credentialContext);
        if (!context || !validateFailureLease(context, request.credentialContext)) {
            return { status: 'stale_context' };
        }
        const outcome = await dependencies.reportQuotaFailure({
            resolved: context.resolved,
            failure: request.normalizedFailure,
        });
        const parsed = RequestAuthFailureOutcomeV1Schema.parse(outcome);
        return isFailureCallerCurrentAfterAwait(
            input.subject,
            request.credentialContext,
            context,
            false,
        )
            ? parsed
            : { status: 'stale_context' };
    };

    const reconcileCredentialLeases:
        ConnectedAccountRequestAuthService['reconcileCredentialLeases'] = (input) => {
        isCredentialLeaseCurrent = input.isCurrent;
        pruneExpiredLeases();
        for (const [key, value] of leases) {
            if (!isCredentialLeaseCurrent(value.account, value.credentialRevision)) {
                leases.delete(key);
            }
        }
    };

    return {
        validateRequestAuth(input) {
            resolveAuthorizedBinding(input.subject, input.purpose);
        },
        lookupRequestAuth,
        refreshAfterAuthFailure,
        reportQuotaFailure,
        reconcileCredentialLeases,
    };
}
