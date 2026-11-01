import type { ConnectedAccountMaterializationRequest } from '@happier-dev/protocol/connect/connected-account-purposes';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { ConnectedServiceQuotaRecoveryCreditsV1, ConnectedServiceQuotaRecoveryCreditDetailsByIdV1, ConnectedServiceQuotaRecoveryCreditV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import type { ProviderAccountSubscriptionV1 } from '@happier-dev/protocol/connect/accountSubscription';
import type { PluginDiagnosticData } from '../plugins/errors.js';
import type { ConnectedAccountCredentialStore, ConnectedAccountProviderIdentity, ConnectedAccountRuntimeConfiguration } from './authenticationTypes.js';

/** Realm-neutral output; the provider runtime owns credential formatting. */
export type ConnectedAccountMaterialization = Readonly<{
    /** Scope positively established by the service from this credential revision.
     * Omission or unknown never establishes personal usage eligibility. */
    usageAccountScope?: 'personal' | 'workspace' | 'unknown';
}> & (
    | Readonly<{ kind: 'httpHeaders'; headers: Readonly<Record<string, string>> }>
    | Readonly<{ kind: 'environment'; env: Readonly<Record<string, string>> }>
    | Readonly<{ kind: 'files'; files: Readonly<Record<string, Uint8Array>> }>
);
export type ConnectedAccountHealthResult =
    | Readonly<{ status: 'connected' | 'expired' | 'reconnectRequired' | 'unavailable'; providerIdentity?: ConnectedAccountProviderIdentity; displayName?: string; scopes?: readonly string[]; diagnostic?: PluginDiagnosticData }>
    | Readonly<{ status: 'rejected'; diagnostic: PluginDiagnosticData }>;
export type ConnectedAccountEstablishedReadContext = Readonly<{
    account: QualifiedConnectedAccountRef;
    configuration: ConnectedAccountRuntimeConfiguration;
    credentials: Pick<ConnectedAccountCredentialStore, 'get'>;
    signal: AbortSignal;
    invokedAtMs: number;
}>;
export type ConnectedAccountRuntimeQuotaBase = Readonly<{
    observedAtMs: number;
    providerOrganizationId?: string;
    planLabel?: string | null;
    subscription?: ProviderAccountSubscriptionV1;
    limits: readonly unknown[];
}>;
/** The host supplies its existing context and quota projection; no SDK dependency flows back into this owner. */
export interface ConnectedAccountEstablishedRuntime<Context extends object, TQuota extends ConnectedAccountRuntimeQuotaBase = ConnectedAccountRuntimeQuotaBase> {
    readonly recoveryCredits?: Readonly<{
        read(context: Context, options?: Readonly<{ signal?: AbortSignal }>): Promise<Readonly<{
            observedAtMs: number; availableCount: number; recoveryCreditDetails?: ConnectedServiceQuotaRecoveryCreditDetailsByIdV1;
            credits: readonly (Readonly<{ providerCreditId: string; status: ConnectedServiceQuotaRecoveryCreditV1['status'] }>
                & Partial<Pick<ConnectedServiceQuotaRecoveryCreditV1, 'kind' | 'title' | 'description' | 'providerResetType' | 'appliesToProviderLimitId' | 'grantedAtMs' | 'expiresAtMs' | 'redeemStartedAtMs' | 'redeemedAtMs'>>)[];
        }>>;
        consume(request: Readonly<{ idempotencyKey: string; providerCreditId?: string; providerLimitIds?: readonly string[] }>, context: Context,
            options?: Readonly<{ signal?: AbortSignal }>): Promise<Readonly<{ status: 'consumed' | 'already_consumed' | 'not_available' | 'nothing_to_reset' }>>;
    }>;
    enrichCredentialContext?(context: Context & Readonly<{ operation: Readonly<{ operationId: string; configurationRevision: string }>; stagedCredentials: ConnectedAccountCredentialStore }>, options?: Readonly<{ signal?: AbortSignal }>): Promise<ConnectedAccountHealthResult | Readonly<{ status: 'outcomeUnknown'; diagnostic: PluginDiagnosticData }>>;
    refresh(context: Context & Readonly<{ operation: Readonly<{ operationId: string; configurationRevision: string }>; stagedCredentials: ConnectedAccountCredentialStore }>, options?: Readonly<{ signal?: AbortSignal }>): Promise<ConnectedAccountHealthResult | Readonly<{ status: 'outcomeUnknown'; diagnostic: PluginDiagnosticData }>>;
    revoke(context: Context, options?: Readonly<{ signal?: AbortSignal }>): Promise<Readonly<{ status: 'remoteRevoked' | 'remoteUnsupported'; diagnostic?: PluginDiagnosticData }> | Readonly<{ status: 'outcomeUnknown'; diagnostic: PluginDiagnosticData }>>;
    status(context: Context, options?: Readonly<{ signal?: AbortSignal }>): Promise<ConnectedAccountHealthResult>;
    quota?(context: Context, options?: Readonly<{ signal?: AbortSignal }>): Promise<TQuota>;
    materialize(request: ConnectedAccountMaterializationRequest, context: Context, options?: Readonly<{ signal?: AbortSignal; existingFiles?: Readonly<Record<string, Uint8Array>> }>): Promise<ConnectedAccountMaterialization>;
}
export type ConnectedAccountRuntimeEstablishedOperation =
    | Readonly<{ kind: 'refresh'; operationId: string; stagedCredentials: ConnectedAccountCredentialStore }>
    | Readonly<{ kind: 'enrichCredentialContext'; operationId: string; stagedCredentials: ConnectedAccountCredentialStore }>
    | Readonly<{ kind: 'status' }>
    | Readonly<{ kind: 'quota' }>
    | Readonly<{ kind: 'recoveryCredits.read' }>
    | Readonly<{ kind: 'revoke' }>
    | Readonly<{ kind: 'recoveryCredits.consume'; request: Readonly<{ idempotencyKey: string; providerCreditId?: string; providerLimitIds?: readonly string[] }> }>
    | Readonly<{ kind: 'materialize'; request: ConnectedAccountMaterializationRequest; existingFiles?: Readonly<Record<string, Uint8Array>> }>;
export type ConnectedAccountRuntimeEstablishedTarget = Readonly<{
    account: QualifiedConnectedAccountRef; expectedCredentialRevision: string; expectedRuntimeConfigurationRevision: string;
}>;
export type ConnectedAccountRuntimeEstablishedInvocation<TOperation extends ConnectedAccountRuntimeEstablishedOperation = ConnectedAccountRuntimeEstablishedOperation> = Readonly<{
    target: ConnectedAccountRuntimeEstablishedTarget; operation: TOperation;
    context: Pick<ConnectedAccountEstablishedReadContext, 'account' | 'configuration' | 'credentials'>;
    isConfigurationCurrent(configuration: ConnectedAccountRuntimeConfiguration): boolean | Promise<boolean>;
    configurationRevocationSignal?(configuration: ConnectedAccountRuntimeConfiguration): AbortSignal | undefined;
    isCredentialRevisionCurrent(): boolean | Promise<boolean>;
    assertProviderCallAllowed?: () => void;
    signal?: AbortSignal;
}>;
export type ConnectedAccountRuntimeEstablishedResult<TOperation extends ConnectedAccountRuntimeEstablishedOperation, TQuota extends ConnectedAccountRuntimeQuotaBase = ConnectedAccountRuntimeQuotaBase> =
    TOperation['kind'] extends 'recoveryCredits.read' ? Awaited<ReturnType<NonNullable<ConnectedAccountEstablishedRuntime<object, TQuota>['recoveryCredits']>['read']>> | null
    : TOperation['kind'] extends 'recoveryCredits.consume' ? Awaited<ReturnType<NonNullable<ConnectedAccountEstablishedRuntime<object, TQuota>['recoveryCredits']>['consume']>> | null
    : TOperation['kind'] extends 'refresh' | 'enrichCredentialContext' ? Awaited<ReturnType<ConnectedAccountEstablishedRuntime<object, TQuota>['refresh']>>
    : TOperation['kind'] extends 'status' ? ConnectedAccountHealthResult
    : TOperation['kind'] extends 'quota' ? (TQuota & Readonly<{ recoveryCredits?: ConnectedServiceQuotaRecoveryCreditsV1; recoveryCreditDetails?: ConnectedServiceQuotaRecoveryCreditDetailsByIdV1 }>) | null
    : TOperation['kind'] extends 'revoke' ? Awaited<ReturnType<ConnectedAccountEstablishedRuntime<object, TQuota>['revoke']>>
    : ConnectedAccountMaterialization;
export type ConnectedAccountEstablishedRuntimeInvoker<TQuota extends ConnectedAccountRuntimeQuotaBase = ConnectedAccountRuntimeQuotaBase> = Readonly<{
    invokeEstablished<TOperation extends ConnectedAccountRuntimeEstablishedOperation>(input: ConnectedAccountRuntimeEstablishedInvocation<TOperation>): Promise<ConnectedAccountRuntimeEstablishedResult<TOperation, TQuota>>;
}>;
