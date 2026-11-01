import type { QualifiedConnectedAccountRef as ConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { PluginContributionRef } from '../plugins/registration/contracts.js';
import type { PluginDiagnosticData } from '../plugins/errors.js';
import type { SharedSavedSecretReferenceSelectionV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

export type ConnectedAccountRuntimeConfigurationTarget =
    | Readonly<{
        kind: 'service';
        service: PluginContributionRef;
        modeId: string;
    }>
    | Readonly<{
        kind: 'account';
        account: ConnectedAccountRef;
        modeId: string;
    }>
    | Readonly<{
        kind: 'attempt';
        attemptId: string;
        service: PluginContributionRef;
        modeId: string;
    }>;
export type ConnectedAccountRuntimeConfiguration = Readonly<{
    target: ConnectedAccountRuntimeConfigurationTarget;
    revision: string;
    values: Readonly<Record<string, JsonValue>>;
    /**
     * Public OAuth client delivered by this Home operator for the exact service
     * and authentication mode. Null/absence means use the plugin's BYO/token
     * path. This metadata is neither a secret nor proof of granted rights.
     * Retain a selected client with the existing attempt before consent so later
     * Home configuration changes cannot alter exchange/refresh/revoke identity.
     */
    getPublicOAuthClient?(
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<Readonly<{ clientId: string; scopes: readonly string[] }> | null>;
    getSecret(
        fieldId: string,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<string | null>;
}>;
export interface ConnectedAccountCredentialStore {
    get(key: string, options?: { signal?: AbortSignal }): Promise<string | null>;
    set(key: string, value: string, options?: { signal?: AbortSignal }): Promise<void>;
    delete(key: string, options?: { signal?: AbortSignal }): Promise<void>;
}
export type ConnectedAccountAuthenticationAttempt =
    | Readonly<{ kind: 'connect'; attemptId: string }>
    | Readonly<{ kind: 'reconnect'; attemptId: string; account: ConnectedAccountRef }>;

export type ConnectedAccountAuthenticationContext = Readonly<{
    service: PluginContributionRef;
    attempt: ConnectedAccountAuthenticationAttempt;
    configuration: ConnectedAccountRuntimeConfiguration;
    attemptCredentials: ConnectedAccountCredentialStore;
}>;

export type ConnectedAccountStageAccountConfiguration = (input: Readonly<{
    values: Readonly<Record<string, JsonValue>>;
    secretValues?: Readonly<Record<string, string>>;
}>) => Promise<void>;

export type ConnectedAccountFailureRetryEvidence =
    | Readonly<{
        failureClass?: never;
        retryNotBeforeMs?: never;
    }>
    | Readonly<{
        /** Closed provider evidence; currently only an explicit rate limit. */
        failureClass: 'rateLimit';
        /** Absolute epoch milliseconds derived from provider response evidence. */
        retryNotBeforeMs?: number;
    }>;

/** Nonsecret provider identity bound to the credential; null marks an unknown fact. */
export type ConnectedAccountProviderIdentity = Readonly<{
    accountId?: string | null;
    email?: string | null;
    organizationId?: string | null;
}>;

export type ConnectedAccountAuthCompletionResult =
    | Readonly<{
        status: 'connected';
        /**
         * Immutable service-local account identity proposed by the plugin when it
         * has a truthful stable value. The host mints an opaque identity when this
         * is omitted on first connect; reconnect remains bound to the admitted
         * exact account.
         */
        accountId?: string;
        providerIdentity?: ConnectedAccountProviderIdentity;
        displayName: string;
        scopes: readonly string[];
    }>
    | (Readonly<{
        status: 'rejected';
        diagnostic: PluginDiagnosticData;
    }> & ConnectedAccountFailureRetryEvidence)
    | (Readonly<{
        status: 'unavailable';
        diagnostic: PluginDiagnosticData;
    }> & ConnectedAccountFailureRetryEvidence)
    | Readonly<{
        status: 'outcomeUnknown';
        diagnostic: PluginDiagnosticData;
    }>;
export type ConnectedAccountAuthFailure = Extract<
    ConnectedAccountAuthCompletionResult,
    Readonly<{ status: 'rejected' | 'unavailable' }>
>;
export type ConnectedAccountOutcomeUnknown = Extract<
    ConnectedAccountAuthCompletionResult,
    Readonly<{ status: 'outcomeUnknown' }>
>;
export type ConnectedAccountConnectedResult = Extract<
    ConnectedAccountAuthCompletionResult,
    Readonly<{ status: 'connected' }>
>;
export type ConnectedAccountOAuthBeginRequest = Readonly<{
    callbackUrl: string;
    state: string;
    pkce: Readonly<{ challenge: string; method: 'S256' }>;
}>;
export type ConnectedAccountOAuthCompletion = Readonly<{
    code: string;
    callbackUrl: string;
    state: string;
    pkceVerifier: string;
}>;
export type ConnectedAccountManualCompletion = Readonly<{
    fields: Readonly<Record<string, string>>;
}>;
/** Host input; plugins receive only the resolved manual fields through their existing ABI. */
export type ConnectedAccountManualInput = ConnectedAccountManualCompletion & Readonly<{
    selectedSecrets?: Readonly<Record<string, SharedSavedSecretReferenceSelectionV1>>;
}>;
export type ConnectedAccountOAuthBeginResult =
    | Readonly<{
        status: 'awaitingOAuthRedirect';
        authorizationUrl: string;
        expiresAtMs?: number;
        issuer?: string;
        issuerResponseParameterRequired?: boolean;
    }>
    | Exclude<ConnectedAccountAuthCompletionResult, Readonly<{ status: 'connected' }>>;
export type ConnectedAccountDeviceBeginResult =
    | Readonly<{
        status: 'awaitingDeviceAuthorization';
        verificationUri: string;
        verificationUriComplete?: string;
        userCode: string;
        expiresAtMs: number;
        pollIntervalMs: number;
    }>
    | Exclude<ConnectedAccountAuthCompletionResult, Readonly<{ status: 'connected' }>>;
export type ConnectedAccountDevicePollResult =
    | Readonly<{ status: 'pending'; retryAfterMs: number }>
    | ConnectedAccountAuthCompletionResult;
export type ConnectedAccountReconciliationResult =
    | Readonly<{ status: 'pending'; retryAfterMs: number }>
    | ConnectedAccountAuthCompletionResult;
export type ConnectedAccountPendingResult = Extract<
    ConnectedAccountDevicePollResult,
    Readonly<{ status: 'pending' }>
>;

/** Authentication callbacks share one contract while each host supplies its context. */
export type ConnectedAccountAuthenticationModeRuntime<Context> = (
    | Readonly<{
        kind: 'oauthAuthorizationCode';
        begin(input: ConnectedAccountOAuthBeginRequest, context: Context, options?: { signal?: AbortSignal }): Promise<ConnectedAccountOAuthBeginResult>;
        complete(input: ConnectedAccountOAuthCompletion, context: Context, options?: { signal?: AbortSignal }): Promise<ConnectedAccountAuthCompletionResult>;
        cancel(context: Context): Promise<void>;
    }>
    | Readonly<{
        kind: 'oauthDeviceCode';
        begin(context: Context, options?: { signal?: AbortSignal }): Promise<ConnectedAccountDeviceBeginResult>;
        poll(context: Context, options?: { signal?: AbortSignal }): Promise<ConnectedAccountDevicePollResult>;
        cancel(context: Context): Promise<void>;
    }>
    | Readonly<{
        kind: 'manual';
        complete(input: ConnectedAccountManualCompletion, context: Context, options?: { signal?: AbortSignal }): Promise<ConnectedAccountAuthCompletionResult>;
    }>
) & Readonly<{
    reconcile?(context: Context, options?: Readonly<{ signal?: AbortSignal }>): Promise<ConnectedAccountReconciliationResult>;
}>;
