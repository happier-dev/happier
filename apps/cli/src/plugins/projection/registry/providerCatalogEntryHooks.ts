import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';
import type {
    AcpBackendSpecV1,
    ExecRuntimeServiceV1,
    FetchRuntimeRequestV1,
    PluginSystemToolContributionV1,
} from '@happier-dev/plugin-sdk';
import {
    ConnectedServiceIdSchema,
    readConnectedServiceLimitCategoryV1,
    resolveConnectedServicesProviderStateSharingPolicyV1,
    type ConnectedServiceCredentialRecordV1,
    type ConnectedServiceId,
} from '@happier-dev/protocol';

import { createBuiltInCliAuthSpec } from '@/agent/acp/catalog/builtIn/auth';
import { createBuiltInCliDetect } from '@/agent/acp/catalog/builtIn/detect';
import { createCatalogCliAuthSpec } from '@/capabilities/cliAuth/createCatalogCliAuthSpec';
import type {
    PreflightSessionControlsProbeKind,
    PreflightSessionControlsProbeParams,
} from '@/capabilities/probes/preflightSessionControlsProbeAdapterTypes';
import { runCliCommandBestEffort } from '@/capabilities/cliAuth/shared';
import {
    hasExactConnectedServiceRestartContinuityContext,
    isConnectedToConnectedServiceSwitch,
    isExactSameConnectedServiceSelection,
    isSameConnectedServiceAuthGroup,
    providerSessionStateUnavailableForResume,
} from '@/backends/connectedServices/switchContinuityContext';
import type {
    CatalogAgentId,
    ConnectedServiceSwitchContinuityParams,
    ConnectedServiceSwitchContinuityResult,
} from '@/backends/types';
import {
    isCloudConnectAuthenticateResultV1,
    type CloudAuthCredentialWriteInputV1,
    type CloudAuthCredentialWriteResultV1,
    type CloudAuthDiagnosticV1,
    type CloudAuthFailureCodeV1,
    type CloudAuthLoopbackInputV1,
    type CloudAuthLoopbackResultV1,
    type CloudAuthOpenBrowserResultV1,
    type CloudAuthPromptTextInputV1,
    type CloudAuthPromptTextResultV1,
    type CloudConnectAuthenticateOptions,
    type CloudConnectAuthenticateResultV1,
    type CloudConnectTarget,
} from '@/cloud/connectTypes';
import { createCloudAuthCallbackService } from '@/cloud/auth/services/callback';
import { resolveConnectedServiceCredentials } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import { buildSafeOauthProviderFailureMessage } from '@/cloud/safeOauthProviderError';
import { generatePkceCodes } from '@/cloud/pkce';
import { parseOauthRedirectPaste } from '@/cloud/parseOauthRedirectPaste';
import { createGlobalConnectedServiceFetchRuntime } from '@/daemon/connectedServices/shared/runtimeFetch';
import {
    resolveConnectedServiceGroupHomeDir,
    resolveConnectedServiceHomeDir,
} from '@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir';
import { readConnectedServiceMaterializedEnvKeysFromEnv } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import {
    createRetainedConnectedServicesMaterialization,
    type ConnectedServicesMaterializationDiagnostic,
    type ConnectedServicesMaterializer,
} from '@/daemon/connectedServices/materialization/materializer';
import { parseProviderResetAt } from '@/daemon/connectedServices/quotas/normalization';
import { createRestartResumeConnectedServiceRuntimeAuthAdapter } from '@/daemon/connectedServices/runtimeAuth/createRestartResumeConnectedServiceRuntimeAuthAdapter';
import type {
    ConnectedServiceProviderRuntimeAuthAdapter,
    ConnectedServiceRuntimeFailureClassification,
} from '@/daemon/connectedServices/runtimeAuth/types';
import { sanitizeConnectedServiceDiagnosticString } from '@/daemon/connectedServices/runtimeAuth/sanitizeConnectedServiceDiagnosticString';
import { canResumeFromMaterializedState } from '@/daemon/connectedServices/stateSharing/canResumeFromMaterializedState';
import { applyConnectedServiceStateSharingDescriptor } from '@/daemon/connectedServices/stateSharing/applyConnectedServiceStateSharingDescriptor';
import { withConnectedServiceStateSharingDestinationLock } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingLock';
import {
    readConnectedServiceStateSharingManifest,
    writeConnectedServiceStateSharingManifest,
} from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';
import type { ConnectedServiceRuntimeAuthSelectionMaterializer } from '@/daemon/connectedServices/sessionAuthSwitch/runtimeAuthSelectionMaterializerTypes';
import type { SessionConnectedServiceRuntimeAuthSelectionMaterializerInput } from '@/daemon/connectedServices/sessionAuthSwitch/switchSessionConnectedServiceAuth';
import { createHostRuntimeControlService } from '@/session/runtime/control/service';
import {
    createResolvedSessionRuntimeControlTransport,
    createSessionRuntimeControlTransport,
} from '@/session/runtime/control/transport';
import { createSessionRuntimeControlReachability } from '@/session/runtime/control/reachability';
import { configuration } from '@/configuration';
import { requireProviderCliLaunchSpec } from '@/packagedRuntime/managedTools/requireProviderCliLaunchSpec';
import {
    normalizePluginAcpDefinition,
    type AcpRuntimeDefinitionBridgeV1,
} from '@/agent/acp/runtime/definition';
import { createPluginExecService } from '@/plugins/runtime/context/exec';
import {
    readManagedServerStateAtPathBestEffort,
    readManagedServerStateBestEffort,
    releaseManagedServerForSwitch,
    releaseManagedServerForSwitchFromState,
    resolveManagedServerStatePath,
    stopManagedServerBestEffort,
} from '@/plugins/runtime/context/managedServerPersistence';
import { createProviderCliAttachOps } from '@/session/attach/providerCliAttach';
import { createBackoffSessionUsageLimitRecoveryControlAdapter } from '@/session/usageLimitRecoveryControls/createBackoffSessionUsageLimitRecoveryControlAdapter';
import { promptInput, promptSecretInput } from '@/terminal/prompts/promptInput';
import { openBrowser } from '@/ui/openBrowser';
import { readPositiveIntEnv } from '@/utils/readPositiveIntEnv';
import { delay } from '@/utils/time';

import type {
    ResolvedCatalogEntry,
    ResolvedProviderContribution,
} from './types';
import type {
    CliAuthContribution,
    CloudCustomAuthenticatorContextV1,
    CloudConnectContribution,
    ConnectedServiceStateSharingDescriptorResult,
    ConnectedServicesContribution,
    ExternalSessionsContribution,
    ManagedServerContribution,
    PreflightSessionControlsContribution,
    ProviderCliSessionCommandContribution,
    ProviderAttachContribution,
    ProviderRuntimeContribution,
    RuntimeControlContribution,
    SessionControlsContribution,
    SessionCatalogControlAdapterResult,
    SessionGoalControlAdapterResult,
    SessionHandoffContribution,
    SessionHandoffProviderBundleRecordExtractor,
    SessionRuntimePreferencesContribution,
    SessionUsageLimitRecoveryControlAdapterResult,
    TerminalContribution,
    VerifyResumeReachable,
} from './providerRuntimeContribution';

type CredentialRecord = ConnectedServiceCredentialRecordV1;
type ProviderCatalogHookFactory = () => Partial<NonNullable<ResolvedProviderContribution['catalogEntry']>>;
type CatalogCliCommandHandler = Awaited<ReturnType<NonNullable<ResolvedCatalogEntry['getCliCommandHandler']>>>;
type RunBackendSessionCliCommand = typeof import('@/cli/runBackendSessionCliCommand')['runBackendSessionCliCommand'];
type ResolveSessionCommandResumeDelegation =
    typeof import('@/cli/sessionCommandResumeDelegation')['resolveSessionCommandResumeDelegation'];
type HandleResumeCommand = typeof import('@/cli/commands/resume')['handleResumeCommand'];
type CliSessionCommandHandlerDeps = Readonly<{
    runBackendSessionCliCommand?: RunBackendSessionCliCommand;
    resolveSessionCommandResumeDelegation?: ResolveSessionCommandResumeDelegation;
    handleResumeCommand?: HandleResumeCommand;
}>;
type AcpBackendSpecFactory = (params: Readonly<{
    cwd: string;
    env: NodeJS.ProcessEnv;
}>) => AcpBackendSpecV1;
type RuntimeControlGoalAdapter = NonNullable<SessionGoalControlAdapterResult>;
type RuntimeControlCatalogAdapter = NonNullable<SessionCatalogControlAdapterResult>;
type RuntimeControlUsageLimitRecoveryAdapter = NonNullable<SessionUsageLimitRecoveryControlAdapterResult>;
type RuntimeControlGoalGetParams = Parameters<NonNullable<RuntimeControlGoalAdapter['getGoal']>>[0];
type RuntimeControlGoalSetParams = Parameters<NonNullable<RuntimeControlGoalAdapter['setGoal']>>[0];
type RuntimeControlGoalClearParams = Parameters<NonNullable<RuntimeControlGoalAdapter['clearGoal']>>[0];
type RuntimeControlCatalogVendorPluginsParams = Parameters<NonNullable<RuntimeControlCatalogAdapter['listVendorPlugins']>>[0];
type RuntimeControlCatalogSkillsParams = Parameters<NonNullable<RuntimeControlCatalogAdapter['listSkills']>>[0];
type RuntimeControlUsageLimitRecoveryCheckParams = Parameters<NonNullable<RuntimeControlUsageLimitRecoveryAdapter['checkNow']>>[0];
type CatalogVendorResumeSupport = Awaited<ReturnType<NonNullable<ResolvedCatalogEntry['getVendorResumeSupport']>>>;
type CatalogChecklistContributions = NonNullable<ResolvedCatalogEntry['checklists']>;

type MaterializedAuthEnvironmentResult = Awaited<ReturnType<ConnectedServicesContribution['materializeAuthEnvironment']>>;
type CloudConnectOauthAuthorizationCode = NonNullable<CloudConnectContribution['oauthAuthorizationCode']>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readFunction<T>(value: unknown): T | null {
    return typeof value === 'function' ? value as T : null;
}

function readPositiveNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function readStringArray(value: unknown): readonly string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function readNonEmptyStringArray(value: unknown): readonly string[] {
    return Array.isArray(value)
        ? value.flatMap((entry) => {
            const stringValue = readString(entry);
            return stringValue ? [stringValue] : [];
        })
        : [];
}

function readStringFunction(value: unknown): ((input: string) => string) | null {
    return typeof value === 'function' ? value as (input: string) => string : null;
}

function readStringArrayFunction(value: unknown): ((input: string[]) => string[]) | null {
    return typeof value === 'function' ? value as (input: string[]) => string[] : null;
}

function readCloudConnectStatus(value: unknown): CloudConnectContribution['status'] | null {
    return value === 'wired' || value === 'experimental' ? value : null;
}

function readCloudVendorKey(value: unknown): CloudConnectContribution['vendorKey'] | null {
    return value === 'openai' || value === 'anthropic' || value === 'gemini' || value === 'scm'
        ? value
        : null;
}

function readConnectedServiceIdArray(value: unknown): readonly ConnectedServiceId[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
        const parsed = ConnectedServiceIdSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
    });
}

function mergeNodeEnv(
    env: Readonly<Record<string, string | undefined>> | undefined,
): NodeJS.ProcessEnv {
    const merged: NodeJS.ProcessEnv = { ...process.env };
    for (const [key, value] of Object.entries(env ?? {})) {
        if (typeof value === 'string') {
            merged[key] = value;
        } else {
            delete merged[key];
        }
    }
    return merged;
}

function readAcpBackendSpecFactory(value: unknown): AcpBackendSpecFactory | null {
    if (!isRecord(value)) return null;
    const createSpec = readFunction<AcpBackendSpecFactory>(value.createSpec);
    if (createSpec) return createSpec;
    const spec = isRecord(value.spec) ? value.spec as AcpBackendSpecV1 : null;
    return spec ? () => spec : null;
}

function createAcpRuntimeDefinitionBridge(params: Readonly<{
    contribution: NonNullable<ProviderRuntimeContribution['acpBackend']>;
    exec: Pick<ExecRuntimeServiceV1, 'systemTools'>;
}>): AcpRuntimeDefinitionBridgeV1 | null {
    const createSpec = readAcpBackendSpecFactory(params.contribution);
    if (!createSpec) return null;
    return Object.freeze({
        exec: params.exec,
        createDefinition: ({ cwd, env }) => normalizePluginAcpDefinition({
            spec: createSpec({
                cwd,
                env: mergeNodeEnv(env),
            }),
        }),
    });
}

function readRuntimeAuthAdapter(value: unknown): ConnectedServicesContribution['runtimeAuthAdapter'] {
    if (value === false) return false;
    if (!isRecord(value)) return undefined;
    return typeof value.classifyRuntimeAuthFailure === 'function'
        && typeof value.materializeActiveProfile === 'function'
        && typeof value.canHotApply === 'function'
        && typeof value.hotApply === 'function'
        && typeof value.recoverAfterRuntimeAuthSwitch === 'function'
        && typeof value.probeQuota === 'function'
        && typeof value.refreshActiveProfile === 'function'
        ? value as ConnectedServicesContribution['runtimeAuthAdapter']
        : undefined;
}

function readFailureCacheStrategy(value: unknown): 'cooldown' | 'retry' | undefined {
    return value === 'cooldown' || value === 'retry' ? value : undefined;
}

function readManagedServerContribution(value: unknown): ManagedServerContribution | null {
    if (!isRecord(value)) return null;
    const timeouts = isRecord(value.timeouts) ? value.timeouts : {};
    const namespace = readString(value.namespace);
    const statePathEnvKey = readString(value.statePathEnvKey);
    const resolveStateFingerprintInput = readFunction<ManagedServerContribution['resolveStateFingerprintInput']>(
        value.resolveStateFingerprintInput,
    );
    const isExpectedProcessCommand = readFunction<ManagedServerContribution['isExpectedProcessCommand']>(
        value.isExpectedProcessCommand,
    );
    const buildHealthUrl = readFunction<ManagedServerContribution['buildHealthUrl']>(value.buildHealthUrl);
    const logLabel = readString(value.logLabel);
    if (!namespace || !statePathEnvKey || !resolveStateFingerprintInput || !isExpectedProcessCommand || !buildHealthUrl || !logLabel) {
        return null;
    }

    return {
        namespace,
        statePathEnvKey,
        resolveStateFingerprintInput,
        isExpectedProcessCommand,
        buildHealthUrl,
        logLabel,
        timeouts: {
            authSwitchDrainMsEnvKey: readString(timeouts.authSwitchDrainMsEnvKey) ?? '',
            authSwitchDrainMsDefault: readPositiveNumber(timeouts.authSwitchDrainMsDefault) ?? 9_000,
            healthProbeMsEnvKey: readString(timeouts.healthProbeMsEnvKey) ?? '',
            healthProbeMsDefault: readPositiveNumber(timeouts.healthProbeMsDefault) ?? 750,
            shutdownGraceMsEnvKey: readString(timeouts.shutdownGraceMsEnvKey) ?? '',
            shutdownGraceMsDefault: readPositiveNumber(timeouts.shutdownGraceMsDefault) ?? 5_000,
            forceKillWaitMsEnvKey: readString(timeouts.forceKillWaitMsEnvKey) ?? '',
            forceKillWaitMsDefault: readPositiveNumber(timeouts.forceKillWaitMsDefault) ?? 500,
            pollIntervalMsEnvKey: readString(timeouts.pollIntervalMsEnvKey) ?? '',
            pollIntervalMsDefault: readPositiveNumber(timeouts.pollIntervalMsDefault) ?? 50,
        },
    };
}

function readProviderAttachContribution(value: unknown): ProviderAttachContribution | null {
    if (!isRecord(value)) return null;
    const resolveTarget = readFunction<ProviderAttachContribution['resolveTarget']>(value.resolveTarget);
    const createArgs = readFunction<ProviderAttachContribution['createArgs']>(value.createArgs);
    const buildHealthUrl = readFunction<ProviderAttachContribution['buildHealthUrl']>(value.buildHealthUrl);
    return resolveTarget && createArgs && buildHealthUrl
        ? { resolveTarget, createArgs, buildHealthUrl }
        : null;
}

function readSessionRuntimePreferencesContribution(value: unknown): SessionRuntimePreferencesContribution | null {
    if (!isRecord(value)) return null;
    const resolve = readFunction<SessionRuntimePreferencesContribution['resolve']>(value.resolve);
    return resolve ? { resolve } : null;
}

function readExternalSessionsContribution(value: unknown): ExternalSessionsContribution | null {
    if (!isRecord(value)) return null;
    const createTranscriptStoreAdapter = readFunction<ExternalSessionsContribution['createTranscriptStoreAdapter']>(
        value.createTranscriptStoreAdapter,
    );
    const createCandidateHostAdapter = readFunction<ExternalSessionsContribution['createCandidateHostAdapter']>(
        value.createCandidateHostAdapter,
    );
    return createTranscriptStoreAdapter || createCandidateHostAdapter
        ? {
            ...(createTranscriptStoreAdapter ? { createTranscriptStoreAdapter } : {}),
            ...(createCandidateHostAdapter ? { createCandidateHostAdapter } : {}),
        }
        : null;
}

function readSessionHandoffContribution(value: unknown): SessionHandoffContribution | null {
    if (!isRecord(value)) return null;
    const surface = isRecord(value.surface)
        && typeof value.surface.exportBundle === 'function'
        && typeof value.surface.importBundle === 'function'
        ? value.surface as SessionHandoffContribution['surface']
        : null;
    const providerBundleRecords = isRecord(value.providerBundleRecords) ? value.providerBundleRecords : null;
    const extract = readFunction<SessionHandoffProviderBundleRecordExtractor>(providerBundleRecords?.extract);
    if (!surface && !extract) return null;
    return {
        ...(surface ? { surface } : {}),
        ...(extract ? { providerBundleRecords: { extract } } : {}),
    };
}

function readCliAuthContribution(value: unknown): CliAuthContribution | null {
    if (!isRecord(value)) return null;
    const detectAuthStatus = readFunction<CliAuthContribution['detectAuthStatus']>(value.detectAuthStatus);
    return detectAuthStatus ? { detectAuthStatus } : null;
}

function readConnectedServiceRecoveryCapabilities(
    value: unknown,
): NonNullable<ConnectedServicesContribution['recoveryCapabilities']> | null {
    if (!isRecord(value)) return null;
    const predictiveSoftSwitch = isRecord(value.predictiveSoftSwitch) ? value.predictiveSoftSwitch : null;
    const mode = predictiveSoftSwitch?.mode;
    if (mode !== 'supported' && mode !== 'unsupported') return null;
    return { predictiveSoftSwitch: { mode } };
}

function readConnectedServicesContribution(value: unknown): ConnectedServicesContribution | null {
    if (!isRecord(value)) return null;
    const serviceIds = readConnectedServiceIdArray(value.serviceIds);
    const stateSharingServiceIds = readConnectedServiceIdArray(value.stateSharingServiceIds);
    const materializedHomeCredentialEntries = readStringArray(value.materializedHomeCredentialEntries);
    const resolveStateSharingSourceRoot = readFunction<ConnectedServicesContribution['resolveStateSharingSourceRoot']>(
        value.resolveStateSharingSourceRoot,
    );
    const resolveStateSharingStateEntryNames = readFunction<ConnectedServicesContribution['resolveStateSharingStateEntryNames']>(
        value.resolveStateSharingStateEntryNames,
    );
    const resolveStateSharingStateSourceRoot = readFunction<ConnectedServicesContribution['resolveStateSharingStateSourceRoot']>(
        value.resolveStateSharingStateSourceRoot,
    );
    const createStateSharingSessionImportRoots = readFunction<ConnectedServicesContribution['createStateSharingSessionImportRoots']>(
        value.createStateSharingSessionImportRoots,
    );
    const resolveVendorResumeIdFromImportedFile = readFunction<ConnectedServicesContribution['resolveVendorResumeIdFromImportedFile']>(
        value.resolveVendorResumeIdFromImportedFile,
    );
    const readConnectedServiceId = readFunction<ConnectedServicesContribution['readConnectedServiceId']>(
        value.readConnectedServiceId,
    );
    const createAuthMaterializationInput = readFunction<ConnectedServicesContribution['createAuthMaterializationInput']>(
        value.createAuthMaterializationInput,
    );
    const materializeAuthEnvironment = readFunction<ConnectedServicesContribution['materializeAuthEnvironment']>(
        value.materializeAuthEnvironment,
    );
    const shouldRestartForServiceSwitch = readFunction<ConnectedServicesContribution['shouldRestartForServiceSwitch']>(
        value.shouldRestartForServiceSwitch,
    );
    const resolveResumeReachabilityUnsupported = readFunction<ConnectedServicesContribution['resolveResumeReachabilityUnsupported']>(
        value.resolveResumeReachabilityUnsupported,
    );
    const classifyUsageLimitError = readFunction<ConnectedServicesContribution['classifyUsageLimitError']>(
        value.classifyUsageLimitError,
    );
    const runtimeAuthAdapter = readRuntimeAuthAdapter(value.runtimeAuthAdapter);
    const restartRematerializeRequiredReason = readString(value.restartRematerializeRequiredReason);
    const connectedSwitchSharedStateRequiredReason = readString(value.connectedSwitchSharedStateRequiredReason);
    const nativeSwitchSharedStateRequiredReason = readString(value.nativeSwitchSharedStateRequiredReason);
    const usageLimitRecovery = isRecord(value.usageLimitRecovery) ? value.usageLimitRecovery : null;
    const providerId = readString(usageLimitRecovery?.providerId);
    const issueProviderFilter = readString(usageLimitRecovery?.issueProviderFilter);
    const parsedDefaultNativeServiceId = usageLimitRecovery?.defaultNativeServiceId === undefined
        ? null
        : ConnectedServiceIdSchema.safeParse(usageLimitRecovery.defaultNativeServiceId);
    const defaultNativeServiceId = parsedDefaultNativeServiceId?.success ? parsedDefaultNativeServiceId.data : null;
    const fallbackBackoffEnvKey = readString(usageLimitRecovery?.fallbackBackoffEnvKey);
    const maxAttemptsEnvKey = readString(usageLimitRecovery?.maxAttemptsEnvKey);
    const defaultFallbackBackoffMs = readPositiveNumber(usageLimitRecovery?.defaultFallbackBackoffMs);
    const defaultMaxAttempts = readPositiveNumber(usageLimitRecovery?.defaultMaxAttempts);
    const recoveryCapabilities = readConnectedServiceRecoveryCapabilities(value.recoveryCapabilities);
    const stateSharingDescriptor = value.stateSharingDescriptor as ConnectedServiceStateSharingDescriptorResult;
    if (
        serviceIds.length === 0
        || !readConnectedServiceId
        || !createAuthMaterializationInput
        || !materializeAuthEnvironment
        || !stateSharingDescriptor
    ) {
        return null;
    }
    return {
        serviceIds,
        ...(stateSharingServiceIds.length > 0 ? { stateSharingServiceIds } : {}),
        ...(readString(value.materializedRootSubdir) ? { materializedRootSubdir: readString(value.materializedRootSubdir)! } : {}),
        ...(materializedHomeCredentialEntries.length > 0 ? { materializedHomeCredentialEntries } : {}),
        ...(resolveStateSharingSourceRoot ? { resolveStateSharingSourceRoot } : {}),
        ...(resolveStateSharingStateEntryNames ? { resolveStateSharingStateEntryNames } : {}),
        ...(resolveStateSharingStateSourceRoot ? { resolveStateSharingStateSourceRoot } : {}),
        ...(createStateSharingSessionImportRoots ? { createStateSharingSessionImportRoots } : {}),
        ...(resolveVendorResumeIdFromImportedFile ? { resolveVendorResumeIdFromImportedFile } : {}),
        readConnectedServiceId,
        createAuthMaterializationInput,
        materializeAuthEnvironment,
        stateSharingDescriptor,
        ...(value.materializeRuntimeAuthSelection === false ? { materializeRuntimeAuthSelection: false } : {}),
        ...(shouldRestartForServiceSwitch ? { shouldRestartForServiceSwitch } : {}),
        ...(restartRematerializeRequiredReason ? { restartRematerializeRequiredReason } : {}),
        ...(connectedSwitchSharedStateRequiredReason ? { connectedSwitchSharedStateRequiredReason } : {}),
        ...(nativeSwitchSharedStateRequiredReason ? { nativeSwitchSharedStateRequiredReason } : {}),
        ...(value.sameAuthGroupRequiresResumeReachability === true ? { sameAuthGroupRequiresResumeReachability: true } : {}),
        ...(resolveResumeReachabilityUnsupported ? { resolveResumeReachabilityUnsupported } : {}),
        ...(classifyUsageLimitError ? { classifyUsageLimitError } : {}),
        ...(runtimeAuthAdapter !== undefined ? { runtimeAuthAdapter } : {}),
        ...(providerId && fallbackBackoffEnvKey && maxAttemptsEnvKey && defaultFallbackBackoffMs && defaultMaxAttempts
            ? {
                usageLimitRecovery: {
                    providerId,
                    ...(issueProviderFilter ? { issueProviderFilter } : {}),
                    ...(defaultNativeServiceId ? { defaultNativeServiceId } : {}),
                    fallbackBackoffEnvKey,
                    maxAttemptsEnvKey,
                    defaultFallbackBackoffMs,
                    defaultMaxAttempts,
                },
            }
            : {}),
        ...(recoveryCapabilities ? { recoveryCapabilities } : {}),
    };
}

function readPreflightSessionControlsContribution(value: unknown): PreflightSessionControlsContribution | null {
    if (!isRecord(value)) return null;
    const probeModelsCommandArgs = readStringArray(value.probeModelsCommandArgs);
    const probeModelsFromCommandOutput = readFunction<NonNullable<PreflightSessionControlsContribution['probeModels']>['parseOutput']>(
        value.probeModelsFromCommandOutput,
    );
    const resolveProbeVariant = readFunction<NonNullable<PreflightSessionControlsContribution['resolveProbeVariant']>>(
        value.resolveProbeVariant,
    );
    const probeModelsRaw = readFunction<NonNullable<PreflightSessionControlsContribution['probeModelsRaw']>>(
        value.probeModelsRaw,
    );
    const probeModesRaw = readFunction<NonNullable<PreflightSessionControlsContribution['probeModesRaw']>>(
        value.probeModesRaw,
    );
    const probeConfigOptionsRaw = readFunction<NonNullable<PreflightSessionControlsContribution['probeConfigOptionsRaw']>>(
        value.probeConfigOptionsRaw,
    );
    const cliModelsCommandArgs = readStringArray(value.cliModelsCommandArgs);
    const verboseModelsCommandArgs = readStringArray(value.verboseModelsCommandArgs);
    return {
        failureCacheStrategy: readFailureCacheStrategy(value.failureCacheStrategy),
        ...(value.needsAccountSettings === true ? { needsAccountSettings: true } : {}),
        ...(resolveProbeVariant ? { resolveProbeVariant } : {}),
        cliModelsCommandArgs: cliModelsCommandArgs.length > 0
            ? cliModelsCommandArgs
            : verboseModelsCommandArgs,
        ...(verboseModelsCommandArgs.length > 0 ? { verboseModelsCommandArgs } : {}),
        ...(probeModelsRaw ? { probeModelsRaw } : {}),
        ...(probeModelsCommandArgs.length > 0 && probeModelsFromCommandOutput
            ? {
                probeModels: {
                    commandArgs: probeModelsCommandArgs,
                    parseOutput: probeModelsFromCommandOutput,
                },
            }
            : {}),
        ...(probeModesRaw ? { probeModesRaw } : {}),
        ...(probeConfigOptionsRaw ? { probeConfigOptionsRaw } : {}),
    };
}

function readCloudConnectContribution(value: unknown): CloudConnectContribution | null {
    if (!isRecord(value)) return null;
    const oauth = isRecord(value.oauthAuthorizationCode) ? value.oauthAuthorizationCode : null;
    const displayName = readString(value.displayName);
    const vendorDisplayName = readString(value.vendorDisplayName);
    const vendorKey = readCloudVendorKey(value.vendorKey);
    const status = readCloudConnectStatus(value.status);
    const clientId = readString(oauth?.clientId);
    const authorizeUrl = readString(oauth?.authorizeUrl);
    const tokenUrl = readString(oauth?.tokenUrl);
    const redirectUri = readString(oauth?.redirectUri);
    const scope = readString(oauth?.scope);
    const customAuthenticator = isRecord(value.customAuthenticator) ? value.customAuthenticator : null;
    const authenticate =
        readFunction<NonNullable<CloudConnectContribution['authenticate']>>(customAuthenticator?.authenticate)
        ?? readFunction<NonNullable<CloudConnectContribution['authenticate']>>(value.authenticate);
    const oauthAuthorizationCode = clientId && authorizeUrl && tokenUrl && redirectUri && scope
        ? {
            clientId,
            authorizeUrl,
            tokenUrl,
            redirectUri,
            scope,
        }
        : null;
    if (!displayName || !vendorDisplayName || !vendorKey || !status || (!oauthAuthorizationCode && !authenticate)) {
        return null;
    }
    return {
        displayName,
        vendorDisplayName,
        vendorKey,
        status,
        ...(oauthAuthorizationCode ? { oauthAuthorizationCode } : {}),
        ...(authenticate ? { authenticate } : {}),
    };
}

function readSessionControlsContribution(value: unknown): SessionControlsContribution | null {
    if (!isRecord(value)) return null;
    const normalizePermissionMode = readStringFunction(value.normalizePermissionMode);
    return normalizePermissionMode ? { normalizePermissionMode } : null;
}

function readTerminalContribution(value: unknown): TerminalContribution | null {
    if (!isRecord(value)) return null;
    const transformHeadlessTmuxArgv = readStringArrayFunction(value.transformHeadlessTmuxArgv);
    return transformHeadlessTmuxArgv ? { transformHeadlessTmuxArgv } : null;
}

export function readCliSessionCommandContribution(
    value: unknown,
    defaultAgentId: CatalogAgentId,
): ProviderCliSessionCommandContribution | null {
    if (!isRecord(value)) return null;
    const backendIdForSessionRuntime = readString(value.backendIdForSessionRuntime) ?? defaultAgentId;
    if (!backendIdForSessionRuntime) return null;
    const agentIdForDeprecatedAliases = readString(value.agentIdForDeprecatedAliases);
    const agentIdForAccountSettings = readString(value.agentIdForAccountSettings);
    const directoryFlags = readStringArray(value.directoryFlags);
    const yoloProviderArgs = readStringArray(value.yoloProviderArgs);
    const versionFlags = readStringArray(value.versionFlags);
    const implicitResumeDelegation = isRecord(value.implicitResumeDelegation)
        ? {
            resumeFlags: readNonEmptyStringArray(value.implicitResumeDelegation.resumeFlags),
        }
        : null;
    const buildSessionOptions = readFunction<ProviderCliSessionCommandContribution['buildSessionOptions']>(
        value.buildSessionOptions,
    );

    return {
        backendIdForSessionRuntime,
        ...(agentIdForDeprecatedAliases ? { agentIdForDeprecatedAliases } : {}),
        ...(agentIdForAccountSettings ? { agentIdForAccountSettings } : {}),
        ...(implicitResumeDelegation && implicitResumeDelegation.resumeFlags.length > 0
            ? { implicitResumeDelegation }
            : {}),
        ...(directoryFlags.length > 0 ? { directoryFlags } : {}),
        ...(typeof value.forwardModelFlag === 'boolean' ? { forwardModelFlag: value.forwardModelFlag } : {}),
        ...(typeof value.forwardResumeFlag === 'boolean' ? { forwardResumeFlag: value.forwardResumeFlag } : {}),
        ...(yoloProviderArgs.length > 0 ? { yoloProviderArgs } : {}),
        ...(versionFlags.length > 0 ? { versionFlags } : {}),
        ...(buildSessionOptions ? { buildSessionOptions } : {}),
    };
}

function normalizeCliSessionCommandOptions(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) return {};
    if (value.ok === false) {
        const errorMessage = readString(value.errorMessage) ?? 'Provider CLI session command rejected the request.';
        throw new Error(errorMessage);
    }
    if (value.ok === true && isRecord(value.options)) {
        return value.options;
    }
    return value;
}

export function createCliSessionCommandHandler(
    cliSessionCommand: ProviderCliSessionCommandContribution,
    cliSubcommand: string,
    deps: CliSessionCommandHandlerDeps = {},
) {
    return async () => {
        const runBackendSessionCliCommand = deps.runBackendSessionCliCommand
            ?? (await import('@/cli/runBackendSessionCliCommand')).runBackendSessionCliCommand;
        return async (context: Parameters<CatalogCliCommandHandler>[0]) => {
            if (cliSessionCommand.implicitResumeDelegation) {
                const resolveSessionCommandResumeDelegation = deps.resolveSessionCommandResumeDelegation
                    ?? (await import('@/cli/sessionCommandResumeDelegation')).resolveSessionCommandResumeDelegation;
                const decision = await resolveSessionCommandResumeDelegation({
                    args: context.args,
                    explicitProviderSubcommand: context.args[0] === cliSubcommand,
                    resumeFlags: cliSessionCommand.implicitResumeDelegation.resumeFlags,
                });
                if (decision.kind === 'delegate') {
                    const handleResumeCommand = deps.handleResumeCommand
                        ?? (await import('@/cli/commands/resume')).handleResumeCommand;
                    await handleResumeCommand([decision.sessionId], {
                        terminalRuntime: context.terminalRuntime,
                        rawArgv: context.rawArgv,
                    });
                    return;
                }
            }

            await runBackendSessionCliCommand({
                context,
                backendIdForSessionRuntime: cliSessionCommand.backendIdForSessionRuntime,
                ...(cliSessionCommand.agentIdForDeprecatedAliases
                    ? {
                        agentIdForDeprecatedAliases: cliSessionCommand.agentIdForDeprecatedAliases as Parameters<typeof runBackendSessionCliCommand>[0]['agentIdForDeprecatedAliases'],
                    }
                    : {}),
                ...(cliSessionCommand.agentIdForAccountSettings
                    ? {
                        agentIdForAccountSettings: cliSessionCommand.agentIdForAccountSettings as Parameters<typeof runBackendSessionCliCommand>[0]['agentIdForAccountSettings'],
                    }
                    : {}),
                ...(cliSessionCommand.directoryFlags ? { directoryFlags: cliSessionCommand.directoryFlags } : {}),
                ...(cliSessionCommand.forwardModelFlag !== undefined
                    ? { forwardModelFlag: cliSessionCommand.forwardModelFlag }
                    : {}),
                ...(cliSessionCommand.forwardResumeFlag !== undefined
                    ? { forwardResumeFlag: cliSessionCommand.forwardResumeFlag }
                    : {}),
                ...(cliSessionCommand.yoloProviderArgs ? { yoloProviderArgs: cliSessionCommand.yoloProviderArgs } : {}),
                ...(cliSessionCommand.versionFlags ? { versionFlags: cliSessionCommand.versionFlags } : {}),
                ...(cliSessionCommand.buildSessionOptions
                    ? {
                        resolveExtraOptions: (args, parsed) => normalizeCliSessionCommandOptions(
                            cliSessionCommand.buildSessionOptions!({ args, parsed }),
                        ),
                    }
                    : {}),
            });
        };
    };
}

function readSessionCatalogControlAdapter(value: unknown): SessionCatalogControlAdapterResult {
    return isRecord(value) ? value as SessionCatalogControlAdapterResult : null;
}

function readRuntimeControlContribution(value: unknown): RuntimeControlContribution | null {
    if (!isRecord(value)) return null;
    const appServer = isRecord(value.appServer) ? value.appServer : null;
    const connectedServices = isRecord(value.connectedServices) ? value.connectedServices : null;
    const goal = isRecord(value.goal) ? value.goal : null;
    const catalog = isRecord(value.catalog) ? value.catalog : null;
    const usageLimitRecovery = isRecord(value.usageLimitRecovery) ? value.usageLimitRecovery : null;
    const contribution: RuntimeControlContribution = {
        ...(appServer
            ? {
                appServer: {
                    ...(readFunction<NonNullable<RuntimeControlContribution['appServer']>['checkAvailable']>(
                        appServer.checkAvailable,
                    ) ? {
                        checkAvailable: readFunction<NonNullable<RuntimeControlContribution['appServer']>['checkAvailable']>(
                            appServer.checkAvailable,
                        )!,
                    } : {}),
                    ...(readFunction<NonNullable<RuntimeControlContribution['appServer']>['request']>(
                        appServer.request,
                    ) ? {
                        request: readFunction<NonNullable<RuntimeControlContribution['appServer']>['request']>(
                            appServer.request,
                        )!,
                    } : {}),
                },
            }
            : {}),
        ...(connectedServices
            ? {
                connectedServices: {
                    ...(readFunction<NonNullable<NonNullable<RuntimeControlContribution['connectedServices']>['createRuntimeAuthAdapter']>>(
                        connectedServices.createRuntimeAuthAdapter,
                    ) ? {
                        createRuntimeAuthAdapter:
                            readFunction<NonNullable<NonNullable<RuntimeControlContribution['connectedServices']>['createRuntimeAuthAdapter']>>(
                                connectedServices.createRuntimeAuthAdapter,
                            )!,
                    } : {}),
                    ...(readFunction<NonNullable<NonNullable<RuntimeControlContribution['connectedServices']>['materializeRuntimeAuthSelection']>>(
                        connectedServices.materializeRuntimeAuthSelection,
                    ) ? {
                        materializeRuntimeAuthSelection:
                            readFunction<NonNullable<NonNullable<RuntimeControlContribution['connectedServices']>['materializeRuntimeAuthSelection']>>(
                                connectedServices.materializeRuntimeAuthSelection,
                            )!,
                    } : {}),
                    ...(readFunction<NonNullable<NonNullable<RuntimeControlContribution['connectedServices']>['resolveSwitchContinuity']>>(
                        connectedServices.resolveSwitchContinuity,
                    ) ? {
                        resolveSwitchContinuity:
                            readFunction<NonNullable<NonNullable<RuntimeControlContribution['connectedServices']>['resolveSwitchContinuity']>>(
                                connectedServices.resolveSwitchContinuity,
                            )!,
                    } : {}),
                    ...(readFunction<NonNullable<NonNullable<RuntimeControlContribution['connectedServices']>['verifyResumeReachable']>>(
                        connectedServices.verifyResumeReachable,
                    ) ? {
                        verifyResumeReachable:
                            readFunction<NonNullable<NonNullable<RuntimeControlContribution['connectedServices']>['verifyResumeReachable']>>(
                                connectedServices.verifyResumeReachable,
                            )!,
                    } : {}),
                    ...(readFunction<NonNullable<NonNullable<RuntimeControlContribution['connectedServices']>['resolveCandidatePersistedSessionFile']>>(
                        connectedServices.resolveCandidatePersistedSessionFile,
                    ) ? {
                        resolveCandidatePersistedSessionFile:
                            readFunction<NonNullable<NonNullable<RuntimeControlContribution['connectedServices']>['resolveCandidatePersistedSessionFile']>>(
                                connectedServices.resolveCandidatePersistedSessionFile,
                            )!,
                    } : {}),
                },
            }
            : {}),
        ...(goal
            ? {
                goal: {
                    ...(readFunction<NonNullable<NonNullable<RuntimeControlContribution['goal']>['getGoal']>>(
                        goal.getGoal,
                    ) ? {
                        getGoal: readFunction<NonNullable<NonNullable<RuntimeControlContribution['goal']>['getGoal']>>(
                            goal.getGoal,
                        )!,
                    } : {}),
                    ...(readFunction<NonNullable<NonNullable<RuntimeControlContribution['goal']>['setGoal']>>(
                        goal.setGoal,
                    ) ? {
                        setGoal: readFunction<NonNullable<NonNullable<RuntimeControlContribution['goal']>['setGoal']>>(
                            goal.setGoal,
                        )!,
                    } : {}),
                    ...(readFunction<NonNullable<NonNullable<RuntimeControlContribution['goal']>['clearGoal']>>(
                        goal.clearGoal,
                    ) ? {
                        clearGoal: readFunction<NonNullable<NonNullable<RuntimeControlContribution['goal']>['clearGoal']>>(
                            goal.clearGoal,
                        )!,
                    } : {}),
                },
            }
            : {}),
        ...(catalog
            ? {
                catalog: {
                    ...(readFunction<NonNullable<NonNullable<RuntimeControlContribution['catalog']>['listVendorPlugins']>>(
                        catalog.listVendorPlugins,
                    ) ? {
                        listVendorPlugins:
                            readFunction<NonNullable<NonNullable<RuntimeControlContribution['catalog']>['listVendorPlugins']>>(
                                catalog.listVendorPlugins,
                            )!,
                    } : {}),
                    ...(readFunction<NonNullable<NonNullable<RuntimeControlContribution['catalog']>['listSkills']>>(
                        catalog.listSkills,
                    ) ? {
                        listSkills:
                            readFunction<NonNullable<NonNullable<RuntimeControlContribution['catalog']>['listSkills']>>(
                                catalog.listSkills,
                            )!,
                    } : {}),
                },
            }
            : {}),
        ...(usageLimitRecovery
            ? {
                usageLimitRecovery: {
                    ...(readFunction<NonNullable<NonNullable<RuntimeControlContribution['usageLimitRecovery']>['checkNow']>>(
                        usageLimitRecovery.checkNow,
                    ) ? {
                        checkNow:
                            readFunction<NonNullable<NonNullable<RuntimeControlContribution['usageLimitRecovery']>['checkNow']>>(
                                usageLimitRecovery.checkNow,
                            )!,
                    } : {}),
                },
            }
            : {}),
    };
    return Object.keys(contribution).length > 0 ? contribution : null;
}

function createRuntimeControlForAuthSelectionMaterializer(
    agentId: CatalogAgentId,
    runtimeControl: RuntimeControlContribution,
    params: Parameters<ConnectedServiceRuntimeAuthSelectionMaterializer>[0],
    exec: ExecRuntimeServiceV1,
) {
    const cwd = typeof params.input.tracked.spawnOptions?.directory === 'string'
        ? params.input.tracked.spawnOptions.directory.trim()
        : null;
    return createHostRuntimeControlService({
        agentId,
        context: {
            cwd,
            metadata: params.input.tracked.happySessionMetadataFromLocalWebhook ?? null,
            accountSettings: params.accountSettings ?? null,
            processEnv: params.processEnv ?? process.env,
            hostServices: { exec },
        },
        appServer: runtimeControl.appServer ?? null,
        session: createSessionRuntimeControlTransport({
            credentials: params.credentials,
            sessionId: params.input.sessionId,
        }),
        reachability: createSessionRuntimeControlReachability(),
    });
}

function createRuntimeControlForSessionControlParams(
    agentId: CatalogAgentId,
    runtimeControl: RuntimeControlContribution,
    exec: ExecRuntimeServiceV1,
    params: Readonly<{
        token: string;
        sessionId: string;
        cwd: string | null;
        metadata: Record<string, unknown>;
        ctx: Parameters<typeof createResolvedSessionRuntimeControlTransport>[0]['ctx'];
        mode: Parameters<typeof createResolvedSessionRuntimeControlTransport>[0]['mode'];
    }>,
) {
    return createHostRuntimeControlService({
        agentId,
        context: {
            cwd: params.cwd,
            metadata: params.metadata,
            accountSettings: null,
            processEnv: process.env,
            hostServices: { exec },
        },
        appServer: runtimeControl.appServer ?? null,
        session: createResolvedSessionRuntimeControlTransport({
            token: params.token,
            sessionId: params.sessionId,
            ctx: params.ctx,
            mode: params.mode,
        }),
        reachability: createSessionRuntimeControlReachability(),
    });
}

function createRuntimeControlMaterializer(
    agentId: CatalogAgentId,
    runtimeControl: RuntimeControlContribution,
    exec: ExecRuntimeServiceV1,
): ConnectedServiceRuntimeAuthSelectionMaterializer | null {
    const materialize = runtimeControl.connectedServices?.materializeRuntimeAuthSelection;
    if (!materialize) return null;
    return async (params) => await materialize({
        runtimeControl: createRuntimeControlForAuthSelectionMaterializer(agentId, runtimeControl, params, exec),
        params,
    });
}

function createRuntimeControlSwitchContinuityResolver(
    agentId: CatalogAgentId,
    runtimeControl: RuntimeControlContribution,
) {
    const resolveSwitchContinuity = runtimeControl.connectedServices?.resolveSwitchContinuity;
    if (!resolveSwitchContinuity) return null;
    return async (params: ConnectedServiceSwitchContinuityParams) => await resolveSwitchContinuity({
        runtimeControl: createHostRuntimeControlService({
            agentId,
            context: {
                cwd: params.cwd ?? null,
                metadata: null,
                accountSettings: null,
                processEnv: process.env,
            },
            appServer: runtimeControl.appServer ?? null,
            reachability: createSessionRuntimeControlReachability(),
        }),
        params,
    });
}

function createRuntimeControlGoalAdapter(
    agentId: CatalogAgentId,
    runtimeControl: RuntimeControlContribution,
    exec: ExecRuntimeServiceV1,
): SessionGoalControlAdapterResult {
    const goal = runtimeControl.goal;
    if (!goal) return null;
    return {
        ...(goal.getGoal ? {
            getGoal: async (params: RuntimeControlGoalGetParams) => await goal.getGoal!({
                runtimeControl: createRuntimeControlForSessionControlParams(agentId, runtimeControl, exec, params),
                params,
            }),
        } : {}),
        ...(goal.setGoal ? {
            setGoal: async (params: RuntimeControlGoalSetParams) => await goal.setGoal!({
                runtimeControl: createRuntimeControlForSessionControlParams(agentId, runtimeControl, exec, params),
                params,
            }),
        } : {}),
        ...(goal.clearGoal ? {
            clearGoal: async (params: RuntimeControlGoalClearParams) => await goal.clearGoal!({
                runtimeControl: createRuntimeControlForSessionControlParams(agentId, runtimeControl, exec, params),
                params,
            }),
        } : {}),
    };
}

function createRuntimeControlCatalogAdapter(
    agentId: CatalogAgentId,
    runtimeControl: RuntimeControlContribution,
    exec: ExecRuntimeServiceV1,
): SessionCatalogControlAdapterResult {
    const catalog = runtimeControl.catalog;
    if (!catalog) return null;
    return {
        ...(catalog.listVendorPlugins ? {
            listVendorPlugins: async (params: RuntimeControlCatalogVendorPluginsParams) => await catalog.listVendorPlugins!({
                runtimeControl: createRuntimeControlForSessionControlParams(agentId, runtimeControl, exec, params),
                params,
            }),
        } : {}),
        ...(catalog.listSkills ? {
            listSkills: async (params: RuntimeControlCatalogSkillsParams) => await catalog.listSkills!({
                runtimeControl: createRuntimeControlForSessionControlParams(agentId, runtimeControl, exec, params),
                params,
            }),
        } : {}),
    };
}

function createRuntimeControlUsageLimitRecoveryAdapter(
    agentId: CatalogAgentId,
    runtimeControl: RuntimeControlContribution,
    exec: ExecRuntimeServiceV1,
): SessionUsageLimitRecoveryControlAdapterResult {
    const usageLimitRecovery = runtimeControl.usageLimitRecovery;
    if (!usageLimitRecovery) return null;
    return {
        ...(usageLimitRecovery.checkNow ? {
            checkNow: async (params: RuntimeControlUsageLimitRecoveryCheckParams) => await usageLimitRecovery.checkNow!({
                runtimeControl: createRuntimeControlForSessionControlParams(agentId, runtimeControl, exec, params),
                params,
            }),
        } : {}),
    };
}

function hasRuntimeControlAdapterMethods(value: Readonly<Record<string, unknown>> | null): boolean {
    return Boolean(value && Object.values(value).some((entry) => typeof entry === 'function'));
}

function managedServerStateParams(
    managedServer: ManagedServerContribution,
    env: NodeJS.ProcessEnv = process.env,
) {
    return {
        env,
        overrideEnvKey: managedServer.statePathEnvKey,
        namespace: managedServer.namespace,
        fingerprintInput: managedServer.resolveStateFingerprintInput(env),
    } as const;
}

function readBoundedPositiveIntEnv(
    key: string,
    fallback: number,
    bounds: Readonly<{ min: number; max: number }>,
): number {
    if (!key) return fallback;
    const value = readPositiveIntEnv(key, fallback);
    return Math.min(bounds.max, Math.max(bounds.min, value));
}

function resolveManagedServerStatePathForEnv(
    managedServer: ManagedServerContribution,
    env: NodeJS.ProcessEnv = process.env,
): string {
    return resolveManagedServerStatePath(managedServerStateParams(managedServer, env));
}

async function readManagedProviderServerStateBestEffort(
    managedServer: ManagedServerContribution,
): Promise<Awaited<ReturnType<typeof readManagedServerStateBestEffort>>> {
    return await readManagedServerStateBestEffort(managedServerStateParams(managedServer, process.env));
}

async function releaseManagedProviderServerForAuthSwitch(
    managedServer: ManagedServerContribution,
    params: Readonly<{
        previousStatePath?: string | null;
        expectedOwnerToken?: string | null;
        expectedActiveServerDir?: string | null;
        expectedDaemonInstanceId?: string | null;
        drainMs?: number;
        trackedClaimCount: number;
        allowCurrentSessionClaim?: boolean;
        processEnv?: NodeJS.ProcessEnv;
    }>,
) {
    const env = params.processEnv ?? process.env;
    return await releaseManagedServerForSwitch({
        ...managedServerStateParams(managedServer, env),
        isExpectedProcessCommand: managedServer.isExpectedProcessCommand,
        previousStatePath: params.previousStatePath,
        expectedOwnerToken: params.expectedOwnerToken,
        expectedActiveServerDir: params.expectedActiveServerDir,
        expectedDaemonInstanceId: params.expectedDaemonInstanceId,
        drainMs: params.drainMs
            ?? readBoundedPositiveIntEnv(
                managedServer.timeouts.authSwitchDrainMsEnvKey,
                managedServer.timeouts.authSwitchDrainMsDefault,
                { min: 250, max: 30_000 },
            ),
        trackedClaimCount: params.trackedClaimCount,
        allowCurrentSessionClaim: params.allowCurrentSessionClaim,
    });
}

async function stopManagedProviderServerBestEffort(managedServer: ManagedServerContribution): Promise<void> {
    await stopManagedServerBestEffort({
        ...managedServerStateParams(managedServer, process.env),
        buildHealthUrl: managedServer.buildHealthUrl,
        healthTimeoutMs: readBoundedPositiveIntEnv(
            managedServer.timeouts.healthProbeMsEnvKey,
            managedServer.timeouts.healthProbeMsDefault,
            { min: 50, max: 10_000 },
        ),
        graceTimeoutMs: readBoundedPositiveIntEnv(
            managedServer.timeouts.shutdownGraceMsEnvKey,
            managedServer.timeouts.shutdownGraceMsDefault,
            { min: 100, max: 30_000 },
        ),
        forceWaitTimeoutMs: readBoundedPositiveIntEnv(
            managedServer.timeouts.forceKillWaitMsEnvKey,
            managedServer.timeouts.forceKillWaitMsDefault,
            { min: 50, max: 10_000 },
        ),
        pollIntervalMs: readBoundedPositiveIntEnv(
            managedServer.timeouts.pollIntervalMsEnvKey,
            managedServer.timeouts.pollIntervalMsDefault,
            { min: 10, max: 1_000 },
        ),
        logLabel: managedServer.logLabel,
    });
}

function materializedRootDirForStableRoot(
    connectedServices: ConnectedServicesContribution,
    stableRootDir: string,
): string {
    return connectedServices.materializedRootSubdir
        ? join(stableRootDir, connectedServices.materializedRootSubdir)
        : stableRootDir;
}

function normalizeMaterializationDiagnostics(value: readonly unknown[] | undefined): readonly {
    code: string;
    providerId?: string;
    serviceId?: ConnectedServiceId;
    severity?: 'info' | 'warning' | 'blocking';
    requestedStateMode?: string;
    effectiveStateMode?: string;
    reason?: string;
    entryName?: string;
}[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
        const record = isRecord(entry) ? entry : null;
        const code = readString(record?.code);
        if (!record || !code) return [];
        const parsedServiceId = record.serviceId === undefined ? null : ConnectedServiceIdSchema.safeParse(record.serviceId);
        const severity = record.severity === 'info' || record.severity === 'warning' || record.severity === 'blocking'
            ? record.severity
            : undefined;
        return [{
            code,
            ...(readString(record.providerId) ? { providerId: readString(record.providerId)! } : {}),
            ...(parsedServiceId?.success ? { serviceId: parsedServiceId.data } : {}),
            ...(severity ? { severity } : {}),
            ...(readString(record.requestedStateMode) ? { requestedStateMode: readString(record.requestedStateMode)! } : {}),
            ...(readString(record.effectiveStateMode) ? { effectiveStateMode: readString(record.effectiveStateMode)! } : {}),
            ...(readString(record.reason) ? { reason: readString(record.reason)! } : {}),
            ...(readString(record.entryName) ? { entryName: readString(record.entryName)! } : {}),
        }];
    });
}

function normalizeStateSharingDiagnostics(
    diagnostics: Awaited<ReturnType<typeof applyConnectedServiceStateSharingDescriptor>>['diagnostics'],
): readonly ConnectedServicesMaterializationDiagnostic[] {
    return diagnostics.map((diagnostic) => {
        const parsedServiceId = diagnostic.serviceId === undefined
            ? null
            : ConnectedServiceIdSchema.safeParse(diagnostic.serviceId);
        return {
            code: diagnostic.code,
            providerId: diagnostic.providerId,
            ...(parsedServiceId?.success ? { serviceId: parsedServiceId.data } : {}),
            ...(diagnostic.requestedStateMode ? { requestedStateMode: diagnostic.requestedStateMode } : {}),
            ...(diagnostic.effectiveStateMode ? { effectiveStateMode: diagnostic.effectiveStateMode } : {}),
            ...(diagnostic.entryName ? { entryName: diagnostic.entryName } : {}),
            ...(diagnostic.reason ? { reason: diagnostic.reason } : {}),
        };
    });
}

async function removeMaterializedHomeCredentialEntries(
    targetDir: string,
    entries: readonly string[] | undefined,
): Promise<void> {
    for (const entry of entries ?? []) {
        await rm(join(targetDir, entry), { recursive: true, force: true });
    }
}

async function applyConnectedServiceStateSharingForContribution(params: Readonly<{
    agentId: CatalogAgentId;
    connectedServices: ConnectedServicesContribution;
    serviceId: ConnectedServiceId;
    materializedRootDir: string;
    env: NodeJS.ProcessEnv;
    stateSourceRoot?: string | null;
    accountSettings?: Readonly<Record<string, unknown>> | null;
    sessionDirectory?: string | null;
}>): Promise<readonly ConnectedServicesMaterializationDiagnostic[]> {
    const resolveStateSharingSourceRoot = params.connectedServices.resolveStateSharingSourceRoot;
    if (!resolveStateSharingSourceRoot) return [];
    if (
        params.connectedServices.stateSharingServiceIds
        && !params.connectedServices.stateSharingServiceIds.includes(params.serviceId)
    ) {
        return [];
    }
    return await withConnectedServiceStateSharingDestinationLock(params.materializedRootDir, async () => {
        const settings = resolveConnectedServicesProviderStateSharingPolicyV1(
            params.accountSettings?.connectedServicesProviderStateSharingSettingsV1,
            params.agentId,
        );
        const sourceRoot = resolveStateSharingSourceRoot({ env: params.env });
        const stateSourceRoot = readString(params.stateSourceRoot) ?? sourceRoot;
        const stateEntryNames = await params.connectedServices.resolveStateSharingStateEntryNames?.({
            sourceRoot: stateSourceRoot,
            materializedRootDir: params.materializedRootDir,
            env: params.env,
            requestedStateMode: settings.stateMode,
            effectiveStateMode: settings.stateMode,
        });
        const sessionImportRoots = settings.stateMode === 'shared'
            ? params.connectedServices.createStateSharingSessionImportRoots?.({
                sourceRoot: stateSourceRoot,
                materializedRootDir: params.materializedRootDir,
            }) ?? [{
                sourceRoot: join(params.materializedRootDir, 'projects'),
                destinationRoot: join(stateSourceRoot, 'projects'),
                includeFile: (relativePath: string) => relativePath.toLowerCase().endsWith('.jsonl'),
            }]
            : [];
        await removeMaterializedHomeCredentialEntries(
            params.materializedRootDir,
            params.connectedServices.materializedHomeCredentialEntries,
        );
        const existingManifest = await readConnectedServiceStateSharingManifest(params.materializedRootDir);
        const applyResult = await applyConnectedServiceStateSharingDescriptor({
            descriptor: params.connectedServices.stateSharingDescriptor,
            nativeSourceContext: {
                sourceRoot,
                sourceEnv: params.env as Record<string, string>,
            },
            target: {
                targetMaterializedRoot: params.materializedRootDir,
                targetMaterializedEnv: {},
            },
            configMode: settings.configMode,
            requestedStateMode: settings.stateMode,
            effectiveStateMode: settings.stateMode,
            cwd: params.sessionDirectory ?? process.cwd(),
            existingManifest,
            ...(stateEntryNames ? { stateEntryNames } : {}),
            resolveStateSourceRoot: (entryName) =>
                params.connectedServices.resolveStateSharingStateSourceRoot?.({
                    entryName,
                    sourceRoot: stateSourceRoot,
                    materializedRootDir: params.materializedRootDir,
                    env: params.env,
                }) ?? stateSourceRoot,
            sessionImportRoots,
            ...(params.connectedServices.resolveVendorResumeIdFromImportedFile
                ? { resolveVendorResumeIdFromImportedFile: params.connectedServices.resolveVendorResumeIdFromImportedFile }
                : {}),
            providerLabel: String(params.agentId),
        });
        await removeMaterializedHomeCredentialEntries(
            params.materializedRootDir,
            params.connectedServices.materializedHomeCredentialEntries,
        );
        await writeConnectedServiceStateSharingManifest(params.materializedRootDir, applyResult.manifest);
        return normalizeStateSharingDiagnostics(applyResult.diagnostics);
    }, { providerId: params.agentId });
}

function createConnectedServicesMaterializer(
    agentId: CatalogAgentId,
    connectedServices: ConnectedServicesContribution,
    managedServer: ManagedServerContribution | null,
    exec: ExecRuntimeServiceV1,
): ConnectedServicesMaterializer {
    return async ({
        activeServerDir,
        recordsByServiceId,
        selectionsByServiceId,
        accountSettings,
        processEnv,
        sessionDirectory,
    }) => {
        const materializationInput: Record<string, unknown> = {};
        let primaryRecord: CredentialRecord | null = null;
        let primaryServiceId: ConnectedServiceId | null = null;

        for (const serviceId of connectedServices.serviceIds) {
            const record = selectionsByServiceId?.get(serviceId)?.record ?? recordsByServiceId.get(serviceId) ?? null;
            if (!record) continue;
            Object.assign(materializationInput, connectedServices.createAuthMaterializationInput(serviceId, record));
            primaryRecord ??= record;
            primaryServiceId ??= serviceId;
        }

        if (!primaryRecord || !primaryServiceId) return null;
        const primarySelection = selectionsByServiceId?.get(primaryServiceId);
        const stableRootDir = primarySelection?.kind === 'group'
            ? resolveConnectedServiceGroupHomeDir({
                activeServerDir,
                serviceId: primarySelection.serviceId,
                groupId: primarySelection.groupId,
                agentId,
            })
            : resolveConnectedServiceHomeDir({
                activeServerDir,
                serviceId: primaryServiceId,
                profileId: primarySelection?.kind === 'profile' ? primarySelection.profileId : primaryRecord.profileId,
                agentId,
            });
        const materializedRootDir = materializedRootDirForStableRoot(connectedServices, stableRootDir);

        const env = processEnv ?? process.env;
        const materializationContext = {
            ...materializationInput,
            rootDir: materializedRootDir,
            processEnv: env,
            accountSettings: accountSettings ?? null,
            sessionDirectory: sessionDirectory ?? null,
            exec,
        };
        const managedServerStatePath = managedServer
            ? resolveManagedServerStatePathForEnv(managedServer, {
                ...env,
                ...((await connectedServices.materializeAuthEnvironment(materializationContext)).env),
            })
            : null;
        const stateSharingDiagnostics = await applyConnectedServiceStateSharingForContribution({
            agentId,
            connectedServices,
            serviceId: primaryServiceId,
            materializedRootDir,
            env,
            accountSettings: accountSettings ?? null,
            sessionDirectory: sessionDirectory ?? null,
        });
        const materialized = await connectedServices.materializeAuthEnvironment({
            ...materializationContext,
            ...(managedServerStatePath ? { managedServerStatePath } : {}),
        });

        return {
            ...createRetainedConnectedServicesMaterialization({
                rootDir: materializedRootDir,
                env: materialized.env,
            }),
            diagnostics: [
                ...stateSharingDiagnostics,
                ...normalizeMaterializationDiagnostics(materialized.diagnostics),
            ],
        };
    };
}

function createRuntimeAuthAdapter(
    agentId: CatalogAgentId,
    connectedServices: ConnectedServicesContribution,
): ConnectedServiceProviderRuntimeAuthAdapter | null {
    if (connectedServices.runtimeAuthAdapter === false) return null;
    if (connectedServices.runtimeAuthAdapter) return connectedServices.runtimeAuthAdapter;
    if (!connectedServices.classifyUsageLimitError) return null;
    const restartResume = createRestartResumeConnectedServiceRuntimeAuthAdapter(agentId);
    return {
        ...restartResume,
        classifyRuntimeAuthFailure(input) {
            const selection = isRecord(input.selection) ? input.selection : null;
            const error = isRecord(input.error) ? input.error : null;
            const classified = connectedServices.classifyUsageLimitError?.({
                providerErrorPath: true,
                error: input.error,
                parseResetAt: parseProviderResetAt,
            });
            if (!isRecord(classified)) return restartResume.classifyRuntimeAuthFailure(input);
            const serviceId = readString(selection?.serviceId) ?? readString(error?.serviceId);
            if (!serviceId) return null;
            const classification: ConnectedServiceRuntimeFailureClassification = {
                kind: readString(classified.kind) === 'rate_limit' ? 'rate_limit' : 'usage_limit',
                serviceId,
                profileId: readString(selection?.activeProfileId ?? selection?.profileId),
                groupId: readString(selection?.groupId),
                resetsAtMs: typeof classified.resetAtMs === 'number' ? classified.resetAtMs : null,
                retryAfterMs: typeof classified.retryAfterMs === 'number' ? classified.retryAfterMs : null,
                planType: null,
                rateLimits: classified,
                source: 'structured_provider_error',
            };
            return {
                ...classification,
                limitCategory: readConnectedServiceLimitCategoryV1(classified.limitCategory) ?? 'usage_limit',
                providerLimitId: readString(classified.providerLimitId),
                quotaScope: readString(classified.quotaScope) ?? 'unknown',
                action: isRecord(classified.action) ? classified.action : null,
            } as ConnectedServiceRuntimeFailureClassification;
        },
    };
}

function readBaseSelectionCredentialRecord(value: unknown): CredentialRecord | null {
    return isRecord(value) ? value as CredentialRecord : null;
}

function readTrackedMaterializedStateSourceEnv(value: unknown): NodeJS.ProcessEnv | null {
    if (!isRecord(value)) return null;
    const env: Record<string, string> = {};
    for (const [key, raw] of Object.entries(value)) {
        if (typeof raw === 'string' && raw.trim().length > 0) {
            env[key] = raw;
        }
    }
    const materializedKeys = readConnectedServiceMaterializedEnvKeysFromEnv(env);
    if (materializedKeys.length === 0) return null;
    return materializedKeys.some((key) => readString(env[key]))
        ? env as NodeJS.ProcessEnv
        : null;
}

function resolvePreviousRuntimeAuthStateSourceRoot(params: Readonly<{
    connectedServices: ConnectedServicesContribution;
    input: SessionConnectedServiceRuntimeAuthSelectionMaterializerInput;
}>): string | null {
    const sourceEnv = readTrackedMaterializedStateSourceEnv(params.input.tracked.spawnOptions?.environmentVariables);
    if (!sourceEnv) return null;
    return readString(params.connectedServices.resolveStateSharingSourceRoot?.({ env: sourceEnv }));
}

function createRuntimeAuthSelectionMaterializationRoot(params: Readonly<{
    agentId: CatalogAgentId;
    serviceId: ConnectedServiceId;
    activeServerDir: string;
    baseSelection: Readonly<{
        profileId: string;
        groupId?: string;
        activeProfileId?: string;
        fallbackProfileId?: string;
    }>;
    connectedServices: ConnectedServicesContribution;
}>): string {
    const groupId = readString(params.baseSelection.groupId);
    const activeProfileId = readString(params.baseSelection.activeProfileId);
    const fallbackProfileId = readString(params.baseSelection.fallbackProfileId);
    const stableRootDir = groupId && activeProfileId && fallbackProfileId
        ? resolveConnectedServiceGroupHomeDir({
            activeServerDir: params.activeServerDir,
            serviceId: params.serviceId,
            groupId,
            agentId: params.agentId,
        })
        : resolveConnectedServiceHomeDir({
            activeServerDir: params.activeServerDir,
            serviceId: params.serviceId,
            profileId: params.baseSelection.profileId,
            agentId: params.agentId,
        });
    return materializedRootDirForStableRoot(params.connectedServices, stableRootDir);
}

function createRetainedRuntimeAuthSelectionMaterializer(
    agentId: CatalogAgentId,
    connectedServices: ConnectedServicesContribution,
    exec: ExecRuntimeServiceV1,
): ConnectedServiceRuntimeAuthSelectionMaterializer {
    return async (params) => {
        const serviceId = connectedServices.readConnectedServiceId(params.input.serviceId);
        if (!serviceId) return params.baseSelection;
        const activeServerDir = readString(params.activeServerDir);
        if (!activeServerDir) return params.baseSelection;
        const record = readBaseSelectionCredentialRecord(params.baseSelection.record);
        if (!record) return params.baseSelection;
        const materializedRootDir = createRuntimeAuthSelectionMaterializationRoot({
            agentId,
            serviceId,
            activeServerDir,
            baseSelection: params.baseSelection,
            connectedServices,
        });
        const env = params.processEnv ?? process.env;
        const stateSharingDiagnostics = await applyConnectedServiceStateSharingForContribution({
            agentId,
            connectedServices,
            serviceId,
            materializedRootDir,
            env,
            stateSourceRoot: resolvePreviousRuntimeAuthStateSourceRoot({
                connectedServices,
                input: params.input,
            }),
            accountSettings: params.accountSettings ?? null,
            sessionDirectory: params.input.tracked.spawnOptions?.directory ?? null,
        });
        const materialized = await connectedServices.materializeAuthEnvironment({
            ...connectedServices.createAuthMaterializationInput(serviceId, record),
            rootDir: materializedRootDir,
            processEnv: env,
            accountSettings: params.accountSettings ?? null,
            sessionDirectory: params.input.tracked.spawnOptions?.directory ?? null,
            exec,
        });
        return {
            ...params.baseSelection,
            targetMaterializedEnv: materialized.env,
            targetMaterializedRoot: materializedRootDir,
            materializationDiagnostics: [
                ...stateSharingDiagnostics,
                ...normalizeMaterializationDiagnostics(materialized.diagnostics),
            ],
        };
    };
}

function createManagedServerRuntimeAuthSelectionMaterializer(
    agentId: CatalogAgentId,
    connectedServices: ConnectedServicesContribution,
    managedServer: ManagedServerContribution,
    exec: ExecRuntimeServiceV1,
): ConnectedServiceRuntimeAuthSelectionMaterializer {
    const materializeRetainedSelection = createRetainedRuntimeAuthSelectionMaterializer(agentId, connectedServices, exec);
    return async (params) => {
        const retainedSelection = await materializeRetainedSelection(params);
        const serviceId = connectedServices.readConnectedServiceId(params.input.serviceId);
        if (!serviceId || !isRecord(retainedSelection)) return retainedSelection;
        const previousBinding = params.input.previous;
        const previousProfileId = previousBinding?.source === 'connected' ? previousBinding.profileId : null;
        const previousContext = await (async () => {
            const normalizedPreviousProfileId = readString(previousProfileId);
            if (!normalizedPreviousProfileId) return null;
            const records = await resolveConnectedServiceCredentials({
                credentials: params.credentials,
                api: params.api,
                bindings: [{ serviceId, profileId: normalizedPreviousProfileId }],
            });
            const previousRecord = records.get(serviceId);
            if (!previousRecord) return null;
            const materializedPrevious = await connectedServices.materializeAuthEnvironment({
                ...connectedServices.createAuthMaterializationInput(serviceId, previousRecord),
                rootDir: '',
                exec,
            });
            const previousStatePath = resolveManagedServerStatePathForEnv(managedServer, {
                ...(params.processEnv ?? process.env),
                ...materializedPrevious.env,
            });
            const previousState = await readManagedServerStateAtPathBestEffort(previousStatePath);
            const previousOwnerToken = readString(previousState?.ownerToken);
            return { previousStatePath, previousOwnerToken };
        })().catch(() => null);

        const postSwitchRecover = previousContext
            ? async (input: Readonly<{
                countTrackedClaimsForStatePath?: (statePath: string) => number;
                hasUnknownTrackedClaims?: boolean;
            }>) => {
                const trackedClaimCount = typeof input.countTrackedClaimsForStatePath === 'function'
                    ? input.countTrackedClaimsForStatePath(previousContext.previousStatePath)
                    : 0;
                if (input.hasUnknownTrackedClaims === true) return;
                await releaseManagedProviderServerForAuthSwitch(managedServer, {
                    previousStatePath: previousContext.previousStatePath,
                    expectedOwnerToken: previousContext.previousOwnerToken,
                    trackedClaimCount,
                    allowCurrentSessionClaim: true,
                });
            }
            : undefined;

        return {
            ...retainedSelection,
            ...(previousContext?.previousStatePath ? { previousStatePath: previousContext.previousStatePath } : {}),
            ...(previousContext?.previousOwnerToken ? { previousOwnerToken: previousContext.previousOwnerToken } : {}),
            ...(postSwitchRecover ? { postSwitchRecover } : {}),
        };
    };
}

function createRuntimeAuthSelectionMaterializer(
    agentId: CatalogAgentId,
    connectedServices: ConnectedServicesContribution,
    managedServer: ManagedServerContribution | null,
    exec: ExecRuntimeServiceV1,
): ConnectedServiceRuntimeAuthSelectionMaterializer | null {
    return managedServer
        ? createManagedServerRuntimeAuthSelectionMaterializer(agentId, connectedServices, managedServer, exec)
        : createRetainedRuntimeAuthSelectionMaterializer(agentId, connectedServices, exec);
}

function createSwitchContinuityResolver(
    agentId: CatalogAgentId,
    connectedServices: ConnectedServicesContribution,
) {
    return async (params: ConnectedServiceSwitchContinuityParams): Promise<ConnectedServiceSwitchContinuityResult> => {
        if (!connectedServices.shouldRestartForServiceSwitch?.(params.serviceId)) {
            return { mode: 'unsupported', reason: 'unsupported_service' };
        }
        if (isConnectedToConnectedServiceSwitch(params)) {
            const restartContinuityCanBeProven = isExactSameConnectedServiceSelection(params)
                || (
                    connectedServices.sameAuthGroupRequiresResumeReachability === true
                    && isSameConnectedServiceAuthGroup(params)
                );
            if (!restartContinuityCanBeProven) {
                if (connectedServices.connectedSwitchSharedStateRequiredReason) {
                    return {
                        mode: 'restart_shared_state_required',
                        reason: connectedServices.connectedSwitchSharedStateRequiredReason,
                    };
                }
                return {
                    mode: 'restart_same_home',
                    reason: connectedServices.restartRematerializeRequiredReason ?? 'provider_rematerialization_required',
                };
            }
            if (!hasExactConnectedServiceRestartContinuityContext(params)) {
                return providerSessionStateUnavailableForResume();
            }

            const targetMaterializedRoot = readString(params.targetMaterializedRoot);
            const providerSessionId = readString(params.vendorResumeId);
            const cwd = readString(params.cwd);
            const materializationIdentity = params.connectedServiceMaterializationIdentityV1 ?? null;
            const targetMaterializedEnv = params.targetMaterializedEnv ?? null;
            if (!targetMaterializedRoot || !providerSessionId || !cwd || !materializationIdentity || !targetMaterializedEnv) {
                return providerSessionStateUnavailableForResume();
            }

            const reachability = await canResumeFromMaterializedState({
                agentId,
                serviceId: params.serviceId,
                targetMaterializedRoot,
                targetMaterializedEnv,
                requestedStateMode: 'isolated',
                effectiveStateMode: 'isolated',
                materializationIdentity,
                vendorResumeId: providerSessionId,
                cwd,
                candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
            });
            return reachability.ok
                ? { mode: 'restart_same_home' }
                : providerSessionStateUnavailableForResume({
                    diagnostics: reachability.continuityDiagnostics,
                });
        }
        return connectedServices.nativeSwitchSharedStateRequiredReason
            ? {
                mode: 'restart_shared_state_required',
                reason: connectedServices.nativeSwitchSharedStateRequiredReason,
            }
            : {
            mode: 'restart_same_home',
            reason: connectedServices.restartRematerializeRequiredReason ?? 'provider_rematerialization_required',
        };
    };
}

function generateOauthState(): string {
    return randomBytes(32).toString('hex');
}

function buildAuthorizationCodeUrl(config: CloudConnectOauthAuthorizationCode, state: string, challenge: string): string {
    const query = new URLSearchParams({
        code: 'true',
        client_id: config.clientId,
        response_type: 'code',
        redirect_uri: config.redirectUri,
        scope: config.scope,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
    });
    return `${config.authorizeUrl}?${query.toString()}`;
}

async function exchangeAuthorizationCodeForTokens(params: Readonly<{
    config: CloudConnectOauthAuthorizationCode;
    code: string;
    verifier: string;
    state: string;
}>): Promise<unknown> {
    const response = await fetch(params.config.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'authorization_code',
            code: params.code,
            redirect_uri: params.config.redirectUri,
            client_id: params.config.clientId,
            code_verifier: params.verifier,
            state: params.state,
        }),
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(buildSafeOauthProviderFailureMessage({
            operation: 'Token exchange',
            status: response.status,
            statusText: response.statusText,
            body,
        }));
    }

    return await response.json();
}

async function authenticateAuthorizationCodeConnectTarget(
    config: CloudConnectOauthAuthorizationCode,
    opts?: CloudConnectAuthenticateOptions,
): Promise<unknown> {
    const timeoutMs =
        typeof opts?.timeoutSeconds === 'number' && Number.isFinite(opts.timeoutSeconds)
            ? Math.max(1, Math.trunc(opts.timeoutSeconds)) * 1000
            : undefined;
    const pkce = generatePkceCodes();
    const state = generateOauthState();
    const authorizationUrl = buildAuthorizationCodeUrl(config, state, pkce.challenge);

    process.stdout.write('\nOpen this URL in a browser to authenticate:\n\n');
    process.stdout.write(`${authorizationUrl}\n\n`);
    process.stdout.write('After login, paste the final redirected URL (or the "code#state" string) here.\n\n');

    if (!opts?.noOpen) {
        await openBrowser(authorizationUrl).catch(() => {
            // Non-fatal: users can still copy/paste the URL and complete auth manually.
        });
    }

    const pastedPromise = promptInput('Paste redirect URL: ');
    const pasted = timeoutMs
        ? await Promise.race([
            pastedPromise,
            delay(timeoutMs).then(() => {
                throw new Error('Authentication timed out');
            }),
        ])
        : await pastedPromise;

    const parsed = parseOauthRedirectPaste({ pasted });
    if (!parsed.ok) {
        throw new Error(`Invalid OAuth redirect paste (${parsed.error})`);
    }
    if (parsed.state !== state) {
        throw new Error('OAuth state mismatch');
    }

    return await exchangeAuthorizationCodeForTokens({
        config,
        code: parsed.code,
        verifier: pkce.verifier,
        state,
    });
}

function sanitizeCloudAuthDiagnostic(value: unknown): CloudAuthDiagnosticV1 | null {
    if (!isRecord(value)) return null;
    const code = readString(value.code);
    if (!code) return null;
    const message = typeof value.message === 'string'
        ? sanitizeConnectedServiceDiagnosticString(value.message)
        : undefined;
    return {
        code: sanitizeConnectedServiceDiagnosticString(code, { maxLength: 120 }),
        ...(message ? { message } : {}),
    };
}

function sanitizeCloudAuthDiagnostics(values: unknown): readonly CloudAuthDiagnosticV1[] {
    if (!Array.isArray(values)) return [];
    return values.flatMap((value) => {
        const diagnostic = sanitizeCloudAuthDiagnostic(value);
        return diagnostic ? [diagnostic] : [];
    });
}

function readCloudAuthFailureCode(value: unknown): CloudAuthFailureCodeV1 {
    return value === 'unsupported'
        || value === 'cancelled'
        || value === 'failed'
        || value === 'invalid_result'
        || value === 'timeout'
        || value === 'provider_error'
        ? value
        : 'failed';
}

function mergeCloudAuthDiagnostics(
    first: readonly CloudAuthDiagnosticV1[],
    second: readonly CloudAuthDiagnosticV1[],
): readonly CloudAuthDiagnosticV1[] | undefined {
    const merged = [...first, ...second];
    return merged.length > 0 ? merged : undefined;
}

function sanitizeCloudConnectAuthenticateResult(
    value: unknown,
    contextDiagnostics: readonly CloudAuthDiagnosticV1[],
): CloudConnectAuthenticateResultV1 {
    if (!isCloudConnectAuthenticateResultV1(value)) {
        return {
            ok: false,
            code: 'invalid_result',
            diagnostics: mergeCloudAuthDiagnostics(contextDiagnostics, [
                {
                    code: 'invalid_custom_auth_result',
                    message: 'Custom authenticator returned an unsupported result shape.',
                },
            ]),
        };
    }

    const record = value as Readonly<Record<string, unknown>>;
    const diagnostics = mergeCloudAuthDiagnostics(
        contextDiagnostics,
        sanitizeCloudAuthDiagnostics(record.diagnostics),
    );
    if (value.ok) {
        const accountRef = readString(record.accountRef);
        const credentialRef = readString(record.credentialRef);
        return {
            ok: true,
            ...(accountRef ? { accountRef } : {}),
            ...(credentialRef ? { credentialRef } : {}),
            ...(diagnostics ? { diagnostics } : {}),
        };
    }

    const retryAfterMs = typeof record.retryAfterMs === 'number' && Number.isFinite(record.retryAfterMs)
        ? Math.max(0, Math.trunc(record.retryAfterMs))
        : undefined;
    return {
        ok: false,
        code: readCloudAuthFailureCode(record.code),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        ...(diagnostics ? { diagnostics } : {}),
    };
}

function createUnsupportedCredentialWriteResult(): CloudAuthCredentialWriteResultV1 {
    return {
        ok: false,
        code: 'unsupported',
        diagnostics: [
            {
                code: 'credential_writer_unavailable',
                message: 'Credential writes are unavailable for this authentication context.',
            },
        ],
    };
}

function createCancelledPromptResult(): CloudAuthPromptTextResultV1 {
    return {
        ok: false,
        code: 'cancelled',
        diagnostics: [{ code: 'authentication_cancelled' }],
    };
}

function createCloudCustomAuthenticatorContext(
    opts: CloudConnectAuthenticateOptions,
): Readonly<{
    context: CloudCustomAuthenticatorContextV1;
    diagnostics: readonly CloudAuthDiagnosticV1[];
}> {
    const diagnostics: CloudAuthDiagnosticV1[] = [];
    const signal = opts.signal ?? new AbortController().signal;
    const fetchRuntime = createGlobalConnectedServiceFetchRuntime();
    const credentialWriter = opts.hostServices?.credentials?.write;
    const pushDiagnostic = (input: CloudAuthDiagnosticV1) => {
        const sanitized = sanitizeCloudAuthDiagnostic(input);
        if (sanitized) diagnostics.push(sanitized);
    };
    const cancelled = () => signal.aborted;
    const requestPromptText = async (input: CloudAuthPromptTextInputV1): Promise<CloudAuthPromptTextResultV1> => {
        if (cancelled()) return createCancelledPromptResult();
        const label = input.label.trim();
        if (!label) {
            return {
                ok: false,
                code: 'unsupported',
                diagnostics: [{ code: 'missing_prompt_label' }],
            };
        }
        const value = await (input.secret ? promptSecretInput(label) : promptInput(label));
        if (cancelled()) return createCancelledPromptResult();
        return { ok: true, value };
    };
    const callbackService = createCloudAuthCallbackService({
        signal,
        promptText: async (label) => {
            const result = await requestPromptText({ label });
            if (result.ok) return result.value;
            const diagnostic = result.diagnostics?.[0]?.code ?? result.code;
            throw new Error(diagnostic);
        },
    });

    const context: CloudCustomAuthenticatorContextV1 = Object.freeze({
        signal,
        now: () => Date.now(),
        fetch: async (request: FetchRuntimeRequestV1) => await fetchRuntime({
            ...request,
            signal: request.signal ?? signal,
        }),
        browser: Object.freeze({
            open: async (url: string): Promise<CloudAuthOpenBrowserResultV1> => {
                if (cancelled()) return { ok: false, code: 'cancelled' };
                try {
                    const opened = await openBrowser(url);
                    if (!opened) {
                        return {
                            ok: false,
                            code: 'unsupported',
                            diagnostics: [
                                {
                                    code: 'browser_open_unavailable',
                                    message: 'Browser opening is unavailable in this environment.',
                                },
                            ],
                        };
                    }
                    return { ok: true };
                } catch (error) {
                    return {
                        ok: false,
                        code: 'failed',
                        diagnostics: [
                            {
                                code: 'browser_open_failed',
                                message: sanitizeConnectedServiceDiagnosticString(
                                    error instanceof Error ? error.message : String(error),
                                ),
                            },
                        ],
                    };
                }
            },
        }),
        prompt: Object.freeze({
            requestText: requestPromptText,
        }),
        oauth: Object.freeze({
            createPkceChallenge: async () => generatePkceCodes(),
            callback: callbackService,
            listenForCallback: async (input: CloudAuthLoopbackInputV1): Promise<CloudAuthLoopbackResultV1> => {
                const created = await callbackService.create({
                    mode: 'loopback',
                    ...(input.defaultPort ? { preferredPort: input.defaultPort } : {}),
                    ...(input.callbackPath?.startsWith('/') ? { callbackPath: input.callbackPath as `/${string}` } : {}),
                });
                if (!created.ok) return created;
                try {
                    return await created.session.wait();
                } finally {
                    await created.session.close();
                }
            },
        }),
        credentials: Object.freeze({
            write: async (input: CloudAuthCredentialWriteInputV1): Promise<CloudAuthCredentialWriteResultV1> => {
                if (cancelled()) return { ok: false, code: 'cancelled' };
                return credentialWriter ? await credentialWriter(input) : createUnsupportedCredentialWriteResult();
            },
        }),
        diagnostics: Object.freeze({
            info: pushDiagnostic,
            warn: pushDiagnostic,
        }),
    });
    return { context, diagnostics };
}

function stripHostOnlyCloudConnectOptions(
    opts?: CloudConnectAuthenticateOptions,
): CloudConnectAuthenticateOptions {
    if (!opts) return {};
    const {
        hostServices: _hostServices,
        ...publicOptions
    } = opts;
    return publicOptions;
}

function createCloudConnectTarget(
    agentId: CatalogAgentId,
    cloudConnect: CloudConnectContribution,
): CloudConnectTarget {
    const authenticate = cloudConnect.authenticate
        ? async (opts?: CloudConnectAuthenticateOptions) => {
            const publicOptions = stripHostOnlyCloudConnectOptions(opts);
            const { context, diagnostics } = createCloudCustomAuthenticatorContext(opts ?? {});
            const result = await cloudConnect.authenticate?.(publicOptions, context);
            return sanitizeCloudConnectAuthenticateResult(result, diagnostics);
        }
        : (opts?: CloudConnectAuthenticateOptions) => authenticateAuthorizationCodeConnectTarget(
            cloudConnect.oauthAuthorizationCode!,
            opts,
        );
    return {
        id: agentId,
        displayName: cloudConnect.displayName,
        vendorDisplayName: cloudConnect.vendorDisplayName,
        vendorKey: cloudConnect.vendorKey,
        status: cloudConnect.status,
        authenticate,
    };
}

function createPreflightContributionProbeParams(
    params: PreflightSessionControlsProbeParams,
    probeKind: PreflightSessionControlsProbeKind,
    exec: ExecRuntimeServiceV1,
): Parameters<NonNullable<PreflightSessionControlsContribution['probeModelsRaw']>>[0] {
    return {
        ...params,
        probeKind,
        exec,
        env: process.env,
    };
}

function createProviderScopedExecService(
    systemTools?: readonly PluginSystemToolContributionV1[],
): ExecRuntimeServiceV1 {
    return createPluginExecService({
        rpcLogAllowedDirectories: [configuration.logsDir],
        systemTools,
    });
}

async function runProviderCliCommandForOutput(params: Readonly<{
    agentId: CatalogAgentId;
    args: readonly string[];
    cwd: string;
    timeoutMs: number;
}>): Promise<string | null> {
    const timeoutMs = Math.max(250, params.timeoutMs);
    let launch: ReturnType<typeof requireProviderCliLaunchSpec>;
    try {
        launch = requireProviderCliLaunchSpec(params.agentId);
    } catch {
        return null;
    }
    const invocation = resolveWindowsCommandInvocation({
        command: launch.command,
        args: [...launch.args, ...params.args],
        env: process.env,
    });

    return await new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (result: string | null) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };

        const child = spawn(invocation.command, invocation.args, {
            cwd: params.cwd,
            env: { ...process.env, CI: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        });

        const timer = setTimeout(() => {
            try {
                child.kill('SIGKILL');
            } catch {
                // Ignore best-effort timeout cleanup failures.
            }
            finish(null);
        }, timeoutMs);

        child.on('error', () => {
            clearTimeout(timer);
            finish(null);
        });

        child.stdout?.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8');
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
        });

        child.on('close', (code) => {
            clearTimeout(timer);
            if (typeof code !== 'number' || code !== 0) return finish(null);
            const output = stdout.trim() ? stdout : stderr;
            finish(output.trim() ? output.trim() : null);
        });
    });
}

export function createProviderRuntimeCatalogEntryHooks(params: Readonly<{
    agentId: CatalogAgentId;
    packageName: string;
    contribution: ProviderRuntimeContribution;
    systemTools?: readonly PluginSystemToolContributionV1[];
}>): ProviderCatalogHookFactory {
    const connectedServices = readConnectedServicesContribution(params.contribution.connectedServices);
    const runtimeControl = readRuntimeControlContribution(params.contribution.runtimeControl);
    const managedServer = readManagedServerContribution(params.contribution.managedServer);
    const attach = readProviderAttachContribution(params.contribution.attach);
    const sessionRuntimePreferences = readSessionRuntimePreferencesContribution(
        params.contribution.sessionRuntimePreferences,
    );
    const externalSessions = readExternalSessionsContribution(params.contribution.externalSessions);
    const sessionHandoff = readSessionHandoffContribution(params.contribution.sessionHandoff);
    const cliAuth = readCliAuthContribution(params.contribution.cliAuth);
    const preflightSessionControls = readPreflightSessionControlsContribution(
        params.contribution.preflightSessionControls,
    );
    const cloudConnect = readCloudConnectContribution(params.contribution.cloudConnect);
    const sessionControls = readSessionControlsContribution(params.contribution.sessionControls);
    const terminal = readTerminalContribution(params.contribution.terminal);
    const cliSessionCommand = readCliSessionCommandContribution(params.contribution.cliSessionCommand, params.agentId);
    const vendorResumeSupport = readFunction<CatalogVendorResumeSupport>(
        params.contribution.vendorResumeSupport?.resolve,
    );
    const checklists = isRecord(params.contribution.checklists)
        ? params.contribution.checklists as CatalogChecklistContributions
        : null;
    const catalogControlAdapter = readSessionCatalogControlAdapter(params.contribution.catalogControlAdapter);
    const acpBackendContribution = isRecord(params.contribution.acpBackend)
        ? params.contribution.acpBackend
        : null;
    const runtimeAuthAdapter = runtimeControl?.connectedServices?.createRuntimeAuthAdapter
        ? runtimeControl.connectedServices.createRuntimeAuthAdapter()
        : connectedServices
            ? createRuntimeAuthAdapter(params.agentId, connectedServices)
            : null;
    const switchContinuityResolver = runtimeControl
        ? createRuntimeControlSwitchContinuityResolver(params.agentId, runtimeControl)
        : connectedServices?.shouldRestartForServiceSwitch
            ? createSwitchContinuityResolver(params.agentId, connectedServices)
            : null;

    return () => {
        const exec = createProviderScopedExecService(params.systemTools);
        const runtimeControlMaterializer = runtimeControl
            ? createRuntimeControlMaterializer(params.agentId, runtimeControl, exec)
            : null;
        const runtimeControlGoalAdapter = runtimeControl
            ? createRuntimeControlGoalAdapter(params.agentId, runtimeControl, exec)
            : null;
        const runtimeControlCatalogAdapter = runtimeControl
            ? createRuntimeControlCatalogAdapter(params.agentId, runtimeControl, exec)
            : null;
        const runtimeControlUsageLimitRecoveryAdapter = runtimeControl
            ? createRuntimeControlUsageLimitRecoveryAdapter(params.agentId, runtimeControl, exec)
            : null;
        const acpRuntimeDefinitionBridge = acpBackendContribution
            ? createAcpRuntimeDefinitionBridge({ contribution: acpBackendContribution, exec })
            : null;
        return ({
        ...(acpRuntimeDefinitionBridge
            ? {
                getAcpRuntimeDefinitionBridge: async () => acpRuntimeDefinitionBridge,
            }
            : {}),
        ...(params.contribution.builtInAcpCatalog === true
            ? {
                getCliDetect: async () => createBuiltInCliDetect(params.agentId),
                getCliAuthSpec: async () => cliAuth
                    ? createCatalogCliAuthSpec(params.agentId, {
                        detectAuthStatus: async ({ resolvedPath }) => cliAuth.detectAuthStatus({
                            resolvedPath,
                            env: process.env,
                            runCommand: async (args, options) => runCliCommandBestEffort({
                                resolvedPath,
                                args: [...args],
                                timeoutMs: options?.timeoutMs,
                                env: options?.env,
                            }),
                        }),
                    })
                    : createBuiltInCliAuthSpec(params.agentId),
            }
            : {}),
        ...(connectedServices
            ? {
                getConnectedServicesMaterializer: async () =>
                    createConnectedServicesMaterializer(params.agentId, connectedServices, managedServer, exec),
                getConnectedServiceStateSharingDescriptor: async () =>
                    connectedServices.stateSharingDescriptor,
                ...(connectedServices.recoveryCapabilities
                    ? {
                        getConnectedServiceRecoveryCapabilities: async () =>
                            connectedServices.recoveryCapabilities ?? null,
                    }
                    : {}),
                ...(connectedServices.materializeRuntimeAuthSelection === false
                    ? (runtimeControlMaterializer
                        ? { materializeConnectedServiceRuntimeAuthSelection: runtimeControlMaterializer }
                        : {})
                    : {
                        materializeConnectedServiceRuntimeAuthSelection:
                            runtimeControlMaterializer
                            ?? createRuntimeAuthSelectionMaterializer(params.agentId, connectedServices, managedServer, exec)
                            ?? undefined,
                    }),
                ...(runtimeAuthAdapter
                    ? {
                        getConnectedServiceRuntimeAuthAdapter: async () => runtimeAuthAdapter,
                    }
                    : {}),
                ...(switchContinuityResolver
                    ? { resolveConnectedServiceSwitchContinuity: switchContinuityResolver }
                    : {}),
                ...(connectedServices.resolveResumeReachabilityUnsupported
                    ? { verifyResumeReachable: runtimeControl?.connectedServices?.verifyResumeReachable ?? connectedServices.resolveResumeReachabilityUnsupported }
                    : {}),
                ...(connectedServices.usageLimitRecovery
                    ? (hasRuntimeControlAdapterMethods(runtimeControlUsageLimitRecoveryAdapter)
                        ? {
                            getSessionUsageLimitRecoveryControlAdapter: async () =>
                                runtimeControlUsageLimitRecoveryAdapter,
                        }
                        : {
                        getSessionUsageLimitRecoveryControlAdapter: async () =>
                            createBackoffSessionUsageLimitRecoveryControlAdapter({
                                providerId: connectedServices.usageLimitRecovery!.providerId,
                                issueProviderFilter: connectedServices.usageLimitRecovery!.issueProviderFilter ?? null,
                                defaultNativeServiceId: connectedServices.usageLimitRecovery!.defaultNativeServiceId ?? null,
                                fallbackBackoffEnvKey: connectedServices.usageLimitRecovery!.fallbackBackoffEnvKey,
                                maxAttemptsEnvKey: connectedServices.usageLimitRecovery!.maxAttemptsEnvKey,
                                defaultFallbackBackoffMs: connectedServices.usageLimitRecovery!.defaultFallbackBackoffMs,
                                defaultMaxAttempts: connectedServices.usageLimitRecovery!.defaultMaxAttempts,
                            }),
                    })
                    : {}),
            }
            : {}),
        ...(externalSessions
            ? {
                getExternalSessionRuntimeHostAdapters: async (adapterParams) => ({
                    transcriptStores: externalSessions.createTranscriptStoreAdapter
                        ? [externalSessions.createTranscriptStoreAdapter(adapterParams)]
                        : [],
                    candidateHosts: externalSessions.createCandidateHostAdapter
                        ? [externalSessions.createCandidateHostAdapter(adapterParams)]
                        : [],
                }),
            }
            : {}),
        ...(runtimeControl?.connectedServices?.verifyResumeReachable && !connectedServices?.resolveResumeReachabilityUnsupported
            ? { verifyResumeReachable: runtimeControl.connectedServices.verifyResumeReachable }
            : {}),
        ...(runtimeControl?.connectedServices?.resolveCandidatePersistedSessionFile
            ? {
                resolveConnectedServiceCandidatePersistedSessionFile:
                    runtimeControl.connectedServices.resolveCandidatePersistedSessionFile,
            }
            : {}),
        ...(hasRuntimeControlAdapterMethods(runtimeControlGoalAdapter)
            ? { getSessionGoalControlAdapter: async () => runtimeControlGoalAdapter }
            : {}),
        ...(hasRuntimeControlAdapterMethods(runtimeControlCatalogAdapter)
            ? { getSessionCatalogControlAdapter: async () => runtimeControlCatalogAdapter }
            : catalogControlAdapter
                ? { getSessionCatalogControlAdapter: async () => catalogControlAdapter }
                : {}),
        ...(!connectedServices?.usageLimitRecovery && hasRuntimeControlAdapterMethods(runtimeControlUsageLimitRecoveryAdapter)
            ? {
                getSessionUsageLimitRecoveryControlAdapter: async () =>
                    runtimeControlUsageLimitRecoveryAdapter,
            }
            : {}),
        ...(cloudConnect
            ? { getCloudConnectTarget: async () => createCloudConnectTarget(params.agentId, cloudConnect) }
            : {}),
        ...(sessionControls
            ? { normalizeSessionControlPermissionMode: sessionControls.normalizePermissionMode }
            : {}),
        ...(terminal
            ? { getHeadlessTmuxArgvTransform: async () => terminal.transformHeadlessTmuxArgv }
            : {}),
        ...(cliSessionCommand
            ? { getCliCommandHandler: createCliSessionCommandHandler(cliSessionCommand, params.agentId) }
            : {}),
        ...(vendorResumeSupport
            ? { getVendorResumeSupport: async () => vendorResumeSupport }
            : {}),
        ...(checklists
            ? { checklists }
            : {}),
        ...(sessionRuntimePreferences
            ? { resolveSessionRuntimePreferences: sessionRuntimePreferences.resolve }
            : {}),
        ...(sessionHandoff?.providerBundleRecords
            ? {
                getSessionHandoffProviderBundleRecordExtractor: async () =>
                    sessionHandoff.providerBundleRecords?.extract ?? null,
            }
            : {}),
        ...(sessionHandoff?.surface
            ? { getHandoffSurface: async () => sessionHandoff.surface ?? null }
            : {}),
        ...(managedServer
            ? {
                getManagedServerLaunchSpec: async () => requireProviderCliLaunchSpec(params.agentId),
                getManagedServerShutdownCleanup: async () => async () => {
                    await stopManagedProviderServerBestEffort(managedServer);
                },
                getManagedServerClaimDescriptor: async () => ({
                    agentId: params.agentId,
                    statePathEnvKey: managedServer.statePathEnvKey,
                    isExpectedProcessCommand: managedServer.isExpectedProcessCommand,
                }),
            }
            : {}),
        ...(attach
            ? {
                getProviderAttachOps: async () => createProviderCliAttachOps({
                    agentId: params.agentId,
                    resolveTarget: ({ metadata, fallbackServerBaseUrl }) => {
                        const target = attach.resolveTarget({ metadata, fallbackServerBaseUrl });
                        return isRecord(target) && target.ok === true
                            ? { ok: true, value: target }
                            : { ok: false, reason: readString(isRecord(target) ? target.reason : null) ?? 'Unable to resolve provider attach target.' };
                    },
                    createArgs: (target) => attach.createArgs(target),
                    buildHealthUrl: (target) => attach.buildHealthUrl(String(target.baseUrl ?? '')),
                    readFallbackServerBaseUrl: async () =>
                        managedServer
                            ? readString((await readManagedProviderServerStateBestEffort(managedServer))?.baseUrl)
                            : null,
                }),
            }
            : {}),
        ...(preflightSessionControls
            ? {
                ...(preflightSessionControls.needsAccountSettings
                    ? { needsAccountSettingsForProbes: true }
                    : {}),
                ...(preflightSessionControls.resolveProbeVariant
                    ? {
                        resolveSessionControlsProbeVariant: preflightSessionControls.resolveProbeVariant,
                        resolveModelsProbeVariant: (variantParams) =>
                            preflightSessionControls.resolveProbeVariant!({
                                ...variantParams,
                                probeKind: variantParams.probeKind ?? 'models',
                            }),
                    }
                    : {}),
                getPreflightSessionControlsProbeAdapter: async () => ({
                    failureCacheStrategy: preflightSessionControls.failureCacheStrategy,
                    cliModelsCommandArgs: preflightSessionControls.cliModelsCommandArgs,
                    ...(preflightSessionControls.verboseModelsCommandArgs
                        ? { verboseModelsCommandArgs: preflightSessionControls.verboseModelsCommandArgs }
                        : {}),
                    ...(preflightSessionControls.probeModelsRaw
                        ? {
                            probeModelsRaw: async (probeParams: PreflightSessionControlsProbeParams) =>
                                await preflightSessionControls.probeModelsRaw!(
                                    createPreflightContributionProbeParams(probeParams, 'models', exec),
                                ),
                        }
                        : preflightSessionControls.probeModels
                        ? {
                            probeModelsRaw: async ({ cwd, timeoutMs }) => {
                                const output = await runProviderCliCommandForOutput({
                                    agentId: params.agentId,
                                    args: preflightSessionControls.probeModels!.commandArgs,
                                    cwd,
                                    timeoutMs,
                                });
                                return output
                                    ? await preflightSessionControls.probeModels!.parseOutput({ output, cwd, timeoutMs })
                                    : null;
                            },
                        }
                        : {}),
                    ...(preflightSessionControls.probeModesRaw
                        ? {
                            probeModesRaw: async (probeParams: PreflightSessionControlsProbeParams) =>
                                await preflightSessionControls.probeModesRaw!(
                                    createPreflightContributionProbeParams(probeParams, 'modes', exec),
                                ),
                        }
                        : {}),
                    ...(preflightSessionControls.probeConfigOptionsRaw
                        ? {
                            probeConfigOptionsRaw: async (probeParams: PreflightSessionControlsProbeParams) =>
                                await preflightSessionControls.probeConfigOptionsRaw!(
                                    createPreflightContributionProbeParams(probeParams, 'configOptions', exec),
                                ),
                        }
                        : {}),
                }),
            }
            : {}),
        });
    };
}

export function applyProviderCatalogEntryHooks(
    contribution: ResolvedProviderContribution,
    hooksByProviderId: Readonly<Record<string, ProviderCatalogHookFactory>>,
): ResolvedProviderContribution {
    const createHooks = hooksByProviderId[contribution.id];
    if (!createHooks || !contribution.catalogEntry) return contribution;
    return Object.freeze({
        ...contribution,
        catalogEntry: Object.freeze({
            ...contribution.catalogEntry,
            ...createHooks(),
        }),
    });
}

export const releaseManagedProviderServerForSwitchFromState = releaseManagedServerForSwitchFromState;
