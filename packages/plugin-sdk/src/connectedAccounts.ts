export { ANTIGRAVITY_OAUTH_PROFILE } from '@happier-dev/protocol/agents/antigravity/oauth-profile';
/**
 * Connected Account authoring, binding, materialization, usage, and runtime
 * contracts. This module is a projection only: canonical Protocol-owned
 * request/runtime values keep their identity — including the V2 descriptor
 * family, which is declared once in Protocol and reached here through its one
 * narrow subpath — while SDK-only author-visible declarations stay at this
 * single package-local boundary.
 */

export { CLAUDE_SUBSCRIPTION_OAUTH_PROFILE } from '@happier-dev/protocol/agents/claude/oauth-profile';
export { CODEX_NATIVE_HOME, CODEX_CONNECTED_SERVICE_HOME_DIRECTORY_NAME } from '@happier-dev/protocol/agents/codex/native-home-policy';
export { CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1, CLAUDE_SUBSCRIPTION_SETUP_TOKEN_ENVIRONMENT_REQUEST_V1 } from '@happier-dev/protocol/agents/claude/connected-account-materialization';
export { OPENAI_CODEX_OAUTH_PROFILE } from '@happier-dev/protocol/agents/codex/oauth-profile';
import { buildConnectedServiceCredentialRecord as buildProtocolConnectedServiceCredentialRecord } from '@happier-dev/protocol/connect/build-connected-service-credential-record';
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
    ConnectedServiceCredentialRevisionV1,
} from '@happier-dev/protocol/connect/connected-service-schemas';
import type { ProviderAccountSubscriptionV1 } from '@happier-dev/protocol/connect/accountSubscription';
export type { ProviderAccountSubscriptionV1 } from '@happier-dev/protocol/connect/accountSubscription';
export type { ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol/connect/account-usage-primitives';
export type { ConnectedAccountCompletionObservation } from '@happier-dev/cli-common/connectedAccounts';
export { resolveConnectedServiceQuotaMeterLabel } from '@happier-dev/protocol/connect/connectedServiceQuotaMeterLabel';
export type {
    PluginConnectedAccountAuthenticationModeV2,
    PluginConnectedAccountAccessOnlyExportV1,
    PluginConnectedAccountAuthenticationV2,
    PluginConnectedAccountConfigurationFieldV2,
    PluginConnectedAccountConfigurationV2,
    PluginConnectedAccountDescriptorContributionV2,
} from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
export { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1, CONNECTED_ACCOUNT_ACCESS_ONLY_EXPORT_CONTRACT_V1 } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';

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
import type { AgentAccountUsageMeter } from './agentRuntime/accountUsage.js';
import type { Disposable } from './lifecycle.js';
import type { PluginInvocationContext } from './invocation.js';
import type { HttpService } from './services/io.js';
import type { ConnectedAccountAuthenticationModeRuntime as CommonAuthenticationModeRuntime, ConnectedAccountEstablishedReadContext, ConnectedAccountEstablishedRuntime } from '@happier-dev/cli-common/connectedAccounts';
import type { PluginConnectedAccountPortableAuthenticationContext } from './services/connectedAccounts.js';
import type { ConnectedAccountMaterialization } from './connected-accounts/materialization.js';
export type { ConnectedAccountMaterialization } from './connected-accounts/materialization.js';
import type { ConnectedAccountConnectionTestResult } from '@happier-dev/cli-common/connectedAccounts';
export type { ConnectedAccountConnectionTestResult } from '@happier-dev/cli-common/connectedAccounts';

export {
    addSafeEpochMilliseconds,
    normalizeNonNegativeSafeMilliseconds,
    parseCompactDurationMs,
    parseProviderTimestampMs,
    parseRetryAfterHeader,
    type ProviderResetTiming,
} from './cloud/quotaTiming.js';
export { parseProviderResetAt, type ProviderResetTextEvidenceParser } from './cloud/quotaReset.js';


export type ClaudeSubscriptionMaterializationContractV1 =
    typeof import('@happier-dev/protocol/agents/claude/connected-account-materialization').CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1;

export type ClaudeSubscriptionSetupTokenEnvironmentRequestV1 =
    typeof import('@happier-dev/protocol/agents/claude/connected-account-materialization').CLAUDE_SUBSCRIPTION_SETUP_TOKEN_ENVIRONMENT_REQUEST_V1;


export { ConnectedAccountPurposeDeclarationsV1Schema } from '@happier-dev/protocol/connect/connected-account-purposes';
export { ConnectedAccountAuthFailureRequestV1Schema, ConnectedAccountQuotaFailureRequestV1Schema, ConnectedAccountRequestAuthUsesV1Schema } from '@happier-dev/protocol/connect/connected-account-request-auth';
/** @realm daemon */
export { ConnectedServiceAuthGroupIdSchema, ConnectedServiceBindingsV1Schema, ConnectedServiceProfileIdSchema } from '@happier-dev/protocol/connect/connected-service-bindings';
/** @realm daemon */
export { QualifiedConnectedAccountGroupV4Schema, QualifiedConnectedAccountListResponseV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
export { QualifiedConnectedAccountRefJsonSchema, QualifiedConnectedAccountRefSchema } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
/** @realm daemon */
export { QualifiedConnectedAccountPurposeBindingV1Schema } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
export type {
    ConnectedAccountHttpHeadersRequest,
    ConnectedAccountMaterializationRequest,
    ConnectedAccountPurposeId,
    PluginConnectedAccountMaterializationKind,
    QualifiedConnectedAccountPurposeV1,
    ConnectedAccountPurposeDeclarationV1 as ConnectedAccountPurposeDeclaration,
    QualifiedConnectedAccountPurposeV1 as QualifiedConnectedAccountPurpose,
} from '@happier-dev/protocol/connect/connected-account-purposes';
export type {
    ConnectedAccountAuthFailureRequestV1,
    ConnectedAccountQuotaFailureRequestV1,
    RequestAuthHeadersV1,
    RequestAuthFactsV1,
    RequestAuthHeaderMapV1,
    RequestAuthCredentialContextV1,
    RequestAuthFailureOutcomeV1,
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
export { normalizeConnectedServiceLimitCategoryV1 } from '@happier-dev/protocol/connect/connected-service-limit-category';
export type {
    ConnectedServiceLimitCategoryV1,
} from '@happier-dev/protocol/connect/connected-service-limit-category';
export { ConnectedServiceCredentialRevisionV1Schema, ConnectedServiceCredentialRecordV1Schema, ConnectedServiceQuotaRecoveryCreditKindV1Schema, ConnectedServiceQuotaRecoveryCreditStatusV1Schema, ConnectedServiceQuotaRecoveryCreditV1Schema, ConnectedServiceQuotaRecoveryCreditsV1Schema, ConnectedServiceQuotaSnapshotV1Schema, ConnectedServiceUsageSourceV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';
export type {
    ConnectedServiceCredentialRecordV1,
    ConnectedServiceCredentialRevisionV1,
    ConnectedServiceQuotaRecoveryCreditKindV1,
    ConnectedServiceQuotaRecoveryCreditStatusV1,
    ConnectedServiceQuotaRecoveryCreditV1,
    ConnectedServiceQuotaRecoveryCreditDetailsV1,
    ConnectedServiceQuotaRecoveryCreditDetailsByIdV1,
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
export { ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1Schema, ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1Schema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
export type {
    ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1,
    ConnectedServiceQuotaRecoveryCreditConsumeReceiptV1,
} from '@happier-dev/protocol/sessions/work-state';
export { resolveConnectedServicesProviderStateSharingPolicyV1 } from '@happier-dev/protocol/account/settings/connected-services';
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
    PluginConnectedAccountHealthResult as ConnectedAccountHealthResult,
    PluginConnectedAccountRegistrationApi,
} from './services/connectedAccounts.js';

/** @realm any */
export type {
    PluginConnectedAccountAuthenticationContext as ConnectedAccountAuthenticationContext,
    PluginConnectedAccountPortableAuthenticationContext as ConnectedAccountPortableAuthenticationContext,
    PluginConnectedAccountAuthenticationModeRuntime as ConnectedAccountAuthenticationModeRuntime,
    PluginConnectedAccountCredentialStore as ConnectedAccountCredentialStore,
    PluginConnectedAccountManualCompletion as ConnectedAccountManualCompletion,
    PluginConnectedAccountRuntimeConfiguration as ConnectedAccountRuntimeConfiguration,
} from './services/connectedAccounts.js';

/** Established Account reads receive selected credentials and portable HTTP only. @realm any */
export type ConnectedAccountPortableReadContext = ConnectedAccountEstablishedReadContext
    & Pick<PluginInvocationContext, 'plugin' | 'contribution' | 'surface' | 'caller'>
    & Readonly<{ services: Readonly<{ http: HttpService }> }>;

/** Portable callbacks registered through the ordinary Account artifact. @realm any */
export type ConnectedAccountPortableRuntime = Readonly<{
    authentication: Readonly<{
        modes: Readonly<Record<string, CommonAuthenticationModeRuntime<PluginConnectedAccountPortableAuthenticationContext>>>;
    }>;
}> & Partial<Pick<ConnectedAccountEstablishedRuntime<ConnectedAccountPortableReadContext>, 'materialize' | 'testConnection'>>;

/** Authentication-only registrations remain valid portable runtimes. @realm any */
export type ConnectedAccountAuthenticationRuntime = ConnectedAccountPortableRuntime;

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

export type ConnectedAccountMaterializationOptions = Readonly<{
    signal?: AbortSignal;
    /** Use this declared service's machine login only when no explicit purpose binding exists. */
    nativeService?: PluginContributionRef;
    /** An observed account reference is only a currentness precondition. */
    expectedAccount?: ConnectedAccountRef;
}>;
export type ConnectedAccountBindingEvent = Readonly<{
    kind: 'resync';
    /** False for initial delivery or presentation-only changes; true when the selected authority changes. */
    authorityChanged: boolean;
}>;
export type ConnectedAccountBindingSummary = Readonly<{
    purpose: string;
    service: PluginContributionRef;
    /** Exact current account resolved from a selected account or group. */
    account: ConnectedAccountRef;
    target: Readonly<{
        kind: 'account' | 'group';
        displayName: string;
    }>;
    /** Nonsecret metadata included only when observation is requested. */
    credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
    configurationRevision?: string | null;
    /** Recorded selected Pool identity; observing never selects or rotates a member. */
    group?: Readonly<{ groupId: string; generation: number }>;
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
 * An authorized metadata listing. `complete` means no accounts were elided.
 * Elision from an explicit caller limit or an owning storage boundary reports
 * `truncated`.
 * There is no resumable cursor.
 */
export type ConnectedAccountMetadataList = Readonly<{
    status: 'complete' | 'truncated';
    accounts: readonly ConnectedAccountListedAccount[];
}>;
export type ConnectedAccountListRequest = Readonly<{
    purpose: string;
    /** Explicit caller demand; omission requests the full authorized inventory. */
    limit?: number;
}>;
export type ConnectedAccountListedMaterializationRequest = Readonly<{
    purpose: string;
    /** An exact account from the current metadata listing; never a selector. */
    account: ConnectedAccountRef;
    materialization: ConnectedAccountMaterializationRequest;
}>;
export type QualifiedConnectedAccountServiceRef = PluginContributionRef;

/** @realm daemon */
export const classifyProviderLimitEvidence: (
    value: unknown,
) => ProviderLimitEvidenceClassification = canonicalClassifyProviderLimitEvidence;

/** Runtime contract for one admitted connected-account implementation. */
export interface ConnectedAccountRuntime {
    /** Optional daemon-only native login; no saved Account is implied or imported. */
    materializeNative?(
        request: ConnectedAccountMaterializationRequest,
        context: Omit<PluginInvocationContext, 'operation'> & Readonly<{ service: PluginContributionRef }>,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<ConnectedAccountMaterialization>;
    /** Optional effectful capability; hosts never emulate it for older plugins. */
    readonly recoveryCredits?: Readonly<{
        read(
            context: PluginConnectedAccountReadContext,
            options?: Readonly<{ signal?: AbortSignal }>,
        ): Promise<Readonly<{
            observedAtMs: number;
            availableCount: number;
            recoveryCreditDetails?: import('@happier-dev/protocol/connect/connected-service-schemas').ConnectedServiceQuotaRecoveryCreditDetailsByIdV1;
            credits: readonly (Readonly<{
                providerCreditId: string;
                status: import('@happier-dev/protocol/connect/connected-service-schemas').ConnectedServiceQuotaRecoveryCreditV1['status'];
            }> & Partial<Pick<import('@happier-dev/protocol/connect/connected-service-schemas').ConnectedServiceQuotaRecoveryCreditV1,
                'kind' | 'title' | 'description' | 'providerResetType' | 'appliesToProviderLimitId' | 'grantedAtMs' | 'expiresAtMs' | 'redeemStartedAtMs' | 'redeemedAtMs'>>)[];
        }>>;
        consume(
            request: Readonly<{ idempotencyKey: string; providerCreditId?: string; providerLimitIds?: readonly string[] }>,
            context: PluginConnectedAccountReadContext,
            options?: Readonly<{ signal?: AbortSignal }>,
        ): Promise<Readonly<{
            status: 'consumed' | 'already_consumed' | 'not_available' | 'nothing_to_reset';
        }>>;
    }>;
    /** Optional metadata-only credential enrichment; never substitutes a token refresh. */
    enrichCredentialContext?(
        context: PluginConnectedAccountMutationContext,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<
        | PluginConnectedAccountHealthResult
        | Readonly<{ status: 'outcomeUnknown'; diagnostic: import('./diagnostics.js').PluginDiagnosticData }>
    >;
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
    /** Explicit no-usage provider check. Local credential status never substitutes this capability. */
    testConnection?(
        context: PluginConnectedAccountReadContext,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<ConnectedAccountConnectionTestResult>;
    status(
        context: PluginConnectedAccountReadContext,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<PluginConnectedAccountHealthResult>;
    quota?(
        context: PluginConnectedAccountReadContext,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<Readonly<{
        observedAtMs: number;
        /** Organization that supplied this observation; the account subject remains the provider user. */
        providerOrganizationId?: string;
        /** Provider-declared plan fact; absence never infers a plan from allowances. */
        planLabel?: string | null;
        subscription?: ProviderAccountSubscriptionV1;
        limits: readonly (Readonly<{
            id: string;
            /** Provider allowance family, distinct from the window identified by id. */
            providerLimitId?: string;
            used?: number | null;
            remaining?: number | null;
            resetsAtMs?: number | null;
        }> & Partial<Pick<AgentAccountUsageMeter, 'label' | 'limit' | 'remainingPct' | 'utilizationPct' | 'unit' | 'status' | 'isExhausted' | 'details' | 'confidence' | 'windowDurationMs' | 'modelId' | 'scope' | 'limitScope'>>)[];
    }>>;
    materialize(
        request: ConnectedAccountMaterializationRequest,
        context: PluginConnectedAccountReadContext,
        options?: Readonly<{
            signal?: AbortSignal;
            /** Host snapshot of declared files in this materialization's selected native home.
             * Absent outside native-home materialization; missing files have no entry.
             * Reconcile integration-owned fields without discarding retained private state. */
            existingFiles?: Readonly<Record<string, Uint8Array>>;
        }>,
    ): Promise<ConnectedAccountMaterialization>;
    readonly authentication: Readonly<{
        modes: Readonly<Record<string, PluginConnectedAccountAuthenticationModeRuntime>>;
    }>;
}

/** The host-owned selection and materialization service exposed to a plugin. */
export interface ConnectedAccountsService {
    /**
     * Session and Run services read the request's admitted selection for this
     * purpose. Plugins consume this binding rather than copying request selections.
     */
    getBinding(
        purpose: string,
        options?: Readonly<{ signal?: AbortSignal; observation?: true }>,
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
     * declared purpose. The host verifies target membership and currentness at
     * credential acquisition, then retains local cancellation and the selected
     * materializer's lifecycle; the selected binding is not changed.
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
