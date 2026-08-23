import type {
    ConnectedAccountRequestAuthUseV1,
    ConnectedServiceCredentialRecordV1,
    ConnectedServiceId,
} from '@happier-dev/protocol';
import type {
    CloudConnectTargetStatus,
    CloudVendorKey,
} from '@happier-dev/agents';
import type {
    AuthenticatorContext as CloudCustomAuthenticatorContextV1,
    Authenticator as CloudCustomAuthenticatorV1,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';

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
    LegacyConnectedServiceRuntimeAuthFailureSourceRevisionResolver,
} from '@/agent/catalog/types';
import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';
import type { ConnectedServiceQuotaFetcherDescriptor } from '@/daemon/connectedServices/quotas/types';
import type { ConnectedServiceProviderRuntimeAuthAdapter } from '@/daemon/connectedServices/runtimeAuth/types';
import type { ConnectedServiceMaterializedHomeFreshness } from '@/daemon/connectedServices/materialization/materializedHomeFreshness';
import type { ProviderSessionArgPartitionResult } from '@/cli/providerSessionArgPartition';
import type { TerminalPromptSubmitVerificationPolicy } from '@/integrations/terminalHost/promptSubmitVerification';
import type { RuntimeActivityApplicability } from '@/agent/runtime/session/activity/runtimeActivityApplicability';

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

type ProviderAttachContributionSource = Readonly<{
    resolveTarget?: RuntimeContributionFunction;
    createArgs?: RuntimeContributionFunction;
    buildHealthUrl?: RuntimeContributionFunction;
}>;

type SessionRuntimePreferencesContributionSource = Readonly<{
    resolve?: RuntimeContributionFunction;
}>;

type SessionStartupContributionSource = Readonly<{
    shouldUseDeferredBootstrap?: RuntimeContributionFunction;
    releasedOverridesCacheV1?: unknown;
}>;

type CodingPromptBehaviorContributionSource = Readonly<{
    resolve?: RuntimeContributionFunction;
}>;

type DaemonSpawnHooksContributionSource = Readonly<{
    resolveRuntimePrerequisites?: RuntimeContributionFunction;
    augmentEnv?: RuntimeContributionFunction;
}>;

type VendorResumeSupportContributionSource = Readonly<{
    /** Declarative support level; a contributed Agent has no host-owned Agent table to read it from. */
    support?: unknown;
    resolve?: RuntimeContributionFunction;
}>;

type AgentChecklistContributionSource = NonNullable<ResolvedCatalogEntry['checklists']>;

type SessionHandoffContributionSource = Readonly<{
    agentBundleRecords?: Readonly<{
        extract?: RuntimeContributionFunction;
    }>;
    runtimeLocalMetadata?: Readonly<{
        build?: RuntimeContributionFunction;
    }>;
    nativeSessionLog?: Readonly<{
        resolvePath?: RuntimeContributionFunction;
    }>;
}>;

type PreflightSessionControlsContributionSource = Readonly<{
    connectedServiceAuth?: unknown;
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
    retainsSessionHookArtifacts?: unknown;
}>;

type PetDiscoveryContributionSource = Readonly<{
    resolveHomePath?: RuntimeContributionFunction;
    resolveHomeEntries?: RuntimeContributionFunction;
}>;

type RuntimeInstallableAdapterContributionSource = Readonly<{
    matchesDescriptor?: RuntimeContributionFunction;
    resolveSpawnSpec?: RuntimeContributionFunction;
    validateAvailability?: RuntimeContributionFunction;
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
    requestAuthUses?: unknown;
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
    sanitizeRetainedMaterializedHome?: RuntimeContributionFunction;
    stateSharingDescriptor?: unknown;
    shouldRestartForServiceSwitch?: RuntimeContributionFunction;
    unsupportedSwitchReason?: RuntimeContributionFunction;
    restartRematerializeRequiredReason?: unknown;
    connectedSwitchSharedStateRequiredReason?: unknown;
    nativeSwitchSharedStateRequiredReason?: unknown;
    exactSameSelectionRequiresResumeReachability?: unknown;
    sameAuthGroupRequiresResumeReachability?: unknown;
    verifyResumeReachable?: RuntimeContributionFunction;
    resolveCandidatePersistedSessionFile?: RuntimeContributionFunction;
    resolveResumeReachabilityUnsupported?: RuntimeContributionFunction;
    classifyUsageLimitError?: RuntimeContributionFunction;
    runtimeAuthAdapter?: unknown;
    daemonAuthBridge?: RuntimeContributionObject;
    quotaFetcherDescriptor?: unknown;
    recoveryCapabilities?: unknown;
    resolveLegacyRuntimeAuthFailureSourceRevision?: RuntimeContributionFunction;
    usageLimitRecovery?: RuntimeContributionObject;
}>;

export type ConnectedServiceStateSharingDescriptorResult = Awaited<
    ReturnType<NonNullable<ResolvedCatalogEntry['getConnectedServiceStateSharingDescriptor']>>
>;

export type ConnectedServiceRecoveryCapabilitiesResult = NonNullable<Awaited<
    ReturnType<NonNullable<ResolvedCatalogEntry['getConnectedServiceRecoveryCapabilities']>>
>>;

export type VerifyResumeReachable = NonNullable<ResolvedCatalogEntry['verifyResumeReachable']>;

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

export type SessionStartupContribution = Readonly<{
    shouldUseDeferredBootstrap: NonNullable<ResolvedCatalogEntry['shouldUseDeferredSessionStartup']>;
    releasedOverridesCacheV1?: true;
}>;

export type DaemonSpawnHooksContribution = DaemonSpawnHooks;

export type SessionHandoffAgentBundleRecordExtractor = NonNullable<
    Awaited<ReturnType<NonNullable<ResolvedCatalogEntry['getSessionHandoffAgentBundleRecordExtractor']>>>
>;

export type SessionHandoffContribution = Readonly<{
    agentBundleRecords?: Readonly<{
        extract: SessionHandoffAgentBundleRecordExtractor;
    }>;
    runtimeLocalMetadata?: Readonly<{
        build: NonNullable<ResolvedCatalogEntry['buildRuntimeLocalHandoffMetadata']>;
    }>;
    nativeSessionLog?: Readonly<{
        resolvePath: NonNullable<ResolvedCatalogEntry['resolveAgentNativeSessionLogPath']>;
    }>;
}>;

export type PreflightSessionControlsContribution = Readonly<{
    connectedServiceAuth?: 'materialized-env';
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
    exec: ExecService;
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
    retainsSessionHookArtifacts?: boolean;
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
    requestAuthUses?: readonly ConnectedAccountRequestAuthUseV1[];
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
    sanitizeRetainedMaterializedHome?: (homeRootDir: string) => Promise<void> | void;
    stateSharingDescriptor: NonNullable<ConnectedServiceStateSharingDescriptorResult>;
    shouldRestartForServiceSwitch?: (serviceId: unknown) => boolean;
    unsupportedSwitchReason?: (serviceId: unknown) => string;
    restartRematerializeRequiredReason?: string;
    connectedSwitchSharedStateRequiredReason?: string;
    nativeSwitchSharedStateRequiredReason?: string;
    exactSameSelectionRequiresResumeReachability?: boolean;
    sameAuthGroupRequiresResumeReachability?: boolean;
    verifyResumeReachable?: VerifyResumeReachable;
    resolveCandidatePersistedSessionFile?: ResolvedCatalogEntry['resolveConnectedServiceCandidatePersistedSessionFile'];
    resolveResumeReachabilityUnsupported?: VerifyResumeReachable;
    classifyUsageLimitError?: (params: Readonly<{
        providerErrorPath: boolean;
        error: unknown;
        now?: number;
        parseResetAt: typeof parseProviderResetAt;
    }>) => unknown;
    runtimeAuthAdapter?: ConnectedServiceProviderRuntimeAuthAdapter | false;
    daemonAuthBridge?: Readonly<{
        serviceIds: readonly ConnectedServiceId[];
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
    resolveLegacyRuntimeAuthFailureSourceRevision?:
        LegacyConnectedServiceRuntimeAuthFailureSourceRevisionResolver;
}>;

export type AgentRuntimeContribution = Readonly<{
    agentCliSystemTool?: Readonly<{
        toolId?: unknown;
    }>;
    runtimeActivityApplicability?: RuntimeActivityApplicability;
    cliAuth?: CliAuthContributionSource;
    attach?: ProviderAttachContributionSource;
    sessionRuntimePreferences?: SessionRuntimePreferencesContributionSource;
    sessionStartup?: SessionStartupContributionSource;
    codingPromptBehavior?: CodingPromptBehaviorContributionSource;
    daemonSpawnHooks?: DaemonSpawnHooksContributionSource;
    vendorResumeSupport?: VendorResumeSupportContributionSource;
    checklists?: AgentChecklistContributionSource;
    sessionHandoff?: SessionHandoffContributionSource;
    preflightSessionControls?: PreflightSessionControlsContributionSource;
    cloudConnect?: CloudConnectContributionSource;
    sessionControls?: SessionControlsContributionSource;
    terminal?: TerminalContributionSource;
    petDiscovery?: PetDiscoveryContributionSource;
    runtimeInstallableAdapter?: RuntimeInstallableAdapterContributionSource;
    cliSessionCommand?: ProviderCliSessionCommandContributionSource;
    connectedServices?: ConnectedServicesContributionSource;
}>;
