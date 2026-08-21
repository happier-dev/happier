import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { rm } from 'node:fs/promises';

import type { PluginExecService, PluginPath } from '@happier-dev/plugin-sdk/runtime';
import { getAgentCliRuntimeSpec } from '@happier-dev/agents';
import type { FetchRuntimeRequestV1 } from '@/plugins/runtime/exec/privateContract';
import {
    resolveConnectedAccountRequestAuthCapabilityPath,
} from '@happier-dev/plugin-sdk/experimental/cloud/request-auth';
import {
    ConnectedAccountRequestAuthUsesV1Schema,
    ConnectedServiceIdSchema,
    readConnectedServiceLimitCategoryV1,
    resolveConnectedServicesProviderStateSharingPolicyV1,
    type ConnectedServiceCredentialRecordV1,
    type ConnectedServiceId,
    type PluginSystemToolContributionV1,
} from '@happier-dev/protocol';

import { createBuiltInCliDetect } from '@/agent/acp/catalog/builtIn/detect';
import { resolveRuntimeActivityApplicability } from '@/agent/runtime/session/activity/runtimeActivityApplicability';
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
} from '@/daemon/connectedServices/switchContinuityContext';
import type {
    CatalogAgentId,
    ConnectedServiceSwitchContinuityParams,
    ConnectedServiceSwitchContinuityResult,
} from '@/agent/catalog/types';
import type { TerminalPromptSubmitVerificationPolicy } from '@/integrations/terminalHost/promptSubmitVerification';
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
import {
    resolveConnectedServiceCredentialResolutions,
} from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import { buildSafeOauthProviderFailureMessage } from '@/cloud/safeOauthProviderError';
import { generatePkceCodes } from '@/cloud/pkce';
import { parseOauthRedirectPaste } from '@/cloud/parseOauthRedirectPaste';
import { createGlobalFetchRuntime } from '@/plugins/runtime/fetch/globalFetchRuntime';
import {
    resolveFirstPartyLegacyAgentConnectedAccountServiceId,
} from './connectedAccountPurposeCompatibility';
import {
    resolveConnectedServiceGroupHomeDir,
    resolveConnectedServiceHomeDir,
} from '@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir';
import { readConnectedServiceMaterializedEnvKeysFromEnv } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import {
    createRetainedConnectedServicesMaterialization,
    type ConnectedServiceMaterializationCredentialRefreshFailureCategory,
    type ConnectedServicesMaterializationDiagnostic,
    type ConnectedServicesMaterializer,
} from '@/daemon/connectedServices/materialization/materializer';
import { parseProviderResetAt } from '@/daemon/connectedServices/quotas/normalization';
import { createRestartResumeConnectedServiceRuntimeAuthAdapter } from '@/daemon/connectedServices/runtimeAuth/createRestartResumeConnectedServiceRuntimeAuthAdapter';
import type {
    ConnectedServiceProviderRuntimeAuthAdapter,
    ConnectedServiceRuntimeFailureClassification,
} from '@/daemon/connectedServices/runtimeAuth/types';
import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';
import { sanitizeConnectedServiceDiagnosticString } from '@/daemon/connectedServices/runtimeAuth/sanitizeConnectedServiceDiagnosticString';
import { canResumeFromMaterializedStateCore } from '@/daemon/connectedServices/stateSharing/canResumeFromMaterializedStateCore';
import { REACHABILITY_CHECK_NOT_IMPLEMENTED_REASON } from '@/daemon/connectedServices/verifyResumeReachableTypes';
import { applyConnectedServiceStateSharingDescriptor } from '@/daemon/connectedServices/stateSharing/applyConnectedServiceStateSharingDescriptor';
import { withConnectedServiceStateSharingDestinationLock } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingLock';
import {
    readConnectedServiceStateSharingManifest,
    writeConnectedServiceStateSharingManifest,
} from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';
import type { ConnectedServiceRuntimeAuthSelectionMaterializer } from '@/daemon/connectedServices/sessionAuthSwitch/runtimeAuthSelectionMaterializerTypes';
import type { SessionConnectedServiceRuntimeAuthSelectionMaterializerInput } from '@/daemon/connectedServices/sessionAuthSwitch/switchSessionConnectedServiceAuth';
import { createSessionConnectedServiceAuthTransport } from '@/session/runtime/control/transport';
import { configuration } from '@/configuration';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import {
    readSessionHandoffContribution,
    resolveSessionHandoffSurface,
} from './sessionHandoffContribution';
import { projectPluginSystemToolContributions } from '@/plugins/runtime/exec/system/tools/definitions';
import {
    createAgentCliSystemToolService,
    type AgentCliSystemToolBinding,
} from '@/plugins/runtime/exec/system/tools/agentCliBinding';
import { createPluginExecSystemToolResolver } from '@/plugins/runtime/exec/system/tools/resolveGrant';
import {
    readManagedServerStateAtPathBestEffort,
    readManagedServerStateBestEffort,
    releaseManagedServerForSwitch,
    releaseManagedServerForSwitchFromState,
    resolveManagedServerStatePath,
    stopManagedServerBestEffort,
} from '@/plugins/runtime/context/managedServerPersistence';
import { promptInput, promptSecretInput } from '@/terminal/prompts/promptInput';
import { openBrowser } from '@/ui/openBrowser';
import { readPositiveIntEnv } from '@/utils/readPositiveIntEnv';
import { delay } from '@/utils/time';

import type {
    ResolvedCatalogEntry,
    ResolvedAgentContribution,
} from './types';
import type {
    CliAuthContribution,
    CloudCustomAuthenticatorContextV1,
    CloudConnectContribution,
    DaemonSpawnHooksContribution,
    ConnectedServiceStateSharingDescriptorResult,
    ConnectedServicesContribution,
    ManagedServerContribution,
    PreflightSessionControlsContribution,
    ProviderCliSessionCommandContribution,
    ProviderAttachContribution,
    AgentRuntimeContribution,
    SessionControlsContribution,
    SessionRuntimePreferencesContribution,
    SessionStartupContribution,
    TerminalContribution,
    VerifyResumeReachable,
} from './agentRuntimeContribution';

type CredentialRecord = ConnectedServiceCredentialRecordV1;
type AgentCatalogHookFactory = () => Partial<NonNullable<ResolvedAgentContribution['catalogEntry']>>;
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

function readAgentCliSystemToolBinding(
    value: unknown,
    systemTools: readonly PluginSystemToolContributionV1[],
): AgentCliSystemToolBinding | null {
    if (value === undefined) return null;
    if (!isRecord(value)) {
        throw new Error('Agent CLI system-tool binding must be an object with a toolId');
    }
    if (Object.keys(value).some((key) => key !== 'toolId')) {
        throw new Error('Agent CLI system-tool binding accepts only toolId');
    }
    const toolId = readString(value.toolId);
    if (!toolId) {
        throw new Error('Agent CLI system-tool binding toolId must be a non-empty string');
    }
    if (!systemTools.some((tool) => tool.id === toolId)) {
        throw new Error(`Agent CLI system-tool binding '${toolId}' must name a declared system tool`);
    }
    return Object.freeze({ toolId });
}

function sameResolvedPath(left: string | null | undefined, right: string | null | undefined): boolean {
    const normalizedLeft = readString(left);
    const normalizedRight = readString(right);
    return Boolean(normalizedLeft && normalizedRight && resolve(normalizedLeft) === resolve(normalizedRight));
}

function readFunction<T>(value: unknown): T | null {
    return typeof value === 'function' ? value as T : null;
}

function readPositiveNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function readProviderHttpStatus(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
        ? value
        : null;
}

function readMaterializationCredentialRefreshFailureCategory(
    value: unknown,
): ConnectedServiceMaterializationCredentialRefreshFailureCategory | null {
    switch (value) {
        case 'invalid_grant':
        case 'invalid_client':
        case 'provider_401':
        case 'provider_403':
        case 'network_error':
        case 'malformed_response':
        case 'missing_access_token':
        case 'missing_refresh_token':
        case 'unknown':
            return value;
        default:
            return null;
    }
}

function normalizeMaterializationCredentialRefreshFailure(value: unknown): ConnectedServicesMaterializationDiagnostic['credentialRefreshFailure'] {
    const record = isRecord(value) ? value : null;
    if (!record) return undefined;
    const category = readMaterializationCredentialRefreshFailureCategory(record.category);
    if (!category) return undefined;
    const providerStatus = readProviderHttpStatus(record.providerStatus);
    const providerErrorCode = readString(record.providerErrorCode);
    return {
        category,
        ...(providerStatus !== null ? { providerStatus } : {}),
        ...(providerErrorCode ? { providerErrorCode } : {}),
    };
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

function readNonEmptyStringArrayArray(value: unknown): readonly (readonly string[])[] {
    return Array.isArray(value)
        ? value.flatMap((entry) => {
            const stringArray = readNonEmptyStringArray(entry);
            return stringArray.length > 0 ? [stringArray] : [];
        })
        : [];
}

function readStringFunction(value: unknown): ((input: string) => string) | null {
    return typeof value === 'function' ? value as (input: string) => string : null;
}

function readStringArrayFunction(value: unknown): ((input: string[]) => string[]) | null {
    return typeof value === 'function' ? value as (input: string[]) => string[] : null;
}

function readSessionStartupContribution(value: unknown): SessionStartupContribution | null {
    if (!isRecord(value)) return null;
    const shouldUseDeferredBootstrap = readFunction<
        SessionStartupContribution['shouldUseDeferredBootstrap']
    >(value.shouldUseDeferredBootstrap);
    if (!shouldUseDeferredBootstrap) return null;
    const releasedOverridesCacheV1 = value.releasedOverridesCacheV1 === true;
    return {
        shouldUseDeferredBootstrap,
        ...(releasedOverridesCacheV1 ? { releasedOverridesCacheV1: true as const } : {}),
    };
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

function serializeRuntimeAuthDestinationTransitions(
    agentId: CatalogAgentId,
    adapter: ConnectedServiceProviderRuntimeAuthAdapter,
): ConnectedServiceProviderRuntimeAuthAdapter {
    const run = async <T>(
        input: Parameters<ConnectedServiceProviderRuntimeAuthAdapter['hotApply']>[0],
        operation: () => Promise<T>,
    ): Promise<T> => {
        const destinationHome = adapter.resolveDestinationHome?.(input) ?? null;
        return destinationHome
            ? await withConnectedServiceStateSharingDestinationLock(destinationHome, operation, { providerId: agentId })
            : await operation();
    };
    return {
        ...adapter,
        hotApply: async (input) => await run(input, async () => await adapter.hotApply(input)),
        ...(adapter.verifyActiveAccount
            ? {
                verifyActiveAccount: async (input) => await run(
                    input,
                    async () => await adapter.verifyActiveAccount!(input),
                ),
            }
            : {}),
    };
}

function readQuotaFetcherDescriptor(value: unknown): ConnectedServicesContribution['quotaFetcherDescriptor'] {
    if (!isRecord(value)) return undefined;
    const id = readString(value.id);
    const createFetcher = readFunction<
        NonNullable<ConnectedServicesContribution['quotaFetcherDescriptor']>['createFetcher']
    >(value.createFetcher);
    const terminalAuthFailureProviderCodes = readNonEmptyStringArray(value.terminalAuthFailureProviderCodes);
    return id && createFetcher
        ? {
            id,
            createFetcher,
            ...(terminalAuthFailureProviderCodes.length > 0 ? { terminalAuthFailureProviderCodes } : {}),
        }
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

function readCliAuthContribution(value: unknown): CliAuthContribution | null {
    if (!isRecord(value)) return null;
    const detectAuthStatus = readFunction<CliAuthContribution['detectAuthStatus']>(value.detectAuthStatus);
    return detectAuthStatus ? { detectAuthStatus } : null;
}

function resolveProjectedResumeReachability(
    connectedServices: ConnectedServicesContribution | null,
): VerifyResumeReachable {
    return connectedServices?.verifyResumeReachable
        ?? connectedServices?.resolveResumeReachabilityUnsupported
        ?? (async () => ({ ok: false, reason: REACHABILITY_CHECK_NOT_IMPLEMENTED_REASON }));
}

function readPredictiveSoftSwitchLiveSessionRequirement(value: unknown): NonNullable<
    NonNullable<ConnectedServicesContribution['recoveryCapabilities']>['predictiveSoftSwitch']['liveSessionRequirement']
> | null | undefined {
    if (value === undefined || value === null) return undefined;
    if (!isRecord(value)) return null;
    if (value.kind === 'none') return { kind: 'none' };
    if (value.kind !== 'shared_group_auth_surface') return null;
    const serviceIds = readConnectedServiceIdArray(value.serviceIds);
    const authEnvKey = typeof value.authEnvKey === 'string' ? value.authEnvKey.trim() : '';
    if (serviceIds.length === 0 || !authEnvKey) return null;
    const authEnvSubpath = readStringArray(value.authEnvSubpath);
    return {
        kind: 'shared_group_auth_surface',
        serviceIds,
        authEnvKey,
        ...(authEnvSubpath.length > 0 ? { authEnvSubpath } : {}),
    };
}

function readRuntimeAuthApplyCapability(value: unknown): NonNullable<
    ConnectedServicesContribution['recoveryCapabilities']
>['runtimeAuthApply'] | null | undefined {
    if (value === undefined || value === null) return undefined;
    if (!isRecord(value)) return null;
    const directLiveHotAuth = value.directLiveHotAuth;
    if (directLiveHotAuth === 'unsupported') return { directLiveHotAuth: 'unsupported' };
    if (!isRecord(directLiveHotAuth)) return null;
    if (typeof directLiveHotAuth.supportsInTurnApply !== 'boolean') return null;
    if (typeof directLiveHotAuth.requiresExactRuntimeIdentity !== 'boolean') return null;
    if (
        directLiveHotAuth.refreshSelectionResync !== 'required'
        && directLiveHotAuth.refreshSelectionResync !== 'not_applicable'
    ) {
        return null;
    }
    const authMode = readRuntimeAuthApplyAuthMode(directLiveHotAuth.authMode);
    if (!authMode) return null;
    return {
        directLiveHotAuth: {
            supportsInTurnApply: directLiveHotAuth.supportsInTurnApply,
            requiresExactRuntimeIdentity: directLiveHotAuth.requiresExactRuntimeIdentity,
            refreshSelectionResync: directLiveHotAuth.refreshSelectionResync,
            authMode,
        },
    };
}

function readRuntimeAuthApplyAuthMode(
    value: unknown,
): NonNullable<
    Exclude<
        NonNullable<
            NonNullable<ConnectedServicesContribution['recoveryCapabilities']>['runtimeAuthApply']
        >['directLiveHotAuth'],
        'unsupported'
    >['authMode']
> | null {
    if (!isRecord(value)) return null;
    if (value.kind === 'managed_provider_session') return { kind: 'managed_provider_session' };
    if (value.kind === 'api_key') return { kind: 'api_key' };
    if (value.kind === 'external_token_injection') {
        const surface = typeof value.surface === 'string' ? value.surface.trim() : '';
        return surface ? { kind: 'external_token_injection', surface } : null;
    }
    if (value.kind === 'provider_owned') {
        const name = typeof value.name === 'string' ? value.name.trim() : '';
        return name ? { kind: 'provider_owned', name } : null;
    }
    return null;
}

function readConnectedServiceRecoveryCapabilities(
    value: unknown,
): NonNullable<ConnectedServicesContribution['recoveryCapabilities']> | null {
    if (!isRecord(value)) return null;
    const predictiveSoftSwitch = isRecord(value.predictiveSoftSwitch) ? value.predictiveSoftSwitch : null;
    const mode = predictiveSoftSwitch?.mode;
    if (mode !== 'supported' && mode !== 'unsupported') return null;
    const liveSessionRequirement = readPredictiveSoftSwitchLiveSessionRequirement(
        predictiveSoftSwitch?.liveSessionRequirement,
    );
    if (liveSessionRequirement === null) return null;
    const runtimeAuthApply = readRuntimeAuthApplyCapability(value.runtimeAuthApply);
    if (runtimeAuthApply === null) return null;
    const sameAccountFanoutStrategy = value.sameAccountFanoutStrategy;
    const generationApplicationScope = value.generationApplicationScope;
    const sharedGenerationApplicationServiceIds = readConnectedServiceIdArray(
        value.sharedGenerationApplicationServiceIds,
    );
    return {
        predictiveSoftSwitch: {
            mode,
            ...(liveSessionRequirement === undefined ? {} : { liveSessionRequirement }),
        },
        ...(sameAccountFanoutStrategy === 'provider_account_id'
            || sameAccountFanoutStrategy === 'shared_group_auth_surface'
            || sameAccountFanoutStrategy === 'none'
            ? { sameAccountFanoutStrategy }
            : {}),
        ...(generationApplicationScope === 'per_session_runtime'
            || generationApplicationScope === 'shared_group_auth_surface'
            || generationApplicationScope === 'request_time_auth'
            || generationApplicationScope === 'unsupported'
            ? { generationApplicationScope }
            : {}),
        ...(sharedGenerationApplicationServiceIds.length > 0
            ? { sharedGenerationApplicationServiceIds }
            : {}),
        ...(runtimeAuthApply === undefined ? {} : { runtimeAuthApply }),
    };
}

function readConnectedServicesContribution(value: unknown): ConnectedServicesContribution | null {
    if (!isRecord(value)) return null;
    const serviceIds = readConnectedServiceIdArray(value.serviceIds);
    const requestAuthUses = value.requestAuthUses === undefined
        ? null
        : ConnectedAccountRequestAuthUsesV1Schema.safeParse(value.requestAuthUses);
    const stateSharingServiceIds = readConnectedServiceIdArray(value.stateSharingServiceIds);
    const noRestartRequiredServiceIds = readConnectedServiceIdArray(value.noRestartRequiredServiceIds);
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
    const isMaterializedHomeStale = readFunction<
        NonNullable<ConnectedServicesContribution['materializedHomeFreshness']>['isMaterializedHomeStale']
    >(value.isMaterializedHomeStale);
    const sanitizeRetainedMaterializedHome = readFunction<ConnectedServicesContribution['sanitizeRetainedMaterializedHome']>(
        value.sanitizeRetainedMaterializedHome,
    );
    const shouldRestartForServiceSwitch = readFunction<ConnectedServicesContribution['shouldRestartForServiceSwitch']>(
        value.shouldRestartForServiceSwitch,
    );
    const unsupportedSwitchReason = readFunction<ConnectedServicesContribution['unsupportedSwitchReason']>(
        value.unsupportedSwitchReason,
    );
    const verifyResumeReachable = readFunction<ConnectedServicesContribution['verifyResumeReachable']>(
        value.verifyResumeReachable,
    );
    const resolveCandidatePersistedSessionFile = readFunction<
        NonNullable<ConnectedServicesContribution['resolveCandidatePersistedSessionFile']>
    >(value.resolveCandidatePersistedSessionFile);
    const resolveResumeReachabilityUnsupported = readFunction<ConnectedServicesContribution['resolveResumeReachabilityUnsupported']>(
        value.resolveResumeReachabilityUnsupported,
    );
    const classifyUsageLimitError = readFunction<ConnectedServicesContribution['classifyUsageLimitError']>(
        value.classifyUsageLimitError,
    );
    const runtimeAuthAdapter = readRuntimeAuthAdapter(value.runtimeAuthAdapter);
    const quotaFetcherDescriptor = readQuotaFetcherDescriptor(value.quotaFetcherDescriptor);
    const daemonAuthBridge = isRecord(value.daemonAuthBridge) ? value.daemonAuthBridge : null;
    const daemonAuthBridgeRefresh = readFunction<
        NonNullable<ConnectedServicesContribution['daemonAuthBridge']>['refresh']
    >(daemonAuthBridge?.refresh);
    const restartRematerializeRequiredReason = readString(value.restartRematerializeRequiredReason);
    const connectedSwitchSharedStateRequiredReason = readString(value.connectedSwitchSharedStateRequiredReason);
    const nativeSwitchSharedStateRequiredReason = readString(value.nativeSwitchSharedStateRequiredReason);
    const usageLimitRecovery = isRecord(value.usageLimitRecovery) ? value.usageLimitRecovery : null;
    const usageLimitRecoveryOwnerId = readString(usageLimitRecovery?.agentId);
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
    const resolveLegacyRuntimeAuthFailureSourceRevision = readFunction<
        NonNullable<ConnectedServicesContribution['resolveLegacyRuntimeAuthFailureSourceRevision']>
    >(value.resolveLegacyRuntimeAuthFailureSourceRevision);
    const stateSharingDescriptor = value.stateSharingDescriptor as ConnectedServiceStateSharingDescriptorResult;
    if (
        serviceIds.length === 0
        || !readConnectedServiceId
        || !createAuthMaterializationInput
        || !materializeAuthEnvironment
        || !stateSharingDescriptor
        || requestAuthUses?.success === false
    ) {
        return null;
    }
    return {
        serviceIds,
        ...(requestAuthUses?.success
            ? { requestAuthUses: Object.freeze(requestAuthUses.data.map((use) => Object.freeze(use))) }
            : {}),
        ...(stateSharingServiceIds.length > 0 ? { stateSharingServiceIds } : {}),
        ...(noRestartRequiredServiceIds.length > 0 ? { noRestartRequiredServiceIds } : {}),
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
        ...(isMaterializedHomeStale
            ? {
                materializedHomeFreshness: {
                    isMaterializedHomeStale,
                },
            }
            : {}),
        ...(sanitizeRetainedMaterializedHome ? { sanitizeRetainedMaterializedHome } : {}),
        stateSharingDescriptor,
        ...(value.materializeRuntimeAuthSelection === false ? { materializeRuntimeAuthSelection: false } : {}),
        ...(shouldRestartForServiceSwitch ? { shouldRestartForServiceSwitch } : {}),
        ...(unsupportedSwitchReason ? { unsupportedSwitchReason } : {}),
        ...(restartRematerializeRequiredReason ? { restartRematerializeRequiredReason } : {}),
        ...(connectedSwitchSharedStateRequiredReason ? { connectedSwitchSharedStateRequiredReason } : {}),
        ...(nativeSwitchSharedStateRequiredReason ? { nativeSwitchSharedStateRequiredReason } : {}),
        ...(value.sameAuthGroupRequiresResumeReachability === true ? { sameAuthGroupRequiresResumeReachability: true } : {}),
        ...(value.exactSameSelectionRequiresResumeReachability === false
            ? { exactSameSelectionRequiresResumeReachability: false }
            : {}),
        ...(verifyResumeReachable ? { verifyResumeReachable } : {}),
        ...(resolveCandidatePersistedSessionFile ? { resolveCandidatePersistedSessionFile } : {}),
        ...(resolveResumeReachabilityUnsupported ? { resolveResumeReachabilityUnsupported } : {}),
        ...(classifyUsageLimitError ? { classifyUsageLimitError } : {}),
        ...(runtimeAuthAdapter !== undefined ? { runtimeAuthAdapter } : {}),
        ...(daemonAuthBridgeRefresh
            ? {
                daemonAuthBridge: {
                    refresh: daemonAuthBridgeRefresh,
                },
            }
            : {}),
        ...(quotaFetcherDescriptor ? { quotaFetcherDescriptor } : {}),
        ...(usageLimitRecoveryOwnerId && fallbackBackoffEnvKey && maxAttemptsEnvKey && defaultFallbackBackoffMs && defaultMaxAttempts
            ? {
                usageLimitRecovery: {
                    agentId: usageLimitRecoveryOwnerId,
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
        ...(resolveLegacyRuntimeAuthFailureSourceRevision
            ? { resolveLegacyRuntimeAuthFailureSourceRevision }
            : {}),
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

function readDaemonSpawnHooksContribution(value: unknown): DaemonSpawnHooksContribution | null {
    if (!isRecord(value)) return null;
    const resolveRuntimePrerequisites = readFunction<NonNullable<DaemonSpawnHooks['resolveRuntimePrerequisites']>>(
        value.resolveRuntimePrerequisites,
    );
    const augmentEnv = readFunction<NonNullable<DaemonSpawnHooks['augmentEnv']>>(value.augmentEnv);
    const contribution: DaemonSpawnHooksContribution = {
        ...(resolveRuntimePrerequisites ? { resolveRuntimePrerequisites } : {}),
        ...(augmentEnv ? { augmentEnv } : {}),
    };
    return Object.keys(contribution).length > 0 ? contribution : null;
}

function readTerminalContribution(value: unknown): TerminalContribution | null {
    if (!isRecord(value)) return null;
    const transformHeadlessTmuxArgv = readStringArrayFunction(value.transformHeadlessTmuxArgv);
    const promptSubmitVerification = readTerminalPromptSubmitVerificationPolicy(value.promptSubmitVerification);
    const contribution: TerminalContribution = {
        ...(transformHeadlessTmuxArgv ? { transformHeadlessTmuxArgv } : {}),
        ...(promptSubmitVerification ? { promptSubmitVerification } : {}),
        ...(value.retainsSessionHookArtifacts === true ? { retainsSessionHookArtifacts: true } : {}),
    };
    return Object.keys(contribution).length > 0 ? contribution : null;
}

function readTerminalPromptSubmitVerificationPolicy(value: unknown): TerminalPromptSubmitVerificationPolicy | null {
    if (!isRecord(value)) return null;
    const shouldVerifyBeforeSubmit = readFunction<TerminalPromptSubmitVerificationPolicy['shouldVerifyBeforeSubmit']>(
        value.shouldVerifyBeforeSubmit,
    );
    const verifyBeforeSubmit = readFunction<TerminalPromptSubmitVerificationPolicy['verifyBeforeSubmit']>(
        value.verifyBeforeSubmit,
    );
    const shouldVerifyAfterSubmit = readFunction<TerminalPromptSubmitVerificationPolicy['shouldVerifyAfterSubmit']>(
        value.shouldVerifyAfterSubmit,
    );
    const verifyAfterSubmit = readFunction<TerminalPromptSubmitVerificationPolicy['verifyAfterSubmit']>(
        value.verifyAfterSubmit,
    );
    if (!shouldVerifyBeforeSubmit || !verifyBeforeSubmit || !shouldVerifyAfterSubmit || !verifyAfterSubmit) {
        return null;
    }
    return {
        shouldVerifyBeforeSubmit,
        verifyBeforeSubmit,
        shouldVerifyAfterSubmit,
        verifyAfterSubmit,
    };
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
    const providerInfoCommandPrefixes = readNonEmptyStringArrayArray(value.providerInfoCommandPrefixes);
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
        ...(providerInfoCommandPrefixes.length > 0 ? { providerInfoCommandPrefixes } : {}),
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
    identity: Readonly<{
        cliSubcommand: string;
        runtimeAuthorityAgentId: string;
    }>,
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
                    explicitProviderSubcommand:
                        context.args[0] === identity.cliSubcommand,
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
                runtimeAuthorityAgentId: identity.runtimeAuthorityAgentId,
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
                ...(cliSessionCommand.providerInfoCommandPrefixes
                    ? { providerInfoCommandPrefixes: cliSessionCommand.providerInfoCommandPrefixes }
                    : {}),
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
        hasInFlightTurnForLaunchFingerprint?: () => Promise<boolean> | boolean;
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
        ...(params.hasInFlightTurnForLaunchFingerprint
            ? { hasInFlightTurnForLaunchFingerprint: params.hasInFlightTurnForLaunchFingerprint }
            : {}),
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

function resolveSharedGroupAuthSurfacePreflightSelection(params: Readonly<{
    agentId: CatalogAgentId;
    connectedServices: ConnectedServicesContribution;
    serviceId: ConnectedServiceId;
    activeServerDir: string;
    baseSelection: Parameters<ConnectedServiceRuntimeAuthSelectionMaterializer>[0]['baseSelection'];
    trackedEnv?: NodeJS.ProcessEnv | null;
    exec: PluginExecService;
}>): unknown | null {
    const requirement = params.connectedServices.recoveryCapabilities?.predictiveSoftSwitch.liveSessionRequirement;
    if (requirement?.kind !== 'shared_group_auth_surface') return null;
    if (!requirement.serviceIds.includes(params.serviceId)) return null;
    const groupId = readString(params.baseSelection.groupId);
    if (!groupId) return null;
    const groupHomeDir = resolveConnectedServiceGroupHomeDir({
        activeServerDir: params.activeServerDir,
        serviceId: params.serviceId,
        groupId,
        agentId: params.agentId,
    });
    const authSurfaceRoot = requirement.authEnvSubpath && requirement.authEnvSubpath.length > 0
        ? resolve(groupHomeDir, ...requirement.authEnvSubpath)
        : groupHomeDir;
    if (!sameResolvedPath(params.trackedEnv?.[requirement.authEnvKey], authSurfaceRoot)) return null;
    return {
        ...params.baseSelection,
        targetMaterializedEnv: { [requirement.authEnvKey]: authSurfaceRoot },
        targetMaterializedRoot: authSurfaceRoot,
        exec: params.exec,
        materializationDiagnostics: [],
    };
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
    credentialRefreshFailure?: ConnectedServicesMaterializationDiagnostic['credentialRefreshFailure'];
}[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
        const record = isRecord(entry) ? entry : null;
        const code = readString(record?.code);
        if (!record || !code) return [];
        const runtimeOwnerId = readString(record.agentId);
        const parsedServiceId = record.serviceId === undefined ? null : ConnectedServiceIdSchema.safeParse(record.serviceId);
        const severity = record.severity === 'info' || record.severity === 'warning' || record.severity === 'blocking'
            ? record.severity
            : undefined;
        const credentialRefreshFailure = normalizeMaterializationCredentialRefreshFailure(record.credentialRefreshFailure);
        return [{
            code,
            ...(runtimeOwnerId ? { providerId: runtimeOwnerId } : {}),
            ...(parsedServiceId?.success ? { serviceId: parsedServiceId.data } : {}),
            ...(severity ? { severity } : {}),
            ...(readString(record.requestedStateMode) ? { requestedStateMode: readString(record.requestedStateMode)! } : {}),
            ...(readString(record.effectiveStateMode) ? { effectiveStateMode: readString(record.effectiveStateMode)! } : {}),
            ...(readString(record.reason) ? { reason: readString(record.reason)! } : {}),
            ...(readString(record.entryName) ? { entryName: readString(record.entryName)! } : {}),
            ...(credentialRefreshFailure ? { credentialRefreshFailure } : {}),
        }];
    });
}

function normalizeStateSharingDiagnostics(
    diagnostics: Awaited<ReturnType<typeof applyConnectedServiceStateSharingDescriptor>>['diagnostics'],
): readonly ConnectedServicesMaterializationDiagnostic[] {
    return diagnostics.map((diagnostic) => {
        const runtimeOwnerId = diagnostic.providerId;
        const parsedServiceId = diagnostic.serviceId === undefined
            ? null
            : ConnectedServiceIdSchema.safeParse(diagnostic.serviceId);
        return {
            code: diagnostic.code,
            providerId: runtimeOwnerId,
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
}>): Promise<Readonly<{
    diagnostics: readonly ConnectedServicesMaterializationDiagnostic[];
    effectiveStateMode: 'isolated' | 'shared';
}>> {
    const resolveStateSharingSourceRoot = params.connectedServices.resolveStateSharingSourceRoot;
    const providerLabel = String(params.agentId);
    const settings = resolveConnectedServicesProviderStateSharingPolicyV1(
        params.accountSettings?.connectedServicesProviderStateSharingSettingsV1,
        params.agentId,
    );
    if (!resolveStateSharingSourceRoot) {
        return { diagnostics: [], effectiveStateMode: settings.stateMode };
    }
    if (
        params.connectedServices.stateSharingServiceIds
        && !params.connectedServices.stateSharingServiceIds.includes(params.serviceId)
    ) {
        return { diagnostics: [], effectiveStateMode: settings.stateMode };
    }
    return await withConnectedServiceStateSharingDestinationLock(params.materializedRootDir, async () => {
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
            providerLabel,
        });
        await removeMaterializedHomeCredentialEntries(
            params.materializedRootDir,
            params.connectedServices.materializedHomeCredentialEntries,
        );
        await writeConnectedServiceStateSharingManifest(params.materializedRootDir, applyResult.manifest);
        return {
            diagnostics: normalizeStateSharingDiagnostics(applyResult.diagnostics),
            effectiveStateMode: applyResult.manifest.effectiveStateMode,
        };
    }, { providerId: providerLabel });
}

function createConnectedServicesMaterializer(
    agentId: CatalogAgentId,
    connectedServices: ConnectedServicesContribution,
    managedServer: ManagedServerContribution | null,
    exec: PluginExecService,
): ConnectedServicesMaterializer {
    const mergeAuthMaterializationInput = (
        target: Record<string, unknown>,
        input: Readonly<Record<string, unknown>>,
    ): void => {
        for (const [key, value] of Object.entries(input)) {
            if (value === null || value === undefined) continue;
            target[key] = value;
        }
    };

    return async ({
        materializationKey,
        activeServerDir,
        recordsByServiceId,
        selectionsByServiceId,
        requestAuthPurposeBindings,
        accountSettings,
        processEnv,
        sessionDirectory,
    }) => {
        const materializationInput: Record<string, unknown> = {};
        const qualifiedPurposeLegacyServiceIds = new Set(
            (requestAuthPurposeBindings ?? []).flatMap((binding) => {
                const service = binding.target.kind === 'account'
                    ? binding.target.account.service
                    : binding.target.service;
                const serviceId =
                    resolveFirstPartyLegacyAgentConnectedAccountServiceId(service);
                return serviceId ? [serviceId] : [];
            }),
        );
        let primaryRecord: CredentialRecord | null = null;
        let primaryServiceId: ConnectedServiceId | null = null;

        for (const serviceId of connectedServices.serviceIds) {
            const record = selectionsByServiceId?.get(serviceId)?.record ?? recordsByServiceId.get(serviceId) ?? null;
            if (!record) continue;
            if (!qualifiedPurposeLegacyServiceIds.has(serviceId)) {
                mergeAuthMaterializationInput(
                    materializationInput,
                    connectedServices.createAuthMaterializationInput(serviceId, record),
                );
            }
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
        // Thread group-bound selections' groupIds to the plugin materializer so runtime-auth
        // selection identities can be pool-scoped (without generation) at the single owner.
        const connectedServiceGroupIdsByServiceId = Object.fromEntries(
            [...(selectionsByServiceId?.entries() ?? [])]
                .flatMap(([serviceId, selection]) => selection.kind === 'group' ? [[serviceId, selection.groupId] as const] : []),
        );
        const materializationContext = {
            ...materializationInput,
            ...(qualifiedPurposeLegacyServiceIds.size > 0
                ? { qualifiedPurposeMaterialization: true }
                : {}),
            ...(Object.keys(connectedServiceGroupIdsByServiceId).length > 0
                ? { connectedServiceGroupIdsByServiceId }
                : {}),
            rootDir: materializedRootDir,
            processEnv: env,
            accountSettings: accountSettings ?? null,
            sessionDirectory: sessionDirectory ?? null,
            exec,
            ...(requestAuthPurposeBindings?.length
                ? {
                    requestAuth: Object.freeze({
                        purposeBindings: requestAuthPurposeBindings,
                        capabilityPath:
                            resolveConnectedAccountRequestAuthCapabilityPath(
                                materializedRootDir,
                            ),
                    }),
                }
                : {}),
        };
        const managedServerStatePath = managedServer
            ? resolveManagedServerStatePathForEnv(managedServer, {
                ...env,
                ...((await connectedServices.materializeAuthEnvironment(materializationContext)).env),
            })
            : null;
        const stateSharing = await applyConnectedServiceStateSharingForContribution({
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
            connectedServicesSessionStateSharingEffectiveMode: stateSharing.effectiveStateMode,
            materializationId: materializationKey,
            ...(managedServerStatePath ? { managedServerStatePath } : {}),
        });

        return {
            ...createRetainedConnectedServicesMaterialization({
                rootDir: materializedRootDir,
                env: materialized.env,
            }),
            diagnostics: [
                ...stateSharing.diagnostics,
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

function createConnectedServiceMaterializedHomeRootResolver(
    agentId: CatalogAgentId,
    connectedServices: ConnectedServicesContribution,
): NonNullable<ResolvedCatalogEntry['resolveConnectedServiceMaterializedHomeRoot']> {
    return (params) => {
        const serviceId = connectedServices.readConnectedServiceId(params.serviceId);
        if (!serviceId) return null;
        const selection = params.selection;
        const stableRootDir = selection?.kind === 'group'
            ? resolveConnectedServiceGroupHomeDir({
                activeServerDir: params.activeServerDir,
                serviceId,
                groupId: selection.groupId,
                agentId,
            })
            : resolveConnectedServiceHomeDir({
                activeServerDir: params.activeServerDir,
                serviceId,
                profileId: selection?.kind === 'profile' ? selection.profileId : params.profileId,
                agentId,
            });
        return materializedRootDirForStableRoot(connectedServices, stableRootDir);
    };
}

function createRetainedRuntimeAuthSelectionMaterializer(
    agentId: CatalogAgentId,
    connectedServices: ConnectedServicesContribution,
    exec: PluginExecService,
): ConnectedServiceRuntimeAuthSelectionMaterializer {
    return async (params) => {
        const baseSelection = {
            ...params.baseSelection,
            applyConnectedServiceAuthGeneration:
                createSessionConnectedServiceAuthTransport({
                    credentials: params.credentials,
                    sessionId: params.input.sessionId,
                }).applyConnectedServiceAuthGeneration,
        };
        const serviceId = connectedServices.readConnectedServiceId(params.input.serviceId);
        if (!serviceId) return baseSelection;
        const activeServerDir = readString(params.activeServerDir);
        if (!activeServerDir) return baseSelection;
        const record = readBaseSelectionCredentialRecord(baseSelection.record);
        if (!record) return baseSelection;
        const materializedRootDir = createRuntimeAuthSelectionMaterializationRoot({
            agentId,
            serviceId,
            activeServerDir,
            baseSelection,
            connectedServices,
        });
        const sharedGroupAuthSurfaceSelection = resolveSharedGroupAuthSurfacePreflightSelection({
            agentId,
            connectedServices,
            serviceId,
            activeServerDir,
            baseSelection,
            trackedEnv: params.input.tracked.spawnOptions?.environmentVariables,
            exec,
        });
        if (params.input.mode === 'preflight') {
            return sharedGroupAuthSurfaceSelection ?? baseSelection;
        }
        if (sharedGroupAuthSurfaceSelection) return sharedGroupAuthSurfaceSelection;
        const env = params.processEnv ?? process.env;
        const materializationId = readString(
            params.input.tracked.spawnOptions?.connectedServiceMaterializationIdentityV1?.id,
        );
        const stateSharing = await applyConnectedServiceStateSharingForContribution({
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
            ...(materializationId ? { materializationId } : {}),
            processEnv: env,
            connectedServicesSessionStateSharingEffectiveMode: stateSharing.effectiveStateMode,
            accountSettings: params.accountSettings ?? null,
            sessionDirectory: params.input.tracked.spawnOptions?.directory ?? null,
            exec,
        });
        return {
            ...baseSelection,
            targetMaterializedEnv: materialized.env,
            targetMaterializedRoot: materializedRootDir,
            exec,
            materializationDiagnostics: [
                ...stateSharing.diagnostics,
                ...normalizeMaterializationDiagnostics(materialized.diagnostics),
            ],
        };
    };
}

function createManagedServerRuntimeAuthSelectionMaterializer(
    agentId: CatalogAgentId,
    connectedServices: ConnectedServicesContribution,
    managedServer: ManagedServerContribution,
    exec: PluginExecService,
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
            const resolutions =
                await resolveConnectedServiceCredentialResolutions({
                credentials: params.credentials,
                api: params.api,
                bindings: [{ serviceId, profileId: normalizedPreviousProfileId }],
            });
            const previousResolution = resolutions.get(serviceId);
            if (
                previousResolution?.revisionSemantics !== 'revisioned'
            ) return null;
            const previousRecord = previousResolution.record;
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
                hasInFlightTurnForStatePath?: (statePath: string) => boolean;
            }>) => {
                const trackedClaimCount = typeof input.countTrackedClaimsForStatePath === 'function'
                    ? input.countTrackedClaimsForStatePath(previousContext.previousStatePath)
                    : 0;
                if (input.hasUnknownTrackedClaims === true) return;
                const hasInFlightTurnForStatePath = input.hasInFlightTurnForStatePath;
                await releaseManagedProviderServerForAuthSwitch(managedServer, {
                    previousStatePath: previousContext.previousStatePath,
                    expectedOwnerToken: previousContext.previousOwnerToken,
                    trackedClaimCount,
                    allowCurrentSessionClaim: true,
                    ...(hasInFlightTurnForStatePath
                        ? {
                            hasInFlightTurnForLaunchFingerprint: () =>
                                hasInFlightTurnForStatePath(previousContext.previousStatePath),
                        }
                        : {}),
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
    exec: PluginExecService,
): ConnectedServiceRuntimeAuthSelectionMaterializer | null {
    return managedServer
        ? createManagedServerRuntimeAuthSelectionMaterializer(agentId, connectedServices, managedServer, exec)
        : createRetainedRuntimeAuthSelectionMaterializer(agentId, connectedServices, exec);
}

function createSwitchContinuityResolver(
    agentId: CatalogAgentId,
    connectedServices: ConnectedServicesContribution,
    runtimeAuthAdapter: ConnectedServiceProviderRuntimeAuthAdapter | null,
    verifyResumeReachable: VerifyResumeReachable,
) {
    return async (params: ConnectedServiceSwitchContinuityParams): Promise<ConnectedServiceSwitchContinuityResult> => {
        if (!connectedServices.shouldRestartForServiceSwitch?.(params.serviceId)) {
            return {
                mode: 'unsupported',
                reason: connectedServices.unsupportedSwitchReason?.(params.serviceId)
                    ?? 'unsupported_service',
            };
        }
        if (
            runtimeAuthAdapter
            && isConnectedToConnectedServiceSwitch(params)
            && params.runtimeAuthSelection !== null
            && params.runtimeAuthSelection !== undefined
        ) {
            const hotApply = runtimeAuthAdapter.canHotApply({
                target: { agentId },
                selection: params.runtimeAuthSelection,
                targetMaterializedEnv: params.targetMaterializedEnv ?? null,
                materializedEnv: params.targetMaterializedEnv ?? null,
            });
            if (isRecord(hotApply) && hotApply.supported === true) {
                return { mode: 'hot_apply' };
            }
        }
        if (isConnectedToConnectedServiceSwitch(params)) {
            const restartContinuityCanBeProven = (
                connectedServices.exactSameSelectionRequiresResumeReachability !== false
                && isExactSameConnectedServiceSelection(params)
            )
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

            const reachability = await canResumeFromMaterializedStateCore({
                targetMaterializedRoot,
                targetMaterializedEnv,
                requestedStateMode: 'isolated',
                effectiveStateMode: 'isolated',
                materializationIdentity,
                vendorResumeId: providerSessionId,
                cwd,
                candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
                verifyResumeReachable,
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
    const fetchRuntime = createGlobalFetchRuntime();
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
    systemTools: readonly PluginSystemToolContributionV1[],
    agentId: CatalogAgentId,
    agentCliSystemTool: AgentCliSystemToolBinding | null,
): Parameters<NonNullable<PreflightSessionControlsContribution['probeModelsRaw']>>[0] {
    const environment = Object.freeze(Object.fromEntries(
        Object.entries(params.env ?? process.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
    ));
    return {
        ...params,
        probeKind,
        exec: createProviderScopedStableExecService({
            cwd: params.cwd,
            environment,
            systemTools,
            agentId,
            agentCliSystemTool,
        }),
        env: environment,
    };
}

function createProviderScopedStableExecService(params: Readonly<{
    cwd: string;
    environment: Readonly<Record<string, string>>;
    systemTools: readonly PluginSystemToolContributionV1[];
    agentId?: CatalogAgentId;
    agentCliSystemTool?: AgentCliSystemToolBinding | null;
}>): PluginExecService {
    const workspaceRoot = resolve(params.cwd);
    const definitions = projectPluginSystemToolContributions(params.systemTools);
    const unboundSystemTools = createPluginExecSystemToolResolver({
        definitions,
        baseEnv: params.environment,
        // Stable invocation services consume the launch immediately, so no
        // legacy grant identity crosses this projection boundary.
        registerGrant() {},
    });
    const boundDefinition = params.agentCliSystemTool
        ? definitions.find((definition) => definition.toolId === params.agentCliSystemTool?.toolId)
        : undefined;
    const systemTools = params.agentId && params.agentCliSystemTool && boundDefinition
        ? createAgentCliSystemToolService({
            agentId: params.agentId,
            runtimeSpec: getAgentCliRuntimeSpec(params.agentId),
            binding: params.agentCliSystemTool,
            definition: boundDefinition,
            processEnv: { ...params.environment },
            delegate: unboundSystemTools,
        })
        : unboundSystemTools;
    return createStablePluginExecService({
        allowedExecutables: params.systemTools.map((tool) => Object.freeze({
            kind: 'systemTool' as const,
            id: tool.id,
        })),
        allowedEnvKeys: Object.freeze([...new Set([...Object.keys(params.environment), 'CI'])]),
        environment: Object.freeze({}),
        allowedCwdScopes: Object.freeze([{
            root: 'workspace' as const,
            pathPrefix: '',
            access: Object.freeze(['read' as const]),
        }]),
        signal: new AbortController().signal,
        isGenerationCurrent: () => true,
        async resolveExecutable() {
            throw new Error('Provider preflight executables must resolve through a declared system tool');
        },
        async resolvePath(path: PluginPath) {
            if (path.root !== 'workspace') {
                throw new Error('Provider preflight working directories must use the scoped workspace root');
            }
            const resolvedPath = resolve(workspaceRoot, path.relativePath);
            const relativePath = resolvedPath.slice(workspaceRoot.length);
            if (
                resolvedPath !== workspaceRoot
                && !relativePath.startsWith('/')
                && !relativePath.startsWith('\\')
            ) {
                throw new Error('Provider preflight working directory escaped the scoped workspace root');
            }
            return resolvedPath;
        },
        systemTools,
    });
}

function createProviderScopedExecService(
    systemTools?: readonly PluginSystemToolContributionV1[],
    agentId?: CatalogAgentId,
    agentCliSystemTool?: AgentCliSystemToolBinding | null,
): PluginExecService {
    const environment = Object.freeze(Object.fromEntries(
        Object.entries(process.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
    ));
    return createProviderScopedStableExecService({
        cwd: process.cwd(),
        environment,
        systemTools: systemTools ?? [],
        agentId,
        agentCliSystemTool,
    });
}

export function createAgentRuntimeCatalogEntryHooks(params: Readonly<{
    agentId: CatalogAgentId;
    packageName: string;
    contribution: AgentRuntimeContribution;
    systemTools?: readonly PluginSystemToolContributionV1[];
}>): AgentCatalogHookFactory {
    const systemTools = params.systemTools ?? Object.freeze([]);
    const agentCliSystemTool = readAgentCliSystemToolBinding(
        params.contribution.agentCliSystemTool,
        systemTools,
    );
    const connectedServices = readConnectedServicesContribution(params.contribution.connectedServices);
    const managedServer = readManagedServerContribution(params.contribution.managedServer);
    const attach = readProviderAttachContribution(params.contribution.attach);
    const sessionRuntimePreferences = readSessionRuntimePreferencesContribution(
        params.contribution.sessionRuntimePreferences,
    );
    const sessionStartup = readSessionStartupContribution(params.contribution.sessionStartup);
    const codingPromptBehavior = readFunction<NonNullable<ResolvedCatalogEntry['resolveCodingPromptBehaviorBlocks']>>(
        params.contribution.codingPromptBehavior?.resolve,
    );
    const daemonSpawnHooks = readDaemonSpawnHooksContribution(params.contribution.daemonSpawnHooks);
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
    const rawRuntimeAuthAdapter = connectedServices
        ? createRuntimeAuthAdapter(params.agentId, connectedServices)
        : null;
    const runtimeAuthAdapter = rawRuntimeAuthAdapter
        ? serializeRuntimeAuthDestinationTransitions(params.agentId, rawRuntimeAuthAdapter)
        : null;
    const projectedResumeReachability = resolveProjectedResumeReachability(connectedServices);
    const connectedServiceSwitchContinuityResolver = connectedServices?.shouldRestartForServiceSwitch
        ? createSwitchContinuityResolver(
            params.agentId,
            connectedServices,
            runtimeAuthAdapter,
            projectedResumeReachability,
        )
        : null;
    const switchContinuityResolver = connectedServiceSwitchContinuityResolver;

    const runtimeActivityApplicabilityDeclarationPresent = Object.prototype.hasOwnProperty.call(
        params.contribution,
        'runtimeActivityApplicability',
    );
    const runtimeActivityApplicability = runtimeActivityApplicabilityDeclarationPresent
        ? resolveRuntimeActivityApplicability(params.contribution.runtimeActivityApplicability, {
            declarationPresent: true,
        })
        : null;

    return () => {
        const exec = createProviderScopedExecService(
            systemTools,
            params.agentId,
            agentCliSystemTool,
        );
        return ({
        ...(agentCliSystemTool ? { agentCliSystemTool } : {}),
        ...(runtimeActivityApplicability ? { runtimeActivityApplicability } : {}),
        ...(params.contribution.builtInAcpCatalog === true
            ? {
                getCliDetect: async () => createBuiltInCliDetect(params.agentId),
                getCliAuthSpec: async () => {
                    if (cliAuth) {
                        const { createCatalogCliAuthSpec } = await import(
                            '@/capabilities/cliAuth/createCatalogCliAuthSpec'
                        );
                        return createCatalogCliAuthSpec(params.agentId, {
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
                        });
                    }
                    const { createBuiltInCliAuthSpec } = await import(
                        '@/agent/acp/catalog/builtIn/auth'
                    );
                    return createBuiltInCliAuthSpec(params.agentId);
                },
            }
            : {}),
        ...(connectedServices
            ? {
                getConnectedServicesMaterializer: async () =>
                    createConnectedServicesMaterializer(params.agentId, connectedServices, managedServer, exec),
                ...(connectedServices.noRestartRequiredServiceIds
                    ? { connectedServiceNoRestartRequiredServiceIds: connectedServices.noRestartRequiredServiceIds }
                    : {}),
                ...(connectedServices.shouldRestartForServiceSwitch
                    ? {
                        shouldRestartConnectedServiceOnCredentialUpdate: (serviceId: ConnectedServiceId) =>
                            connectedServices.shouldRestartForServiceSwitch?.(serviceId) === true,
                    }
                    : {}),
                connectedServiceIds: connectedServices.serviceIds,
                ...(connectedServices.requestAuthUses
                    ? { connectedAccountRequestAuthUses: connectedServices.requestAuthUses }
                    : {}),
                resolveConnectedServiceMaterializedHomeRoot:
                    createConnectedServiceMaterializedHomeRootResolver(params.agentId, connectedServices),
                ...(connectedServices.materializedHomeFreshness
                    ? {
                        getConnectedServiceMaterializedHomeFreshness: async () =>
                            connectedServices.materializedHomeFreshness ?? null,
                    }
                    : {}),
                ...(connectedServices.sanitizeRetainedMaterializedHome
                    ? { sanitizeRetainedConnectedServiceMaterializedHome: connectedServices.sanitizeRetainedMaterializedHome }
                    : {}),
                getConnectedServiceStateSharingDescriptor: async () =>
                    connectedServices.stateSharingDescriptor,
                ...(connectedServices.recoveryCapabilities
                    ? {
                        getConnectedServiceRecoveryCapabilities: async () =>
                            connectedServices.recoveryCapabilities ?? null,
                    }
                    : {}),
                ...(connectedServices.resolveLegacyRuntimeAuthFailureSourceRevision
                    ? {
                        resolveLegacyConnectedServiceRuntimeAuthFailureSourceRevision:
                            connectedServices.resolveLegacyRuntimeAuthFailureSourceRevision,
                    }
                    : {}),
                ...(connectedServices.materializeRuntimeAuthSelection === false
                    ? {}
                    : {
                        materializeConnectedServiceRuntimeAuthSelection:
                            createRuntimeAuthSelectionMaterializer(params.agentId, connectedServices, managedServer, exec)
                            ?? undefined,
                    }),
                ...(runtimeAuthAdapter
                    ? {
                        getConnectedServiceRuntimeAuthAdapter: async () => runtimeAuthAdapter,
                    }
                    : {}),
                ...(connectedServices.daemonAuthBridge
                    ? {
                        getConnectedServiceDaemonAuthBridgeRefresh: async () =>
                            connectedServices.daemonAuthBridge?.refresh ?? null,
                    }
                    : {}),
                ...(connectedServices.quotaFetcherDescriptor
                    ? {
                        getConnectedServiceQuotaFetcherDescriptor: async () =>
                            connectedServices.quotaFetcherDescriptor ?? null,
                    }
                    : {}),
                ...(switchContinuityResolver
                    ? { resolveConnectedServiceSwitchContinuity: switchContinuityResolver }
                    : {}),
                ...(connectedServices.verifyResumeReachable || connectedServices.resolveResumeReachabilityUnsupported
                    ? { verifyResumeReachable: projectedResumeReachability }
                    : {}),
                ...(connectedServices.usageLimitRecovery
                    ? {
                        sessionUsageLimitRecoveryBackoffPolicy: {
                            providerId: connectedServices.usageLimitRecovery.agentId,
                            issueProviderFilter:
                                connectedServices.usageLimitRecovery.issueProviderFilter ?? null,
                            defaultNativeServiceId:
                                connectedServices.usageLimitRecovery.defaultNativeServiceId ?? null,
                            fallbackBackoffEnvKey:
                                connectedServices.usageLimitRecovery.fallbackBackoffEnvKey,
                            maxAttemptsEnvKey:
                                connectedServices.usageLimitRecovery.maxAttemptsEnvKey,
                            defaultFallbackBackoffMs:
                                connectedServices.usageLimitRecovery.defaultFallbackBackoffMs,
                            defaultMaxAttempts:
                                connectedServices.usageLimitRecovery.defaultMaxAttempts,
                        },
                    }
                    : {}),
            }
            : {}),
        ...(connectedServices?.resolveCandidatePersistedSessionFile
            ? {
                resolveConnectedServiceCandidatePersistedSessionFile:
                    connectedServices.resolveCandidatePersistedSessionFile,
            }
            : {}),
        ...(cloudConnect
            ? { getCloudConnectTarget: async () => createCloudConnectTarget(params.agentId, cloudConnect) }
            : {}),
        ...(sessionControls
            ? { normalizeSessionControlPermissionMode: sessionControls.normalizePermissionMode }
            : {}),
        ...(terminal?.transformHeadlessTmuxArgv
            ? { getHeadlessTmuxArgvTransform: async () => terminal.transformHeadlessTmuxArgv! }
            : {}),
        ...(terminal?.promptSubmitVerification
            ? { getTerminalPromptSubmitVerificationPolicy: async () => terminal.promptSubmitVerification! }
            : {}),
        ...(terminal?.retainsSessionHookArtifacts
            ? {
                onTerminalAttachmentRetired: async ({ happyHomeDir, sessionId }) => {
                    const { disposeSessionHookArtifactsForSession } = await import(
                        '@/plugins/runtime/hooks/session/service'
                    );
                    await disposeSessionHookArtifactsForSession({ happyHomeDir, sessionId });
                },
            }
            : {}),
        ...(cliSessionCommand
            ? {
                getCliCommandHandler: createCliSessionCommandHandler(
                    cliSessionCommand,
                    {
                        cliSubcommand: params.agentId,
                        runtimeAuthorityAgentId: params.agentId,
                    },
                ),
            }
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
        ...(sessionStartup
            ? { shouldUseDeferredSessionStartup: sessionStartup.shouldUseDeferredBootstrap }
            : {}),
        ...(sessionStartup?.releasedOverridesCacheV1
            ? { releasedStartupOverridesCacheV1: sessionStartup.releasedOverridesCacheV1 }
            : {}),
        ...(codingPromptBehavior
            ? { resolveCodingPromptBehaviorBlocks: codingPromptBehavior }
            : {}),
        ...(daemonSpawnHooks
            ? { getDaemonSpawnHooks: async () => daemonSpawnHooks }
            : {}),
        ...(sessionHandoff?.agentBundleRecords
            ? {
                getSessionHandoffAgentBundleRecordExtractor: async () =>
                    sessionHandoff.agentBundleRecords?.extract ?? null,
            }
            : {}),
        ...(sessionHandoff?.surface
            ? {
                getHandoffSurface: async () => resolveSessionHandoffSurface(
                    sessionHandoff,
                    (workspaceRoot) => createProviderScopedStableExecService({
                        cwd: workspaceRoot,
                        environment: Object.freeze(Object.fromEntries(
                            Object.entries(process.env).filter(
                                (entry): entry is [string, string] => typeof entry[1] === 'string',
                            ),
                        )),
                        systemTools,
                        agentId: params.agentId,
                        agentCliSystemTool,
                    }),
                ),
            }
            : {}),
        ...(sessionHandoff?.resolveReplayChildLaunch
            ? { resolveReplayChildLaunch: sessionHandoff.resolveReplayChildLaunch }
            : {}),
        ...(sessionHandoff?.runtimeLocalMetadata
            ? { buildRuntimeLocalHandoffMetadata: sessionHandoff.runtimeLocalMetadata.build }
            : {}),
        ...(managedServer
            ? {
                getManagedServerLaunchSpec: async () => {
                    const { requireAgentCliLaunchSpec } = await import(
                        '@/packagedRuntime/managedTools/requireAgentCliLaunchSpec'
                    );
                    return requireAgentCliLaunchSpec(params.agentId);
                },
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
                getProviderAttachOps: async () => {
                    const { createProviderCliAttachOps } = await import(
                        '@/session/attach/providerCliAttach'
                    );
                    return createProviderCliAttachOps({
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
                    });
                },
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
                                    createPreflightContributionProbeParams(
                                        probeParams,
                                        'models',
                                        systemTools,
                                        params.agentId,
                                        agentCliSystemTool,
                                    ),
                                ),
                        }
                        : {}),
                    ...(preflightSessionControls.probeModesRaw
                        ? {
                            probeModesRaw: async (probeParams: PreflightSessionControlsProbeParams) =>
                                await preflightSessionControls.probeModesRaw!(
                                    createPreflightContributionProbeParams(
                                        probeParams,
                                        'modes',
                                        systemTools,
                                        params.agentId,
                                        agentCliSystemTool,
                                    ),
                                ),
                        }
                        : {}),
                    ...(preflightSessionControls.probeConfigOptionsRaw
                        ? {
                            probeConfigOptionsRaw: async (probeParams: PreflightSessionControlsProbeParams) =>
                                await preflightSessionControls.probeConfigOptionsRaw!(
                                    createPreflightContributionProbeParams(
                                        probeParams,
                                        'configOptions',
                                        systemTools,
                                        params.agentId,
                                        agentCliSystemTool,
                                    ),
                                ),
                        }
                        : {}),
                }),
            }
            : {}),
        });
    };
}

export function applyAgentCatalogEntryHooks(
    contribution: ResolvedAgentContribution,
    hooksByAgentId: Readonly<Record<string, AgentCatalogHookFactory>>,
): ResolvedAgentContribution {
    const createHooks = hooksByAgentId[contribution.id];
    if (!createHooks || !contribution.catalogEntry) return contribution;
    return Object.freeze({
        ...contribution,
        catalogEntry: Object.freeze({
            ...contribution.catalogEntry,
            ...createHooks(),
        }),
    });
}

export const releaseManagedAgentServerForSwitchFromState = releaseManagedServerForSwitchFromState;
