import {
    ConnectedServiceCredentialRecordV1Schema,
    ConnectedServiceCredentialRevisionV1Schema,
    type ConnectedServiceCredentialRecordV1 as ProtocolConnectedServiceCredentialRecordV1,
    type ConnectedServiceCredentialRevisionV1,
    type ConnectedServiceId as ProtocolConnectedServiceId,
} from '@happier-dev/protocol';

import type { FetchRuntimeServiceV1 } from '../fetch.js';

export {
    PROVIDER_LIMIT_EVIDENCE_CLASSIFIER_PROJECTION_V1,
    classifyProviderLimitEvidence,
    type ProviderLimitEvidenceClassification,
    type ProviderLimitEvidenceConfidence,
    type ProviderLimitEvidenceContext,
    type ProviderLimitEvidenceProvenance,
    type ProviderLimitCategory,
} from './providerLimitEvidence.js';
export {
    ConnectedServiceCredentialRecordV1Schema,
    ConnectedServiceCredentialRevisionV1Schema,
};

export {
    ConnectedServiceAuthGroupIdSchema,
    ConnectedServiceBindingsV1Schema,
    ConnectedServiceProfileIdSchema,
    ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1Schema,
    ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1Schema,
    ConnectedServiceQuotaRecoveryCreditKindV1Schema,
    ConnectedServiceQuotaRecoveryCreditStatusV1Schema,
    ConnectedServiceQuotaRecoveryCreditV1Schema,
    ConnectedServiceQuotaRecoveryCreditsV1Schema,
    ConnectedServiceQuotaSnapshotV1Schema,
    buildConnectedServiceCredentialRecord,
    normalizeConnectedServiceLimitCategoryV1,
    resolveConnectedServicesProviderStateSharingPolicyV1,
} from '@happier-dev/protocol';
export {
    getProviderConnectedServicesAdapter,
    readSessionMetadataConnectedServiceBindings,
} from '@happier-dev/agents';
export type {
    AccountSettings,
    ConnectedServiceAuthGroupId,
    ConnectedServiceCredentialRecordV1,
    ConnectedServiceCredentialRevisionV1,
    ConnectedServiceId,
    ConnectedServiceLimitCategoryV1,
    ConnectedServiceProfileId,
    ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1,
    ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1,
    ConnectedServiceQuotaRecoveryCreditKindV1,
    ConnectedServiceQuotaRecoveryCreditStatusV1,
    ConnectedServiceQuotaRecoveryCreditV1,
    ConnectedServiceQuotaRecoveryCreditsV1,
    ConnectedServiceQuotaMeterV1,
    ConnectedServiceQuotaSnapshotV1,
    ConnectedServicesProviderStateSharingPolicyV1,
} from '@happier-dev/protocol';
export type {
    ProviderConnectedServicesAdapter,
    SessionMetadataConnectedServiceBinding,
} from '@happier-dev/agents';

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

export type ConnectedServiceAuthMaterializationBindingV1<
    TServiceId extends ProtocolConnectedServiceId = ProtocolConnectedServiceId,
    TInputKey extends string = string,
> = Readonly<{
    serviceId: TServiceId;
    inputKey: TInputKey;
}>;

export type ConnectedServiceAuthMaterializationHelpersV1<
    TServiceId extends ProtocolConnectedServiceId,
    TInputKey extends string,
> = Readonly<{
    serviceIds: readonly TServiceId[];
    readConnectedServiceId(selection: unknown): TServiceId | null;
    createAuthMaterializationInput<TRecord>(
        serviceId: ProtocolConnectedServiceId,
        record: TRecord,
    ): Readonly<Record<string, TRecord>>;
}>;

export function defineConnectedServiceAuthMaterialization<
    const TServiceId extends ProtocolConnectedServiceId,
    const TInputKey extends string,
>(
    bindings: readonly ConnectedServiceAuthMaterializationBindingV1<TServiceId, TInputKey>[],
): ConnectedServiceAuthMaterializationHelpersV1<TServiceId, TInputKey> {
    const serviceIds = Object.freeze(bindings.map((binding) => binding.serviceId));
    const bindingsByServiceId = new Map<ProtocolConnectedServiceId, TInputKey>(
        bindings.map((binding) => [binding.serviceId, binding.inputKey]),
    );
    const supportedServiceIds = new Set<ProtocolConnectedServiceId>(serviceIds);

    function readConnectedServiceId(selection: unknown): TServiceId | null {
        if (typeof selection === 'string' && supportedServiceIds.has(selection as ProtocolConnectedServiceId)) {
            return selection as TServiceId;
        }
        const serviceId = readRecord(selection)?.serviceId;
        return typeof serviceId === 'string' && supportedServiceIds.has(serviceId as ProtocolConnectedServiceId)
            ? serviceId as TServiceId
            : null;
    }

    function createAuthMaterializationInput<TRecord>(
        serviceId: ProtocolConnectedServiceId,
        record: TRecord,
    ): Readonly<Record<string, TRecord>> {
        const inputKey = bindingsByServiceId.get(serviceId);
        if (!inputKey) return {};
        return { [inputKey]: record };
    }

    return {
        serviceIds,
        readConnectedServiceId,
        createAuthMaterializationInput,
    };
}

export type ConnectedServiceTokenCredentialRecordV1 = Extract<
    ProtocolConnectedServiceCredentialRecordV1,
    { kind: 'token' }
>;

export type ConnectedServiceOauthCredentialRecordV1 = Extract<
    ProtocolConnectedServiceCredentialRecordV1,
    { kind: 'oauth' }
>;

export type ConnectedServiceOauthCredentialRecordWithExpiryV1 =
    ConnectedServiceOauthCredentialRecordV1 & Readonly<{ expiresAt: number }>;

export type ConnectedServiceCredentialRequirementOptionsV1 = Readonly<{
    message?: string | ((record: ProtocolConnectedServiceCredentialRecordV1) => string);
}>;

export type ConnectedServiceOauthAuthEntryV1 = Readonly<{
    type: 'oauth';
    refresh: string;
    access: string;
    expires: number;
    accountId?: string;
}>;

export function readConnectedServiceCredentialRecord(
    value: unknown,
): ProtocolConnectedServiceCredentialRecordV1 | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return ConnectedServiceCredentialRecordV1Schema.safeParse(value).success
        ? value as ProtocolConnectedServiceCredentialRecordV1
        : null;
}

function resolveCredentialRequirementMessage(
    record: ProtocolConnectedServiceCredentialRecordV1,
    options: ConnectedServiceCredentialRequirementOptionsV1 | undefined,
    fallback: string,
): string {
    if (!options?.message) return fallback;
    return typeof options.message === 'function' ? options.message(record) : options.message;
}

export function requireConnectedServiceTokenCredentialRecord(
    record: ProtocolConnectedServiceCredentialRecordV1,
    options?: ConnectedServiceCredentialRequirementOptionsV1,
): ConnectedServiceTokenCredentialRecordV1 {
    if (record.kind !== 'token') {
        throw new Error(resolveCredentialRequirementMessage(
            record,
            options,
            `Expected token credential record for ${record.serviceId}/${record.profileId}`,
        ));
    }
    return record;
}

export function requireConnectedServiceOauthCredentialRecordWithExpiry(
    record: ProtocolConnectedServiceCredentialRecordV1,
    options?: ConnectedServiceCredentialRequirementOptionsV1,
): ConnectedServiceOauthCredentialRecordWithExpiryV1 {
    if (record.kind !== 'oauth') {
        throw new Error(resolveCredentialRequirementMessage(
            record,
            options,
            `Expected oauth credential record for ${record.serviceId}/${record.profileId}`,
        ));
    }
    if (typeof record.expiresAt !== 'number') {
        throw new Error(`Expected oauth credential record with expiresAt for ${record.serviceId}/${record.profileId}`);
    }
    return record as ConnectedServiceOauthCredentialRecordWithExpiryV1;
}

export function buildConnectedServiceOauthAuthEntry(
    record: ConnectedServiceOauthCredentialRecordWithExpiryV1,
): ConnectedServiceOauthAuthEntryV1 {
    return {
        type: 'oauth',
        refresh: record.oauth.refreshToken,
        access: record.oauth.accessToken,
        expires: record.expiresAt,
        ...(record.oauth.providerAccountId ? { accountId: record.oauth.providerAccountId } : {}),
    };
}

export type CloudAuthFailureCodeV1 =
    | 'unsupported'
    | 'cancelled'
    | 'failed'
    | 'invalid_result'
    | 'timeout'
    | 'provider_error';

export type CloudAuthDiagnosticV1 = Readonly<{
    code: string;
    message?: string;
}>;

export type CloudAuthOpenBrowserResultV1 =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; code: CloudAuthFailureCodeV1; diagnostics?: readonly CloudAuthDiagnosticV1[] }>;

export type CloudAuthPromptTextInputV1 = Readonly<{
    label: string;
    secret?: boolean;
}>;

export type CloudAuthPromptTextResultV1 =
    | Readonly<{ ok: true; value: string }>
    | Readonly<{ ok: false; code: CloudAuthFailureCodeV1; diagnostics?: readonly CloudAuthDiagnosticV1[] }>;

export type CloudAuthPkceChallengeV1 = Readonly<{
    verifier: string;
    challenge: string;
}>;

export type CloudAuthCallbackModeV1 = 'loopback' | 'paste';

export type CloudAuthCallbackCreateInputV1 = Readonly<{
    mode: CloudAuthCallbackModeV1;
    preferredPort?: number;
    callbackPath?: `/${string}`;
    timeoutMs?: number;
}>;

export type CloudAuthCallbackWaitInputV1 = Readonly<{
    promptLabel?: string;
}>;

export type CloudAuthCallbackResultV1 =
    | Readonly<{ ok: true; code: string; state: string; redirectUri: string }>
    | Readonly<{ ok: false; code: CloudAuthFailureCodeV1; diagnostics?: readonly CloudAuthDiagnosticV1[] }>;

export type CloudAuthCallbackSessionV1 = Readonly<{
    mode: CloudAuthCallbackModeV1;
    state: string;
    redirectUri: string;
    callbackUrl?: string;
    port?: number;
    wait(input?: CloudAuthCallbackWaitInputV1): Promise<CloudAuthCallbackResultV1>;
    close(): Promise<void>;
}>;

export type CloudAuthCallbackCreateResultV1 =
    | Readonly<{ ok: true; session: CloudAuthCallbackSessionV1 }>
    | Readonly<{ ok: false; code: CloudAuthFailureCodeV1; diagnostics?: readonly CloudAuthDiagnosticV1[] }>;

export type CloudAuthCallbackServiceV1 = Readonly<{
    create(input: CloudAuthCallbackCreateInputV1): Promise<CloudAuthCallbackCreateResultV1>;
}>;

export type CloudAuthLoopbackInputV1 = Readonly<{
    defaultPort?: number;
    callbackPath?: string;
}>;

export type CloudAuthLoopbackResultV1 = CloudAuthCallbackResultV1;

export type CloudAuthCredentialWriteInputV1 = Readonly<{
    serviceId?: string;
    profileId?: string;
    record?: unknown;
}>;

export type CloudAuthCredentialWriteResultV1 =
    | Readonly<{ ok: true; credentialRef: string }>
    | Readonly<{ ok: false; code: CloudAuthFailureCodeV1; diagnostics?: readonly CloudAuthDiagnosticV1[] }>;

export type CloudConnectAuthenticateOptionsV1 = Readonly<{
    paste?: boolean;
    device?: boolean;
    noOpen?: boolean;
    timeoutSeconds?: number;
    signal?: AbortSignal;
    serviceId?: string;
    profileId?: string;
}>;

export type CloudConnectAuthenticateResultV1 =
    | Readonly<{
        ok: true;
        accountRef?: string;
        credentialRef?: string;
        diagnostics?: readonly CloudAuthDiagnosticV1[];
    }>
    | Readonly<{
        ok: false;
        code: CloudAuthFailureCodeV1;
        retryAfterMs?: number;
        diagnostics?: readonly CloudAuthDiagnosticV1[];
    }>;

export function isCloudConnectAuthenticateResultV1(value: unknown): value is CloudConnectAuthenticateResultV1 {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Readonly<Record<string, unknown>>;
    if (record.ok === true) return true;
    return record.ok === false && typeof record.code === 'string';
}

export type ConnectedServiceQuotaFetchErrorCode =
    | 'auth_failure'
    | 'missing_auth'
    | 'network'
    | 'malformed'
    | 'provider_backoff';

export class ConnectedServiceQuotaFetchError extends Error {
    readonly status: number | null;
    readonly retryAfterMs: number | null;
    readonly resetAtMs: number | null;
    readonly quotaFetchErrorCode: ConnectedServiceQuotaFetchErrorCode;
    readonly providerCode: string | null;

    constructor(message: string, options: Readonly<{
        status?: number | null;
        retryAfterMs?: number | null;
        resetAtMs?: number | null;
        quotaFetchErrorCode: ConnectedServiceQuotaFetchErrorCode;
        providerCode?: string | null;
    }>) {
        super(message);
        this.name = 'ConnectedServiceQuotaFetchError';
        this.status = typeof options.status === 'number' && Number.isFinite(options.status)
            ? Math.trunc(options.status)
            : null;
        this.retryAfterMs = typeof options.retryAfterMs === 'number' && Number.isFinite(options.retryAfterMs)
            ? Math.max(0, Math.trunc(options.retryAfterMs))
            : null;
        this.resetAtMs = typeof options.resetAtMs === 'number' && Number.isFinite(options.resetAtMs)
            ? Math.max(0, Math.trunc(options.resetAtMs))
            : null;
        this.quotaFetchErrorCode = options.quotaFetchErrorCode;
        this.providerCode = typeof options.providerCode === 'string' && options.providerCode.trim()
            ? options.providerCode.trim()
            : null;
    }
}

export type CloudCustomAuthenticatorContextV1 = Readonly<{
    signal: AbortSignal;
    now(): number;
    fetch: FetchRuntimeServiceV1;
    browser: Readonly<{
        open(url: string): Promise<CloudAuthOpenBrowserResultV1>;
    }>;
    prompt: Readonly<{
        requestText(input: CloudAuthPromptTextInputV1): Promise<CloudAuthPromptTextResultV1>;
    }>;
    oauth: Readonly<{
        createPkceChallenge(): Promise<CloudAuthPkceChallengeV1>;
        callback: CloudAuthCallbackServiceV1;
        listenForCallback(input: CloudAuthLoopbackInputV1): Promise<CloudAuthLoopbackResultV1>;
    }>;
    credentials: Readonly<{
        write(input: CloudAuthCredentialWriteInputV1): Promise<CloudAuthCredentialWriteResultV1>;
    }>;
    diagnostics: Readonly<{
        info(input: CloudAuthDiagnosticV1): void;
        warn(input: CloudAuthDiagnosticV1): void;
    }>;
}>;

export type CloudCustomAuthenticatorV1 = (
    opts: CloudConnectAuthenticateOptionsV1,
    context: CloudCustomAuthenticatorContextV1,
) => Promise<CloudConnectAuthenticateResultV1 | unknown> | CloudConnectAuthenticateResultV1 | unknown;
