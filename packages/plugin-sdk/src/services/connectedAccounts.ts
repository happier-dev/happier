/** @moduleRealm daemon */
import type {
    ConnectedAccountListedState,
    ConnectedAccountRef,
    ConnectedAccountRuntime,
} from '../connectedAccounts.js';
import type { PluginDiagnosticData } from '../diagnostics.js';
import type { PluginContributionRef } from '../identity.js';
import type { PluginInvocationContext } from '../invocation.js';
import type { HttpService } from './io.js';
import type { LoggerService } from './core.js';
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

import type {
    ConnectedAccountAuthenticationModeRuntime,
    ConnectedAccountRuntimeConfigurationTarget as PluginConnectedAccountRuntimeConfigurationTarget,
    ConnectedAccountRuntimeConfiguration as PluginConnectedAccountRuntimeConfiguration,
    ConnectedAccountCredentialStore as PluginConnectedAccountCredentialStore,
    ConnectedAccountAuthenticationAttempt as PluginConnectedAccountAuthenticationAttempt,
    ConnectedAccountFailureRetryEvidence as PluginConnectedAccountFailureRetryEvidence,
    ConnectedAccountProviderIdentity,
    ConnectedAccountAuthCompletionResult as PluginConnectedAccountAuthCompletionResult,
    ConnectedAccountAuthFailure as PluginConnectedAccountAuthFailure,
    ConnectedAccountOutcomeUnknown as PluginConnectedAccountOutcomeUnknown,
    ConnectedAccountConnectedResult as PluginConnectedAccountConnectedResult,
    ConnectedAccountOAuthBeginRequest as PluginConnectedAccountOAuthBeginRequest,
    ConnectedAccountOAuthCompletion as PluginConnectedAccountOAuthCompletion,
    ConnectedAccountManualCompletion as PluginConnectedAccountManualCompletion,
    ConnectedAccountOAuthBeginResult as PluginConnectedAccountOAuthBeginResult,
    ConnectedAccountDeviceBeginResult as PluginConnectedAccountDeviceBeginResult,
    ConnectedAccountDevicePollResult as PluginConnectedAccountDevicePollResult,
    ConnectedAccountReconciliationResult as PluginConnectedAccountReconciliationResult,
    ConnectedAccountPendingResult as PluginConnectedAccountPendingResult
} from '@happier-dev/cli-common/connectedAccounts';
/** @realm any */
export type {
    ConnectedAccountRuntimeConfigurationTarget as PluginConnectedAccountRuntimeConfigurationTarget,
    ConnectedAccountRuntimeConfiguration as PluginConnectedAccountRuntimeConfiguration,
    ConnectedAccountCredentialStore as PluginConnectedAccountCredentialStore,
    ConnectedAccountAuthenticationAttempt as PluginConnectedAccountAuthenticationAttempt,
    ConnectedAccountFailureRetryEvidence as PluginConnectedAccountFailureRetryEvidence,
    ConnectedAccountProviderIdentity,
    ConnectedAccountAuthCompletionResult as PluginConnectedAccountAuthCompletionResult,
    ConnectedAccountAuthFailure as PluginConnectedAccountAuthFailure,
    ConnectedAccountOutcomeUnknown as PluginConnectedAccountOutcomeUnknown,
    ConnectedAccountConnectedResult as PluginConnectedAccountConnectedResult,
    ConnectedAccountOAuthBeginRequest as PluginConnectedAccountOAuthBeginRequest,
    ConnectedAccountOAuthCompletion as PluginConnectedAccountOAuthCompletion,
    ConnectedAccountManualCompletion as PluginConnectedAccountManualCompletion,
    ConnectedAccountOAuthBeginResult as PluginConnectedAccountOAuthBeginResult,
    ConnectedAccountDeviceBeginResult as PluginConnectedAccountDeviceBeginResult,
    ConnectedAccountDevicePollResult as PluginConnectedAccountDevicePollResult,
    ConnectedAccountReconciliationResult as PluginConnectedAccountReconciliationResult,
    ConnectedAccountPendingResult as PluginConnectedAccountPendingResult
} from '@happier-dev/cli-common/connectedAccounts';
/**
 * Connected Account runtime work is not an Action invocation, so it never
 * receives the Action progress reporter. Its own `operation` metadata would
 * otherwise intersect with that reporter and force the host to advertise a
 * progress callback it discards.
 */
/** @realm any */
export type PluginConnectedAccountPortableAuthenticationContext = Pick<PluginInvocationContext,
    'plugin' | 'contribution' | 'surface' | 'invokedAtMs' | 'caller' | 'signal'> & Readonly<{
    services: Readonly<{
        http: HttpService;
        /** Host diagnostics when available; portable Account hosts may omit logging. */
        logger?: Pick<LoggerService, 'warn'>;
    }>;
    service: PluginContributionRef;
    attempt: PluginConnectedAccountAuthenticationAttempt;
    configuration: PluginConnectedAccountRuntimeConfiguration;
    attemptCredentials: PluginConnectedAccountCredentialStore;
}>;
/** Native authentication retains the daemon's ordinary invocation services. @realm daemon */
export type PluginConnectedAccountAuthenticationContext = Omit<PluginInvocationContext, 'operation'> & Pick<
    PluginConnectedAccountPortableAuthenticationContext,
    'service' | 'attempt' | 'configuration' | 'attemptCredentials'
>;
/** @realm any */
export type PluginConnectedAccountAuthenticationModeRuntime =
    ConnectedAccountAuthenticationModeRuntime<PluginConnectedAccountAuthenticationContext>;
export type { ConnectedAccountHealthResult as PluginConnectedAccountHealthResult } from '@happier-dev/cli-common/connectedAccounts';
import type { ConnectedAccountHealthResult as PluginConnectedAccountHealthResult } from '@happier-dev/cli-common/connectedAccounts';
export type PluginConnectedAccountReadContext = Omit<PluginInvocationContext, 'operation'> & Readonly<{
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
