import type {
    ConnectedAccountRequestAuthUseV1,
    ConnectedServiceCredentialRecordV1,
    ConnectedServiceId,
} from '@happier-dev/protocol';
import type {
    ConnectedServiceSessionFileImportDetail,
    ConnectedServiceSessionFileImportRoot,
} from '@/daemon/connectedServices/stateSharing/importConnectedServiceSessionFiles';
import type { parseProviderResetAt } from '@/daemon/connectedServices/quotas/normalization';
import type {
    ConnectedServiceDaemonAuthBridgeRefresh,
    LegacyConnectedServiceRuntimeAuthFailureSourceRevisionResolver,
} from '@/agent/catalog/types';
import type { ConnectedServiceQuotaFetcherDescriptor } from '@/daemon/connectedServices/quotas/types';
import type { ConnectedServiceProviderRuntimeAuthAdapter } from '@/daemon/connectedServices/runtimeAuth/types';
import type { ConnectedServiceMaterializedHomeFreshness } from '@/daemon/connectedServices/materialization/materializedHomeFreshness';

import type { ResolvedCatalogEntry } from './types';
import type { ConnectedServiceStateSharingMode } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';

type RuntimeContributionFunction =
    | (() => unknown)
    | ((first: never) => unknown)
    | ((first: never, second: never) => unknown)
    | ((first: never, second: never, third: never) => unknown);

type RuntimeContributionObject = Readonly<Record<string, unknown>>;

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
    reconcileStateSharingSource?: (params: Readonly<{
        sourceRoot: string;
        materializedRootDir: string;
    }>) => Promise<void> | void;
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
    sessionHandoff?: SessionHandoffContributionSource;
    connectedServices?: ConnectedServicesContributionSource;
}>;
