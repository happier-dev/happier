import type {
    ConnectedAccountAuthenticationContext as PluginConnectedAccountAuthenticationContext,
    ConnectedAccountRuntime as PluginConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import type {
    PluginContributionRef,
} from '@happier-dev/plugin-sdk';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { QualifiedConnectedAccountIdSchema, sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import type { PluginConnectedAccountAuthenticationModeV2 } from '@happier-dev/protocol';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/json-schema-validation';

import {
    ConnectedAccountRuntimeInvocationNotStartedError,
    type ConnectedAccountRuntimeLease,
} from './contributionRegistry';
import type { PluginSourceCustody } from '../sourceAuthority';

type MaybePromise<T> = T | Promise<T>;
type PluginConnectedAccountCredentialStore =
    PluginConnectedAccountAuthenticationContext['attemptCredentials'];
type PluginConnectedAccountRuntimeConfiguration =
    PluginConnectedAccountAuthenticationContext['configuration'];
type PluginConnectedAccountRef = Extract<
    PluginConnectedAccountAuthenticationContext['attempt'],
    { kind: 'reconnect' }
>['account'];
type AuthenticationRuntime =
    PluginConnectedAccountRuntime['authentication']['modes'][string];
type OAuthAuthenticationRuntime = Extract<AuthenticationRuntime, { kind: 'oauthAuthorizationCode' }>;
type DeviceAuthenticationRuntime = Extract<AuthenticationRuntime, { kind: 'oauthDeviceCode' }>;
type ManualAuthenticationRuntime = Extract<AuthenticationRuntime, { kind: 'manual' }>;
type PluginConnectedAccountOAuthCompletion =
    Parameters<OAuthAuthenticationRuntime['complete']>[0];

export type ConnectedAccountOAuthCallbackCompletion = Readonly<Pick<
    PluginConnectedAccountOAuthCompletion,
    'code' | 'callbackUrl' | 'state'
>>;

export type ConnectedAccountAttemptConfigurationAdmission =
    | Readonly<{
        status: 'ready';
        snapshot: PluginConnectedAccountRuntimeConfiguration;
        /**
         * Opaque full-replacement account configuration staged for the first credential settlement.
         * The attempt owner never opens this envelope.
         */
        stagedAccountConfigurationContent?: unknown;
    }>
    | Readonly<{
        status: 'configurationRequired';
        target: PluginConnectedAccountRuntimeConfiguration['target'];
        missingFieldIds: readonly string[];
    }>
    | Readonly<{
        status: 'conflict' | 'unavailable';
        code: string;
    }>;

export type ConnectedAccountAttemptModeAdmission = Readonly<{
    service: PluginContributionRef;
    descriptor: PluginConnectedAccountAuthenticationModeV2;
    authenticationModeCardinality?: 'single' | 'multiple';
    /** Process-local fence for provider callbacks; never persisted. */
    occurrenceId: string;
    /** Durable byte/source authority used to restore the attempt after restart. */
    sourceCustody: PluginSourceCustody;
    /** Retains the admitted executable and form contract until attempt cleanup. */
    runtimeCustody?: Readonly<{
        lease: ConnectedAccountRuntimeLease;
        invoke(input: ConnectedAccountAttemptProviderInvocation): Promise<unknown>;
        release(): Promise<void>;
    }>;
}>;

export type ConnectedAccountAttemptProviderOperation =
    | Readonly<{
        kind: 'beginOAuth';
        request: Parameters<OAuthAuthenticationRuntime['begin']>[0];
    }>
    | Readonly<{ kind: 'beginDevice' }>
    | Readonly<{ kind: 'submitManual'; fields: Readonly<Record<string, string>> }>
    | Readonly<{ kind: 'completeOAuth'; completion: PluginConnectedAccountOAuthCompletion }>
    | Readonly<{ kind: 'pollDevice' }>
    | Readonly<{ kind: 'reconcile' }>
    | Readonly<{ kind: 'cancel' }>;

type AuthenticationAttemptContext = Pick<
    PluginConnectedAccountAuthenticationContext,
    'service' | 'attempt' | 'configuration' | 'attemptCredentials'
>;

export type ConnectedAccountAttemptProviderInvocation = Readonly<{
    admission: ConnectedAccountAttemptModeAdmission & Readonly<{ modeId: string }>;
    operation: ConnectedAccountAttemptProviderOperation;
    context: AuthenticationAttemptContext;
    signal?: AbortSignal;
}>;

type ProviderResult =
    | Awaited<ReturnType<OAuthAuthenticationRuntime['begin']>>
    | Awaited<ReturnType<DeviceAuthenticationRuntime['begin']>>
    | Awaited<ReturnType<OAuthAuthenticationRuntime['complete']>>
    | Awaited<ReturnType<ManualAuthenticationRuntime['complete']>>
    | Awaited<ReturnType<DeviceAuthenticationRuntime['poll']>>
    | Awaited<ReturnType<NonNullable<AuthenticationRuntime['reconcile']>>>;

type ValidatedProviderResult = ProviderResult & Readonly<{
    failureClass?: 'rateLimit';
    retryNotBeforeMs?: number;
}>;

export type ConnectedAccountAttemptSettlementRequest = Readonly<{
    intent: 'connect' | 'reconnect';
    service: PluginContributionRef;
    accountId: string;
    authenticationModeId: string;
    directExportContract?: typeof CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 | null;
    contributionContractVersion?: string;
    expectedCredentialRevision: string | null;
    expectedCredentialConfigurationRevision: string | null;
    expectedConfigurationRevision: string;
    sourceCustody: PluginSourceCustody;
    stagedCredentials: Readonly<Record<string, string>>;
    stagedAccountConfigurationContent?: unknown;
    providerIdentity?: Readonly<{
        accountId?: string;
        email?: string;
    }>;
    displayName: string;
    scopes: readonly string[];
}>;

export type ConnectedAccountDeviceTransactionSnapshot = Readonly<{
    attemptId: string;
    createdAtMs: number;
    intent: 'connect' | 'reconnect';
    service: PluginContributionRef;
    account?: PluginConnectedAccountRef;
    modeId: string;
    sourceCustody: PluginSourceCustody;
    expectedCredentialRevision: string | null;
    expectedCredentialConfigurationRevision: string | null;
    expectedConfigurationRevision: string;
    expiresAtMs: number;
    pollIntervalMs: number;
    nextPollAtMs: number;
    verificationUri: string;
    verificationUriComplete?: string;
    userCode: string;
    stagedCredentials: Readonly<Record<string, string>>;
    stagedAccountConfigurationContent?: unknown;
    preparedSettlement?: ConnectedAccountAttemptSettlementRequest;
}>;

export type ConnectedAccountOAuthTransactionSnapshot = Readonly<{
    attemptId: string;
    createdAtMs: number;
    intent: 'connect' | 'reconnect';
    service: PluginContributionRef;
    account?: PluginConnectedAccountRef;
    modeId: string;
    sourceCustody: PluginSourceCustody;
    expectedCredentialRevision: string | null;
    expectedCredentialConfigurationRevision: string | null;
    expectedConfigurationRevision: string;
    phase: 'starting' | 'awaitingOAuth' | 'outcomeUnknown';
    authorizationUrl?: string;
    expiresAtMs?: number;
    stagedCredentials: Readonly<Record<string, string>>;
    stagedAccountConfigurationContent?: unknown;
    preparedSettlement?: ConnectedAccountAttemptSettlementRequest;
}>;

export type ConnectedAccountOAuthTransaction = Readonly<{
    request: Parameters<OAuthAuthenticationRuntime['begin']>[0];
    snapshot?: ConnectedAccountOAuthTransactionSnapshot;
    acknowledge?(
        snapshot: ConnectedAccountOAuthTransactionSnapshot,
    ): MaybePromise<void>;
    acceptCompletion(
        completion: ConnectedAccountOAuthCallbackCompletion,
    ): MaybePromise<PluginConnectedAccountOAuthCompletion>;
    close(): MaybePromise<void>;
}>;

export type ConnectedAccountOAuthTransactionOwner = Readonly<{
    create(input: Readonly<{
        attemptId: string;
        service: PluginContributionRef;
        snapshot: ConnectedAccountOAuthTransactionSnapshot;
        callbackUrl?: string;
    }>): Promise<ConnectedAccountOAuthTransaction>;
    read?(
        attemptId: string,
    ): MaybePromise<
        (ConnectedAccountOAuthTransaction & Readonly<{
            snapshot: ConnectedAccountOAuthTransactionSnapshot;
        }>)
        | null
    >;
}>;

export type ConnectedAccountDeviceTransactionOwner = Readonly<{
    acknowledge(input: ConnectedAccountDeviceTransactionSnapshot): MaybePromise<void>;
    read(attemptId: string): MaybePromise<ConnectedAccountDeviceTransactionSnapshot | null>;
    clear(attemptId: string): MaybePromise<void>;
}>;

export type ConnectedAccountAttemptResponse =
    | Readonly<{ status: 'starting'; attemptId: string }>
    | Readonly<{ status: 'awaitingManual'; attemptId: string }>
    | Readonly<{
        status: 'awaitingOAuth';
        attemptId: string;
        authorizationUrl?: string;
        callbackUrl: string;
        expiresAtMs?: number;
    }>
    | Readonly<{
        status: 'awaitingDeviceAuthorization';
        attemptId: string;
        verificationUri?: string;
        verificationUriComplete?: string;
        userCode?: string;
        expiresAtMs?: number;
        pollIntervalMs?: number;
    }>
    | Readonly<{
        status: 'configurationRequired';
        attemptId?: string;
        target: PluginConnectedAccountRuntimeConfiguration['target'];
        missingFieldIds: readonly string[];
    }>
    | Readonly<{ status: 'pending'; attemptId: string; retryAfterMs: number }>
    | Readonly<{ status: 'outcomeUnknown'; attemptId: string; diagnostic: unknown }>
    | Readonly<{ status: 'reconnectRequired'; attemptId: string; code: string }>
    | Readonly<{ status: 'connected'; attemptId: string; account: PluginConnectedAccountRef }>
    | Readonly<{ status: 'cancelled'; attemptId: string }>
    | Readonly<{
        status: 'cleanupPending';
        attemptId: string;
        code: 'connected_account_attempt_cleanup_pending';
    }>
    | Readonly<{
        status: 'rejected' | 'unavailable';
        attemptId?: string;
        code: string;
        diagnostic?: unknown;
        failureClass?: 'rateLimit';
        retryNotBeforeMs?: number;
    }>
    | Readonly<{
        status: 'conflict';
        attemptId?: string;
        code: string;
        diagnostic?: unknown;
    }>;

type AttemptResponse = ConnectedAccountAttemptResponse;

type ActiveStoredAttempt = {
    id: string;
    active: boolean;
    createdAtMs: number;
    intent: 'connect' | 'reconnect';
    account: PluginConnectedAccountRef | null;
    expectedCredentialRevision: string | null;
    expectedCredentialConfigurationRevision: string | null;
    admission: ConnectedAccountAttemptModeAdmission & Readonly<{ modeId: string }>;
    configuration: Extract<ConnectedAccountAttemptConfigurationAdmission, { status: 'ready' }> | null;
    credentials: ReturnType<typeof createAttemptCredentialStore>;
    pendingDurableOperations: number;
    preparedSettlement: ConnectedAccountAttemptSettlementRequest | null;
    preparedSettlementAcknowledged: boolean;
    decisiveSettlement: Promise<AttemptResponse> | null;
    oauthTransaction: ConnectedAccountOAuthTransaction | null;
    oauthExpiresAtMs: number | null;
    oauthAuthorizationUrl: string | null;
    device: {
        expiresAtMs: number;
        pollIntervalMs: number;
        nextPollAtMs: number;
        verificationUri: string;
        verificationUriComplete?: string;
        userCode: string;
    } | null;
    phase:
        | 'configurationRequired'
        | 'starting'
        | 'awaitingManual'
        | 'awaitingOAuth'
        | 'awaitingDeviceAuthorization'
        | 'inFlight'
        | 'outcomeUnknown'
        | 'reconnectRequired'
        | 'connected'
        | 'cancelled'
        | 'rejected';
    lastResponse: AttemptResponse | null;
    cleanupTerminalResponse: null;
    terminalResponseCustody?: { released: boolean };
};

type RestoringStoredAttempt = {
    id: string;
    active: boolean;
    createdAtMs: number;
    credentials: ReturnType<typeof createAttemptCredentialStore>;
    pendingDurableOperations: number;
    oauthTransaction: ConnectedAccountOAuthTransaction | null;
    phase: 'restoring';
    lastResponse: Extract<AttemptResponse, { status: 'pending' }>;
    cleanupTerminalResponse: null;
    runtimeCustody?: ConnectedAccountAttemptModeAdmission['runtimeCustody'];
    terminalResponseCustody?: { released: boolean };
};

type CleanupPendingStoredAttempt = {
    id: string;
    active: false;
    createdAtMs: number;
    credentials: ReturnType<typeof createAttemptCredentialStore>;
    pendingDurableOperations: number;
    oauthTransaction: ConnectedAccountOAuthTransaction | null;
    phase: 'cleanupPending';
    lastResponse: Extract<AttemptResponse, { status: 'cleanupPending' }>;
    cleanupTerminalResponse: AttemptResponse;
    logService: PluginContributionRef | null;
    settlementPrepared: boolean;
    cleanupPromise: Promise<void> | null;
    runtimeCustody?: ConnectedAccountAttemptModeAdmission['runtimeCustody'];
    terminalResponseCustody: { released: boolean };
    cleanupTargets: Readonly<{
        oauthTransaction: boolean;
        deviceTransaction: boolean;
        configuration: boolean;
    }>;
    cleanupTargetRevisions: Readonly<{
        oauthTransaction: number;
        deviceTransaction: number;
        configuration: number;
    }>;
};

type StoredAttempt =
    | ActiveStoredAttempt
    | RestoringStoredAttempt
    | CleanupPendingStoredAttempt;

function sameService(left: PluginContributionRef, right: PluginContributionRef): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

function snapshotSourceMatchesAdmission(
    snapshot: ConnectedAccountOAuthTransactionSnapshot | ConnectedAccountDeviceTransactionSnapshot,
    admission: ConnectedAccountAttemptModeAdmission,
): boolean {
    return pluginSourceCustodyV1Equal(snapshot.sourceCustody, admission.sourceCustody);
}

/**
 * Classifies a rejected `runtime.admit` / `runtime.isCurrent` call.
 *
 * The contribution registry answers a retired or disposed generation with the
 * typed `ConnectedAccountRuntimeInvocationNotStartedError` instead of an
 * absent lease, so a caller can tell "reload and retry" from "this generation
 * has no usable runtime for the service". Discarding the error collapses both
 * into `connected_account_runtime_unavailable` and hides that fact from the
 * connect surface. The typed error maps onto the same drift response this
 * owner already returns when the non-throwing currentness check reports the
 * admission is stale; every other rejection stays unavailable. Neither outcome
 * admits an attempt, so the reason becomes legible without loosening
 * fail-closed admission.
 */
function runtimeAdmissionFailure(error: unknown): Readonly<{
    status: 'conflict' | 'unavailable';
    code:
        | 'connected_account_runtime_generation_changed'
        | 'connected_account_runtime_unavailable';
}> {
    return error instanceof ConnectedAccountRuntimeInvocationNotStartedError
        ? { status: 'conflict', code: error.code }
        : { status: 'unavailable', code: 'connected_account_runtime_unavailable' };
}

function createAttemptCredentialStore(): PluginConnectedAccountCredentialStore & Readonly<{
    snapshot(): Readonly<Record<string, string>>;
    clear(): void;
}> {
    const values = new Map<string, string>();
    return Object.freeze({
        async get(key: string) {
            return values.get(key) ?? null;
        },
        async set(key: string, value: string) {
            values.set(key, value);
        },
        async delete(key: string) {
            values.delete(key);
        },
        snapshot() {
            return Object.freeze(Object.fromEntries(values));
        },
        clear() {
            values.clear();
        },
    });
}

function diagnosticCode(diagnostic: unknown, fallback: string): string {
    if (
        typeof diagnostic === 'object'
        && diagnostic !== null
        && 'code' in diagnostic
        && typeof diagnostic.code === 'string'
        && diagnostic.code.length > 0
    ) {
        return diagnostic.code;
    }
    return fallback;
}

function isCanonicalAccountId(value: unknown): value is string {
    const parsed = QualifiedConnectedAccountIdSchema.safeParse(value);
    return parsed.success && parsed.data === value;
}

function snapshotProviderResult(value: unknown): ValidatedProviderResult {
    // Registration owns the typed SDK ABI; this copy only detaches attempt custody.
    return structuredClone(value) as ValidatedProviderResult;
}

export class ConnectedAccountAttemptCleanupError extends Error {
    readonly code = 'connected_account_attempt_cleanup_pending';
    readonly attemptId: string;

    constructor(attemptId: string) {
        super('Connected-account attempt cleanup is pending');
        this.name = 'ConnectedAccountAttemptCleanupError';
        this.attemptId = attemptId;
    }
}

export function createConnectedAccountAuthenticationAttemptOwner(params: Readonly<{
    createAttemptId(): string;
    createAccountId(): string;
    now(): number;
    onBackgroundTransition?(input: Readonly<{
        response: ConnectedAccountAttemptResponse;
        service: PluginContributionRef;
        settlementPhase: 'notPrepared' | 'prepared' | 'cleanupPending' | 'settled';
    }>): void;
    accounts: Readonly<{
        readExact(account: PluginConnectedAccountRef): Promise<Readonly<{
            account: PluginConnectedAccountRef;
            authenticationModeId: string;
            credentialRevision: string;
            configurationRevision: string | null;
        }> | null>;
    }>;
    configuration: Readonly<{
        admit(input: Readonly<{
            intent: 'connect' | 'reconnect';
            service: PluginContributionRef;
            account?: PluginConnectedAccountRef;
            mode: PluginConnectedAccountAuthenticationModeV2;
            attemptId?: string;
            expectedConfigurationRevision?: string;
            occurrenceId: string;
            sourceCustody: PluginSourceCustody;
        }>): Promise<ConnectedAccountAttemptConfigurationAdmission>;
        isCurrent(
            snapshot: PluginConnectedAccountRuntimeConfiguration,
        ): MaybePromise<boolean>;
        destroyAttempt?(attemptId: string): MaybePromise<void>;
    }>;
    runtime: Readonly<{
        admit(input: Readonly<{
            service: PluginContributionRef;
            modeId: string;
        }>): Promise<ConnectedAccountAttemptModeAdmission>;
        isCurrent(admission: ConnectedAccountAttemptModeAdmission): MaybePromise<boolean>;
        invoke(input: ConnectedAccountAttemptProviderInvocation): Promise<unknown>;
    }>;
    assertEffectfulOperationAllowed?(input: Readonly<{
        intent: 'connect' | 'reconnect';
        service: PluginContributionRef;
        attemptId: string;
        authenticationModeId: string;
        authenticationModeCardinality?: 'single' | 'multiple';
        configurationState: 'unconfigured' | 'configured';
    }>): MaybePromise<void>;
    oauth: ConnectedAccountOAuthTransactionOwner;
    deviceTransactions?: ConnectedAccountDeviceTransactionOwner;
    lateEvidence?: Readonly<{
        reconcile(input: Readonly<{
            attemptId: string;
            service: PluginContributionRef;
            account?: PluginConnectedAccountRef;
        }>): Promise<ProviderResult>;
    }>;
    settlement: Readonly<{
        settle(request: ConnectedAccountAttemptSettlementRequest): Promise<Readonly<{
            status: 'connected';
            account: PluginConnectedAccountRef;
        }> | Readonly<{
            status: 'conflict' | 'rejected' | 'unavailable';
            code: string;
        }>>;
        reconcile?(request: ConnectedAccountAttemptSettlementRequest): Promise<Readonly<{
            status: 'connected';
            account: PluginConnectedAccountRef;
        }> | Readonly<{
            status: 'conflict' | 'rejected' | 'unavailable';
            code: string;
        }>>;
    }>;
}>): Readonly<{
    beginConnect(input: Readonly<{
        service: PluginContributionRef;
        modeId: string;
        expectedConfigurationRevision?: string;
    }>): Promise<AttemptResponse>;
    beginReconnect(input: Readonly<{
        account: PluginConnectedAccountRef;
        expectedConfigurationRevision?: string;
    }>): Promise<AttemptResponse>;
    continueConnect(input: Readonly<{
        attemptId: string;
        expectedConfigurationRevision?: string;
    }>): Promise<AttemptResponse>;
    resolveConfigurationControlTarget(input: Readonly<{
        attemptId: string;
    }>): Promise<Readonly<{
        target: Extract<
            PluginConnectedAccountRuntimeConfiguration['target'],
            { kind: 'attempt' }
        >;
        mode: PluginConnectedAccountAuthenticationModeV2;
        occurrenceId: string;
        sourceCustody: PluginSourceCustody;
    }> | null>;
    resumeDevice(input: Readonly<{
        attemptId: string;
    }>): Promise<AttemptResponse>;
    submitManual(input: Readonly<{
        attemptId: string;
        fields: Readonly<Record<string, string>>;
        signal?: AbortSignal;
    }>): Promise<AttemptResponse>;
    completeOAuth(input: Readonly<{
        attemptId: string;
        completion: ConnectedAccountOAuthCallbackCompletion;
        signal?: AbortSignal;
    }>): Promise<AttemptResponse>;
    pollDevice(input: Readonly<{
        attemptId: string;
        signal?: AbortSignal;
    }>): Promise<AttemptResponse>;
    reconcile(input: Readonly<{
        attemptId: string;
        signal?: AbortSignal;
    }>): Promise<AttemptResponse>;
    cancel(input: Readonly<{ attemptId: string }>): Promise<AttemptResponse>;
    read(input: Readonly<{ attemptId: string; restoreKind?: 'oauth' }>): Promise<AttemptResponse>;
    inspectObservability(attemptId: string): Readonly<{
        service: PluginContributionRef | null;
        settlementPhase: 'notPrepared' | 'prepared' | 'settling' | 'cleanupPending' | 'settled';
    }> | null;
    releaseTerminalResponse(attemptId: string): void;
    dispose(): void;
}> {
    const attempts = new Map<string, StoredAttempt>();
    const reservedAttemptIds = new Set<string>();
    const terminalResponses = new Map<string, Readonly<{
        response: AttemptResponse;
        service: PluginContributionRef | null;
        settlementPrepared: boolean;
        custody: { released: boolean };
    }>>();

    function unavailable(attemptId?: string): AttemptResponse {
        return {
            status: 'unavailable',
            ...(attemptId ? { attemptId } : {}),
            code: 'connected_account_attempt_not_found',
        };
    }

    async function destroyAttempt(
        attempt: StoredAttempt,
        terminalResponse: AttemptResponse,
        options?: Readonly<{
            skipOAuthTransactionCleanup?: boolean;
            skipDeviceTransactionCleanup?: boolean;
            skipConfigurationCleanup?: boolean;
            retainTerminalResponse?: boolean;
        }>,
    ): Promise<void> {
        if (attempt.phase === 'cleanupPending') {
            await continueCleanupAttempt(attempt, options);
            return;
        }
        const current = attempts.get(attempt.id);
        if (current !== attempt) {
            if (current?.phase === 'cleanupPending') {
                await continueCleanupAttempt(current);
            }
            return;
        }
        attempt.active = false;
        const cleanupAttempt: CleanupPendingStoredAttempt = {
            id: attempt.id,
            active: false,
            createdAtMs: attempt.createdAtMs,
            credentials: attempt.credentials,
            pendingDurableOperations: attempt.pendingDurableOperations,
            oauthTransaction: attempt.oauthTransaction,
            phase: 'cleanupPending',
            lastResponse: {
                status: 'cleanupPending',
                attemptId: attempt.id,
                code: 'connected_account_attempt_cleanup_pending',
            },
            cleanupTerminalResponse: terminalResponse,
            logService: 'admission' in attempt ? attempt.admission.service : null,
            settlementPrepared: 'preparedSettlement' in attempt && attempt.preparedSettlement !== null,
            cleanupPromise: null,
            runtimeCustody: 'admission' in attempt ? attempt.admission.runtimeCustody : attempt.runtimeCustody,
            terminalResponseCustody: attempt.terminalResponseCustody ??= { released: false },
            cleanupTargets: Object.freeze({
                oauthTransaction: options?.skipOAuthTransactionCleanup !== true,
                deviceTransaction: options?.skipDeviceTransactionCleanup !== true,
                configuration: options?.skipConfigurationCleanup !== true,
            }),
            cleanupTargetRevisions: Object.freeze({
                oauthTransaction:
                    options?.skipOAuthTransactionCleanup === true ? 0 : 1,
                deviceTransaction:
                    options?.skipDeviceTransactionCleanup === true ? 0 : 1,
                configuration:
                    options?.skipConfigurationCleanup === true ? 0 : 1,
            }),
        };
        attempts.set(attempt.id, cleanupAttempt);
        await continueCleanupAttempt(cleanupAttempt, options);
    }

    async function performCleanupAttempt(
        attempt: CleanupPendingStoredAttempt,
        options?: Readonly<{ retainTerminalResponse?: boolean }>,
    ): Promise<void> {
        attempt.credentials.clear();
        const cleanupTargets = attempt.cleanupTargets;
        const cleanupTargetRevisions = attempt.cleanupTargetRevisions;
        const oauthTransaction = attempt.oauthTransaction;
        const cleanupResults = await Promise.allSettled([
            Promise.resolve().then(async () => {
                if (cleanupTargets.oauthTransaction) {
                    await oauthTransaction?.close();
                }
            }),
            Promise.resolve().then(async () => {
                if (cleanupTargets.deviceTransaction) {
                    await params.deviceTransactions?.clear(attempt.id);
                }
            }),
            Promise.resolve().then(async () => {
                if (cleanupTargets.configuration) {
                    await params.configuration.destroyAttempt?.(attempt.id);
                }
            }),
        ]);
        attempt.cleanupTargets = Object.freeze({
            oauthTransaction:
                attempt.cleanupTargetRevisions.oauthTransaction
                    !== cleanupTargetRevisions.oauthTransaction
                || (
                    cleanupTargets.oauthTransaction
                    && cleanupResults[0]?.status === 'rejected'
                ),
            deviceTransaction:
                attempt.cleanupTargetRevisions.deviceTransaction
                    !== cleanupTargetRevisions.deviceTransaction
                || (
                    cleanupTargets.deviceTransaction
                    && cleanupResults[1]?.status === 'rejected'
                ),
            configuration:
                attempt.cleanupTargetRevisions.configuration
                    !== cleanupTargetRevisions.configuration
                || (
                    cleanupTargets.configuration
                    && cleanupResults[2]?.status === 'rejected'
                ),
        });
        if (cleanupResults.some((result) => result.status === 'rejected')) {
            throw new ConnectedAccountAttemptCleanupError(attempt.id);
        }
        if (
            attempt.pendingDurableOperations > 0
            || attempt.cleanupTargets.oauthTransaction
            || attempt.cleanupTargets.deviceTransaction
            || attempt.cleanupTargets.configuration
        ) {
            return;
        }
        await attempt.runtimeCustody?.release();
        if (attempts.get(attempt.id) === attempt) {
            attempts.delete(attempt.id);
            scheduleExpiryReclaim();
        }
        if (!attempt.terminalResponseCustody.released && options?.retainTerminalResponse !== false && !disposed) {
            terminalResponses.set(attempt.id, {
                response: attempt.cleanupTerminalResponse,
                service: attempt.logService,
                settlementPrepared: attempt.settlementPrepared,
                custody: attempt.terminalResponseCustody,
            });
        }
    }

    function continueCleanupAttempt(
        attempt: CleanupPendingStoredAttempt,
        options?: Readonly<{ retainTerminalResponse?: boolean }>,
    ): Promise<void> {
        if (attempt.cleanupPromise) return attempt.cleanupPromise;
        let resolveCleanup!: () => void;
        let rejectCleanup!: (reason: unknown) => void;
        const cleanupPromise = new Promise<void>((resolve, reject) => {
            resolveCleanup = resolve;
            rejectCleanup = reject;
        });
        attempt.cleanupPromise = cleanupPromise;
        void performCleanupAttempt(attempt, options).then(
            () => {
                if (attempts.get(attempt.id) === attempt) {
                    attempt.cleanupPromise = null;
                }
                resolveCleanup();
            },
            (error) => {
                if (attempts.get(attempt.id) === attempt) {
                    attempt.cleanupPromise = null;
                }
                rejectCleanup(error);
            },
        );
        return cleanupPromise;
    }

    async function expireAttemptIfNeeded(
        attempt: StoredAttempt,
    ): Promise<AttemptResponse | null> {
        if (
            attempt.phase === 'cleanupPending'
            || attempt.phase === 'restoring'
        ) return null;
        if (!isAttemptExpired(attempt)) return null;
        const response: AttemptResponse = {
            status: 'unavailable',
            attemptId: attempt.id,
            code: 'connected_account_attempt_expired',
        };
        await destroyAttempt(attempt, response);
        return response;
    }

    function attemptExpiryMs(attempt: StoredAttempt): number | null {
        if (attempt.phase === 'awaitingOAuth') return attempt.oauthExpiresAtMs;
        if (attempt.phase === 'awaitingDeviceAuthorization') return attempt.device?.expiresAtMs ?? null;
        return null;
    }

    function isAttemptExpired(attempt: StoredAttempt): boolean {
        const expiresAtMs = attemptExpiryMs(attempt);
        return expiresAtMs !== null && params.now() >= expiresAtMs;
    }

    async function reclaimExpiredChallenges(): Promise<void> {
        for (const attempt of [...attempts.values()]) {
            if (attempts.get(attempt.id) !== attempt) continue;
            try {
                await expireAttemptIfNeeded(attempt);
            } catch (error) {
                if (!(error instanceof ConnectedAccountAttemptCleanupError)) {
                    throw error;
                }
            }
        }
    }

    // One timer closes expired provider challenges without unrelated traffic.
    // Manual work and entered/prepared effects have no host-invented deadline.
    let disposed = false;
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;
    let expiryTimerTargetMs: number | null = null;

    function earliestLiveAttemptExpiryMs(): number | null {
        let earliest: number | null = null;
        for (const attempt of attempts.values()) {
            if (
                attempt.phase === 'cleanupPending'
                || attempt.phase === 'restoring'
            ) continue;
            const expiresAtMs = attemptExpiryMs(attempt);
            if (expiresAtMs === null) continue;
            if (earliest === null || expiresAtMs < earliest) {
                earliest = expiresAtMs;
            }
        }
        return earliest;
    }

    function clearExpiryTimer(): void {
        if (expiryTimer) {
            clearTimeout(expiryTimer);
        }
        expiryTimer = null;
        expiryTimerTargetMs = null;
    }

    function scheduleExpiryReclaim(): void {
        if (disposed) return;
        const earliest = earliestLiveAttemptExpiryMs();
        if (earliest === null) {
            clearExpiryTimer();
            return;
        }
        if (expiryTimer && expiryTimerTargetMs === earliest) return;
        clearExpiryTimer();
        const delayMs = Math.max(0, earliest - params.now());
        const timer = setTimeout(() => {
            expiryTimer = null;
            expiryTimerTargetMs = null;
            void reclaimExpiredChallenges()
                .then(() => {
                    if (!disposed) {
                        scheduleExpiryReclaim();
                    }
                })
                .catch(() => {
                    // Reclaim already isolates per-attempt cleanup failures;
                    // an unexpected failure stops automatic re-arming until
                    // the next admission or restoration arms the timer again.
                });
        }, delayMs);
        // Attempt reclamation must never keep a daemon process alive on its own.
        timer.unref?.();
        expiryTimer = timer;
        expiryTimerTargetMs = earliest;
    }

    async function reserveAttemptId(): Promise<string> {
        await reclaimExpiredChallenges();
        const attemptId = params.createAttemptId();
        if (!attemptId || attempts.has(attemptId) || reservedAttemptIds.has(attemptId)) {
            throw new Error('Connected-account attempt ids must be unique non-empty strings');
        }
        reservedAttemptIds.add(attemptId);
        return attemptId;
    }

    function installRestoration(attempt: RestoringStoredAttempt): boolean {
        if (
            !attempt.id
            || attempts.has(attempt.id)
            || reservedAttemptIds.has(attempt.id)
        ) {
            return false;
        }
        attempts.set(attempt.id, attempt);
        return true;
    }

    async function begin(input: Readonly<{
        intent: 'connect' | 'reconnect';
        service: PluginContributionRef;
        account: PluginConnectedAccountRef | null;
        modeId: string;
        expectedCredentialRevision: string | null;
        expectedCredentialConfigurationRevision: string | null;
        expectedConfigurationRevision?: string;
    }>): Promise<AttemptResponse> {
        if (disposed) return unavailable();
        let admitted: ConnectedAccountAttemptModeAdmission;
        try {
            admitted = await params.runtime.admit({
                service: input.service,
                modeId: input.modeId,
            });
        } catch (error) {
            return runtimeAdmissionFailure(error);
        }
        let custodyTransferred = false;
        try {
        if (disposed) return unavailable();
        if (
            !sameService(admitted.service, input.service)
            || admitted.descriptor.id !== input.modeId
        ) {
            return {
                status: 'unavailable',
                code: 'connected_account_authentication_mode_mismatch',
            };
        }

        const needsAttemptTarget = (
            'configuration' in admitted.descriptor
            && admitted.descriptor.configuration?.scope === 'account'
        )
            && input.intent === 'connect';
        const reservedAttemptId = needsAttemptTarget
            ? await reserveAttemptId()
            : null;
        let configuration: ConnectedAccountAttemptConfigurationAdmission;
        try {
            configuration = await params.configuration.admit({
                intent: input.intent,
                service: input.service,
                ...(input.account ? { account: input.account } : {}),
                mode: admitted.descriptor,
                occurrenceId: admitted.occurrenceId,
                sourceCustody: admitted.sourceCustody,
                ...(reservedAttemptId ? { attemptId: reservedAttemptId } : {}),
                ...(input.expectedConfigurationRevision
                    ? { expectedConfigurationRevision: input.expectedConfigurationRevision }
                    : {}),
            });
        } catch (error) {
            if (reservedAttemptId) {
                reservedAttemptIds.delete(reservedAttemptId);
                await params.configuration.destroyAttempt?.(reservedAttemptId);
            }
            throw error;
        }
        if (disposed) {
            if (reservedAttemptId) {
                reservedAttemptIds.delete(reservedAttemptId);
                await params.configuration.destroyAttempt?.(reservedAttemptId);
            }
            return unavailable();
        }
        if (configuration.status !== 'ready') {
            if (configuration.status === 'configurationRequired') {
                const response: AttemptResponse = {
                    status: 'configurationRequired',
                    ...(reservedAttemptId ? { attemptId: reservedAttemptId } : {}),
                    target: configuration.target,
                    missingFieldIds: Object.freeze([...configuration.missingFieldIds]),
                };
                if (reservedAttemptId) {
                    reservedAttemptIds.delete(reservedAttemptId);
                    attempts.set(reservedAttemptId, {
                        id: reservedAttemptId,
                        active: true,
                        createdAtMs: params.now(),
                        intent: input.intent,
                        account: input.account,
                        expectedCredentialRevision: input.expectedCredentialRevision,
                        expectedCredentialConfigurationRevision:
                            input.expectedCredentialConfigurationRevision,
                        admission: Object.freeze({
                            ...admitted,
                            modeId: admitted.descriptor.id,
                        }),
                        configuration: null,
                        credentials: createAttemptCredentialStore(),
                        pendingDurableOperations: 0,
                        preparedSettlement: null,
                        preparedSettlementAcknowledged: false,
                        decisiveSettlement: null,
                        oauthTransaction: null,
                        oauthExpiresAtMs: null,
                        oauthAuthorizationUrl: null,
                        device: null,
                        phase: 'configurationRequired',
                        lastResponse: response,
                        cleanupTerminalResponse: null,
                    });
                    custodyTransferred = true;
                    scheduleExpiryReclaim();
                }
                return response;
            }
            if (reservedAttemptId) {
                reservedAttemptIds.delete(reservedAttemptId);
                await params.configuration.destroyAttempt?.(reservedAttemptId);
            }
            return {
                status: configuration.status,
                code: configuration.code,
            };
        }
        if (
            input.expectedConfigurationRevision !== undefined
            && configuration.snapshot.revision !== input.expectedConfigurationRevision
        ) {
            if (reservedAttemptId) {
                reservedAttemptIds.delete(reservedAttemptId);
                await params.configuration.destroyAttempt?.(reservedAttemptId);
            }
            return {
                status: 'conflict',
                code: 'connected_account_configuration_changed',
            };
        }

        const attemptId = reservedAttemptId ?? await reserveAttemptId();
        if (disposed) {
            reservedAttemptIds.delete(attemptId);
            if (reservedAttemptId) await params.configuration.destroyAttempt?.(reservedAttemptId);
            return unavailable();
        }
        const phase = admitted.descriptor.kind === 'manual'
            ? 'awaitingManual'
            : admitted.descriptor.kind === 'oauthAuthorizationCode'
                ? 'awaitingOAuth'
                : 'awaitingDeviceAuthorization';
        const attempt: ActiveStoredAttempt = {
            id: attemptId,
            active: true,
            createdAtMs: params.now(),
            intent: input.intent,
            account: input.account,
            expectedCredentialRevision: input.expectedCredentialRevision,
            expectedCredentialConfigurationRevision:
                input.expectedCredentialConfigurationRevision,
            admission: Object.freeze({
                ...admitted,
                modeId: admitted.descriptor.id,
            }),
            configuration,
            credentials: createAttemptCredentialStore(),
            pendingDurableOperations: 0,
            preparedSettlement: null,
            preparedSettlementAcknowledged: false,
            decisiveSettlement: null,
            oauthTransaction: null,
            oauthExpiresAtMs: null,
            oauthAuthorizationUrl: null,
            device: null,
            phase,
            lastResponse: null,
            cleanupTerminalResponse: null,
        };
        reservedAttemptIds.delete(attemptId);
        attempts.set(attemptId, attempt);
        custodyTransferred = true;
        scheduleExpiryReclaim();
        const operationAdmissionFailure =
            await rejectAttemptWhenEffectfulOperationIsDisallowed(attempt);
        if (operationAdmissionFailure) return operationAdmissionFailure;
        const response: AttemptResponse = phase === 'awaitingManual'
            ? { status: phase, attemptId }
            : { status: 'starting', attemptId };
        attempt.lastResponse = response;
        if (phase !== 'awaitingManual') {
            attempt.phase = 'starting';
            startProviderFlowInBackground(attempt);
        }
        return response;
        } finally {
            if (!custodyTransferred) await admitted.runtimeCustody?.release();
        }
    }

    function readAttempt(attemptId: string): StoredAttempt | null {
        return attempts.get(attemptId) ?? null;
    }

    function attemptOwnershipFailure(
        attempt: ActiveStoredAttempt | RestoringStoredAttempt,
    ): AttemptResponse | null {
        if (!disposed && attempt.active && attempts.get(attempt.id) === attempt) return null;
        return {
            status: 'conflict',
            attemptId: attempt.id,
            code: 'connected_account_attempt_cancelled',
        };
    }

    function beginDurableOperation(
        attempt: ActiveStoredAttempt | RestoringStoredAttempt,
    ): (options?: Readonly<{ resumeCleanup?: boolean }>) => void {
        attempt.pendingDurableOperations += 1;
        let finished = false;
        return (options) => {
            if (finished) return;
            finished = true;
            const current = attempts.get(attempt.id);
            if (current === attempt) {
                attempt.pendingDurableOperations -= 1;
            } else if (current?.phase === 'cleanupPending') {
                current.pendingDurableOperations -= 1;
            } else {
                attempt.pendingDurableOperations -= 1;
            }
            if (
                options?.resumeCleanup !== false
                && current?.phase === 'cleanupPending'
                && current.pendingDurableOperations === 0
            ) {
                void continueCleanupAttempt(current).catch(() => {
                    // The same cleanup record retains failed targets for exact retry.
                });
            }
        };
    }

    function contextFor(attempt: ActiveStoredAttempt): AuthenticationAttemptContext {
        if (!attempt.configuration) {
            throw new Error('Connected-account provider work requires admitted configuration');
        }
        return Object.freeze({
            service: attempt.admission.service,
            attempt: attempt.intent === 'connect'
                ? Object.freeze({ kind: 'connect' as const, attemptId: attempt.id })
                : Object.freeze({
                    kind: 'reconnect' as const,
                    attemptId: attempt.id,
                    account: attempt.account!,
                }),
            configuration: attempt.configuration.snapshot,
            attemptCredentials: attempt.credentials,
        });
    }

    function snapshotDeviceTransaction(
        attempt: ActiveStoredAttempt,
    ): ConnectedAccountDeviceTransactionSnapshot {
        if (!attempt.device || !attempt.configuration) {
            throw new Error('Connected-account device transaction requires admitted device state');
        }
        return Object.freeze({
            attemptId: attempt.id,
            createdAtMs: attempt.createdAtMs,
            intent: attempt.intent,
            service: attempt.admission.service,
            ...(attempt.account ? { account: attempt.account } : {}),
            modeId: attempt.admission.modeId,
            sourceCustody: attempt.admission.sourceCustody,
            expectedCredentialRevision: attempt.expectedCredentialRevision,
            expectedCredentialConfigurationRevision:
                attempt.expectedCredentialConfigurationRevision,
            expectedConfigurationRevision: attempt.configuration.snapshot.revision,
            expiresAtMs: attempt.device.expiresAtMs,
            pollIntervalMs: attempt.device.pollIntervalMs,
            nextPollAtMs: attempt.device.nextPollAtMs,
            verificationUri: attempt.device.verificationUri,
            ...(attempt.device.verificationUriComplete === undefined
                ? {}
                : { verificationUriComplete: attempt.device.verificationUriComplete }),
            userCode: attempt.device.userCode,
            stagedCredentials: attempt.credentials.snapshot(),
            ...(attempt.configuration.stagedAccountConfigurationContent === undefined
                ? {}
                : {
                    stagedAccountConfigurationContent:
                        attempt.configuration.stagedAccountConfigurationContent,
                }),
            ...(attempt.preparedSettlement
                ? { preparedSettlement: attempt.preparedSettlement }
                : {}),
        });
    }

    function snapshotOAuthTransaction(
        attempt: ActiveStoredAttempt,
        phase: ConnectedAccountOAuthTransactionSnapshot['phase'],
    ): ConnectedAccountOAuthTransactionSnapshot {
        if (!attempt.configuration) {
            throw new Error('Connected-account OAuth transaction requires admitted configuration');
        }
        const expiresAtMs = attempt.oauthExpiresAtMs ?? undefined;
        return Object.freeze({
            attemptId: attempt.id,
            createdAtMs: attempt.createdAtMs,
            intent: attempt.intent,
            service: attempt.admission.service,
            ...(attempt.account ? { account: attempt.account } : {}),
            modeId: attempt.admission.modeId,
            sourceCustody: attempt.admission.sourceCustody,
            expectedCredentialRevision: attempt.expectedCredentialRevision,
            expectedCredentialConfigurationRevision:
                attempt.expectedCredentialConfigurationRevision,
            expectedConfigurationRevision: attempt.configuration.snapshot.revision,
            phase,
            ...(attempt.oauthAuthorizationUrl === null
                ? {}
                : { authorizationUrl: attempt.oauthAuthorizationUrl }),
            ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
            stagedCredentials: attempt.credentials.snapshot(),
            ...(attempt.configuration.stagedAccountConfigurationContent === undefined
                ? {}
                : {
                    stagedAccountConfigurationContent:
                        attempt.configuration.stagedAccountConfigurationContent,
                }),
            ...(attempt.preparedSettlement
                ? { preparedSettlement: attempt.preparedSettlement }
                : {}),
        });
    }

    async function acknowledgeOAuthTransaction(
        attempt: ActiveStoredAttempt,
        phase: ConnectedAccountOAuthTransactionSnapshot['phase'],
    ): Promise<void> {
        const finishDurableOperation = beginDurableOperation(attempt);
        try {
            await attempt.oauthTransaction?.acknowledge?.(
                snapshotOAuthTransaction(attempt, phase),
            );
        } finally {
            finishDurableOperation({ resumeCleanup: false });
        }
    }

    async function acknowledgeDeviceTransaction(
        attempt: ActiveStoredAttempt,
    ): Promise<void> {
        const finishDurableOperation = beginDurableOperation(attempt);
        try {
            await params.deviceTransactions?.acknowledge(
                snapshotDeviceTransaction(attempt),
            );
        } finally {
            finishDurableOperation({ resumeCleanup: false });
        }
    }

    async function checkCurrentness(
        attempt: ActiveStoredAttempt,
        _beforeProviderEntry = false,
    ): Promise<AttemptResponse | null> {
        const before = attemptOwnershipFailure(attempt);
        if (before) return before;
        if (isAttemptExpired(attempt)) {
            return {
                status: 'unavailable',
                attemptId: attempt.id,
                code: 'connected_account_attempt_expired',
            };
        }
        if (!attempt.configuration) {
            return {
                status: 'conflict',
                attemptId: attempt.id,
                code: 'connected_account_configuration_required',
            };
        }
        let configurationCurrent: boolean;
        try {
            configurationCurrent =
                await params.configuration.isCurrent(attempt.configuration.snapshot);
        } catch {
            return attemptOwnershipFailure(attempt) ?? {
                status: 'unavailable',
                attemptId: attempt.id,
                code: 'connected_account_attempt_internal_unavailable',
            };
        }
        if (!configurationCurrent) {
            return {
                status: 'conflict',
                attemptId: attempt.id,
                code: 'connected_account_configuration_changed',
            };
        }
        const afterConfiguration = attemptOwnershipFailure(attempt);
        if (afterConfiguration) return afterConfiguration;
        if (attempt.account) {
            let exact: Awaited<ReturnType<typeof params.accounts.readExact>>;
            try {
                exact = await params.accounts.readExact(attempt.account);
            } catch {
                return attemptOwnershipFailure(attempt) ?? {
                    status: 'unavailable',
                    attemptId: attempt.id,
                    code: 'connected_account_attempt_internal_unavailable',
                };
            }
            const afterAccountRead = attemptOwnershipFailure(attempt);
            if (afterAccountRead) return afterAccountRead;
            if (
                !exact
                || !sameQualifiedConnectedAccountRef(exact.account, attempt.account)
                || exact.authenticationModeId !== attempt.admission.modeId
                || exact.credentialRevision !== attempt.expectedCredentialRevision
                || exact.configurationRevision
                    !== attempt.expectedCredentialConfigurationRevision
            ) {
                return {
                    status: 'conflict',
                    attemptId: attempt.id,
                    code: 'connected_account_credential_changed',
                };
            }
        }
        return attemptOwnershipFailure(attempt);
    }

    async function readEffectfulOperationAdmissionFailure(input: Readonly<{
        intent: 'connect' | 'reconnect';
        service: PluginContributionRef;
        attemptId: string;
        authenticationModeId: string;
        authenticationModeCardinality?: 'single' | 'multiple';
        configurationState: 'unconfigured' | 'configured';
    }>): Promise<AttemptResponse | null> {
        try {
            await params.assertEffectfulOperationAllowed?.(input);
            return null;
        } catch (error) {
            const code = (
                error
                && typeof error === 'object'
                && 'code' in error
                && typeof error.code === 'string'
            )
                ? error.code
                : 'connected_account_peer_operation_admission_unavailable';
            return {
                status: 'unavailable',
                attemptId: input.attemptId,
                code,
            };
        }
    }

    async function rejectAttemptWhenEffectfulOperationIsDisallowed(
        attempt: ActiveStoredAttempt,
    ): Promise<AttemptResponse | null> {
        const failure = await readEffectfulOperationAdmissionFailure({
            intent: attempt.intent,
            service: attempt.admission.service,
            attemptId: attempt.id,
            authenticationModeId: attempt.admission.modeId,
            ...(attempt.admission.authenticationModeCardinality
                ? {
                    authenticationModeCardinality:
                        attempt.admission.authenticationModeCardinality,
                }
                : {}),
            configurationState:
                attempt.configuration?.snapshot.revision === 'unconfigured'
                    ? 'unconfigured'
                    : 'configured',
        });
        const ownershipFailure = attemptOwnershipFailure(attempt);
        if (ownershipFailure) return ownershipFailure;
        if (!failure) return null;
        attempt.phase = 'rejected';
        attempt.lastResponse = failure;
        await destroyAttempt(attempt, failure);
        return failure;
    }

    function preservePossibleProviderOutcome(
        attempt: ActiveStoredAttempt,
        currentness: AttemptResponse,
    ): AttemptResponse | null {
        if (
            currentness.status !== 'unavailable'
            || currentness.code
                !== 'connected_account_attempt_internal_unavailable'
        ) {
            return null;
        }
        attempt.phase = 'outcomeUnknown';
        const response: AttemptResponse = {
            status: 'outcomeUnknown',
            attemptId: attempt.id,
            diagnostic: {
                code: 'connected_account_provider_operation_interrupted',
            },
        };
        attempt.lastResponse = response;
        return response;
    }

    async function resolveReconciliationCurrentness(
        attempt: ActiveStoredAttempt,
        currentness: AttemptResponse,
    ): Promise<AttemptResponse> {
        if (!attempt.active || attempts.get(attempt.id) !== attempt) {
            return currentness;
        }
        const uncertain = preservePossibleProviderOutcome(
            attempt,
            currentness,
        );
        if (uncertain) return uncertain;
        await destroyAttempt(attempt, currentness);
        return currentness;
    }

    async function resolveSettlementReconciliationCurrentness(
        attempt: ActiveStoredAttempt,
        currentness: AttemptResponse,
        outcomeUnknownResponse: AttemptResponse,
    ): Promise<AttemptResponse> {
        const ownershipFailure = attemptOwnershipFailure(attempt);
        if (ownershipFailure) return ownershipFailure;
        if (
            currentness.status === 'unavailable'
                && currentness.code
                    === 'connected_account_attempt_internal_unavailable'
        ) {
            attempt.phase = 'outcomeUnknown';
            attempt.lastResponse = outcomeUnknownResponse;
            return outcomeUnknownResponse;
        }
        const response: AttemptResponse = {
            status: 'reconnectRequired',
            attemptId: attempt.id,
            code:
                'connected_account_authentication_reconciliation_unavailable',
        };
        attempt.phase = 'reconnectRequired';
        attempt.lastResponse = response;
        await destroyAttempt(attempt, response);
        return response;
    }

    async function cleanUpAfterDeviceAcknowledgementDrift(
        attempt: ActiveStoredAttempt,
        drift: AttemptResponse,
    ): Promise<void> {
        if (attemptOwnershipFailure(attempt)) {
            await compensateLateDurableWrite(attempt);
            return;
        }
        await destroyAttempt(
            attempt,
            terminalResponses.get(attempt.id)?.response ?? drift,
        );
    }

    async function compensateLateDurableWrite(
        attempt: ActiveStoredAttempt | RestoringStoredAttempt,
        target?: 'oauth' | 'device',
    ): Promise<void> {
        const current = attempts.get(attempt.id);
        if (current?.phase === 'cleanupPending') {
            if (attempt.oauthTransaction) {
                current.oauthTransaction = attempt.oauthTransaction;
            }
            current.cleanupTargets = Object.freeze({
                oauthTransaction:
                    current.cleanupTargets.oauthTransaction
                    || target === 'oauth'
                    || (
                        target === undefined
                        && attempt.oauthTransaction !== null
                    ),
                deviceTransaction:
                    current.cleanupTargets.deviceTransaction
                    || target === 'device'
                    || (
                        target === undefined
                        && 'device' in attempt
                        && attempt.device !== null
                    ),
                configuration: current.cleanupTargets.configuration,
            });
            current.cleanupTargetRevisions = Object.freeze({
                oauthTransaction:
                    current.cleanupTargetRevisions.oauthTransaction
                    + (
                        target === 'oauth'
                        || (
                            target === undefined
                            && attempt.oauthTransaction !== null
                        )
                            ? 1
                            : 0
                    ),
                deviceTransaction:
                    current.cleanupTargetRevisions.deviceTransaction
                    + (
                        target === 'device'
                        || (
                            target === undefined
                            && 'device' in attempt
                            && attempt.device !== null
                        )
                            ? 1
                            : 0
                    ),
                configuration:
                    current.cleanupTargetRevisions.configuration,
            });
            await continueCleanupAttempt(current);
            if (
                attempts.get(attempt.id) === current
                && current.pendingDurableOperations === 0
            ) {
                await continueCleanupAttempt(current);
            }
            return;
        }
        const terminalResponse =
            terminalResponses.get(attempt.id)?.response
            ?? {
                status: 'cancelled' as const,
                attemptId: attempt.id,
            };
        const cleanupAttempt: CleanupPendingStoredAttempt = {
            id: attempt.id,
            active: false,
            createdAtMs: attempt.createdAtMs,
            credentials: attempt.credentials,
            pendingDurableOperations: 0,
            oauthTransaction: attempt.oauthTransaction,
            phase: 'cleanupPending',
            lastResponse: {
                status: 'cleanupPending',
                attemptId: attempt.id,
                code: 'connected_account_attempt_cleanup_pending',
            },
            cleanupTerminalResponse: terminalResponse,
            logService: 'admission' in attempt ? attempt.admission.service : null,
            settlementPrepared: 'preparedSettlement' in attempt && attempt.preparedSettlement !== null,
            cleanupPromise: null,
            runtimeCustody: 'admission' in attempt ? attempt.admission.runtimeCustody : attempt.runtimeCustody,
            terminalResponseCustody: attempt.terminalResponseCustody ??= { released: false },
            cleanupTargets: Object.freeze({
                oauthTransaction: target === 'oauth'
                    || (target === undefined && attempt.oauthTransaction !== null),
                deviceTransaction: target === 'device'
                    || (
                        target === undefined
                        && 'device' in attempt
                        && attempt.device !== null
                    ),
                configuration: false,
            }),
            cleanupTargetRevisions: Object.freeze({
                oauthTransaction: target === 'oauth'
                    || (target === undefined && attempt.oauthTransaction !== null)
                    ? 1
                    : 0,
                deviceTransaction: target === 'device'
                    || (
                        target === undefined
                        && 'device' in attempt
                        && attempt.device !== null
                    )
                    ? 1
                    : 0,
                configuration: 0,
            }),
        };
        attempts.set(attempt.id, cleanupAttempt);
        await continueCleanupAttempt(cleanupAttempt);
    }

    function abandonRestoration(attempt: RestoringStoredAttempt): void {
        if (attempts.get(attempt.id) === attempt) {
            attempts.delete(attempt.id);
        }
        attempt.active = false;
        attempt.credentials.clear();
    }

    async function resolvePreparedAcknowledgementCurrentness(
        attempt: ActiveStoredAttempt,
        currentness: AttemptResponse,
    ): Promise<AttemptResponse> {
        if (attemptOwnershipFailure(attempt)) {
            await compensateLateDurableWrite(attempt);
            return currentness;
        }
        return await resolveReconciliationCurrentness(
            attempt,
            currentness,
        );
    }

    async function acknowledgePreparedSettlement(
        attempt: ActiveStoredAttempt,
    ): Promise<AttemptResponse | null> {
        if (attempt.preparedSettlementAcknowledged) return null;
        try {
            if (attempt.oauthTransaction) {
                await acknowledgeOAuthTransaction(attempt, 'outcomeUnknown');
            } else if (attempt.device && params.deviceTransactions) {
                await acknowledgeDeviceTransaction(attempt);
            } else {
                attempt.preparedSettlementAcknowledged = true;
                return null;
            }
        } catch {
            const ownershipFailure = attemptOwnershipFailure(attempt);
            if (ownershipFailure) {
                await compensateLateDurableWrite(
                    attempt,
                    attempt.oauthTransaction ? 'oauth' : 'device',
                );
                return ownershipFailure;
            }
            attempt.phase = 'outcomeUnknown';
            const response: AttemptResponse = {
                status: 'outcomeUnknown',
                attemptId: attempt.id,
                diagnostic: {
                    code: attempt.oauthTransaction
                        ? 'connected_account_oauth_settlement_persistence_unavailable'
                        : 'connected_account_device_settlement_persistence_unavailable',
                },
            };
            attempt.lastResponse = response;
            return response;
        }
        attempt.preparedSettlementAcknowledged = true;
        const currentness = await checkCurrentness(attempt);
        if (!currentness) return null;
        return await resolvePreparedAcknowledgementCurrentness(
            attempt,
            currentness,
        );
    }

    async function completeDecisiveSettlement(
        attempt: ActiveStoredAttempt,
        request: ConnectedAccountAttemptSettlementRequest,
        outcomeUnknownResponse: AttemptResponse,
        reconciliationOnly: boolean,
    ): Promise<AttemptResponse> {
        const operation = reconciliationOnly
            ? params.settlement.reconcile
            : params.settlement.settle;
        if (!operation) {
            const response: AttemptResponse = {
                status: 'reconnectRequired',
                attemptId: attempt.id,
                code:
                    'connected_account_authentication_reconciliation_unavailable',
            };
            attempt.phase = 'reconnectRequired';
            attempt.lastResponse = response;
            await destroyAttempt(attempt, response);
            return response;
        }
        let settlement: Awaited<ReturnType<typeof params.settlement.settle>>;
        try {
            settlement = await operation(request);
        } catch {
            const currentness = await checkCurrentness(attempt);
            if (currentness) {
                return await resolveSettlementReconciliationCurrentness(
                    attempt,
                    currentness,
                    outcomeUnknownResponse,
                );
            }
            attempt.phase = 'outcomeUnknown';
            return outcomeUnknownResponse;
        }
        const afterSettlement = attemptOwnershipFailure(attempt);
        if (afterSettlement) return afterSettlement;
        if (settlement.status !== 'connected') {
            const response: AttemptResponse = reconciliationOnly
                ? {
                    status: 'reconnectRequired',
                    attemptId: attempt.id,
                    code:
                        'connected_account_authentication_reconciliation_unavailable',
                }
                : {
                    status: settlement.status,
                    attemptId: attempt.id,
                    code: settlement.code,
                };
            attempt.lastResponse = response;
            if (reconciliationOnly) {
                attempt.phase = 'reconnectRequired';
            }
            await destroyAttempt(attempt, response);
            return response;
        }
        if (!sameQualifiedConnectedAccountRef(settlement.account, {
            service: request.service,
            accountId: request.accountId,
        })) {
            const response: AttemptResponse = {
                status: 'conflict',
                attemptId: attempt.id,
                code: 'connected_account_settlement_identity_mismatch',
            };
            attempt.lastResponse = response;
            await destroyAttempt(attempt, response);
            return response;
        }
        attempt.phase = 'connected';
        const response: AttemptResponse = {
            status: 'connected',
            attemptId: attempt.id,
            account: settlement.account,
        };
        attempt.lastResponse = response;
        await destroyAttempt(attempt, response);
        return response;
    }

    async function settlePrepared(
        attempt: ActiveStoredAttempt,
        phaseAlreadyClaimed = false,
        reconciliationOnly = false,
    ): Promise<AttemptResponse> {
        const request = attempt.preparedSettlement;
        if (!request) {
            throw new Error('Connected-account settlement must be prepared before commit');
        }
        if (!phaseAlreadyClaimed) {
            if (attempt.phase !== 'outcomeUnknown') {
                return {
                    status: 'conflict',
                    attemptId: attempt.id,
                    code: attempt.phase === 'inFlight'
                        ? 'connected_account_attempt_in_progress'
                        : 'connected_account_attempt_phase_mismatch',
                };
            }
            attempt.phase = 'inFlight';
        }
        const acknowledgement = await acknowledgePreparedSettlement(attempt);
        if (acknowledgement) return acknowledgement;
        const drift = await checkCurrentness(attempt);
        if (drift) {
            if (reconciliationOnly) {
                return await resolveSettlementReconciliationCurrentness(
                    attempt,
                    drift,
                    attempt.lastResponse ?? {
                        status: 'outcomeUnknown',
                        attemptId: attempt.id,
                        diagnostic: {
                            code:
                                'connected_account_settlement_outcome_unknown',
                        },
                    },
                );
            }
            return await resolveReconciliationCurrentness(attempt, drift);
        }
        const admissionFailure =
            await rejectAttemptWhenEffectfulOperationIsDisallowed(attempt);
        if (admissionFailure) return admissionFailure;
        const beforeSettlement = attemptOwnershipFailure(attempt);
        if (beforeSettlement) return beforeSettlement;
        const outcomeUnknownResponse: AttemptResponse = {
            status: 'outcomeUnknown',
            attemptId: attempt.id,
            diagnostic: {
                code: 'connected_account_settlement_outcome_unknown',
            },
        };
        attempt.lastResponse = outcomeUnknownResponse;

        let resolveDecisiveSettlement!: (response: AttemptResponse) => void;
        let rejectDecisiveSettlement!: (reason: unknown) => void;
        const decisiveSettlement = new Promise<AttemptResponse>((resolve, reject) => {
            resolveDecisiveSettlement = resolve;
            rejectDecisiveSettlement = reject;
        });
        attempt.decisiveSettlement = decisiveSettlement;
        void (async () => {
            try {
                resolveDecisiveSettlement(await completeDecisiveSettlement(
                    attempt,
                    request,
                    outcomeUnknownResponse,
                    reconciliationOnly,
                ));
            } catch (error) {
                rejectDecisiveSettlement(error);
            } finally {
                if (attempt.decisiveSettlement === decisiveSettlement) {
                    attempt.decisiveSettlement = null;
                }
            }
        })();
        return await decisiveSettlement;
    }

    async function settleConnected(
        attempt: ActiveStoredAttempt,
        result: Extract<ProviderResult, { status: 'connected' }>,
    ): Promise<AttemptResponse> {
        if (attempt.preparedSettlement) {
            return await settlePrepared(attempt, true);
        }
        const drift = await checkCurrentness(attempt);
        if (drift) {
            return await resolveReconciliationCurrentness(attempt, drift);
        }
        if (
            attempt.account
            && result.accountId !== undefined
            && attempt.account.accountId !== result.accountId
        ) {
            attempt.phase = 'rejected';
            const response: AttemptResponse = {
                status: 'rejected',
                attemptId: attempt.id,
                code: 'connected_account_reconnect_identity_mismatch',
            };
            attempt.lastResponse = response;
            await destroyAttempt(attempt, response);
            return response;
        }
        let accountId: string;
        if (attempt.account) {
            accountId = attempt.account.accountId;
        } else if (result.accountId !== undefined) {
            if (result.accountId === attempt.id) {
                attempt.phase = 'rejected';
                const response: AttemptResponse = {
                    status: 'rejected',
                    attemptId: attempt.id,
                    code: 'connected_account_attempt_identity_forbidden',
                };
                attempt.lastResponse = response;
                await destroyAttempt(attempt, response);
                return response;
            }
            accountId = result.accountId;
        } else {
            try {
                accountId = params.createAccountId();
            } catch {
                accountId = '';
            }
            if (!isCanonicalAccountId(accountId) || accountId === attempt.id) {
                attempt.phase = 'rejected';
                const response: AttemptResponse = {
                    status: 'unavailable',
                    attemptId: attempt.id,
                    code: 'connected_account_identity_unavailable',
                };
                attempt.lastResponse = response;
                await destroyAttempt(attempt, response);
                return response;
            }
        }
        attempt.preparedSettlement = Object.freeze({
            intent: attempt.intent,
            service: attempt.admission.service,
            accountId,
            authenticationModeId: attempt.admission.modeId,
            directExportContract:
                attempt.admission.descriptor.kind === 'manual'
                    ? attempt.admission.descriptor.directExport?.contractVersion ?? null
                    : null,
            expectedCredentialRevision: attempt.expectedCredentialRevision,
            expectedCredentialConfigurationRevision:
                attempt.expectedCredentialConfigurationRevision,
            expectedConfigurationRevision: attempt.configuration!.snapshot.revision,
            sourceCustody: attempt.admission.sourceCustody,
            stagedCredentials: attempt.credentials.snapshot(),
            ...(attempt.configuration!.stagedAccountConfigurationContent !== undefined
                ? { stagedAccountConfigurationContent: attempt.configuration!.stagedAccountConfigurationContent }
                : {}),
            ...(result.providerIdentity ? { providerIdentity: result.providerIdentity } : {}),
            displayName: result.displayName,
            scopes: Object.freeze([...result.scopes]),
        });
        attempt.preparedSettlementAcknowledged =
            !attempt.oauthTransaction && !attempt.device;
        return await settlePrepared(attempt, true);
    }

    async function handleProviderResult(
        attempt: ActiveStoredAttempt,
        result: ValidatedProviderResult,
    ): Promise<AttemptResponse> {
        if (result.status === 'connected') {
            return await settleConnected(attempt, result);
        }
        if (result.status === 'outcomeUnknown') {
            const drift = await checkCurrentness(attempt);
            if (drift) {
                const uncertain = preservePossibleProviderOutcome(
                    attempt,
                    drift,
                );
                if (uncertain) return uncertain;
            }
            if (drift) {
                attempt.lastResponse = drift;
                await destroyAttempt(attempt, drift);
                return drift;
            }
            if (attempt.admission.descriptor.outcomeReconciliation === 'none') {
                attempt.phase = 'reconnectRequired';
                const response: AttemptResponse = {
                    status: 'reconnectRequired',
                    attemptId: attempt.id,
                    code: 'connected_account_authentication_outcome_unknown',
                };
                attempt.lastResponse = response;
                await destroyAttempt(attempt, response);
                return response;
            }
            attempt.phase = 'outcomeUnknown';
            if (attempt.oauthTransaction) {
                try {
                    await acknowledgeOAuthTransaction(attempt, 'outcomeUnknown');
                } catch {
                    const ownershipFailure = attemptOwnershipFailure(attempt);
                    if (ownershipFailure) {
                        await compensateLateDurableWrite(attempt, 'oauth');
                        return ownershipFailure;
                    }
                    const response: AttemptResponse = {
                        status: 'outcomeUnknown',
                        attemptId: attempt.id,
                        diagnostic: {
                            code: 'connected_account_oauth_transaction_persistence_unavailable',
                        },
                    };
                    attempt.lastResponse = response;
                    return response;
                }
                const afterAcknowledge = await checkCurrentness(attempt);
                if (afterAcknowledge) {
                    const uncertain = preservePossibleProviderOutcome(
                        attempt,
                        afterAcknowledge,
                    );
                    if (uncertain) return uncertain;
                }
                if (
                    afterAcknowledge
                    && attemptOwnershipFailure(attempt)
                ) {
                    await compensateLateDurableWrite(attempt);
                    return afterAcknowledge;
                }
                if (afterAcknowledge) {
                    await destroyAttempt(attempt, afterAcknowledge);
                    return afterAcknowledge;
                }
            }
            const response: AttemptResponse = {
                status: 'outcomeUnknown',
                attemptId: attempt.id,
                diagnostic: result.diagnostic,
            };
            attempt.lastResponse = response;
            return response;
        }
        const drift = await checkCurrentness(attempt);
        if (drift) {
            const uncertain = preservePossibleProviderOutcome(attempt, drift);
            if (uncertain) return uncertain;
            attempt.lastResponse = drift;
            await destroyAttempt(attempt, drift);
            return drift;
        }
        if (result.status === 'awaitingOAuthRedirect') {
            // The transaction snapshot reads the provider expiry, so stage it before
            // the durable write. The actionable phase and its response stay
            // unpublished until that acknowledgement lands and the attempt is proven
            // still current: an eager read or completion must never act on
            // authorization this daemon could not recover after a restart.
            attempt.oauthExpiresAtMs = result.expiresAtMs ?? null;
            attempt.oauthAuthorizationUrl = result.authorizationUrl;
            const response: AttemptResponse = {
                status: 'awaitingOAuth',
                attemptId: attempt.id,
                authorizationUrl: result.authorizationUrl,
                callbackUrl: attempt.oauthTransaction!.request.callbackUrl,
                ...(result.expiresAtMs === undefined ? {} : { expiresAtMs: result.expiresAtMs }),
            };
            try {
                await acknowledgeOAuthTransaction(attempt, 'awaitingOAuth');
            } catch {
                const ownershipFailure = attemptOwnershipFailure(attempt);
                if (ownershipFailure) {
                    await compensateLateDurableWrite(attempt, 'oauth');
                    return ownershipFailure;
                }
                const unavailableResponse: AttemptResponse = {
                    status: 'unavailable',
                    attemptId: attempt.id,
                    code: 'connected_account_oauth_transaction_unavailable',
                };
                attempt.lastResponse = unavailableResponse;
                await destroyAttempt(attempt, unavailableResponse);
                return unavailableResponse;
            }
            const afterAcknowledge = await checkCurrentness(attempt);
            if (afterAcknowledge) {
                const uncertain = preservePossibleProviderOutcome(
                    attempt,
                    afterAcknowledge,
                );
                if (uncertain) return uncertain;
                if (attemptOwnershipFailure(attempt)) {
                    await compensateLateDurableWrite(attempt);
                } else {
                    await destroyAttempt(attempt, afterAcknowledge);
                }
                return afterAcknowledge;
            }
            attempt.phase = 'awaitingOAuth';
            attempt.lastResponse = response;
            scheduleExpiryReclaim();
            return response;
        }
        if (result.status === 'awaitingDeviceAuthorization') {
            // Same publication rule as the OAuth branch: the snapshot needs the device
            // state, but the actionable phase and response wait for the durable
            // acknowledgement and the currentness recheck.
            attempt.device = {
                expiresAtMs: result.expiresAtMs,
                pollIntervalMs: result.pollIntervalMs,
                nextPollAtMs: params.now() + result.pollIntervalMs,
                verificationUri: result.verificationUri,
                ...(result.verificationUriComplete === undefined
                    ? {}
                    : { verificationUriComplete: result.verificationUriComplete }),
                userCode: result.userCode,
            };
            try {
                await acknowledgeDeviceTransaction(attempt);
            } catch {
                const ownershipFailure = attemptOwnershipFailure(attempt);
                if (ownershipFailure) {
                    await compensateLateDurableWrite(attempt, 'device');
                    return ownershipFailure;
                }
                const response: AttemptResponse = {
                    status: 'unavailable',
                    attemptId: attempt.id,
                    code: 'connected_account_device_transaction_unavailable',
                };
                await destroyAttempt(attempt, response);
                return response;
            }
            const afterAcknowledge = await checkCurrentness(attempt);
            if (afterAcknowledge) {
                const uncertain = preservePossibleProviderOutcome(
                    attempt,
                    afterAcknowledge,
                );
                if (uncertain) return uncertain;
                await cleanUpAfterDeviceAcknowledgementDrift(attempt, afterAcknowledge);
                return afterAcknowledge;
            }
            const response: AttemptResponse = {
                status: 'awaitingDeviceAuthorization',
                attemptId: attempt.id,
                verificationUri: result.verificationUri,
                ...(result.verificationUriComplete === undefined
                    ? {}
                    : { verificationUriComplete: result.verificationUriComplete }),
                userCode: result.userCode,
                expiresAtMs: result.expiresAtMs,
                pollIntervalMs: result.pollIntervalMs,
            };
            attempt.phase = 'awaitingDeviceAuthorization';
            attempt.lastResponse = response;
            scheduleExpiryReclaim();
            return response;
        }
        if (result.status === 'pending') {
            const republishesDevicePhase =
                attempt.admission.descriptor.kind === 'oauthDeviceCode';
            // `outcomeUnknown` is an uncertainty phase, not an actionable one, so it is
            // published immediately. The device phase re-publication waits for the same
            // acknowledgement and currentness recheck as its first publication.
            if (!republishesDevicePhase) attempt.phase = 'outcomeUnknown';
            if (attempt.oauthTransaction) {
                try {
                    await acknowledgeOAuthTransaction(attempt, 'outcomeUnknown');
                } catch {
                    const ownershipFailure = attemptOwnershipFailure(attempt);
                    if (ownershipFailure) {
                        await compensateLateDurableWrite(attempt, 'oauth');
                        return ownershipFailure;
                    }
                    const response: AttemptResponse = {
                        status: 'outcomeUnknown',
                        attemptId: attempt.id,
                        diagnostic: {
                            code: 'connected_account_oauth_transaction_persistence_unavailable',
                        },
                    };
                    attempt.lastResponse = response;
                    return response;
                }
                const afterAcknowledge = await checkCurrentness(attempt);
                if (afterAcknowledge) {
                    const uncertain = preservePossibleProviderOutcome(
                        attempt,
                        afterAcknowledge,
                    );
                    if (uncertain) return uncertain;
                    if (attemptOwnershipFailure(attempt)) {
                        await compensateLateDurableWrite(attempt);
                    } else {
                        await destroyAttempt(attempt, afterAcknowledge);
                    }
                    return afterAcknowledge;
                }
            }
            if (attempt.device) {
                attempt.device.pollIntervalMs = Math.max(
                    attempt.device.pollIntervalMs,
                    result.retryAfterMs,
                );
                attempt.device.nextPollAtMs = params.now() + attempt.device.pollIntervalMs;
                try {
                    await acknowledgeDeviceTransaction(attempt);
                } catch {
                    const ownershipFailure = attemptOwnershipFailure(attempt);
                    if (ownershipFailure) {
                        await compensateLateDurableWrite(attempt, 'device');
                        return ownershipFailure;
                    }
                    const response: AttemptResponse = {
                        status: 'unavailable',
                        attemptId: attempt.id,
                        code: 'connected_account_device_transaction_unavailable',
                    };
                    attempt.lastResponse = response;
                    await destroyAttempt(attempt, response);
                    return response;
                }
                const afterAcknowledge = await checkCurrentness(attempt);
                if (afterAcknowledge) {
                    const uncertain = preservePossibleProviderOutcome(
                        attempt,
                        afterAcknowledge,
                    );
                    if (uncertain) return uncertain;
                    await cleanUpAfterDeviceAcknowledgementDrift(attempt, afterAcknowledge);
                    return afterAcknowledge;
                }
            }
            if (republishesDevicePhase) {
                attempt.phase = 'awaitingDeviceAuthorization';
            }
            const response: AttemptResponse = {
                status: 'pending',
                attemptId: attempt.id,
                retryAfterMs: result.retryAfterMs,
            };
            attempt.lastResponse = response;
            return response;
        }
        attempt.phase = 'rejected';
        const response: AttemptResponse = {
            status: result.status,
            attemptId: attempt.id,
            code: diagnosticCode(
                result.diagnostic,
                result.status === 'rejected'
                    ? 'connected_account_authentication_rejected'
                    : 'connected_account_authentication_unavailable',
            ),
            diagnostic: result.diagnostic,
            ...(result.failureClass === undefined
                ? {}
                : { failureClass: result.failureClass }),
            ...(result.retryNotBeforeMs === undefined
                ? {}
                : { retryNotBeforeMs: result.retryNotBeforeMs }),
        };
        attempt.lastResponse = response;
        await destroyAttempt(attempt, response);
        return response;
    }

    async function invoke(
        attempt: ActiveStoredAttempt,
        operation: ConnectedAccountAttemptProviderOperation,
        signal?: AbortSignal,
    ): Promise<AttemptResponse> {
        if (isAttemptExpired(attempt)) return (await expireAttemptIfNeeded(attempt))!;
        attempt.phase = 'inFlight';
        const before = await checkCurrentness(attempt, true);
        if (before) {
            attempt.phase = 'rejected';
            attempt.lastResponse = before;
            await destroyAttempt(attempt, before);
            return before;
        }
        const admissionFailure =
            await rejectAttemptWhenEffectfulOperationIsDisallowed(attempt);
        if (admissionFailure) return admissionFailure;
        const afterAdmissionCurrentness = await checkCurrentness(attempt, true);
        if (afterAdmissionCurrentness) {
            const ownershipFailure = attemptOwnershipFailure(attempt);
            if (ownershipFailure) return ownershipFailure;
            attempt.phase = 'rejected';
            attempt.lastResponse = afterAdmissionCurrentness;
            await destroyAttempt(attempt, afterAdmissionCurrentness);
            return afterAdmissionCurrentness;
        }
        const beforeInvocation = attemptOwnershipFailure(attempt);
        if (beforeInvocation) return beforeInvocation;
        let result: unknown;
        try {
            result = await params.runtime.invoke({
                admission: attempt.admission,
                operation,
                context: contextFor(attempt),
                ...(signal ? { signal } : {}),
            });
        } catch {
            result = {
                status: 'outcomeUnknown',
                diagnostic: {
                    code: 'connected_account_provider_operation_interrupted',
                    severity: 'error',
                },
            };
        }
        return await handleProviderResult(
            attempt,
            snapshotProviderResult(result),
        );
    }

    async function beginProviderFlow(attempt: ActiveStoredAttempt): Promise<AttemptResponse> {
        if (attempt.admission.descriptor.kind === 'manual') return attempt.lastResponse!;
        const beforeProviderFlow = attemptOwnershipFailure(attempt);
        if (beforeProviderFlow) return beforeProviderFlow;
        if (attempt.admission.descriptor.kind === 'oauthDeviceCode') {
            if (params.deviceTransactions) {
                let existingTransaction: ConnectedAccountDeviceTransactionSnapshot | null;
                try {
                    existingTransaction = await params.deviceTransactions.read(
                        attempt.id,
                    );
                } catch {
                    const response: AttemptResponse = {
                        status: 'unavailable',
                        attemptId: attempt.id,
                        code:
                            'connected_account_device_transaction_unavailable',
                    };
                    attempt.lastResponse = response;
                    await destroyAttempt(attempt, response, {
                        // The availability read failed before a transaction or
                        // provider effect existed, so retrying the same failed
                        // remote cleanup would turn a safe refusal into a
                        // permanent cleanup-pending loop.
                        skipDeviceTransactionCleanup: true,
                    });
                    return response;
                }
                if (existingTransaction !== null) {
                    const response: AttemptResponse = {
                        status: 'conflict',
                        attemptId: attempt.id,
                        code: 'connected_account_device_transaction_conflict',
                    };
                    attempt.lastResponse = response;
                    await destroyAttempt(attempt, response, {
                        // A colliding durable identity is not this attempt's
                        // transaction and must never be deleted by it.
                        skipDeviceTransactionCleanup: true,
                    });
                    return response;
                }
            }
            return await invoke(attempt, { kind: 'beginDevice' });
        }
        attempt.phase = 'inFlight';
        const before = await checkCurrentness(attempt, true);
        if (before) {
            await destroyAttempt(attempt, before);
            return before;
        }
        const operationAdmissionFailure =
            await rejectAttemptWhenEffectfulOperationIsDisallowed(attempt);
        if (operationAdmissionFailure) return operationAdmissionFailure;
        const beforeTransaction = attemptOwnershipFailure(attempt);
        if (beforeTransaction) return beforeTransaction;
        let transaction: StoredAttempt['oauthTransaction'];
        const finishDurableOperation = beginDurableOperation(attempt);
        try {
            transaction = await params.oauth.create({
                attemptId: attempt.id,
                service: attempt.admission.service,
                snapshot: snapshotOAuthTransaction(attempt, 'starting'),
                ...(attempt.admission.descriptor.callbackUrl
                    ? { callbackUrl: attempt.admission.descriptor.callbackUrl }
                    : {}),
            });
        } catch {
            finishDurableOperation();
            const ownershipFailure = attemptOwnershipFailure(attempt);
            if (ownershipFailure) return ownershipFailure;
            const response: AttemptResponse = {
                status: 'unavailable',
                attemptId: attempt.id,
                code: 'connected_account_oauth_transaction_unavailable',
            };
            await destroyAttempt(attempt, response);
            return response;
        }
        attempt.oauthTransaction = transaction;
        const ownershipFailure = attemptOwnershipFailure(attempt);
        if (ownershipFailure) {
            try {
                await compensateLateDurableWrite(attempt, 'oauth');
            } finally {
                finishDurableOperation();
            }
            return ownershipFailure;
        }
        finishDurableOperation();
        const afterTransaction = await checkCurrentness(attempt, true);
        if (afterTransaction) {
            if (attemptOwnershipFailure(attempt)) {
                await compensateLateDurableWrite(attempt, 'oauth');
            } else {
                await destroyAttempt(attempt, afterTransaction);
            }
            return afterTransaction;
        }
        return await invoke(attempt, {
            kind: 'beginOAuth',
            request: transaction.request,
        });
    }

    function startProviderFlowInBackground(attempt: ActiveStoredAttempt): void {
        const report = (response: AttemptResponse) => {
            try {
                params.onBackgroundTransition?.({
                    response,
                    service: attempt.admission.service,
                    settlementPhase: attempt.preparedSettlement
                        ? attempt.active ? 'prepared' : 'settled'
                        : 'notPrepared',
                });
            } catch {
                // Observability cannot turn a completed provider transition into a failure.
            }
        };
        void beginProviderFlow(attempt).then(report).catch(async () => {
            if (!attempt.active || attempts.get(attempt.id) !== attempt) return;
            const response: AttemptResponse = {
                status: 'unavailable',
                attemptId: attempt.id,
                code: 'connected_account_attempt_internal_unavailable',
            };
            attempt.lastResponse = response;
            try {
                await destroyAttempt(attempt, response);
            } catch {
                // destroyAttempt retains cleanup failures for the cleanup retry path.
            }
            report(response);
        });
    }

    async function restoreOAuthAttempt(
        attemptId: string,
    ): Promise<
        | Readonly<{ attempt: ActiveStoredAttempt }>
        | Readonly<{ response: AttemptResponse }>
    > {
        if (!params.oauth.read) {
            return { response: unavailable(attemptId) };
        }
        const credentials = createAttemptCredentialStore();
        const restoration: RestoringStoredAttempt = {
            id: attemptId,
            active: true,
            createdAtMs: params.now(),
            credentials,
            pendingDurableOperations: 0,
            oauthTransaction: null,
            phase: 'restoring',
            lastResponse: {
                status: 'pending',
                attemptId,
                retryAfterMs: 1,
            },
            cleanupTerminalResponse: null,
        };
        if (!installRestoration(restoration)) {
            credentials.clear();
            return {
                response: {
                    status: 'conflict',
                    attemptId,
                    code: 'connected_account_attempt_capacity_exhausted',
                },
            };
        }
        let transaction: Awaited<ReturnType<NonNullable<typeof params.oauth.read>>>;
        const finishDurableOperation = beginDurableOperation(restoration);
        try {
            transaction = await params.oauth.read(attemptId);
        } catch {
            finishDurableOperation();
            const ownershipFailure = attemptOwnershipFailure(restoration);
            if (ownershipFailure) {
                return { response: ownershipFailure };
            }
            abandonRestoration(restoration);
            return {
                response: {
                    status: 'unavailable',
                    attemptId,
                    code: 'connected_account_oauth_transaction_unavailable',
                },
            };
        }
        const afterRead = attemptOwnershipFailure(restoration);
        if (afterRead) {
            if (transaction) {
                restoration.oauthTransaction = transaction;
                try {
                    await compensateLateDurableWrite(restoration, 'oauth');
                } finally {
                    finishDurableOperation();
                }
            } else {
                finishDurableOperation();
            }
            return { response: afterRead };
        }
        finishDurableOperation();
        if (!transaction) {
            abandonRestoration(restoration);
            return { response: unavailable(attemptId) };
        }
        restoration.oauthTransaction = transaction;
        let snapshot = transaction.snapshot;
        restoration.createdAtMs = snapshot?.createdAtMs ?? params.now();
        const cleanUpTerminal = async (
            response: AttemptResponse,
        ): Promise<Readonly<{ response: AttemptResponse }>> => ({
            response: await (async () => {
                await destroyAttempt(restoration, response, {
                    retainTerminalResponse: false,
                });
                return response;
            })(),
        });
        if (
            !snapshot
            || snapshot.attemptId !== attemptId
            || snapshot.modeId.length === 0
            || !snapshot.sourceCustody
            || !Number.isFinite(snapshot.createdAtMs)
            || (
                snapshot.expiresAtMs !== undefined
                && (
                    !Number.isFinite(snapshot.expiresAtMs)
                    || snapshot.expiresAtMs <= params.now()
                )
            )
            || snapshot.phase === 'starting'
            || (
                snapshot.expectedCredentialConfigurationRevision !== null
                && (
                    typeof snapshot.expectedCredentialConfigurationRevision
                        !== 'string'
                    || snapshot.expectedCredentialConfigurationRevision.length === 0
                )
            )
            || (
                snapshot.intent === 'connect'
                ? (
                    snapshot.account !== undefined
                    || snapshot.expectedCredentialConfigurationRevision !== null
                )
                : snapshot.account === undefined
            )
        ) {
            return await cleanUpTerminal({
                status: 'unavailable',
                attemptId,
                code: snapshot?.phase === 'starting'
                    ? 'connected_account_oauth_authorization_interrupted'
                    : 'connected_account_attempt_not_found',
            });
        }
        const operationAdmissionFailure =
            await readEffectfulOperationAdmissionFailure({
                intent: snapshot.intent,
                service: snapshot.service,
                attemptId,
                authenticationModeId: snapshot.modeId,
                configurationState:
                    snapshot.expectedConfigurationRevision === 'unconfigured'
                        ? 'unconfigured'
                        : 'configured',
            });
        const afterOperationAdmission =
            attemptOwnershipFailure(restoration);
        if (afterOperationAdmission) {
            return { response: afterOperationAdmission };
        }
        if (operationAdmissionFailure) {
            return await cleanUpTerminal(operationAdmissionFailure);
        }
            let admitted: ConnectedAccountAttemptModeAdmission;
            try {
                admitted = await params.runtime.admit({
                    service: snapshot.service,
                    modeId: snapshot.modeId,
                });
            } catch (error) {
                const ownershipFailure = attemptOwnershipFailure(restoration);
                if (ownershipFailure) return { response: ownershipFailure };
                return await cleanUpTerminal({
                    ...runtimeAdmissionFailure(error),
                    attemptId,
                });
            }
            const afterAdmission = attemptOwnershipFailure(restoration);
            if (afterAdmission) {
                await admitted.runtimeCustody?.release();
                return { response: afterAdmission };
            }
            restoration.runtimeCustody = admitted.runtimeCustody;
            let runtimeCurrent: boolean;
            try {
                runtimeCurrent = await params.runtime.isCurrent(admitted);
            } catch (error) {
                const ownershipFailure = attemptOwnershipFailure(restoration);
                if (ownershipFailure) return { response: ownershipFailure };
                return await cleanUpTerminal({
                    ...runtimeAdmissionFailure(error),
                    attemptId,
                });
            }
            const afterRuntime = attemptOwnershipFailure(restoration);
            if (afterRuntime) return { response: afterRuntime };
            if (
                admitted.descriptor.kind !== 'oauthAuthorizationCode'
                || admitted.descriptor.id !== snapshot.modeId
                || !snapshotSourceMatchesAdmission(snapshot, admitted)
                || !sameService(admitted.service, snapshot.service)
                || !runtimeCurrent
            ) {
                return await cleanUpTerminal({
                    status: 'conflict',
                    attemptId,
                    code: 'connected_account_runtime_generation_changed',
                });
            }
            if (snapshot.intent === 'reconnect') {
                let exact: Awaited<ReturnType<typeof params.accounts.readExact>>;
                try {
                    exact = await params.accounts.readExact(snapshot.account!);
                } catch {
                    const ownershipFailure = attemptOwnershipFailure(restoration);
                    if (ownershipFailure) return { response: ownershipFailure };
                    return await cleanUpTerminal({
                        status: 'unavailable',
                        attemptId,
                        code: 'connected_account_attempt_internal_unavailable',
                    });
                }
                const afterAccountRead = attemptOwnershipFailure(restoration);
                if (afterAccountRead) return { response: afterAccountRead };
                if (
                    !exact
                    || !sameQualifiedConnectedAccountRef(exact.account, snapshot.account!)
                    || exact.authenticationModeId !== snapshot.modeId
                    || exact.credentialRevision !== snapshot.expectedCredentialRevision
                    || exact.configurationRevision
                        !== snapshot.expectedCredentialConfigurationRevision
                ) {
                    return await cleanUpTerminal({
                        status: 'conflict',
                        attemptId,
                        code: 'connected_account_credential_changed',
                    });
                }
            }
            let configuration: ConnectedAccountAttemptConfigurationAdmission;
            try {
                configuration = await params.configuration.admit({
                    intent: snapshot.intent,
                    service: snapshot.service,
                    ...(snapshot.account ? { account: snapshot.account } : {}),
                    mode: admitted.descriptor,
                    occurrenceId: admitted.occurrenceId,
                    sourceCustody: admitted.sourceCustody,
                    ...(snapshot.intent === 'connect' ? { attemptId: snapshot.attemptId } : {}),
                    expectedConfigurationRevision: snapshot.expectedConfigurationRevision,
                });
            } catch {
                const ownershipFailure = attemptOwnershipFailure(restoration);
                if (ownershipFailure) return { response: ownershipFailure };
                return await cleanUpTerminal({
                    status: 'unavailable',
                    attemptId,
                    code: 'connected_account_configuration_unavailable',
                });
            }
            const afterConfiguration = attemptOwnershipFailure(restoration);
            if (afterConfiguration) return { response: afterConfiguration };
            if (
                configuration.status !== 'ready'
                || configuration.snapshot.revision !== snapshot.expectedConfigurationRevision
            ) {
                return await cleanUpTerminal({
                    status: 'conflict',
                    attemptId,
                    code: 'connected_account_configuration_changed',
                });
            }
            try {
                for (const [key, value] of Object.entries(snapshot.stagedCredentials)) {
                    await credentials.set(key, value);
                }
            } catch {
                return await cleanUpTerminal({
                    status: 'conflict',
                    attemptId,
                    code: 'connected_account_oauth_transaction_invalid',
                });
            }
            const afterCredentials = attemptOwnershipFailure(restoration);
            if (afterCredentials) {
                credentials.clear();
                return { response: afterCredentials };
            }
            const preparedSettlement = snapshot.preparedSettlement;
            if (
                preparedSettlement
                && (
                    preparedSettlement.intent !== snapshot.intent
                    || !sameService(preparedSettlement.service, snapshot.service)
                    || !pluginSourceCustodyV1Equal(
                        preparedSettlement.sourceCustody,
                        admitted.sourceCustody,
                    )
                    || preparedSettlement.authenticationModeId !== snapshot.modeId
                    || preparedSettlement.expectedCredentialRevision !== snapshot.expectedCredentialRevision
                    || preparedSettlement.expectedCredentialConfigurationRevision
                        !== snapshot.expectedCredentialConfigurationRevision
                    || preparedSettlement.expectedConfigurationRevision !== snapshot.expectedConfigurationRevision
                    || !isCanonicalAccountId(preparedSettlement.accountId)
                    || (
                        snapshot.account !== undefined
                        && !sameQualifiedConnectedAccountRef({
                            service: preparedSettlement.service,
                            accountId: preparedSettlement.accountId,
                        }, snapshot.account)
                    )
                )
            ) {
                return await cleanUpTerminal({
                    status: 'conflict',
                    attemptId,
                    code: 'connected_account_oauth_transaction_invalid',
                });
            }
            const response: AttemptResponse = snapshot.phase === 'awaitingOAuth'
                ? {
                    status: 'awaitingOAuth',
                    attemptId,
                    callbackUrl: transaction.request.callbackUrl,
                    ...(snapshot.authorizationUrl === undefined
                        ? {}
                        : { authorizationUrl: snapshot.authorizationUrl }),
                    ...(snapshot.expiresAtMs === undefined
                        ? {}
                        : { expiresAtMs: snapshot.expiresAtMs }),
                }
                : {
                    status: 'outcomeUnknown',
                    attemptId,
                    diagnostic: {
                        code: preparedSettlement
                            ? 'connected_account_settlement_outcome_unknown'
                            : 'connected_account_provider_operation_interrupted',
                    },
                };
            const attempt: ActiveStoredAttempt = {
                id: snapshot.attemptId,
                active: true,
                createdAtMs: snapshot.createdAtMs,
                intent: snapshot.intent,
                account: snapshot.account ?? null,
                expectedCredentialRevision: snapshot.expectedCredentialRevision,
                expectedCredentialConfigurationRevision:
                    snapshot.expectedCredentialConfigurationRevision,
                admission: Object.freeze({
                    ...admitted,
                    modeId: admitted.descriptor.id,
                }),
                configuration,
                credentials,
                pendingDurableOperations: 0,
                preparedSettlement: preparedSettlement ?? null,
                preparedSettlementAcknowledged: preparedSettlement !== undefined,
                decisiveSettlement: null,
                oauthTransaction: transaction,
                oauthExpiresAtMs: snapshot.expiresAtMs ?? null,
                oauthAuthorizationUrl: snapshot.authorizationUrl ?? null,
                device: null,
                phase: snapshot.phase,
                lastResponse: response,
                cleanupTerminalResponse: null,
            };
            const beforeActivation = attemptOwnershipFailure(restoration);
            if (beforeActivation) return { response: beforeActivation };
            attempts.set(attempt.id, attempt);
            scheduleExpiryReclaim();
            return { attempt };
    }

    return Object.freeze({
        releaseTerminalResponse(attemptId) {
            const terminal = terminalResponses.get(attemptId);
            if (terminal) terminal.custody.released = true;
            terminalResponses.delete(attemptId);
            const attempt = attempts.get(attemptId);
            if (attempt?.phase === 'cleanupPending') attempt.terminalResponseCustody.released = true;
        },
        inspectObservability(attemptId) {
            const attempt = attempts.get(attemptId);
            if (attempt?.phase === 'cleanupPending') {
                return Object.freeze({
                    service: attempt.logService,
                    settlementPhase: 'cleanupPending' as const,
                });
            }
            if (attempt?.phase === 'restoring') {
                return Object.freeze({ service: null, settlementPhase: 'notPrepared' as const });
            }
            if (attempt) {
                return Object.freeze({
                    service: attempt.admission.service,
                    settlementPhase: attempt.preparedSettlement
                        ? attempt.phase === 'inFlight' ? 'settling' as const : 'prepared' as const
                        : 'notPrepared' as const,
                });
            }
            const terminal = terminalResponses.get(attemptId);
            return terminal ? Object.freeze({
                service: terminal.service,
                settlementPhase: terminal.settlementPrepared ? 'settled' as const : 'notPrepared' as const,
            }) : null;
        },
        async beginConnect(input) {
            return await begin({
                intent: 'connect',
                service: input.service,
                account: null,
                modeId: input.modeId,
                expectedCredentialRevision: null,
                expectedCredentialConfigurationRevision: null,
                ...(input.expectedConfigurationRevision
                    ? { expectedConfigurationRevision: input.expectedConfigurationRevision }
                    : {}),
            });
        },
        async beginReconnect(input) {
            const exact = await params.accounts.readExact(input.account);
            if (!exact || !sameQualifiedConnectedAccountRef(exact.account, input.account)) {
                return {
                    status: 'unavailable',
                    code: 'connected_account_not_found',
                };
            }
            return await begin({
                intent: 'reconnect',
                service: exact.account.service,
                account: exact.account,
                modeId: exact.authenticationModeId,
                expectedCredentialRevision: exact.credentialRevision,
                expectedCredentialConfigurationRevision:
                    exact.configurationRevision,
                ...(input.expectedConfigurationRevision
                    ? { expectedConfigurationRevision: input.expectedConfigurationRevision }
                : {}),
            });
        },
        async resolveConfigurationControlTarget(input) {
            const attempt = readAttempt(input.attemptId);
            if (
                !attempt
                || !attempt.active
                || attempt.phase !== 'configurationRequired'
                || attempt.lastResponse?.status !== 'configurationRequired'
                || attempt.lastResponse.target.kind !== 'attempt'
                || attempt.lastResponse.target.attemptId !== attempt.id
                || !sameService(
                    attempt.lastResponse.target.service,
                    attempt.admission.service,
                )
                || attempt.lastResponse.target.modeId !== attempt.admission.modeId
            ) {
                return null;
            }
            const target = attempt.lastResponse.target;
            attempt.phase = 'inFlight';
            let runtimeCurrent: boolean;
            try {
                runtimeCurrent =
                    await params.runtime.isCurrent(attempt.admission);
            } catch {
                if (attemptOwnershipFailure(attempt)) return null;
                attempt.phase = 'configurationRequired';
                return null;
            }
            if (attemptOwnershipFailure(attempt)) return null;
            attempt.phase = 'configurationRequired';
            if (!runtimeCurrent) return null;
            return Object.freeze({
                target,
                mode: attempt.admission.descriptor,
                occurrenceId: attempt.admission.occurrenceId,
                sourceCustody: attempt.admission.sourceCustody,
            });
        },
        async resumeDevice(input) {
            const deviceTransactions = params.deviceTransactions;
            if (!deviceTransactions) {
                return {
                    status: 'unavailable',
                    attemptId: input.attemptId,
                    code: 'connected_account_device_transaction_unavailable',
                };
            }
            const credentials = createAttemptCredentialStore();
            const restoration: RestoringStoredAttempt = {
                id: input.attemptId,
                active: true,
                createdAtMs: params.now(),
                credentials,
                pendingDurableOperations: 0,
                oauthTransaction: null,
                phase: 'restoring',
                lastResponse: {
                    status: 'pending',
                    attemptId: input.attemptId,
                    retryAfterMs: 1,
                },
                cleanupTerminalResponse: null,
            };
            if (!installRestoration(restoration)) {
                credentials.clear();
                return {
                    status: 'conflict',
                    attemptId: input.attemptId,
                    code: 'connected_account_attempt_capacity_exhausted',
                };
            }
            let snapshot: Awaited<ReturnType<typeof deviceTransactions.read>>;
            const finishDurableOperation =
                beginDurableOperation(restoration);
            try {
                snapshot = await deviceTransactions.read(input.attemptId);
            } catch {
                finishDurableOperation();
                const ownershipFailure = attemptOwnershipFailure(restoration);
                if (ownershipFailure) return ownershipFailure;
                abandonRestoration(restoration);
                return {
                    status: 'unavailable',
                    attemptId: input.attemptId,
                    code: 'connected_account_device_transaction_unavailable',
                };
            }
            const afterRead = attemptOwnershipFailure(restoration);
            if (afterRead) {
                if (snapshot) {
                    try {
                        await compensateLateDurableWrite(
                            restoration,
                            'device',
                        );
                    } finally {
                        finishDurableOperation();
                    }
                } else {
                    finishDurableOperation();
                }
                return afterRead;
            }
            finishDurableOperation();
            if (!snapshot) {
                abandonRestoration(restoration);
                return unavailable(input.attemptId);
            }
            restoration.createdAtMs = snapshot.createdAtMs;
            const cleanUpTerminal = async (
                response: AttemptResponse,
            ): Promise<AttemptResponse> => {
                await destroyAttempt(restoration, response, {
                    retainTerminalResponse: false,
                });
                return response;
            };
            if (
                snapshot.attemptId !== input.attemptId
                || snapshot.expiresAtMs <= params.now()
                || snapshot.modeId.length === 0
                || !snapshot.sourceCustody
                || (
                    snapshot.expectedCredentialConfigurationRevision !== null
                    && (
                        typeof snapshot.expectedCredentialConfigurationRevision
                            !== 'string'
                        || snapshot.expectedCredentialConfigurationRevision.length === 0
                    )
                )
                || (
                    snapshot.intent === 'connect'
                    && snapshot.expectedCredentialConfigurationRevision !== null
                )
            ) {
                return await cleanUpTerminal({
                    status: 'unavailable',
                    attemptId: input.attemptId,
                    code: 'connected_account_device_authorization_expired',
                });
            }
            const operationAdmissionFailure =
                await readEffectfulOperationAdmissionFailure({
                    intent: snapshot.intent,
                    service: snapshot.service,
                    attemptId: input.attemptId,
                    authenticationModeId: snapshot.modeId,
                    configurationState:
                        snapshot.expectedConfigurationRevision
                            === 'unconfigured'
                            ? 'unconfigured'
                            : 'configured',
                });
            const afterOperationAdmission =
                attemptOwnershipFailure(restoration);
            if (afterOperationAdmission) return afterOperationAdmission;
            if (operationAdmissionFailure) {
                return await cleanUpTerminal(operationAdmissionFailure);
            }
                let admitted: ConnectedAccountAttemptModeAdmission;
                try {
                    admitted = await params.runtime.admit({
                        service: snapshot.service,
                        modeId: snapshot.modeId,
                    });
                } catch (error) {
                    const ownershipFailure =
                        attemptOwnershipFailure(restoration);
                    if (ownershipFailure) return ownershipFailure;
                    return await cleanUpTerminal({
                        ...runtimeAdmissionFailure(error),
                        attemptId: input.attemptId,
                    });
                }
                const afterAdmission = attemptOwnershipFailure(restoration);
                if (afterAdmission) {
                    await admitted.runtimeCustody?.release();
                    return afterAdmission;
                }
                restoration.runtimeCustody = admitted.runtimeCustody;
                let runtimeCurrent: boolean;
                try {
                    runtimeCurrent = await params.runtime.isCurrent(admitted);
                } catch (error) {
                    const ownershipFailure =
                        attemptOwnershipFailure(restoration);
                    if (ownershipFailure) return ownershipFailure;
                    return await cleanUpTerminal({
                        ...runtimeAdmissionFailure(error),
                        attemptId: input.attemptId,
                    });
                }
                const afterRuntime = attemptOwnershipFailure(restoration);
                if (afterRuntime) return afterRuntime;
                if (
                    admitted.descriptor.kind !== 'oauthDeviceCode'
                    || admitted.descriptor.id !== snapshot.modeId
                    || !snapshotSourceMatchesAdmission(snapshot, admitted)
                    || !sameService(admitted.service, snapshot.service)
                    || !runtimeCurrent
                ) {
                    return await cleanUpTerminal({
                        status: 'conflict',
                        attemptId: input.attemptId,
                        code: 'connected_account_runtime_generation_changed',
                    });
                }
                if (snapshot.intent === 'reconnect') {
                    if (!snapshot.account) {
                        return await cleanUpTerminal({
                            status: 'conflict',
                            attemptId: input.attemptId,
                            code: 'connected_account_device_transaction_invalid',
                        });
                    }
                    let exact: Awaited<ReturnType<typeof params.accounts.readExact>>;
                    try {
                        exact = await params.accounts.readExact(snapshot.account);
                    } catch {
                        const ownershipFailure =
                            attemptOwnershipFailure(restoration);
                        if (ownershipFailure) return ownershipFailure;
                        return await cleanUpTerminal({
                            status: 'unavailable',
                            attemptId: input.attemptId,
                            code: 'connected_account_attempt_internal_unavailable',
                        });
                    }
                    const afterAccountRead =
                        attemptOwnershipFailure(restoration);
                    if (afterAccountRead) return afterAccountRead;
                    if (
                        !exact
                        || !sameQualifiedConnectedAccountRef(exact.account, snapshot.account)
                        || exact.authenticationModeId !== snapshot.modeId
                        || exact.credentialRevision !== snapshot.expectedCredentialRevision
                        || exact.configurationRevision
                            !== snapshot.expectedCredentialConfigurationRevision
                    ) {
                        return await cleanUpTerminal({
                            status: 'conflict',
                            attemptId: input.attemptId,
                            code: 'connected_account_credential_changed',
                        });
                    }
                }
                let configuration: ConnectedAccountAttemptConfigurationAdmission;
                try {
                    configuration = await params.configuration.admit({
                        intent: snapshot.intent,
                        service: snapshot.service,
                        ...(snapshot.account ? { account: snapshot.account } : {}),
                        mode: admitted.descriptor,
                        occurrenceId: admitted.occurrenceId,
                        sourceCustody: admitted.sourceCustody,
                        ...(snapshot.intent === 'connect' ? { attemptId: snapshot.attemptId } : {}),
                        expectedConfigurationRevision: snapshot.expectedConfigurationRevision,
                    });
                } catch {
                    const ownershipFailure =
                        attemptOwnershipFailure(restoration);
                    if (ownershipFailure) return ownershipFailure;
                    return await cleanUpTerminal({
                        status: 'unavailable',
                        attemptId: input.attemptId,
                        code: 'connected_account_configuration_unavailable',
                    });
                }
                const afterConfiguration =
                    attemptOwnershipFailure(restoration);
                if (afterConfiguration) return afterConfiguration;
                if (
                    configuration.status !== 'ready'
                    || configuration.snapshot.revision !== snapshot.expectedConfigurationRevision
                ) {
                    return await cleanUpTerminal({
                        status: 'conflict',
                        attemptId: input.attemptId,
                        code: 'connected_account_configuration_changed',
                    });
                }
                try {
                    for (const [key, value] of Object.entries(snapshot.stagedCredentials)) {
                        await credentials.set(key, value);
                    }
                } catch {
                    return await cleanUpTerminal({
                        status: 'conflict',
                        attemptId: input.attemptId,
                        code: 'connected_account_device_transaction_invalid',
                    });
                }
                const afterCredentials =
                    attemptOwnershipFailure(restoration);
                if (afterCredentials) {
                    credentials.clear();
                    return afterCredentials;
                }
                const preparedSettlement = snapshot.preparedSettlement;
                if (
                    preparedSettlement
                    && (
                        preparedSettlement.intent !== snapshot.intent
                        || !sameService(preparedSettlement.service, snapshot.service)
                        || !pluginSourceCustodyV1Equal(
                            preparedSettlement.sourceCustody,
                            admitted.sourceCustody,
                        )
                        || preparedSettlement.authenticationModeId !== snapshot.modeId
                        || preparedSettlement.expectedCredentialRevision !== snapshot.expectedCredentialRevision
                        || preparedSettlement.expectedCredentialConfigurationRevision
                            !== snapshot.expectedCredentialConfigurationRevision
                        || preparedSettlement.expectedConfigurationRevision !== snapshot.expectedConfigurationRevision
                        || !isCanonicalAccountId(preparedSettlement.accountId)
                        || (
                            snapshot.account !== undefined
                            && !sameQualifiedConnectedAccountRef({
                                service: preparedSettlement.service,
                                accountId: preparedSettlement.accountId,
                            }, snapshot.account)
                        )
                    )
                ) {
                    return await cleanUpTerminal({
                        status: 'conflict',
                        attemptId: input.attemptId,
                        code: 'connected_account_device_transaction_invalid',
                    });
                }
                const attempt: ActiveStoredAttempt = {
                    id: snapshot.attemptId,
                    active: true,
                    createdAtMs: snapshot.createdAtMs,
                    intent: snapshot.intent,
                    account: snapshot.account ?? null,
                    expectedCredentialRevision: snapshot.expectedCredentialRevision,
                    expectedCredentialConfigurationRevision:
                        snapshot.expectedCredentialConfigurationRevision,
                    admission: Object.freeze({
                        ...admitted,
                        modeId: admitted.descriptor.id,
                    }),
                    configuration,
                    credentials,
                    pendingDurableOperations: 0,
                    preparedSettlement: preparedSettlement ?? null,
                    preparedSettlementAcknowledged: preparedSettlement !== undefined,
                    decisiveSettlement: null,
                    oauthTransaction: null,
                    oauthExpiresAtMs: null,
                    oauthAuthorizationUrl: null,
                    device: {
                        expiresAtMs: snapshot.expiresAtMs,
                        pollIntervalMs: snapshot.pollIntervalMs,
                        nextPollAtMs: snapshot.nextPollAtMs,
                        verificationUri: snapshot.verificationUri,
                        ...(snapshot.verificationUriComplete === undefined
                            ? {}
                            : { verificationUriComplete: snapshot.verificationUriComplete }),
                        userCode: snapshot.userCode,
                    },
                    phase: 'awaitingDeviceAuthorization',
                    lastResponse: null,
                    cleanupTerminalResponse: null,
                };
                const response: AttemptResponse = {
                    status: 'awaitingDeviceAuthorization',
                    attemptId: attempt.id,
                    verificationUri: snapshot.verificationUri,
                    ...(snapshot.verificationUriComplete === undefined
                        ? {}
                        : { verificationUriComplete: snapshot.verificationUriComplete }),
                    userCode: snapshot.userCode,
                    expiresAtMs: snapshot.expiresAtMs,
                    pollIntervalMs: snapshot.pollIntervalMs,
                };
                if (preparedSettlement) {
                    attempt.phase = 'outcomeUnknown';
                    attempt.lastResponse = {
                        status: 'outcomeUnknown',
                        attemptId: attempt.id,
                        diagnostic: { code: 'connected_account_settlement_outcome_unknown' },
                    };
                    const beforeActivation =
                        attemptOwnershipFailure(restoration);
                    if (beforeActivation) return beforeActivation;
                    attempts.set(attempt.id, attempt);
                    scheduleExpiryReclaim();
                    return await settlePrepared(attempt, false, true);
                }
                attempt.lastResponse = response;
                const beforeActivation =
                    attemptOwnershipFailure(restoration);
                if (beforeActivation) return beforeActivation;
                attempts.set(attempt.id, attempt);
                scheduleExpiryReclaim();
                return response;
        },
        async continueConnect(input) {
            const attempt = readAttempt(input.attemptId);
            if (!attempt) return unavailable(input.attemptId);
            const expired = await expireAttemptIfNeeded(attempt);
            if (expired) return expired;
            if (attempt.phase !== 'configurationRequired' || attempt.intent !== 'connect') {
                return {
                    status: 'conflict',
                    attemptId: input.attemptId,
                    code: attempt.phase === 'inFlight'
                        ? 'connected_account_attempt_in_progress'
                        : 'connected_account_attempt_phase_mismatch',
                    };
            }
            attempt.phase = 'inFlight';
            let configuration: ConnectedAccountAttemptConfigurationAdmission;
            try {
                configuration = await params.configuration.admit({
                    intent: 'connect',
                    service: attempt.admission.service,
                    mode: attempt.admission.descriptor,
                    attemptId: attempt.id,
                    occurrenceId: attempt.admission.occurrenceId,
                    sourceCustody: attempt.admission.sourceCustody,
                    ...(input.expectedConfigurationRevision
                        ? { expectedConfigurationRevision: input.expectedConfigurationRevision }
                        : {}),
                });
            } catch {
                const ownershipFailure = attemptOwnershipFailure(attempt);
                if (ownershipFailure) return ownershipFailure;
                attempt.phase = 'configurationRequired';
                return {
                    status: 'unavailable',
                    attemptId: input.attemptId,
                    code: 'connected_account_configuration_unavailable',
                };
            }
            const afterConfiguration = attemptOwnershipFailure(attempt);
            if (afterConfiguration) return afterConfiguration;
            if (configuration.status !== 'ready') {
                if (configuration.status === 'configurationRequired') {
                    attempt.phase = 'configurationRequired';
                    const response: AttemptResponse = {
                        status: 'configurationRequired',
                        attemptId: attempt.id,
                        target: configuration.target,
                        missingFieldIds: Object.freeze([...configuration.missingFieldIds]),
                    };
                    attempt.lastResponse = response;
                    return response;
                }
                const response: AttemptResponse = {
                    status: configuration.status,
                    attemptId: attempt.id,
                    code: configuration.code,
                };
                await destroyAttempt(attempt, response);
                return response;
            }
            if (
                input.expectedConfigurationRevision !== undefined
                && configuration.snapshot.revision !== input.expectedConfigurationRevision
            ) {
                const response: AttemptResponse = {
                    status: 'conflict',
                    attemptId: attempt.id,
                    code: 'connected_account_configuration_changed',
                };
                await destroyAttempt(attempt, response);
                return response;
            }
            if (
                configuration.snapshot.target.kind !== 'attempt'
                || configuration.snapshot.target.attemptId !== attempt.id
                || !sameService(configuration.snapshot.target.service, attempt.admission.service)
                || configuration.snapshot.target.modeId !== attempt.admission.modeId
            ) {
                const response: AttemptResponse = {
                    status: 'conflict',
                    attemptId: attempt.id,
                    code: 'connected_account_configuration_target_mismatch',
                };
                await destroyAttempt(attempt, response);
                return response;
            }
            attempt.configuration = configuration;
            const operationAdmissionFailure =
                await rejectAttemptWhenEffectfulOperationIsDisallowed(attempt);
            if (operationAdmissionFailure) return operationAdmissionFailure;
            const beforeProviderFlow = attemptOwnershipFailure(attempt);
            if (beforeProviderFlow) return beforeProviderFlow;
            attempt.phase = attempt.admission.descriptor.kind === 'manual'
                ? 'awaitingManual'
                : attempt.admission.descriptor.kind === 'oauthAuthorizationCode'
                    ? 'awaitingOAuth'
                    : 'awaitingDeviceAuthorization';
            const response: AttemptResponse = attempt.phase === 'awaitingManual'
                ? { status: 'awaitingManual', attemptId: attempt.id }
                : { status: 'starting', attemptId: attempt.id };
            attempt.lastResponse = response;
            if (attempt.phase !== 'awaitingManual') {
                attempt.phase = 'starting';
                startProviderFlowInBackground(attempt);
            }
            return response;
        },
        async submitManual(input) {
            const attempt = readAttempt(input.attemptId);
            if (!attempt) return unavailable(input.attemptId);
            if (attempt.phase !== 'awaitingManual' || attempt.admission.descriptor.kind !== 'manual') {
                return {
                    status: 'conflict',
                    attemptId: input.attemptId,
                    code: attempt.phase === 'inFlight'
                        ? 'connected_account_attempt_in_progress'
                        : 'connected_account_attempt_phase_mismatch',
                };
            }
            const fields = attempt.admission.descriptor.fields;
            const declaredIds = new Set(fields.map((field) => field.id));
            let valid = Object.keys(input.fields).every((id) => declaredIds.has(id));
            try {
                valid = valid && fields.every((field) => isValidPluginJsonSchemaValue(
                    compilePluginJsonSchema(field.schema), input.fields[field.id] ?? '',
                ));
            } catch {
                valid = false;
            }
            if (!valid) {
                const response: AttemptResponse = {
                    status: 'rejected', attemptId: attempt.id,
                    code: 'connected_account_manual_fields_invalid',
                };
                await destroyAttempt(attempt, response);
                return response;
            }
            return await invoke(attempt, {
                kind: 'submitManual',
                fields: Object.freeze({ ...input.fields }),
            }, input.signal);
        },
        async completeOAuth(input) {
            let attempt = readAttempt(input.attemptId);
            if (!attempt) {
                const restored = await restoreOAuthAttempt(input.attemptId);
                if ('response' in restored) return restored.response;
                attempt = restored.attempt;
            }
            if (attempt.phase === 'outcomeUnknown') {
                if (attempt.preparedSettlement) {
                    return await settlePrepared(attempt, false, true);
                }
                if (attempt.admission.descriptor.outcomeReconciliation === 'none') {
                    const response: AttemptResponse = {
                        status: 'reconnectRequired',
                        attemptId: attempt.id,
                        code: 'connected_account_authentication_outcome_unknown',
                    };
                    attempt.phase = 'reconnectRequired';
                    attempt.lastResponse = response;
                    await destroyAttempt(attempt, response);
                    return response;
                }
                return attempt.lastResponse ?? {
                    status: 'outcomeUnknown',
                    attemptId: attempt.id,
                    diagnostic: { code: 'connected_account_provider_operation_interrupted' },
                };
            }
            if (
                attempt.phase !== 'awaitingOAuth'
                || attempt.admission.descriptor.kind !== 'oauthAuthorizationCode'
            ) {
                return {
                    status: 'conflict',
                    attemptId: input.attemptId,
                    code: attempt.phase === 'inFlight'
                        ? 'connected_account_attempt_in_progress'
                        : 'connected_account_attempt_phase_mismatch',
                    };
            }
            attempt.phase = 'inFlight';
            const beforeCompletion = await checkCurrentness(attempt, true);
            if (beforeCompletion) {
                attempt.phase = 'rejected';
                attempt.lastResponse = beforeCompletion;
                await destroyAttempt(attempt, beforeCompletion);
                return beforeCompletion;
            }
            const operationAdmissionFailure =
                await rejectAttemptWhenEffectfulOperationIsDisallowed(attempt);
            if (operationAdmissionFailure) return operationAdmissionFailure;
            const beforeCompletionEffect = attemptOwnershipFailure(attempt);
            if (beforeCompletionEffect) return beforeCompletionEffect;
            let completion: PluginConnectedAccountOAuthCompletion;
            try {
                completion = await attempt.oauthTransaction!.acceptCompletion(input.completion);
            } catch {
                const ownershipFailure = attemptOwnershipFailure(attempt);
                if (ownershipFailure) return ownershipFailure;
                const response: AttemptResponse = {
                    status: 'rejected',
                    attemptId: attempt.id,
                    code: 'connected_account_oauth_completion_invalid',
                };
                await destroyAttempt(attempt, response);
                return response;
            }
            const afterCompletion = attemptOwnershipFailure(attempt);
            if (afterCompletion) {
                await compensateLateDurableWrite(attempt, 'oauth');
                return afterCompletion;
            }
            attempt.phase = 'outcomeUnknown';
            attempt.lastResponse = {
                status: 'outcomeUnknown',
                attemptId: attempt.id,
                diagnostic: { code: 'connected_account_provider_operation_interrupted' },
            };
            try {
                await acknowledgeOAuthTransaction(attempt, 'outcomeUnknown');
            } catch {
                const ownershipFailure = attemptOwnershipFailure(attempt);
                if (ownershipFailure) {
                    await compensateLateDurableWrite(attempt, 'oauth');
                    return ownershipFailure;
                }
                const response: AttemptResponse = {
                    status: 'unavailable',
                    attemptId: attempt.id,
                    code: 'connected_account_oauth_transaction_unavailable',
                };
                attempt.phase = 'rejected';
                attempt.lastResponse = response;
                await destroyAttempt(attempt, response);
                return response;
            }
            const afterAcknowledge = await checkCurrentness(attempt, true);
            if (afterAcknowledge) {
                const uncertain = preservePossibleProviderOutcome(
                    attempt,
                    afterAcknowledge,
                );
                if (uncertain) return uncertain;
                if (attemptOwnershipFailure(attempt)) {
                    await compensateLateDurableWrite(attempt);
                } else {
                    await destroyAttempt(attempt, afterAcknowledge);
                }
                return afterAcknowledge;
            }
            return await invoke(attempt, {
                kind: 'completeOAuth',
                completion: Object.freeze({ ...completion }),
            }, input.signal);
        },
        async pollDevice(input) {
            const attempt = readAttempt(input.attemptId);
            if (!attempt) return unavailable(input.attemptId);
            if (
                attempt.phase !== 'awaitingDeviceAuthorization'
                || attempt.admission.descriptor.kind !== 'oauthDeviceCode'
            ) {
                return {
                    status: 'conflict',
                    attemptId: input.attemptId,
                    code: attempt.phase === 'inFlight'
                        ? 'connected_account_attempt_in_progress'
                        : 'connected_account_attempt_phase_mismatch',
                };
            }
            const nowMs = params.now();
            if (!attempt.device || nowMs >= attempt.device.expiresAtMs) {
                const response: AttemptResponse = {
                    status: 'unavailable',
                    attemptId: attempt.id,
                    code: 'connected_account_device_authorization_expired',
                };
                await destroyAttempt(attempt, response);
                return response;
            }
            if (nowMs < attempt.device.nextPollAtMs) {
                return {
                    status: 'pending',
                    attemptId: attempt.id,
                    retryAfterMs: Math.max(
                        1,
                        attempt.device.nextPollAtMs - nowMs,
                    ),
                };
            }
            return await invoke(attempt, { kind: 'pollDevice' }, input.signal);
        },
        async reconcile(input) {
            const attempt = readAttempt(input.attemptId);
            if (!attempt) {
                return terminalResponses.get(input.attemptId)?.response
                    ?? unavailable(input.attemptId);
            }
            const expired = await expireAttemptIfNeeded(attempt);
            if (expired) return expired;
            if (attempt.phase === 'reconnectRequired') return attempt.lastResponse ?? unavailable(input.attemptId);
            if (attempt.phase !== 'outcomeUnknown') {
                return {
                    status: 'conflict',
                    attemptId: input.attemptId,
                    code: attempt.phase === 'inFlight'
                        ? 'connected_account_attempt_in_progress'
                        : 'connected_account_attempt_phase_mismatch',
                };
            }
            if (attempt.preparedSettlement) {
                return await settlePrepared(attempt, false, true);
            }
            if (attempt.admission.descriptor.outcomeReconciliation === 'providerCheck') {
                attempt.phase = 'inFlight';
                const before = await checkCurrentness(attempt);
                if (before) {
                    return await resolveReconciliationCurrentness(
                        attempt,
                        before,
                    );
                }
                return await invoke(attempt, { kind: 'reconcile' }, input.signal);
            }
            if (
                attempt.admission.descriptor.outcomeReconciliation === 'lateEvidence'
                && params.lateEvidence
            ) {
                attempt.phase = 'inFlight';
                const before = await checkCurrentness(attempt);
                if (before) {
                    return await resolveReconciliationCurrentness(
                        attempt,
                        before,
                    );
                }
                const operationAdmissionFailure =
                    await rejectAttemptWhenEffectfulOperationIsDisallowed(
                        attempt,
                    );
                if (operationAdmissionFailure) {
                    return operationAdmissionFailure;
                }
                const beforeLateEvidence = attemptOwnershipFailure(attempt);
                if (beforeLateEvidence) return beforeLateEvidence;
                let result: ProviderResult;
                try {
                    result = await params.lateEvidence.reconcile({
                        attemptId: attempt.id,
                        service: attempt.admission.service,
                        ...(attempt.account ? { account: attempt.account } : {}),
                    });
                } catch {
                    const currentness = await checkCurrentness(attempt);
                    if (currentness) {
                        return await resolveReconciliationCurrentness(
                            attempt,
                            currentness,
                        );
                    }
                    attempt.phase = 'outcomeUnknown';
                    const response: AttemptResponse = {
                        status: 'outcomeUnknown',
                        attemptId: attempt.id,
                        diagnostic: { code: 'connected_account_late_evidence_unavailable' },
                    };
                    attempt.lastResponse = response;
                    return response;
                }
                return await handleProviderResult(
                    attempt,
                    snapshotProviderResult(result),
                );
            }
            attempt.phase = 'reconnectRequired';
            const response: AttemptResponse = {
                status: 'reconnectRequired',
                attemptId: attempt.id,
                code: 'connected_account_authentication_reconciliation_unavailable',
            };
            attempt.lastResponse = response;
            await destroyAttempt(attempt, response);
            return response;
        },
        async cancel(input) {
            const attempt = readAttempt(input.attemptId);
            if (!attempt) {
                const terminal = terminalResponses.get(input.attemptId);
                if (terminal) terminal.custody.released = true;
                terminalResponses.delete(input.attemptId);
                return terminal?.response ?? unavailable(input.attemptId);
            }
            if (attempt.phase === 'cleanupPending') {
                const terminalResponse = attempt.cleanupTerminalResponse;
                try {
                    await continueCleanupAttempt(attempt);
                } catch {
                    return attempts.get(input.attemptId)?.lastResponse
                        ?? attempt.lastResponse;
                }
                return terminalResponses.get(input.attemptId)?.response
                    ?? terminalResponse;
            }
            if (attempt.phase === 'restoring') {
                const response: AttemptResponse = {
                    status: 'cancelled',
                    attemptId: attempt.id,
                };
                await destroyAttempt(attempt, response);
                return response;
            }
            if (attempt.decisiveSettlement) {
                return await attempt.decisiveSettlement;
            }
            if (
                attempt.preparedSettlement
                && attempt.phase === 'outcomeUnknown'
                && attempt.lastResponse?.status === 'outcomeUnknown'
            ) {
                return attempt.lastResponse;
            }
            const expired = await expireAttemptIfNeeded(attempt);
            if (expired) return expired;
            const shouldCancelProvider = attempt.admission.descriptor.kind !== 'manual'
                && attempt.configuration !== null;
            attempt.active = false;
            if (shouldCancelProvider) {
                const context = contextFor(attempt);
                void Promise.resolve().then(async () => {
                    await params.runtime.invoke({
                        admission: attempt.admission,
                        operation: { kind: 'cancel' },
                        context,
                    });
                }).catch(() => undefined);
            }
            attempt.phase = 'cancelled';
            const response: AttemptResponse = {
                status: 'cancelled',
                attemptId: attempt.id,
            };
            attempt.lastResponse = response;
            await destroyAttempt(attempt, response);
            return response;
        },
        async read(input) {
            let attempt = readAttempt(input.attemptId);
            if (!attempt && input.restoreKind === 'oauth') {
                const restored = await restoreOAuthAttempt(input.attemptId);
                if ('response' in restored) return restored.response;
                attempt = restored.attempt;
            }
            if (!attempt) {
                return terminalResponses.get(input.attemptId)?.response
                    ?? unavailable(input.attemptId);
            }
            if (attempt.phase === 'cleanupPending') {
                const terminalResponse = attempt.cleanupTerminalResponse;
                try {
                    await continueCleanupAttempt(attempt);
                } catch {
                    return attempts.get(input.attemptId)?.lastResponse
                        ?? attempt.lastResponse;
                }
                return terminalResponses.get(input.attemptId)?.response
                    ?? terminalResponse;
            }
            const expired = await expireAttemptIfNeeded(attempt);
            return expired ?? attempt.lastResponse ?? unavailable(input.attemptId);
        },
        dispose() {
            disposed = true;
            clearExpiryTimer();
            terminalResponses.clear();
            for (const attempt of attempts.values()) {
                const custody = 'admission' in attempt ? attempt.admission.runtimeCustody : attempt.runtimeCustody;
                void custody?.release().catch(() => undefined);
            }
        },
    });
}
