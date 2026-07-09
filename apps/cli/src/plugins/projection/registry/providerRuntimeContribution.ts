import type { ConnectedServiceCredentialRecordV1, ConnectedServiceId } from '@happier-dev/protocol';
import type {
    CloudConnectTargetStatus,
    CloudVendorKey,
    HandoffSurfaceV1,
    HostRuntimeControlAppServerDelegateV1,
    HostRuntimeControlServiceV1,
} from '@happier-dev/agents';
import type { AcpBackendSpecV1, ExecRuntimeServiceV1 } from '@happier-dev/plugin-sdk';
import type {
    ExternalSessionCandidateHostAdapterV1,
    ExternalSessionHostAdaptersContributionV1,
    ExternalSessionRuntimeHostAdapterParamsV1,
    ExternalSessionTranscriptStoreAdapterV1,
} from '@happier-dev/plugin-sdk/sessions';
import type {
    CloudCustomAuthenticatorContextV1,
    CloudCustomAuthenticatorV1,
} from '@happier-dev/plugin-sdk';

import type {
    PreflightSessionControlsProbeKind,
    PreflightSessionControlsProbeParams,
} from '@/capabilities/probes/preflightSessionControlsProbeAdapterTypes';
import type {
    ConnectedServiceSessionFileImportDetail,
    ConnectedServiceSessionFileImportRoot,
} from '@/daemon/connectedServices/stateSharing/importConnectedServiceSessionFiles';
import type { parseProviderResetAt } from '@/daemon/connectedServices/quotas/normalization';
import type {
    CliAuthStatusDraft,
    ConnectedServiceDaemonAuthBridgeRefresh,
    ConnectedServiceSwitchContinuityParams,
    ConnectedServiceSwitchContinuityResult,
    ExternalSessionRuntimeHostAdapterParams,
} from '@/agent/catalog/types';
import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';
import type { ConnectedServiceQuotaFetcherDescriptor } from '@/daemon/connectedServices/quotas/types';
import type { ConnectedServiceProviderRuntimeAuthAdapter } from '@/daemon/connectedServices/runtimeAuth/types';
import type { ConnectedServiceMaterializedHomeFreshness } from '@/daemon/connectedServices/materialization/materializedHomeFreshness';
import type { ProviderSessionArgPartitionResult } from '@/cli/providerSessionArgPartition';
import type { ExternalSessionCandidateHostAdapter } from '@/session/external/candidates/host';
import type { ExternalSessionTranscriptStoreAdapter } from '@/session/external/transcripts/store';
import type { TerminalPromptSubmitVerificationPolicy } from '@/integrations/terminalHost/promptSubmitVerification';

import type { ResolvedCatalogEntry } from './types';
import type { ConnectedServiceStateSharingMode } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';

type RuntimeContributionFunction =
    | (() => unknown)
    | ((first: never) => unknown)
    | ((first: never, second: never) => unknown)
    | ((first: never, second: never, third: never) => unknown);

type RuntimeContributionObject = Readonly<Record<string, unknown>>;

type CliAuthContributionSource = Readonly<{
    detectAuthStatus?: RuntimeContributionFunction;
}>;

type ManagedServerContributionSource = Readonly<{
    namespace?: unknown;
    statePathEnvKey?: unknown;
    resolveStateFingerprintInput?: RuntimeContributionFunction;
    isExpectedProcessCommand?: RuntimeContributionFunction;
    buildHealthUrl?: RuntimeContributionFunction;
    logLabel?: unknown;
    timeouts?: RuntimeContributionObject;
}>;

type ProviderAttachContributionSource = Readonly<{
    resolveTarget?: RuntimeContributionFunction;
    createArgs?: RuntimeContributionFunction;
    buildHealthUrl?: RuntimeContributionFunction;
}>;

type SessionRuntimePreferencesContributionSource = Readonly<{
    resolve?: RuntimeContributionFunction;
}>;

type CodingPromptBehaviorContributionSource = Readonly<{
    resolve?: RuntimeContributionFunction;
}>;

type DaemonSpawnHooksContributionSource = Readonly<{
    resolveRuntimePrerequisites?: RuntimeContributionFunction;
    augmentEnv?: RuntimeContributionFunction;
}>;

type VendorResumeSupportContributionSource = Readonly<{
    resolve?: RuntimeContributionFunction;
}>;

type AgentChecklistContributionSource = NonNullable<ResolvedCatalogEntry['checklists']>;

type SessionHandoffContributionSource = Readonly<{
    surface?: unknown;
    providerBundleRecords?: Readonly<{
        extract?: RuntimeContributionFunction;
    }>;
}>;

type PreflightSessionControlsContributionSource = Readonly<{
    failureCacheStrategy?: unknown;
    needsAccountSettings?: unknown;
    resolveProbeVariant?: RuntimeContributionFunction;
    verboseModelsCommandArgs?: readonly unknown[];
    probeModelsCommandArgs?: readonly unknown[];
    probeModelsFromCommandOutput?: RuntimeContributionFunction;
    probeModelsRaw?: RuntimeContributionFunction;
    probeModesRaw?: RuntimeContributionFunction;
    probeConfigOptionsRaw?: RuntimeContributionFunction;
}>;

type CloudConnectContributionSource = Readonly<{
    displayName?: unknown;
    vendorDisplayName?: unknown;
    vendorKey?: unknown;
    status?: unknown;
    oauthAuthorizationCode?: Readonly<{
        clientId?: unknown;
        authorizeUrl?: unknown;
        tokenUrl?: unknown;
        redirectUri?: unknown;
        scope?: unknown;
    }>;
    customAuthenticator?: Readonly<{
        authenticate?: RuntimeContributionFunction;
    }>;
    authenticate?: RuntimeContributionFunction;
}>;

type SessionControlsContributionSource = Readonly<{
    normalizePermissionMode?: RuntimeContributionFunction;
}>;

type TerminalContributionSource = Readonly<{
    transformHeadlessTmuxArgv?: RuntimeContributionFunction;
    promptSubmitVerification?: RuntimeContributionObject;
}>;

type AcpBackendContributionSource = Readonly<{
    spec?: AcpBackendSpecV1;
    createSpec?: (params: Readonly<{
        cwd: string;
        env: NodeJS.ProcessEnv;
    }>) => AcpBackendSpecV1;
}>;

type ProviderCliSessionCommandContributionSource = Readonly<{
    backendIdForSessionRuntime?: unknown;
    agentIdForDeprecatedAliases?: unknown;
    agentIdForAccountSettings?: unknown;
    implicitResumeDelegation?: Readonly<{
        resumeFlags?: readonly unknown[];
    }>;
    directoryFlags?: readonly unknown[];
    forwardModelFlag?: unknown;
    forwardResumeFlag?: unknown;
    yoloProviderArgs?: readonly unknown[];
    versionFlags?: readonly unknown[];
    providerInfoCommandPrefixes?: readonly (readonly unknown[])[];
    buildSessionOptions?: RuntimeContributionFunction;
}>;

type ConnectedServicesContributionSource = Readonly<{
    serviceIds?: readonly unknown[];
    stateSharingServiceIds?: readonly unknown[];
    materializedRootSubdir?: unknown;
    noRestartRequiredServiceIds?: readonly unknown[];
    materializedHomeCredentialEntries?: readonly unknown[];
    resolveStateSharingSourceRoot?: RuntimeContributionFunction;
    resolveStateSharingStateEntryNames?: RuntimeContributionFunction;
    resolveStateSharingStateSourceRoot?: RuntimeContributionFunction;
    createStateSharingSessionImportRoots?: RuntimeContributionFunction;
    resolveVendorResumeIdFromImportedFile?: RuntimeContributionFunction;
    readConnectedServiceId?: RuntimeContributionFunction;
    createAuthMaterializationInput?: RuntimeContributionFunction;
    materializeAuthEnvironment?: RuntimeContributionFunction;
    isMaterializedHomeStale?: RuntimeContributionFunction;
    materializeRuntimeAuthSelection?: unknown;
    stateSharingDescriptor?: unknown;
    shouldRestartForServiceSwitch?: RuntimeContributionFunction;
    restartRematerializeRequiredReason?: unknown;
    connectedSwitchSharedStateRequiredReason?: unknown;
    nativeSwitchSharedStateRequiredReason?: unknown;
    sameAuthGroupRequiresResumeReachability?: unknown;
    resolveResumeReachabilityUnsupported?: RuntimeContributionFunction;
    classifyUsageLimitError?: RuntimeContributionFunction;
    runtimeAuthAdapter?: unknown;
    daemonAuthBridge?: RuntimeContributionObject;
    quotaFetcherDescriptor?: unknown;
    recoveryCapabilities?: unknown;
    usageLimitRecovery?: RuntimeContributionObject;
}>;

type RuntimeControlContributionSource = Readonly<{
    appServer?: RuntimeContributionObject;
    connectedServices?: RuntimeContributionObject;
    goal?: RuntimeContributionObject;
    catalog?: RuntimeContributionObject;
    usageLimitRecovery?: RuntimeContributionObject;
}>;

type ExternalSessionsContributionSource = Readonly<{
    createTranscriptStoreAdapter?: RuntimeContributionFunction;
    createCandidateHostAdapter?: RuntimeContributionFunction;
}>;

export type ConnectedServiceStateSharingDescriptorResult = Awaited<
    ReturnType<NonNullable<ResolvedCatalogEntry['getConnectedServiceStateSharingDescriptor']>>
>;

export type ConnectedServiceRecoveryCapabilitiesResult = NonNullable<Awaited<
    ReturnType<NonNullable<ResolvedCatalogEntry['getConnectedServiceRecoveryCapabilities']>>
>>;

export type SessionCatalogControlAdapterResult = Awaited<
    ReturnType<NonNullable<ResolvedCatalogEntry['getSessionCatalogControlAdapter']>>
>;

export type SessionGoalControlAdapterResult = Awaited<
    ReturnType<NonNullable<ResolvedCatalogEntry['getSessionGoalControlAdapter']>>
>;

export type SessionUsageLimitRecoveryControlAdapterResult = Awaited<
    ReturnType<NonNullable<ResolvedCatalogEntry['getSessionUsageLimitRecoveryControlAdapter']>>
>;

export type VerifyResumeReachable = NonNullable<ResolvedCatalogEntry['verifyResumeReachable']>;

type RuntimeAuthSelectionMaterializerParams = Parameters<
    NonNullable<ResolvedCatalogEntry['materializeConnectedServiceRuntimeAuthSelection']>
>[0];

type RuntimeControlInput<TParams> = Readonly<{
    runtimeControl: HostRuntimeControlServiceV1;
    params: TParams;
}>;

export type CliAuthContribution = Readonly<{
    detectAuthStatus: (params: Readonly<{
        resolvedPath: string;
        env: NodeJS.ProcessEnv;
        runCommand: (
            args: readonly string[],
            options?: Readonly<{
                timeoutMs?: number;
                env?: Readonly<Record<string, string>>;
            }>,
        ) => Promise<Readonly<{
            ok: boolean;
            stdout: string;
            stderr: string;
            exitCode: number | null;
        }>>;
    }>) => Promise<CliAuthStatusDraft> | CliAuthStatusDraft;
}>;

export type ManagedServerContribution = Readonly<{
    namespace: string;
    statePathEnvKey: string;
    resolveStateFingerprintInput: (env: NodeJS.ProcessEnv) => Readonly<Record<string, string>>;
    isExpectedProcessCommand: (command: string) => boolean;
    buildHealthUrl: (baseUrl: string) => string | null;
    logLabel: string;
    timeouts: Readonly<{
        authSwitchDrainMsEnvKey: string;
        authSwitchDrainMsDefault: number;
        healthProbeMsEnvKey: string;
        healthProbeMsDefault: number;
        shutdownGraceMsEnvKey: string;
        shutdownGraceMsDefault: number;
        forceKillWaitMsEnvKey: string;
        forceKillWaitMsDefault: number;
        pollIntervalMsEnvKey: string;
        pollIntervalMsDefault: number;
    }>;
}>;

export type ProviderAttachContribution = Readonly<{
    resolveTarget: (params: Readonly<{
        metadata: Readonly<Record<string, unknown>>;
        fallbackServerBaseUrl?: string | null;
    }>) => unknown;
    createArgs: (target: Readonly<Record<string, unknown>>) => readonly string[];
    buildHealthUrl: (baseUrl: string) => string | null;
}>;

export type SessionRuntimePreferencesContribution = Readonly<{
    resolve: NonNullable<ResolvedCatalogEntry['resolveSessionRuntimePreferences']>;
}>;

export type DaemonSpawnHooksContribution = DaemonSpawnHooks;

export type SessionHandoffProviderBundleRecordExtractor = NonNullable<
    Awaited<ReturnType<NonNullable<ResolvedCatalogEntry['getSessionHandoffProviderBundleRecordExtractor']>>>
>;

export type SessionHandoffContribution = Readonly<{
    surface?: HandoffSurfaceV1;
    providerBundleRecords?: Readonly<{
        extract: SessionHandoffProviderBundleRecordExtractor;
    }>;
}>;

export type PreflightSessionControlsContribution = Readonly<{
    failureCacheStrategy?: 'cooldown' | 'retry';
    needsAccountSettings?: boolean;
    resolveProbeVariant?: NonNullable<ResolvedCatalogEntry['resolveSessionControlsProbeVariant']>;
    cliModelsCommandArgs?: readonly string[];
    verboseModelsCommandArgs?: readonly string[];
    probeModelsRaw?: (params: PreflightSessionControlsContributionProbeParams) => Promise<unknown | null> | unknown | null;
    probeModels?: Readonly<{
        commandArgs: readonly string[];
        parseOutput: (params: Readonly<{
            output: string;
            cwd: string;
            timeoutMs: number;
        }>) => Promise<unknown | null> | unknown | null;
    }>;
    probeModesRaw?: (params: PreflightSessionControlsContributionProbeParams) => Promise<unknown | null> | unknown | null;
    probeConfigOptionsRaw?: (params: PreflightSessionControlsContributionProbeParams) => Promise<unknown | null> | unknown | null;
}>;

export type PreflightSessionControlsContributionProbeParams = PreflightSessionControlsProbeParams & Readonly<{
    probeKind: PreflightSessionControlsProbeKind;
    exec: ExecRuntimeServiceV1;
    env: NodeJS.ProcessEnv;
}>;

export type CloudConnectContribution = Readonly<{
    displayName: string;
    vendorDisplayName: string;
    vendorKey: CloudVendorKey | 'scm';
    status: CloudConnectTargetStatus;
    oauthAuthorizationCode?: Readonly<{
        clientId: string;
        authorizeUrl: string;
        tokenUrl: string;
        redirectUri: string;
        scope: string;
    }>;
    authenticate?: CloudCustomAuthenticatorV1;
}>;

export type { CloudCustomAuthenticatorContextV1, CloudCustomAuthenticatorV1 };

export type SessionControlsContribution = Readonly<{
    normalizePermissionMode: (permissionMode: string) => string;
}>;

export type TerminalContribution = Readonly<{
    transformHeadlessTmuxArgv?: (argv: string[]) => string[];
    promptSubmitVerification?: TerminalPromptSubmitVerificationPolicy;
}>;

export type ProviderCliSessionCommandResumeDelegationV1 = Readonly<{
    resumeFlags: readonly string[];
}>;

export type ProviderCliSessionCommandContribution = Readonly<{
    backendIdForSessionRuntime: string;
    agentIdForDeprecatedAliases?: string;
    agentIdForAccountSettings?: string;
    implicitResumeDelegation?: ProviderCliSessionCommandResumeDelegationV1;
    directoryFlags?: readonly string[];
    forwardModelFlag?: boolean;
    forwardResumeFlag?: boolean;
    yoloProviderArgs?: readonly string[];
    versionFlags?: readonly string[];
    providerInfoCommandPrefixes?: readonly (readonly string[])[];
    buildSessionOptions?: (input: Readonly<{
        args: readonly string[];
        parsed: ProviderSessionArgPartitionResult;
    }>) => unknown;
}>;

export type ConnectedServicesContribution = Readonly<{
    serviceIds: readonly ConnectedServiceId[];
    stateSharingServiceIds?: readonly ConnectedServiceId[];
    materializedRootSubdir?: string;
    noRestartRequiredServiceIds?: readonly ConnectedServiceId[];
    materializedHomeCredentialEntries?: readonly string[];
    resolveStateSharingSourceRoot?: (params: Readonly<{ env: NodeJS.ProcessEnv }>) => string;
    resolveStateSharingStateEntryNames?: (params: Readonly<{
        sourceRoot: string;
        materializedRootDir: string;
        env: NodeJS.ProcessEnv;
        requestedStateMode: ConnectedServiceStateSharingMode;
        effectiveStateMode: ConnectedServiceStateSharingMode;
    }>) => Promise<readonly string[]> | readonly string[];
    resolveStateSharingStateSourceRoot?: (params: Readonly<{
        entryName: string;
        sourceRoot: string;
        materializedRootDir: string;
        env: NodeJS.ProcessEnv;
    }>) => string;
    createStateSharingSessionImportRoots?: (params: Readonly<{
        sourceRoot: string;
        materializedRootDir: string;
    }>) => readonly ConnectedServiceSessionFileImportRoot[];
    resolveVendorResumeIdFromImportedFile?: (detail: ConnectedServiceSessionFileImportDetail) => string | null;
    readConnectedServiceId: (selection: unknown) => ConnectedServiceId | null;
    createAuthMaterializationInput: (
        serviceId: ConnectedServiceId,
        record: ConnectedServiceCredentialRecordV1,
    ) => Readonly<Record<string, unknown>>;
    materializeAuthEnvironment: (input: Readonly<Record<string, unknown>>) =>
        Promise<Readonly<{
            env: Readonly<Record<string, string>>;
            diagnostics?: readonly unknown[];
        }>>
        | Readonly<{
            env: Readonly<Record<string, string>>;
            diagnostics?: readonly unknown[];
        }>;
    materializedHomeFreshness?: ConnectedServiceMaterializedHomeFreshness;
    stateSharingDescriptor: NonNullable<ConnectedServiceStateSharingDescriptorResult>;
    materializeRuntimeAuthSelection?: boolean;
    shouldRestartForServiceSwitch?: (serviceId: unknown) => boolean;
    restartRematerializeRequiredReason?: string;
    connectedSwitchSharedStateRequiredReason?: string;
    nativeSwitchSharedStateRequiredReason?: string;
    sameAuthGroupRequiresResumeReachability?: boolean;
    resolveResumeReachabilityUnsupported?: VerifyResumeReachable;
    classifyUsageLimitError?: (params: Readonly<{
        providerErrorPath: boolean;
        error: unknown;
        now?: number;
        parseResetAt: typeof parseProviderResetAt;
    }>) => unknown;
    runtimeAuthAdapter?: ConnectedServiceProviderRuntimeAuthAdapter | false;
    daemonAuthBridge?: Readonly<{
        refresh: ConnectedServiceDaemonAuthBridgeRefresh;
    }>;
    quotaFetcherDescriptor?: ConnectedServiceQuotaFetcherDescriptor;
    usageLimitRecovery?: Readonly<{
        agentId: string;
        issueProviderFilter?: string;
        defaultNativeServiceId?: ConnectedServiceId;
        fallbackBackoffEnvKey: string;
        maxAttemptsEnvKey: string;
        defaultFallbackBackoffMs: number;
        defaultMaxAttempts: number;
    }>;
    recoveryCapabilities?: ConnectedServiceRecoveryCapabilitiesResult;
}>;

export type RuntimeControlContribution = Readonly<{
    appServer?: HostRuntimeControlAppServerDelegateV1;
    connectedServices?: Readonly<{
        createRuntimeAuthAdapter?: () => ConnectedServiceProviderRuntimeAuthAdapter;
        materializeRuntimeAuthSelection?: (
            input: RuntimeControlInput<RuntimeAuthSelectionMaterializerParams>,
        ) => Promise<unknown | null> | unknown | null;
        resolveSwitchContinuity?: (
            input: RuntimeControlInput<ConnectedServiceSwitchContinuityParams>,
        ) => Promise<ConnectedServiceSwitchContinuityResult> | ConnectedServiceSwitchContinuityResult;
        verifyResumeReachable?: VerifyResumeReachable;
        resolveCandidatePersistedSessionFile?: ResolvedCatalogEntry['resolveConnectedServiceCandidatePersistedSessionFile'];
    }>;
    goal?: Readonly<{
        getGoal?: (
            input: RuntimeControlInput<Parameters<NonNullable<NonNullable<SessionGoalControlAdapterResult>['getGoal']>>[0]>,
        ) => Promise<unknown> | unknown;
        setGoal?: (
            input: RuntimeControlInput<Parameters<NonNullable<NonNullable<SessionGoalControlAdapterResult>['setGoal']>>[0]>,
        ) => Promise<unknown> | unknown;
        clearGoal?: (
            input: RuntimeControlInput<Parameters<NonNullable<NonNullable<SessionGoalControlAdapterResult>['clearGoal']>>[0]>,
        ) => Promise<unknown> | unknown;
    }>;
    catalog?: Readonly<{
        listVendorPlugins?: (
            input: RuntimeControlInput<Parameters<NonNullable<NonNullable<SessionCatalogControlAdapterResult>['listVendorPlugins']>>[0]>,
        ) => Promise<unknown> | unknown;
        listSkills?: (
            input: RuntimeControlInput<Parameters<NonNullable<NonNullable<SessionCatalogControlAdapterResult>['listSkills']>>[0]>,
        ) => Promise<unknown> | unknown;
    }>;
    usageLimitRecovery?: Readonly<{
        checkNow?: (
            input: RuntimeControlInput<Parameters<NonNullable<NonNullable<SessionUsageLimitRecoveryControlAdapterResult>['checkNow']>>[0]>,
        ) => Promise<unknown> | unknown;
        consumeResetCredit?: (
            input: RuntimeControlInput<Parameters<NonNullable<NonNullable<SessionUsageLimitRecoveryControlAdapterResult>['consumeResetCredit']>>[0]>,
        ) => Promise<unknown> | unknown;
    }>;
}>;

export type ExternalSessionsContribution = Readonly<{
    createTranscriptStoreAdapter?: (
        params: ExternalSessionRuntimeHostAdapterParamsV1,
    ) => ExternalSessionTranscriptStoreAdapter | ExternalSessionTranscriptStoreAdapterV1;
    createCandidateHostAdapter?: (
        params: ExternalSessionRuntimeHostAdapterParamsV1,
    ) => ExternalSessionCandidateHostAdapter | ExternalSessionCandidateHostAdapterV1;
}> & ExternalSessionHostAdaptersContributionV1;

export type ProviderRuntimeContribution = Readonly<{
    builtInAcpCatalog?: boolean;
    acpBackend?: AcpBackendContributionSource;
    cliAuth?: CliAuthContributionSource;
    managedServer?: ManagedServerContributionSource;
    attach?: ProviderAttachContributionSource;
    sessionRuntimePreferences?: SessionRuntimePreferencesContributionSource;
    codingPromptBehavior?: CodingPromptBehaviorContributionSource;
    daemonSpawnHooks?: DaemonSpawnHooksContributionSource;
    vendorResumeSupport?: VendorResumeSupportContributionSource;
    checklists?: AgentChecklistContributionSource;
    sessionHandoff?: SessionHandoffContributionSource;
    preflightSessionControls?: PreflightSessionControlsContributionSource;
    cloudConnect?: CloudConnectContributionSource;
    sessionControls?: SessionControlsContributionSource;
    terminal?: TerminalContributionSource;
    cliSessionCommand?: ProviderCliSessionCommandContributionSource;
    connectedServices?: ConnectedServicesContributionSource;
    runtimeControl?: RuntimeControlContributionSource;
    externalSessions?: ExternalSessionsContributionSource;
    catalogControlAdapter?: unknown;
}>;
