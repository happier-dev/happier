import type { PluginDiagnosticData } from '../diagnostics.js';
import type { JsonValue, PluginContributionRef } from '../identity.js';
import type { PluginInvocationContext } from '../invocation.js';
import type { Disposable } from '../lifecycle.js';
import type {
    PluginConnectedAccountMaterializationKind,
} from '@happier-dev/protocol';

export type { PluginConnectedAccountMaterializationKind } from '@happier-dev/protocol';

export type PluginConnectedAccountRef = Readonly<{ service: PluginContributionRef; accountId: string }>;
export type PluginConnectedAccountState = 'connected' | 'expired' | 'reconnectRequired' | 'unavailable';
export type PluginConnectedAccountBindingSummary = Readonly<{
    purpose: string;
    service: PluginContributionRef;
    target: Readonly<{
        kind: 'account' | 'group';
        displayName: string;
    }>;
}>;
export type PluginConnectedAccountMaterializationRequest =
    | Readonly<{
        kind: Extract<PluginConnectedAccountMaterializationKind, 'httpHeaders'>;
        origin: string;
        headerNames: readonly string[];
    }>
    | Readonly<{
        kind: Extract<PluginConnectedAccountMaterializationKind, 'environment'>;
        keys: readonly string[];
    }>
    | Readonly<{
        kind: Extract<PluginConnectedAccountMaterializationKind, 'files'>;
        fileIds: readonly string[];
    }>;
export type PluginConnectedAccountMaterialization =
    | Readonly<{
        kind: Extract<PluginConnectedAccountMaterializationKind, 'httpHeaders'>;
        headers: Readonly<Record<string, string>>;
    }>
    | Readonly<{
        kind: Extract<PluginConnectedAccountMaterializationKind, 'environment'>;
        env: Readonly<Record<string, string>>;
    }>
    | Readonly<{
        kind: Extract<PluginConnectedAccountMaterializationKind, 'files'>;
        files: Readonly<Record<string, Uint8Array>>;
    }>;
export type PluginConnectedAccountBindingEvent = Readonly<{ kind: 'resync' }>;

export interface PluginConnectedAccountsService {
    getBinding(purpose: string, options?: { signal?: AbortSignal }): Promise<PluginConnectedAccountBindingSummary | null>;
    requestSelection(
        request: Readonly<{ purpose: string; reason: string }>,
        options?: { signal?: AbortSignal },
    ): Promise<PluginConnectedAccountBindingSummary>;
    materialize(
        purpose: string,
        request: PluginConnectedAccountMaterializationRequest,
        options?: { signal?: AbortSignal },
    ): Promise<PluginConnectedAccountMaterialization>;
    watch(
        purpose: string,
        listener: (event: PluginConnectedAccountBindingEvent) => void,
    ): Disposable;
}

export type PluginConnectedAccountRuntimeConfigurationTarget =
    | Readonly<{
        kind: 'service';
        service: PluginContributionRef;
        modeId: string;
    }>
    | Readonly<{
        kind: 'account';
        account: PluginConnectedAccountRef;
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
export type PluginConnectedAccountCredentialReader = Pick<
    PluginConnectedAccountCredentialStore,
    'get'
>;
export type PluginConnectedAccountAuthenticationAttempt =
    | Readonly<{ kind: 'connect'; attemptId: string }>
    | Readonly<{ kind: 'reconnect'; attemptId: string; account: PluginConnectedAccountRef }>;
export type PluginConnectedAccountAuthenticationContext = PluginInvocationContext & Readonly<{
    service: PluginContributionRef;
    attempt: PluginConnectedAccountAuthenticationAttempt;
    configuration: PluginConnectedAccountRuntimeConfiguration;
    attemptCredentials: PluginConnectedAccountCredentialStore;
}>;
export type PluginConnectedAccountReadContext = PluginInvocationContext & Readonly<{
    account: PluginConnectedAccountRef;
    configuration: PluginConnectedAccountRuntimeConfiguration;
    credentials: PluginConnectedAccountCredentialReader;
}>;
export type PluginConnectedAccountMutationContext = PluginConnectedAccountReadContext & Readonly<{
    operation: Readonly<{ operationId: string; configurationRevision: string }>;
    stagedCredentials: PluginConnectedAccountCredentialStore;
}>;

export type PluginConnectedAccountAuthFailure = Readonly<{
    status: 'rejected' | 'unavailable';
    diagnostic: PluginDiagnosticData;
}>;
export type PluginConnectedAccountOutcomeUnknown = Readonly<{
    status: 'outcomeUnknown';
    diagnostic: PluginDiagnosticData;
}>;
export type PluginConnectedAccountConnectedResult = Readonly<{
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
}>;
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
    | PluginConnectedAccountAuthFailure
    | PluginConnectedAccountOutcomeUnknown;
export type PluginConnectedAccountDeviceBeginResult =
    | Readonly<{
        status: 'awaitingDeviceAuthorization';
        verificationUri: string;
        verificationUriComplete?: string;
        userCode: string;
        expiresAtMs: number;
        pollIntervalMs: number;
    }>
    | PluginConnectedAccountAuthFailure
    | PluginConnectedAccountOutcomeUnknown;
export type PluginConnectedAccountPendingResult =
    Readonly<{ status: 'pending'; retryAfterMs: number }>;
export type PluginConnectedAccountDevicePollResult =
    | PluginConnectedAccountPendingResult
    | PluginConnectedAccountConnectedResult
    | PluginConnectedAccountAuthFailure
    | PluginConnectedAccountOutcomeUnknown;
export type PluginConnectedAccountAuthCompletionResult =
    | PluginConnectedAccountConnectedResult
    | PluginConnectedAccountAuthFailure
    | PluginConnectedAccountOutcomeUnknown;
export type PluginConnectedAccountReconciliationResult =
    | PluginConnectedAccountConnectedResult
    | PluginConnectedAccountPendingResult
    | PluginConnectedAccountAuthFailure
    | PluginConnectedAccountOutcomeUnknown;
type PluginConnectedAccountReconciliationRuntime = Readonly<{
    reconcile?(
        context: PluginConnectedAccountAuthenticationContext,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<PluginConnectedAccountReconciliationResult>;
}>;
export type PluginConnectedAccountAuthenticationModeRuntime =
    | (Readonly<{
        kind: 'oauthAuthorizationCode';
        begin(input: PluginConnectedAccountOAuthBeginRequest, context: PluginConnectedAccountAuthenticationContext, options?: { signal?: AbortSignal }): Promise<PluginConnectedAccountOAuthBeginResult>;
        complete(input: PluginConnectedAccountOAuthCompletion, context: PluginConnectedAccountAuthenticationContext, options?: { signal?: AbortSignal }): Promise<PluginConnectedAccountAuthCompletionResult>;
        cancel(context: PluginConnectedAccountAuthenticationContext): Promise<void>;
    }> & PluginConnectedAccountReconciliationRuntime)
    | (Readonly<{
        kind: 'oauthDeviceCode';
        begin(context: PluginConnectedAccountAuthenticationContext, options?: { signal?: AbortSignal }): Promise<PluginConnectedAccountDeviceBeginResult>;
        poll(context: PluginConnectedAccountAuthenticationContext, options?: { signal?: AbortSignal }): Promise<PluginConnectedAccountDevicePollResult>;
        cancel(context: PluginConnectedAccountAuthenticationContext): Promise<void>;
    }> & PluginConnectedAccountReconciliationRuntime)
    | (Readonly<{
        kind: 'manual';
        complete(input: PluginConnectedAccountManualCompletion, context: PluginConnectedAccountAuthenticationContext, options?: { signal?: AbortSignal }): Promise<PluginConnectedAccountAuthCompletionResult>;
    }> & PluginConnectedAccountReconciliationRuntime);
export type PluginConnectedAccountHealthResult =
    | Readonly<{ status: PluginConnectedAccountState; displayName?: string; scopes?: readonly string[]; diagnostic?: PluginDiagnosticData }>
    | Readonly<{ status: 'rejected'; diagnostic: PluginDiagnosticData }>;
export type PluginConnectedAccountRefreshResult =
    | PluginConnectedAccountHealthResult
    | Readonly<{ status: 'outcomeUnknown'; diagnostic: PluginDiagnosticData }>;
export type PluginConnectedAccountRevocationResult =
    | Readonly<{
        status: 'remoteRevoked' | 'remoteUnsupported';
        diagnostic?: PluginDiagnosticData;
    }>
    | Readonly<{ status: 'outcomeUnknown'; diagnostic: PluginDiagnosticData }>;
export type PluginConnectedAccountQuotaSnapshot = Readonly<{
    observedAtMs: number;
    limits: readonly Readonly<{
        id: string;
        used?: number;
        remaining?: number;
        resetsAtMs?: number;
    }>[];
}>;
export interface PluginConnectedAccountCommonRuntime {
    refresh(context: PluginConnectedAccountMutationContext, options?: { signal?: AbortSignal }): Promise<PluginConnectedAccountRefreshResult>;
    revoke(context: PluginConnectedAccountReadContext, options?: { signal?: AbortSignal }): Promise<PluginConnectedAccountRevocationResult>;
    status(context: PluginConnectedAccountReadContext, options?: { signal?: AbortSignal }): Promise<PluginConnectedAccountHealthResult>;
    quota?(context: PluginConnectedAccountReadContext, options?: { signal?: AbortSignal }): Promise<PluginConnectedAccountQuotaSnapshot>;
    materialize(request: PluginConnectedAccountMaterializationRequest, context: PluginConnectedAccountReadContext, options?: { signal?: AbortSignal }): Promise<PluginConnectedAccountMaterialization>;
}
export interface PluginConnectedAccountRuntime extends PluginConnectedAccountCommonRuntime {
    readonly authentication: Readonly<{
        modes: Readonly<Record<string, PluginConnectedAccountAuthenticationModeRuntime>>;
    }>;
}

export interface PluginConnectedAccountRegistrationApi {
    register(id: string, runtime: PluginConnectedAccountRuntime): void;
}
