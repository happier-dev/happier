/** @moduleRealm daemon */
import type {
    ConnectedAccountListedState,
    ConnectedAccountRef,
    ConnectedAccountRuntime,
} from '../connectedAccounts.js';
import type { PluginDiagnosticData } from '../diagnostics.js';
import type { JsonValue, PluginContributionRef } from '../identity.js';
import type { PluginInvocationContext } from '../invocation.js';
export type {
    ConnectedAccountBindingEvent as PluginConnectedAccountBindingEvent,
    ConnectedAccountBindingSummary as PluginConnectedAccountBindingSummary,
    ConnectedAccountListedState as PluginConnectedAccountState,
    ConnectedAccountMaterialization as PluginConnectedAccountMaterialization,
    ConnectedAccountMaterializationRequest as PluginConnectedAccountMaterializationRequest,
    ConnectedAccountRef as PluginConnectedAccountRef,
    ConnectedAccountMaterializationOptions as PluginConnectedAccountMaterializationOptions,
    ConnectedAccountRuntime as PluginConnectedAccountRuntime,
    ConnectedAccountsService as PluginConnectedAccountsService,
    ConnectedAccountsService,
    PluginConnectedAccountMaterializationKind,
} from '../connectedAccounts.js';

export type PluginConnectedAccountRuntimeConfigurationTarget =
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
export type PluginConnectedAccountRuntimeConfiguration = Readonly<{
    target: PluginConnectedAccountRuntimeConfigurationTarget;
    revision: string;
    values: Readonly<Record<string, JsonValue>>;
    getSecret(
        fieldId: string,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<string | null>;
}>;
export interface PluginConnectedAccountCredentialStore {
    get(key: string, options?: { signal?: AbortSignal }): Promise<string | null>;
    set(key: string, value: string, options?: { signal?: AbortSignal }): Promise<void>;
    delete(key: string, options?: { signal?: AbortSignal }): Promise<void>;
}
export type PluginConnectedAccountAuthenticationAttempt =
    | Readonly<{ kind: 'connect'; attemptId: string }>
    | Readonly<{ kind: 'reconnect'; attemptId: string; account: ConnectedAccountRef }>;
export type PluginConnectedAccountAuthenticationContext = PluginInvocationContext & Readonly<{
    service: PluginContributionRef;
    attempt: PluginConnectedAccountAuthenticationAttempt;
    configuration: PluginConnectedAccountRuntimeConfiguration;
    attemptCredentials: PluginConnectedAccountCredentialStore;
}>;
export type PluginConnectedAccountAuthCompletionResult =
    | Readonly<{
        status: 'connected';
        /**
         * Immutable service-local account identity proposed by the plugin when it
         * has a truthful stable value. The host mints an opaque identity when this
         * is omitted on first connect; reconnect remains bound to the admitted
         * exact account.
         */
        accountId?: string;
        providerIdentity?: Readonly<{
            accountId?: string;
            email?: string;
        }>;
        displayName: string;
        scopes: readonly string[];
    }>
    | Readonly<{
        status: 'rejected' | 'unavailable';
        diagnostic: PluginDiagnosticData;
    }>
    | Readonly<{
        status: 'outcomeUnknown';
        diagnostic: PluginDiagnosticData;
    }>;
export type PluginConnectedAccountAuthFailure = Extract<
    PluginConnectedAccountAuthCompletionResult,
    Readonly<{ status: 'rejected' | 'unavailable' }>
>;
export type PluginConnectedAccountOutcomeUnknown = Extract<
    PluginConnectedAccountAuthCompletionResult,
    Readonly<{ status: 'outcomeUnknown' }>
>;
export type PluginConnectedAccountConnectedResult = Extract<
    PluginConnectedAccountAuthCompletionResult,
    Readonly<{ status: 'connected' }>
>;
export type PluginConnectedAccountOAuthBeginRequest = Readonly<{
    callbackUrl: string;
    state: string;
    pkce: Readonly<{ challenge: string; method: 'S256' }>;
}>;
export type PluginConnectedAccountOAuthCompletion = Readonly<{
    code: string;
    callbackUrl: string;
    state: string;
    pkceVerifier: string;
}>;
export type PluginConnectedAccountManualCompletion = Readonly<{
    fields: Readonly<Record<string, string>>;
}>;
export type PluginConnectedAccountOAuthBeginResult =
    | Readonly<{
        status: 'awaitingOAuthRedirect';
        authorizationUrl: string;
        expiresAtMs?: number;
    }>
    | Exclude<PluginConnectedAccountAuthCompletionResult, Readonly<{ status: 'connected' }>>;
export type PluginConnectedAccountDeviceBeginResult =
    | Readonly<{
        status: 'awaitingDeviceAuthorization';
        verificationUri: string;
        verificationUriComplete?: string;
        userCode: string;
        expiresAtMs: number;
        pollIntervalMs: number;
    }>
    | Exclude<PluginConnectedAccountAuthCompletionResult, Readonly<{ status: 'connected' }>>;
export type PluginConnectedAccountDevicePollResult =
    | Readonly<{ status: 'pending'; retryAfterMs: number }>
    | PluginConnectedAccountAuthCompletionResult;
export type PluginConnectedAccountReconciliationResult =
    | Readonly<{ status: 'pending'; retryAfterMs: number }>
    | PluginConnectedAccountAuthCompletionResult;
export type PluginConnectedAccountPendingResult = Extract<
    PluginConnectedAccountDevicePollResult,
    Readonly<{ status: 'pending' }>
>;
export type PluginConnectedAccountAuthenticationModeRuntime =
    (
        | Readonly<{
            kind: 'oauthAuthorizationCode';
            begin(input: PluginConnectedAccountOAuthBeginRequest, context: PluginConnectedAccountAuthenticationContext, options?: { signal?: AbortSignal }): Promise<PluginConnectedAccountOAuthBeginResult>;
            complete(input: PluginConnectedAccountOAuthCompletion, context: PluginConnectedAccountAuthenticationContext, options?: { signal?: AbortSignal }): Promise<PluginConnectedAccountAuthCompletionResult>;
            cancel(context: PluginConnectedAccountAuthenticationContext): Promise<void>;
        }>
        | Readonly<{
            kind: 'oauthDeviceCode';
            begin(context: PluginConnectedAccountAuthenticationContext, options?: { signal?: AbortSignal }): Promise<PluginConnectedAccountDeviceBeginResult>;
            poll(context: PluginConnectedAccountAuthenticationContext, options?: { signal?: AbortSignal }): Promise<PluginConnectedAccountDevicePollResult>;
            cancel(context: PluginConnectedAccountAuthenticationContext): Promise<void>;
        }>
        | Readonly<{
            kind: 'manual';
            complete(input: PluginConnectedAccountManualCompletion, context: PluginConnectedAccountAuthenticationContext, options?: { signal?: AbortSignal }): Promise<PluginConnectedAccountAuthCompletionResult>;
        }>
    ) & Readonly<{
        reconcile?(
            context: PluginConnectedAccountAuthenticationContext,
            options?: Readonly<{ signal?: AbortSignal }>,
        ): Promise<PluginConnectedAccountReconciliationResult>;
    }>;
export type PluginConnectedAccountHealthResult =
    | Readonly<{ status: ConnectedAccountListedState; displayName?: string; scopes?: readonly string[]; diagnostic?: PluginDiagnosticData }>
    | Readonly<{ status: 'rejected'; diagnostic: PluginDiagnosticData }>;
export type PluginConnectedAccountReadContext = PluginInvocationContext & Readonly<{
    account: ConnectedAccountRef;
    configuration: PluginConnectedAccountRuntimeConfiguration;
    credentials: Pick<PluginConnectedAccountCredentialStore, 'get'>;
}>;
export type PluginConnectedAccountMutationContext = PluginConnectedAccountReadContext & Readonly<{
    operation: Readonly<{ operationId: string; configurationRevision: string }>;
    stagedCredentials: PluginConnectedAccountCredentialStore;
}>;
export type PluginConnectedAccountCommonRuntime = Pick<
    ConnectedAccountRuntime,
    'refresh' | 'revoke' | 'status' | 'quota' | 'materialize'
>;
export type PluginConnectedAccountRefreshResult = Awaited<
    ReturnType<ConnectedAccountRuntime['refresh']>
>;
export type PluginConnectedAccountRevocationResult = Awaited<
    ReturnType<ConnectedAccountRuntime['revoke']>
>;
export type PluginConnectedAccountQuotaSnapshot = Awaited<ReturnType<
    NonNullable<ConnectedAccountRuntime['quota']>
>>;

export interface PluginConnectedAccountRegistrationApi {
    register(id: string, runtime: ConnectedAccountRuntime): void;
}
