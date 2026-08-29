/**
 * Connected Account authoring, binding, materialization, usage, and runtime
 * contracts. This module is a projection only: canonical Protocol-owned
 * request/runtime values keep their identity — including the V2 descriptor
 * family, which is declared once in Protocol and reached here through its one
 * narrow subpath — while SDK-only author-visible declarations stay at this
 * single package-local boundary.
 */

import {
    CLAUDE_OAUTH_AUTHORIZE_URL,
    CLAUDE_OAUTH_CALLBACK_URL,
    CLAUDE_OAUTH_CLIENT_ID,
    CLAUDE_OAUTH_TOKEN_URL,
} from '@happier-dev/protocol/providers/claude/oauth-profile';
import {
    CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1 as canonicalClaudeSubscriptionMaterializationContractV1,
    CLAUDE_SUBSCRIPTION_SETUP_TOKEN_ENVIRONMENT_REQUEST_V1 as canonicalClaudeSubscriptionSetupTokenEnvironmentRequestV1,
} from '@happier-dev/protocol/connect/claude-subscription-materialization';
import {
    OPENAI_CODEX_AUTH_BASE_URL,
    OPENAI_CODEX_AUTHORIZE_URL,
    OPENAI_CODEX_CLIENT_ID,
    OPENAI_CODEX_DEVICE_REDIRECT_URI,
    OPENAI_CODEX_DEVICE_TOKEN_URL,
    OPENAI_CODEX_DEVICE_USER_CODE_URL,
    OPENAI_CODEX_DEVICE_VERIFICATION_URL,
    OPENAI_CODEX_SCOPE,
    OPENAI_CODEX_SCOPES,
    OPENAI_CODEX_TOKEN_URL,
} from '@happier-dev/protocol/providers/codex/oauth';
import {
    buildConnectedServiceCredentialRecord as buildProtocolConnectedServiceCredentialRecord,
} from '@happier-dev/protocol/connect/build-connected-service-credential-record';
import type {
    ConnectedAccountHttpHeadersRequest,
    ConnectedAccountMaterializationRequest,
    ConnectedAccountPurposeId,
    PluginConnectedAccountMaterializationKind,
} from '@happier-dev/protocol/connect/connected-account-purposes';
import type {
    ConnectedAccountServiceKey,
    ConnectedServiceId,
} from '@happier-dev/protocol/connect/connected-service-bindings';
import type {
    QualifiedConnectedAccountRef,
    QualifiedConnectedAccountRef as ConnectedAccountRef,
} from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type {
    ConnectedServiceCredentialRecordV1,
} from '@happier-dev/protocol/connect/connected-service-schemas';
export type {
    PluginConnectedAccountAuthenticationModeV2,
    PluginConnectedAccountAuthenticationV2,
    PluginConnectedAccountConfigurationFieldV2,
    PluginConnectedAccountConfigurationV2,
    PluginConnectedAccountDescriptorContributionV2,
} from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';

import {
    ConnectedServiceQuotaFetchError as QuotaFetchError,
    buildConnectedServiceOauthAuthEntry as canonicalBuildOauthAuthEntry,
    defineConnectedServiceAuthMaterialization as canonicalDefineAuthMaterialization,
    isCloudConnectAuthenticateResultV1 as canonicalIsAuthenticateResult,
    readConnectedServiceCredentialRecord as canonicalParseCredentialRecord,
    requireConnectedServiceOauthCredentialRecordWithExpiry as canonicalRequireOauthCredentialRecordWithExpiry,
    requireConnectedServiceTokenCredentialRecord as canonicalRequireTokenCredentialRecord,
} from './cloud/auth.js';
import type { CloudConnectAuthenticateResultV1 } from './cloud/auth.js';
import {
    PROVIDER_LIMIT_EVIDENCE_CLASSIFIER_PROJECTION_V1,
    classifyProviderLimitEvidence as canonicalClassifyProviderLimitEvidence,
} from './cloud/providerLimitEvidence.js';
import type {
    ProviderLimitEvidenceClassification,
} from './cloud/providerLimitEvidence.js';
import type {
    PluginConnectedAccountAuthenticationModeRuntime,
    PluginConnectedAccountHealthResult,
    PluginConnectedAccountMutationContext,
    PluginConnectedAccountReadContext,
} from './services/connectedAccounts.js';
import type { JsonValue, PluginContributionRef } from './identity.js';
import type { Disposable } from './lifecycle.js';

/** Public, nonsecret OAuth metadata shared by Claude Subscription authors. */
export const CLAUDE_SUBSCRIPTION_OAUTH_PROFILE: Readonly<{
    authorizeUrl: string;
    callbackUrl: string;
    clientId: string;
    tokenUrl: string;
}> = Object.freeze({
    authorizeUrl: CLAUDE_OAUTH_AUTHORIZE_URL,
    callbackUrl: CLAUDE_OAUTH_CALLBACK_URL,
    clientId: CLAUDE_OAUTH_CLIENT_ID,
    tokenUrl: CLAUDE_OAUTH_TOKEN_URL,
});

export type ClaudeSubscriptionMaterializationContractV1 = Readonly<{
    service: Readonly<{
        pluginId: string;
        localId: string;
    }>;
    setupToken: Readonly<{
        authenticationModeId: string;
        environmentKey: string;
    }>;
    oauth: Readonly<{
        authenticationModeId: string;
        requestAuthRequiredErrorCode: string;
    }>;
    unsupportedEnvironmentRequestErrorCode: string;
}>;

export type ClaudeSubscriptionSetupTokenEnvironmentRequestV1 = Readonly<{
    kind: 'environment';
    keys: readonly string[];
}>;

export const CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1:
ClaudeSubscriptionMaterializationContractV1 = canonicalClaudeSubscriptionMaterializationContractV1;
export const CLAUDE_SUBSCRIPTION_SETUP_TOKEN_ENVIRONMENT_REQUEST_V1:
ClaudeSubscriptionSetupTokenEnvironmentRequestV1 = canonicalClaudeSubscriptionSetupTokenEnvironmentRequestV1;

/** Public, nonsecret OAuth and device-flow metadata shared by Codex authors. */
export const OPENAI_CODEX_OAUTH_PROFILE: Readonly<{
    authBaseUrl: string;
    authorizeUrl: string;
    clientId: string;
    scope: string;
    scopes: readonly string[];
    tokenUrl: string;
    device: Readonly<{
        redirectUri: string;
        tokenUrl: string;
        userCodeUrl: string;
        verificationUrl: string;
    }>;
}> = Object.freeze({
    authBaseUrl: OPENAI_CODEX_AUTH_BASE_URL,
    authorizeUrl: OPENAI_CODEX_AUTHORIZE_URL,
    clientId: OPENAI_CODEX_CLIENT_ID,
    scope: OPENAI_CODEX_SCOPE,
    scopes: OPENAI_CODEX_SCOPES,
    tokenUrl: OPENAI_CODEX_TOKEN_URL,
    device: Object.freeze({
        redirectUri: OPENAI_CODEX_DEVICE_REDIRECT_URI,
        tokenUrl: OPENAI_CODEX_DEVICE_TOKEN_URL,
        userCodeUrl: OPENAI_CODEX_DEVICE_USER_CODE_URL,
        verificationUrl: OPENAI_CODEX_DEVICE_VERIFICATION_URL,
    }),
});

export {
    ConnectedAccountPurposeDeclarationsV1Schema,
} from '@happier-dev/protocol/connect/connected-account-purposes';
export {
    ConnectedAccountAuthFailureRequestV1Schema,
    ConnectedAccountQuotaFailureRequestV1Schema,
    ConnectedAccountRequestAuthUsesV1Schema,
} from '@happier-dev/protocol/connect/connected-account-request-auth';
/** @realm daemon */
export {
    ConnectedServiceAuthGroupIdSchema,
    ConnectedServiceBindingsV1Schema,
    ConnectedServiceProfileIdSchema,
} from '@happier-dev/protocol/connect/connected-service-bindings';
/** @realm daemon */
export {
    QualifiedConnectedAccountGroupV4Schema,
    QualifiedConnectedAccountListResponseV4Schema,
} from '@happier-dev/protocol/connect/qualified-connected-account-projections';
export {
    QualifiedConnectedAccountRefJsonSchema,
    QualifiedConnectedAccountRefSchema,
} from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
/** @realm daemon */
export {
    QualifiedConnectedAccountPurposeBindingV1Schema,
} from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
export type {
    ConnectedAccountHttpHeadersRequest,
    ConnectedAccountMaterializationRequest,
    ConnectedAccountPurposeId,
    PluginConnectedAccountMaterializationKind,
    ConnectedAccountPurposeDeclarationV1 as ConnectedAccountPurposeDeclaration,
    QualifiedConnectedAccountPurposeV1 as QualifiedConnectedAccountPurpose,
} from '@happier-dev/protocol/connect/connected-account-purposes';
export type {
    ConnectedAccountRequestAuthMaterializationV1 as ConnectedAccountRequestAuthMaterialization,
    ConnectedAccountRequestAuthUseV1 as ConnectedAccountRequestAuthUse,
} from '@happier-dev/protocol/connect/connected-account-request-auth';
export type { ProviderAccountUsageQuotaScopeV1 } from '@happier-dev/protocol/connect/account-usage-primitives';
export type {
    QualifiedConnectedAccountRef,
} from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
export type { QualifiedConnectedAccountRef as ConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
export type {
    ConnectedAccountServiceKey,
    ConnectedServiceAuthGroupId,
    ConnectedServiceBindingsV1 as ConnectedServiceBindings,
    ConnectedServiceId,
    ConnectedServiceProfileId,
} from '@happier-dev/protocol/connect/connected-service-bindings';
export {
    normalizeConnectedServiceLimitCategoryV1,
} from '@happier-dev/protocol/connect/connected-service-limit-category';
export type {
    ConnectedServiceLimitCategoryV1,
} from '@happier-dev/protocol/connect/connected-service-limit-category';
export {
    ConnectedServiceCredentialRevisionV1Schema,
    ConnectedServiceCredentialRecordV1Schema,
    ConnectedServiceQuotaRecoveryCreditKindV1Schema,
    ConnectedServiceQuotaRecoveryCreditStatusV1Schema,
    ConnectedServiceQuotaRecoveryCreditV1Schema,
    ConnectedServiceQuotaRecoveryCreditsV1Schema,
    ConnectedServiceQuotaSnapshotV1Schema,
    ConnectedServiceUsageSourceV1Schema,
} from '@happier-dev/protocol/connect/connected-service-schemas';
export type {
    ConnectedServiceCredentialRecordV1,
    ConnectedServiceCredentialRevisionV1,
    ConnectedServiceQuotaRecoveryCreditKindV1,
    ConnectedServiceQuotaRecoveryCreditStatusV1,
    ConnectedServiceQuotaRecoveryCreditV1,
    ConnectedServiceQuotaRecoveryCreditsV1,
    ConnectedServiceQuotaMeterV1,
    ConnectedServiceQuotaSnapshotV1,
    ConnectedServiceUsageSourceV1,
} from '@happier-dev/protocol/connect/connected-service-schemas';
export type {
    QualifiedConnectedAccountPurposeBindingTargetV1 as QualifiedConnectedAccountPurposeBindingTarget,
    QualifiedConnectedAccountPurposeBindingV1 as QualifiedConnectedAccountPurposeBinding,
    QualifiedConnectedAccountPurposeBindingsV1,
} from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
export {
    ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1Schema,
    ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1Schema,
} from '@happier-dev/protocol/sessions/work-state';
export type {
    ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1,
    ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1,
} from '@happier-dev/protocol/sessions/work-state';
export {
    resolveConnectedServicesProviderStateSharingPolicyV1,
} from '@happier-dev/protocol/account/settings/connected-services';
export type {
    ConnectedServicesProviderStateSharingPolicyV1,
} from '@happier-dev/protocol/account/settings/connected-services';
/** @realm daemon */
export {
    QuotaFetchError,
};
export type {
    CloudAuthCallbackCreateInputV1 as AuthCallbackCreateInput,
    CloudAuthCallbackCreateResultV1 as AuthCallbackCreateResult,
    CloudAuthCallbackModeV1 as AuthCallbackMode,
    CloudAuthCallbackResultV1 as AuthCallbackResult,
    CloudAuthCallbackServiceV1 as AuthCallbackService,
    CloudAuthCallbackSessionV1 as AuthCallbackSession,
    CloudAuthCallbackWaitInputV1 as AuthCallbackWaitInput,
    CloudAuthCredentialWriteInputV1 as AuthCredentialWriteInput,
    CloudAuthCredentialWriteResultV1 as AuthCredentialWriteResult,
    CloudAuthDiagnosticV1 as AuthDiagnostic,
    CloudAuthFailureCodeV1 as AuthFailureCode,
    CloudAuthLoopbackInputV1 as AuthLoopbackInput,
    CloudAuthLoopbackResultV1 as AuthLoopbackResult,
    CloudAuthOpenBrowserResultV1 as AuthOpenBrowserResult,
    CloudAuthPkceChallengeV1 as AuthPkceChallenge,
    CloudAuthPromptTextInputV1 as AuthPromptTextInput,
    CloudAuthPromptTextResultV1 as AuthPromptTextResult,
    CloudConnectAuthenticateOptionsV1 as AuthenticateOptions,
    CloudConnectAuthenticateResultV1 as AuthenticateResult,
    CloudCustomAuthenticatorContextV1 as AuthenticatorContext,
    CloudCustomAuthenticatorV1 as Authenticator,
    ConnectedServiceQuotaFetchErrorCode as QuotaFetchErrorCode,
} from './cloud/auth.js';

/** @realm daemon */
export {
    PROVIDER_LIMIT_EVIDENCE_CLASSIFIER_PROJECTION_V1,
};
export type {
    ProviderLimitCategory,
    ProviderLimitEvidenceClassification,
    ProviderLimitEvidenceConfidence,
    ProviderLimitEvidenceContext,
    ProviderLimitEvidenceProvenance,
} from './cloud/providerLimitEvidence.js';

export {
    unsupportedAccountUsage,
} from './accountUsage.js';
export type {
    UnsupportedAccountUsage,
} from './accountUsage.js';

/** @realm daemon */
export {
    HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON_ENV,
    HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON_ENV,
} from './envConstants.js';

/** @realm daemon */
export type {
    PluginConnectedAccountAuthenticationContext as ConnectedAccountAuthenticationContext,
    PluginConnectedAccountAuthenticationModeRuntime as ConnectedAccountAuthenticationModeRuntime,
    PluginConnectedAccountCredentialStore as ConnectedAccountCredentialStore,
    PluginConnectedAccountHealthResult as ConnectedAccountHealthResult,
    PluginConnectedAccountManualCompletion as ConnectedAccountManualCompletion,
    PluginConnectedAccountRegistrationApi,
    PluginConnectedAccountRuntimeConfiguration as ConnectedAccountRuntimeConfiguration,
} from './services/connectedAccounts.js';

type ConnectedServiceCredentialRawMetadataV1 = Readonly<{
    claudeAiOauth?: Readonly<{
        subscriptionType?: string;
        rateLimitTier?: string;
    }>;
    'claude.ai_oauth'?: Readonly<{
        subscriptionType?: string;
        rateLimitTier?: string;
    }>;
}>;

/** A service/input-key binding accepted by the canonical auth materializer. */
export type AuthMaterializationBinding<
    TServiceId extends ConnectedServiceId = ConnectedServiceId,
    TInputKey extends string = string,
> = Readonly<{
    serviceId: TServiceId;
    inputKey: TInputKey;
}>;

/** The stable helper set returned by the canonical auth materializer. */
export type AuthMaterializationHelpers<
    TServiceId extends ConnectedServiceId,
    TInputKey extends string,
> = Readonly<{
    serviceIds: readonly TServiceId[];
    readConnectedServiceId(selection: unknown): TServiceId | null;
    createAuthMaterializationInput<TRecord>(
        serviceId: ConnectedServiceId,
        record: TRecord,
    ): Readonly<Record<string, TRecord>>;
}>;

export type TokenCredentialRecord = Extract<
    ConnectedServiceCredentialRecordV1,
    Readonly<{ kind: 'token' }>
>;
export type OauthCredentialRecord = Extract<
    ConnectedServiceCredentialRecordV1,
    Readonly<{ kind: 'oauth' }>
>;
export type OauthCredentialRecordWithExpiry = OauthCredentialRecord & Readonly<{
    expiresAt: number;
}>;
export type CredentialRequirementOptions = Readonly<{
    message?: string | ((record: ConnectedServiceCredentialRecordV1) => string);
}>;
export type OauthAuthEntry = Readonly<{
    type: 'oauth';
    refresh: string;
    access: string;
    expires: number;
    accountId?: string;
}>;

/** @realm daemon */
export const defineAuthMaterialization: <
    const TServiceId extends ConnectedServiceId,
    const TInputKey extends string,
>(
    bindings: readonly AuthMaterializationBinding<TServiceId, TInputKey>[],
) => AuthMaterializationHelpers<TServiceId, TInputKey> = canonicalDefineAuthMaterialization;
/** @realm daemon */
export const parseCredentialRecord: (
    value: unknown,
) => ConnectedServiceCredentialRecordV1 | null = canonicalParseCredentialRecord;
/** @realm daemon */
export const requireTokenCredentialRecord: (
    record: ConnectedServiceCredentialRecordV1,
    options?: CredentialRequirementOptions,
) => TokenCredentialRecord = canonicalRequireTokenCredentialRecord;
/** @realm daemon */
export const requireOauthCredentialRecordWithExpiry: (
    record: ConnectedServiceCredentialRecordV1,
    options?: CredentialRequirementOptions,
) => OauthCredentialRecordWithExpiry = canonicalRequireOauthCredentialRecordWithExpiry;
/** @realm daemon */
export const buildOauthAuthEntry: (
    record: OauthCredentialRecordWithExpiry,
) => OauthAuthEntry = canonicalBuildOauthAuthEntry;
/** @realm daemon */
export const isAuthenticateResult: (
    value: unknown,
) => value is CloudConnectAuthenticateResultV1 = canonicalIsAuthenticateResult;

export type ConnectedAccountMaterialization =
    | Readonly<{
        kind: 'httpHeaders';
        headers: Readonly<Record<string, string>>;
    }>
    | Readonly<{
        kind: 'environment';
        env: Readonly<Record<string, string>>;
    }>
    | Readonly<{
        kind: 'files';
        files: Readonly<Record<string, Uint8Array>>;
    }>;
export type ConnectedAccountMaterializationOptions = Readonly<{
    signal?: AbortSignal;
    /** An observed account reference is only a currentness precondition. */
    expectedAccount?: ConnectedAccountRef;
}>;
export type ConnectedAccountBindingEvent = Readonly<{ kind: 'resync' }>;
export type ConnectedAccountBindingSummary = Readonly<{
    purpose: string;
    service: PluginContributionRef;
    /** Exact current account resolved from a selected account or group. */
    account: ConnectedAccountRef;
    target: Readonly<{
        kind: 'account' | 'group';
        displayName: string;
    }>;
}>;
/** Host-owned connection state of one listed Connected Account. */
export type ConnectedAccountListedState =
    | 'connected'
    | 'expired'
    | 'reconnectRequired'
    | 'unavailable';
/** Non-secret metadata for one account authorized for a declared purpose. */
export type ConnectedAccountListedAccount = Readonly<{
    account: ConnectedAccountRef;
    displayName: string;
    state: ConnectedAccountListedState;
    /**
     * Every host-normalized, credential-free configured origin owned by this
     * Connected Account. Empty is valid for fixed-origin and non-HTTP
     * materializations; the host never selects a preferred origin.
     */
    connectedAccountOrigins: readonly string[];
    /**
     * Every host-normalized, credential-free configured service base owned by
     * this Connected Account — the origin plus the path segment a deployment
     * lives beneath, such as an Azure DevOps organization or collection or a
     * path-prefixed self-hosted install. A source routes by these; HostAccess
     * still governs by `connectedAccountOrigins`, and every base begins with
     * one of them. Empty exactly when `connectedAccountOrigins` is empty; the
     * host never selects a preferred base.
     */
    connectedAccountBases: readonly string[];
}>;
/**
 * A bounded metadata listing. `complete` is the only complete result: any
 * elision — the clamped request limit or a storage cap — reports `truncated`.
 * There is no resumable cursor.
 */
export type ConnectedAccountMetadataList = Readonly<{
    status: 'complete' | 'truncated';
    accounts: readonly ConnectedAccountListedAccount[];
}>;
export type ConnectedAccountListRequest = Readonly<{
    purpose: string;
    /** Host-clamped upper bound on returned accounts. */
    limit?: number;
}>;
export type ConnectedAccountListedMaterializationRequest = Readonly<{
    purpose: string;
    /** An exact account from the current bounded listing; never a selector. */
    account: ConnectedAccountRef;
    materialization: ConnectedAccountMaterializationRequest;
}>;
export type QualifiedConnectedAccountServiceRef = PluginContributionRef;

/** @realm daemon */
export const classifyProviderLimitEvidence: (
    value: unknown,
    context?: Readonly<{
        kind: 'piTerminalProviderError';
        producerVersion: string;
        provider: string;
    }>,
) => ProviderLimitEvidenceClassification = canonicalClassifyProviderLimitEvidence;

/** Runtime contract for one admitted connected-account implementation. */
export interface ConnectedAccountRuntime {
    refresh(
        context: PluginConnectedAccountMutationContext,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<
        | PluginConnectedAccountHealthResult
        | Readonly<{ status: 'outcomeUnknown'; diagnostic: import('./diagnostics.js').PluginDiagnosticData }>
    >;
    revoke(
        context: PluginConnectedAccountReadContext,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<
        | Readonly<{
            status: 'remoteRevoked' | 'remoteUnsupported';
            diagnostic?: import('./diagnostics.js').PluginDiagnosticData;
        }>
        | Readonly<{ status: 'outcomeUnknown'; diagnostic: import('./diagnostics.js').PluginDiagnosticData }>
    >;
    status(
        context: PluginConnectedAccountReadContext,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<PluginConnectedAccountHealthResult>;
    quota?(
        context: PluginConnectedAccountReadContext,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<Readonly<{
        observedAtMs: number;
        limits: readonly Readonly<{
            id: string;
            used?: number;
            remaining?: number;
            resetsAtMs?: number;
        }> [];
    }>>;
    materialize(
        request: ConnectedAccountMaterializationRequest,
        context: PluginConnectedAccountReadContext,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<ConnectedAccountMaterialization>;
    readonly authentication: Readonly<{
        modes: Readonly<Record<string, PluginConnectedAccountAuthenticationModeRuntime>>;
    }>;
}

/** The host-owned selection and materialization service exposed to a plugin. */
export interface ConnectedAccountsService {
    getBinding(
        purpose: string,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<ConnectedAccountBindingSummary | null>;
    requestSelection(
        request: Readonly<{ purpose: string; reason: string }>,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<ConnectedAccountBindingSummary>;
    materialize(
        purpose: string,
        request: ConnectedAccountMaterializationRequest,
        options?: ConnectedAccountMaterializationOptions,
    ): Promise<ConnectedAccountMaterialization>;
    /**
     * Lists non-secret metadata for the exact current target of the declared
     * purpose: one account for a direct target, or the current enabled members
     * of a group target. It exposes no credential, configuration, capability
     * bag, group catalogue, caller-selected service, cursor, or unrelated
     * account, and it never mutates the selected binding.
     */
    listAccounts(
        request: ConnectedAccountListRequest,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<ConnectedAccountMetadataList>;
    /**
     * Materializes one account admitted by the exact current target of the
     * declared purpose. The host re-verifies target membership and currentness
     * before and after materialization; the selected binding is not changed.
     */
    materializeListedAccount(
        request: ConnectedAccountListedMaterializationRequest,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<ConnectedAccountMaterialization>;
    watch(
        purpose: string,
        listener: (event: ConnectedAccountBindingEvent) => void,
    ): Disposable;
}

/** @realm daemon */
export const buildConnectedServiceCredentialRecord: (
    params:
        | Readonly<{
            now: number;
            serviceId: ConnectedServiceId;
            profileId: string;
            kind: 'oauth';
            expiresAt?: number | null;
            oauth: Readonly<{
                accessToken: string;
                refreshToken: string;
                idToken: string | null;
                scope: string | null;
                tokenType: string | null;
                providerAccountId: string | null;
                providerEmail: string | null;
                raw?: ConnectedServiceCredentialRawMetadataV1 | null;
            }>;
        }>
        | Readonly<{
            now: number;
            serviceId: ConnectedServiceId;
            profileId: string;
            kind: 'token';
            token: Readonly<{
                token: string;
                providerAccountId: string | null;
                providerEmail: string | null;
            }>;
        }>,
) => ConnectedServiceCredentialRecordV1 = buildProtocolConnectedServiceCredentialRecord;
