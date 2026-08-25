import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { rm } from 'node:fs/promises';

import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import type { PluginPath } from '@happier-dev/plugin-sdk';
import { getAgentCliRuntimeSpec } from '@happier-dev/agents/cli/runtime';
import { isBundledAgentId } from '@happier-dev/agents/agent-ids';
import {
    resolveConnectedAccountRequestAuthCapabilityPath,
} from '@happier-dev/agents/request-auth';
import { resolveConnectedServicesProviderStateSharingPolicyV1 } from '@happier-dev/protocol/account/settings/connected-services';
import { ConnectedAccountRequestAuthUsesV1Schema } from '@happier-dev/protocol/connect/connected-account-request-auth';
import { ConnectedServiceIdSchema, type ConnectedServiceId } from '@happier-dev/protocol/connect/connected-service-bindings';
import { readConnectedServiceLimitCategoryV1 } from '@happier-dev/protocol/connect/connected-service-limit-category';
import { type ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol/connect/connected-service-schemas';
import { type InstallableDependencyDescriptor } from '@happier-dev/protocol/installables';
import { type PluginSystemToolContributionV1 } from '@happier-dev/protocol/plugins/contributions/system-tools';

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
    VendorResumeSupportLevel,
} from '@/agent/catalog/types';
import type { TerminalPromptSubmitVerificationPolicy } from '@/integrations/terminalHost/promptSubmitVerification';
import {
    isCloudConnectAuthenticateResultV1,
    type AuthCredentialWriteInput,
    type AuthCredentialWriteResult,
    type AuthDiagnostic,
    type AuthFailureCode,
    type AuthLoopbackInput,
    type AuthLoopbackResult,
    type AuthOpenBrowserResult,
    type AuthPromptTextInput,
    type AuthPromptTextResult,
    type CloudConnectAuthenticateOptions,
    type AuthenticateResult,
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
    resolveConnectedServiceGroupHomeDir,
    resolveConnectedServiceHomeDir,
} from '@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir';
import {
    createRetainedConnectedServicesMaterialization,
    type ConnectedServiceMaterializationCredentialRefreshFailureCategory,
    type ConnectedServicesMaterializationDiagnostic,
    type ConnectedServicesMaterializer,
} from '@/daemon/connectedServices/materialization/materializer';
import {
    ensurePrivateConnectedServiceMaterializedRoot,
} from '@/daemon/connectedServices/materialize/privateMaterializedRoot';
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
import {
    withConnectedServiceStateSharingDestinationLock,
    withConnectedServiceStateSharingLocks,
} from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingLock';
import {
    readConnectedServiceStateSharingManifest,
    writeConnectedServiceStateSharingManifest,
} from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';
import { configuration } from '@/configuration';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import {
    readSessionHandoffContribution,
} from './sessionHandoffContribution';
import { projectPluginSystemToolContributions } from '@/plugins/runtime/exec/system/tools/definitions';
import {
    createAgentCliSystemToolService,
    type AgentCliSystemToolBinding,
} from '@/plugins/runtime/exec/system/tools/agentCliBinding';
import { createPluginExecSystemToolResolver } from '@/plugins/runtime/exec/system/tools/resolveGrant';
import { promptInput, promptSecretInput } from '@/terminal/prompts/promptInput';
import { openBrowser } from '@/ui/openBrowser';

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

const VENDOR_RESUME_SUPPORT_LEVELS: ReadonlySet<string> = new Set<VendorResumeSupportLevel>([
    'supported',
    'unsupported',
    'experimental',
]);

function readVendorResumeSupportLevel(value: unknown): VendorResumeSupportLevel | null {
    return typeof value === 'string' && VENDOR_RESUME_SUPPORT_LEVELS.has(value)
        ? value as VendorResumeSupportLevel
        : null;
}

/**
 * Projects the one bounded daemon-spawn hook contract onto a catalog entry.
 * Both declarative bundled contributions and activation-registered Agent
 * runtimes use this exact catalog seam.
 */
export function projectAgentDaemonSpawnHooksCatalogEntry(
    daemonSpawnHooks: DaemonSpawnHooks,
): Pick<ResolvedCatalogEntry, 'getDaemonSpawnHooks'> {
    return Object.freeze({
        getDaemonSpawnHooks: async () => daemonSpawnHooks,
    });
}

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
        hotApply: async (input) => await run(input, async () => {
            const currentness = await input.validateCurrentBeforeMutation?.();
            if (currentness?.current === false) {
                return {
                    applied: false,
                    ...(currentness.authoritativeTarget
                        ? {
                            status: 'superseded_after_apply',
                            activeProfileId: currentness.authoritativeTarget.profileId,
                            generation: currentness.authoritativeTarget.generation,
                            credentialRevision: currentness.authoritativeTarget.credentialRevision,
                        }
                        : {}),
                    reason: currentness.reason,
                    recovery: 'none',
                };
            }
            return await adapter.hotApply(input);
        }),
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
    const daemonAuthBridgeServiceIds = readConnectedServiceIdArray(daemonAuthBridge?.serviceIds);
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
        ...(daemonAuthBridgeRefresh && daemonAuthBridgeServiceIds.length > 0
            ? {
                daemonAuthBridge: {
                    serviceIds: daemonAuthBridgeServiceIds,
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
    const probePassiveRealtimeSetupRaw = readFunction<NonNullable<PreflightSessionControlsContribution['probePassiveRealtimeSetupRaw']>>(
        value.probePassiveRealtimeSetupRaw,
    );
    const cliModelsCommandArgs = readStringArray(value.cliModelsCommandArgs);
    const verboseModelsCommandArgs = readStringArray(value.verboseModelsCommandArgs);
    return {
        ...(value.connectedServiceAuth === 'materialized-env'
            ? { connectedServiceAuth: 'materialized-env' as const }
            : {}),
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
        ...(probePassiveRealtimeSetupRaw ? { probePassiveRealtimeSetupRaw } : {}),
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
    const shouldVerifyAfterSubmit = readFunction<TerminalPromptSubmitVerificationPolicy['shouldVerifyAfterSubmit']>(
        value.shouldVerifyAfterSubmit,
    );
    const verifyBeforeSubmitStaging = readFunction<NonNullable<TerminalPromptSubmitVerificationPolicy['verifyBeforeSubmitStaging']>>(
        value.verifyBeforeSubmitStaging,
    );
    const verifyAfterSubmit = readFunction<TerminalPromptSubmitVerificationPolicy['verifyAfterSubmit']>(
        value.verifyAfterSubmit,
    );
    if (!shouldVerifyAfterSubmit || !verifyAfterSubmit) {
        return null;
    }
    return {
        shouldVerifyAfterSubmit,
        ...(verifyBeforeSubmitStaging ? { verifyBeforeSubmitStaging } : {}),
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
    const agentIdForAccountSettings = readString(value.agentIdForAccountSettings) ?? defaultAgentId;
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
        agentIdForAccountSettings,
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
    stateSharingPolicy: ReturnType<typeof resolveConnectedServicesProviderStateSharingPolicyV1>;
    sessionDirectory?: string | null;
}>): Promise<Readonly<{
    diagnostics: readonly ConnectedServicesMaterializationDiagnostic[];
    effectiveStateMode: 'isolated' | 'shared';
}>> {
    const resolveStateSharingSourceRoot = params.connectedServices.resolveStateSharingSourceRoot;
    const providerLabel = String(params.agentId);
    if (!resolveStateSharingSourceRoot) {
        return { diagnostics: [], effectiveStateMode: params.stateSharingPolicy.stateMode };
    }
    if (
        params.connectedServices.stateSharingServiceIds
        && !params.connectedServices.stateSharingServiceIds.includes(params.serviceId)
    ) {
        return { diagnostics: [], effectiveStateMode: params.stateSharingPolicy.stateMode };
    }
    const settings = params.stateSharingPolicy;
    const sourceRoot = resolveStateSharingSourceRoot({ env: params.env });
    const stateSourceRoot = readString(params.stateSourceRoot) ?? sourceRoot;
    const lockRoots = settings.stateMode === 'shared'
        ? [params.materializedRootDir, sourceRoot, stateSourceRoot]
        : [params.materializedRootDir];
    return await withConnectedServiceStateSharingLocks(lockRoots, async () => {
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
        if (settings.stateMode === 'shared') {
            await params.connectedServices.reconcileStateSharingSource?.({
                sourceRoot: stateSourceRoot,
                materializedRootDir: params.materializedRootDir,
            });
        }
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
    exec: ExecService,
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
        rootDir,
        recordsByServiceId,
        selectionsByServiceId,
        connectedAccountMaterializationAuthority,
        accountSettings,
        processEnv,
        sessionDirectory,
    }) => {
        const materializationInput: Record<string, unknown> = {};
        const requestAuthPurposeBindings = connectedAccountMaterializationAuthority.kind === 'qualified'
            ? connectedAccountMaterializationAuthority.requestAuthPurposeBindings
            : [];
        let primaryRecord: CredentialRecord | null = null;
        let primaryServiceId: ConnectedServiceId | null = null;

        for (const serviceId of connectedServices.serviceIds) {
            const record = selectionsByServiceId?.get(serviceId)?.record ?? recordsByServiceId.get(serviceId) ?? null;
            if (!record) continue;
            if (connectedAccountMaterializationAuthority.kind === 'legacy_unfenced_one_shot') {
                mergeAuthMaterializationInput(
                    materializationInput,
                    connectedServices.createAuthMaterializationInput(serviceId, record),
                );
            }
            primaryRecord ??= record;
            primaryServiceId ??= serviceId;
        }

        if (!primaryRecord || !primaryServiceId) return null;
        const stateSharingPolicy = resolveConnectedServicesProviderStateSharingPolicyV1(
            accountSettings?.connectedServicesProviderStateSharingSettingsV1,
            agentId,
        );
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
        await ensurePrivateConnectedServiceMaterializedRoot(materializedRootDir);

        const env = processEnv ?? process.env;
        // Thread group-bound selections' groupIds to the plugin materializer so runtime-auth
        // selection identities can be pool-scoped (without generation) at the single owner.
        const connectedServiceGroupIdsByServiceId = Object.fromEntries(
            [...(selectionsByServiceId?.entries() ?? [])]
                .flatMap(([serviceId, selection]) => selection.kind === 'group' ? [[serviceId, selection.groupId] as const] : []),
        );
        const materializationContext = {
            ...materializationInput,
            connectedAccountMaterializationAuthority:
                connectedAccountMaterializationAuthority.kind,
            ...(Object.keys(connectedServiceGroupIdsByServiceId).length > 0
                ? { connectedServiceGroupIdsByServiceId }
                : {}),
            rootDir: materializedRootDir,
            processEnv: env,
            connectedServicesSessionStateSharingRequested: stateSharingPolicy.stateMode === 'shared',
            sessionDirectory: sessionDirectory ?? null,
            exec,
            ...(requestAuthPurposeBindings.length
                ? {
                    requestAuth: Object.freeze({
                        purposeBindings: requestAuthPurposeBindings,
                        capabilityPath:
                            resolveConnectedAccountRequestAuthCapabilityPath(
                                rootDir,
                            ),
                    }),
                }
                : {}),
        };
        const stateSharing = await applyConnectedServiceStateSharingForContribution({
            agentId,
            connectedServices,
            serviceId: primaryServiceId,
            materializedRootDir,
            env,
            stateSharingPolicy,
            sessionDirectory: sessionDirectory ?? null,
        });
        const materialized = await connectedServices.materializeAuthEnvironment({
            ...materializationContext,
            connectedServicesSessionStateSharingEffectiveMode: stateSharing.effectiveStateMode,
            materializationId: materializationKey,
        });

        return {
            ...createRetainedConnectedServicesMaterialization({
                rootDir: materializedRootDir,
                env: materialized.env,
            }),
            ...(requestAuthPurposeBindings.length
                ? { requestAuthMaterializedRoot: rootDir }
                : {}),
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

    let pasted: string;
    if (timeoutMs === undefined) {
        pasted = await promptInput('Paste redirect URL: ');
    } else {
        const promptAbortController = new AbortController();
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            promptAbortController.abort();
        }, timeoutMs);
        try {
            pasted = await promptInput('Paste redirect URL: ', { signal: promptAbortController.signal });
        } catch (error) {
            if (timedOut) throw new Error('Authentication timed out');
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

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

function sanitizeCloudAuthDiagnostic(value: unknown): AuthDiagnostic | null {
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

function sanitizeCloudAuthDiagnostics(values: unknown): readonly AuthDiagnostic[] {
    if (!Array.isArray(values)) return [];
    return values.flatMap((value) => {
        const diagnostic = sanitizeCloudAuthDiagnostic(value);
        return diagnostic ? [diagnostic] : [];
    });
}

function readCloudAuthFailureCode(value: unknown): AuthFailureCode {
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
    first: readonly AuthDiagnostic[],
    second: readonly AuthDiagnostic[],
): readonly AuthDiagnostic[] | undefined {
    const merged = [...first, ...second];
    return merged.length > 0 ? merged : undefined;
}

function sanitizeCloudConnectAuthenticateResult(
    value: unknown,
    contextDiagnostics: readonly AuthDiagnostic[],
): AuthenticateResult {
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

function createUnsupportedCredentialWriteResult(): AuthCredentialWriteResult {
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

function createCancelledPromptResult(): AuthPromptTextResult {
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
    diagnostics: readonly AuthDiagnostic[];
}> {
    const diagnostics: AuthDiagnostic[] = [];
    const signal = opts.signal ?? new AbortController().signal;
    const fetchRuntime = createGlobalFetchRuntime();
    const credentialWriter = opts.hostServices?.credentials?.write;
    const pushDiagnostic = (input: AuthDiagnostic) => {
        const sanitized = sanitizeCloudAuthDiagnostic(input);
        if (sanitized) diagnostics.push(sanitized);
    };
    const cancelled = () => signal.aborted;
    const requestPromptText = async (
        input: AuthPromptTextInput,
        options: Readonly<{ signal?: AbortSignal }> = {},
    ): Promise<AuthPromptTextResult> => {
        const promptSignal = options.signal ?? signal;
        const promptCancelled = () => cancelled() || promptSignal.aborted;
        if (promptCancelled()) return createCancelledPromptResult();
        const label = input.label.trim();
        if (!label) {
            return {
                ok: false,
                code: 'unsupported',
                diagnostics: [{ code: 'missing_prompt_label' }],
            };
        }
        try {
            const value = await (input.secret
                ? promptSecretInput(label)
                : promptInput(label, { signal: promptSignal }));
            if (promptCancelled()) return createCancelledPromptResult();
            return { ok: true, value };
        } catch (error) {
            if (promptCancelled()) return createCancelledPromptResult();
            throw error;
        }
    };
    const callbackService = createCloudAuthCallbackService({
        signal,
        promptText: async (label, options) => {
            const result = await requestPromptText({ label }, options);
            if (result.ok) return result.value;
            const diagnostic = result.diagnostics?.[0]?.code ?? result.code;
            throw new Error(diagnostic);
        },
    });

    const context: CloudCustomAuthenticatorContextV1 = Object.freeze({
        signal,
        now: () => Date.now(),
        fetch: Object.freeze({
            request: async (
                request: Parameters<HttpService['request']>[0],
                options: Parameters<HttpService['request']>[1] = {},
            ) => await fetchRuntime.request(request, {
                signal: options.signal ?? signal,
            }),
        }),
        browser: Object.freeze({
            open: async (url: string): Promise<AuthOpenBrowserResult> => {
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
            listenForCallback: async (input: AuthLoopbackInput): Promise<AuthLoopbackResult> => {
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
            write: async (input: AuthCredentialWriteInput): Promise<AuthCredentialWriteResult> => {
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
}>): ExecService {
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
    const systemTools = params.agentId
        && isBundledAgentId(params.agentId)
        && params.agentCliSystemTool
        && boundDefinition
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
): ExecService {
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
    const vendorResumeSupportLevel = readVendorResumeSupportLevel(
        params.contribution.vendorResumeSupport?.support,
    );
    const resolvePetDiscoveryHomePath = readFunction<NonNullable<ResolvedCatalogEntry['resolvePetDiscoveryHomePath']>>(
        params.contribution.petDiscovery?.resolveHomePath,
    );
    const resolvePetDiscoveryHomeEntries = readFunction<NonNullable<ResolvedCatalogEntry['resolvePetDiscoveryHomeEntries']>>(
        params.contribution.petDiscovery?.resolveHomeEntries,
    );
    const matchesRuntimeInstallableDescriptor = readFunction<(
        descriptor: InstallableDependencyDescriptor,
    ) => boolean>(params.contribution.runtimeInstallableAdapter?.matchesDescriptor);
    const resolveRuntimeInstallableSpawnSpec = readFunction<(
        opts?: Readonly<{ env?: NodeJS.ProcessEnv }>,
        deps?: Readonly<{
            resolveExistingManagedBinPath?: (env?: NodeJS.ProcessEnv) => string | null;
        }>,
    ) => { command: string; args: readonly string[] }>(
        params.contribution.runtimeInstallableAdapter?.resolveSpawnSpec,
    );
    const validateRuntimeInstallableAvailability = readFunction<(
        spec: Readonly<{ command: string; args: readonly string[] }>,
        opts?: Readonly<{ env?: NodeJS.ProcessEnv }>,
    ) => Readonly<{ ok: true } | { ok: false; errorMessage: string }>>(
        params.contribution.runtimeInstallableAdapter?.validateAvailability,
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
        // An Agent's baseline CLI detect and auth spec are always projected from its
        // declared manifest CLI metadata by `createManifestAgentCatalogEntry`, for
        // bundled and installed Agents alike. Only a plugin that owns bespoke probe
        // logic overrides the spec here, and that override is reachable through the
        // same declaration seam an external Agent uses.
        ...(cliAuth
            ? {
                getCliAuthSpec: async () => {
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
                },
            }
            : {}),
        ...(connectedServices
            ? {
                getConnectedServicesMaterializer: async () =>
                    createConnectedServicesMaterializer(params.agentId, connectedServices, exec),
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
                ...(runtimeAuthAdapter
                    ? {
                        getConnectedServiceRuntimeAuthAdapter: async () => runtimeAuthAdapter,
                    }
                    : {}),
                ...(connectedServices.daemonAuthBridge
                    ? {
                        getConnectedServiceDaemonAuthBridgeRefresh: async (serviceId: ConnectedServiceId) =>
                            connectedServices.daemonAuthBridge?.serviceIds.includes(serviceId) === true
                                ? connectedServices.daemonAuthBridge.refresh
                                : null,
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
        ...(vendorResumeSupportLevel
            ? { vendorResumeSupport: vendorResumeSupportLevel }
            : {}),
        ...(vendorResumeSupport
            ? { getVendorResumeSupport: async () => vendorResumeSupport }
            : {}),
        ...(checklists
            ? { checklists }
            : {}),
        ...(resolvePetDiscoveryHomePath
            ? { resolvePetDiscoveryHomePath }
            : {}),
        ...(resolvePetDiscoveryHomeEntries
            ? { resolvePetDiscoveryHomeEntries }
            : {}),
        ...(matchesRuntimeInstallableDescriptor
            && resolveRuntimeInstallableSpawnSpec
            && validateRuntimeInstallableAvailability
            ? {
                getRuntimeInstallableAdapter: async (descriptor: InstallableDependencyDescriptor) => {
                    if (!matchesRuntimeInstallableDescriptor(descriptor)) return null;
                    const { createCodexAcpRuntimeInstallableAdapter } = await import(
                        '@/packagedRuntime/installables/sourceAdapters/codexAcpRuntimeInstallable'
                    );
                    return createCodexAcpRuntimeInstallableAdapter(descriptor, {
                        resolveSpawnSpec: resolveRuntimeInstallableSpawnSpec,
                        validateAvailability: validateRuntimeInstallableAvailability,
                    });
                },
            }
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
            ? projectAgentDaemonSpawnHooksCatalogEntry(daemonSpawnHooks)
            : {}),
        ...(sessionHandoff?.agentBundleRecords
            ? {
                getSessionHandoffAgentBundleRecordExtractor: async () =>
                    sessionHandoff.agentBundleRecords?.extract ?? null,
            }
            : {}),
        ...(sessionHandoff?.runtimeLocalMetadata
            ? { buildRuntimeLocalHandoffMetadata: sessionHandoff.runtimeLocalMetadata.build }
            : {}),
        ...(sessionHandoff?.nativeSessionLog
            ? { resolveAgentNativeSessionLogPath: sessionHandoff.nativeSessionLog.resolvePath }
            : {}),
        ...(attach
            ? {
                resolveHostAgentRuntimeSurfaces: async () => {
                    const { createProviderCliAttachSurface } = await import(
                        '@/session/attach/providerCliAttach'
                    );
                    return Object.freeze({
                        attach: createProviderCliAttachSurface({
                            agentId: params.agentId,
                            resolveTarget: ({ metadata, fallbackServerBaseUrl }) => {
                                const target = attach.resolveTarget({ metadata, fallbackServerBaseUrl });
                                return isRecord(target) && target.ok === true
                                    ? { ok: true, value: target }
                                    : { ok: false, reason: readString(isRecord(target) ? target.reason : null) ?? 'Unable to resolve provider attach target.' };
                            },
                            createArgs: (target) => attach.createArgs(target),
                            buildHealthUrl: (target) => attach.buildHealthUrl(String(target.baseUrl ?? '')),
                        }),
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
                    ...(preflightSessionControls.connectedServiceAuth
                        ? { connectedServiceAuth: preflightSessionControls.connectedServiceAuth }
                        : {}),
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
                    ...(preflightSessionControls.probePassiveRealtimeSetupRaw
                        ? {
                            probePassiveRealtimeSetupRaw: async (probeParams: PreflightSessionControlsProbeParams) =>
                                await preflightSessionControls.probePassiveRealtimeSetupRaw!(
                                    createPreflightContributionProbeParams(
                                        probeParams,
                                        'passiveRealtimeSetup',
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
