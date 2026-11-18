import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import { isAbsolute } from 'node:path';
import { resolveAgentNativeTranscriptPathFromSessionMetadata } from '@happier-dev/agents';
import { findCatalogEntry } from '@/agent/catalog/registry';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { isCustomAcpAgentContributionIdentityV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { isSessionResumeSupported } from '@/session/runtime/resumeSupport';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import { logger } from '@/ui/logger';
import type { TeamCredentialLaunchFailureCode, TeamCredentialLaunchFailurePhase } from '@/session/services/sessionTeamCredentialLaunchError';

import type {
    SpawnSessionOptions,
    SpawnSessionResult,
} from '@/session/shared/spawnSessionContract';
import { readCanonicalSpawnRuntimeSelection } from '@/rpc/handlers/spawnRuntimeSelection';
import {
    SPAWN_SESSION_ERROR_CODES,
} from '@/session/shared/spawnSessionContract';
import {
    PersistedProviderResumeBindingError,
    readPersistedProviderResumeState,
} from '@/providers/lifecycle/readPersistedResumeSelection';
import { resolveSpawnBackendIdentity } from '../spawn/resolveSpawnBackendIdentity';
import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';
import { resolveDaemonStartupSourceFromEnv } from '@/daemon/ownership/daemonOwnershipMetadata';
import { resolveDarwinBackgroundServiceSpawnDirectoryFailure } from '../spawn/resolveDarwinBackgroundServiceSpawnDirectoryFailure';
import { applyInitialTranscriptAfterSeqToAttachPayload } from '../sessionEncryption/applyInitialTranscriptAfterSeqToAttachPayload';
import { buildProviderSpawnErrorResult } from '../spawn/buildProviderSpawnErrorResult';
import { AcpCatalogUnavailableError, resolveConfiguredAcpBackendFromAccountSettings } from '@/agent/acp/catalog/configured/resolveBackend';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { resolvePreparedSessionDirectory } from './resolvePreparedSessionDirectory';
import { resolveSessionMemoryCeilingBytes } from '../platform/linux/sessionMemoryCeiling';
import { resolveSessionRuntimeSnapshot } from '../sessions/runtimeSnapshot/resolveSessionRuntimeSnapshot';
import { projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { readSessionSpawnModelChoice } from '@/session/creation/readSessionSpawnModelChoice';
import { readAgentDefaultModelSelectionV1 } from '@happier-dev/protocol/providers/selection/v1';
import {
    ConnectedServicesDefaultUnavailableError,
    createCredentialsSpawnConnectedServicesTeamResourceCatalogResolver,
    mergeSessionTeamCredentialBindingIntents,
    resolveSessionSpawnConnectedServicesDefaultsPayload,
} from '@/session/services/spawnConnectedServicesDefaults';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';

/**
 * A requested Agent that is not installed in the current catalog is an invalid
 * spawn request, reported through the existing spawn error vocabulary rather
 * than as an escaping `CatalogAgentNotInstalledError`.
 */
function buildAgentNotInstalledSpawnErrorResult(agentId: string): SpawnSessionResult {
    return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: `Agent '${agentId}' is not installed or unavailable in the current Agent catalog`,
    };
}

type BackendIdentitySuccess = Extract<
    Awaited<ReturnType<typeof resolveSpawnBackendIdentity>>,
    { ok: true }
>;

export type PreparedExecuteSpawnSessionRequest = Readonly<{
    memoryHighBytes: number | null;
    normalizedExistingSessionId: string;
    effectiveResume: string;
    candidatePersistedSessionFile?: string | null;
    effectiveBackendTargetV2: BackendIdentitySuccess['effectiveBackendTargetV2'];
    sessionAttachPayload: BackendIdentitySuccess['sessionAttachPayload'];
    catalogAgentId: CatalogAgentId | null;
    daemonSpawnHooks: DaemonSpawnHooks | null;
    environmentVariablesValidation: Readonly<{
        ok: true;
        env: Record<string, string>;
    }>;
    persistedProviderResumeState: ReturnType<typeof readPersistedProviderResumeState>;
}> & Pick<
    SpawnSessionOptions,
    | 'directory'
    | 'directoryKind'
    | 'sessionCreationTag'
    | 'sessionId'
    | 'existingSessionId'
    | 'profileId'
    | 'permissionMode'
    | 'permissionModeUpdatedAt'
    | 'agentModeId'
    | 'agentModeUpdatedAt'
    | 'modelSelection'
    | 'runtimeDescriptorV1'
    | 'connectedServices'
    | 'connectedServicesUpdatedAt'
    | 'connectedServiceMaterializationIdentityV1'
    | 'teamCredentialBindings'
>;

export type PrepareExecuteSpawnSessionRequestInput = Readonly<{
    readMachineResourcesPolicy?: import('@/processes/toolIdleTimeouts').MachineResourcesPolicyReader;
    options: SpawnSessionOptions;
    /** Account snapshot admitted by the daemon caller; never read from ambient UI/global state. */
    accountSettings?: Readonly<Record<string, unknown>>;
    acpCatalogSnapshot?: AcpCatalogSnapshotV1;
    /** The captured Account caller owns async hydration and custody, not this admission projection. */
    readAcpCatalogSnapshot?(): Promise<AcpCatalogSnapshotV1>;
    credentials: NonNullable<Parameters<typeof resolveSpawnBackendIdentity>[0]['credentials']>;
    operationContext?: SavedSecretOperationContextV1;
}>;

export async function prepareExecuteSpawnSessionRequest(
    params: Readonly<{
        request: PrepareExecuteSpawnSessionRequestInput;
        onTeamCredentialRefusal?: (refusal: Readonly<{
            code: TeamCredentialLaunchFailureCode; phase: TeamCredentialLaunchFailurePhase;
        }>) => void;
        validateEnvVarRecordStrict: (value: unknown) => Readonly<
            | {
                ok: true;
                env: Record<string, string>;
            }
            | {
                ok: false;
                error: string;
            }
        >;
    }>,
): Promise<PreparedExecuteSpawnSessionRequest | SpawnSessionResult> {
    const { options } = params.request;
    const environmentVariableCount = options.environmentVariables && typeof options.environmentVariables === 'object'
        ? Object.keys(options.environmentVariables as Record<string, unknown>).length
        : 0;
    const environmentVariablesValidation = params.validateEnvVarRecordStrict(options.environmentVariables);
    logger.debugLargeJson('[DAEMON RUN] Preparing session spawn', {
        approvedNewDirectoryCreation: options.approvedNewDirectoryCreation,
        hasSessionId: typeof options.sessionId === 'string' && options.sessionId.trim().length > 0,
        hasExistingSessionId: typeof options.existingSessionId === 'string'
            && options.existingSessionId.trim().length > 0,
        hasMachineId: typeof options.machineId === 'string' && options.machineId.trim().length > 0,
        hasBackendTarget: options.backendTarget !== undefined,
        hasAgentTarget: options.agentTarget !== undefined,
        hasProfileId: typeof options.profileId === 'string' && options.profileId.trim().length > 0,
        hasInitialTranscriptAfterSeq: typeof options.initialTranscriptAfterSeq === 'number',
        hasResume: typeof options.resume === 'string' && options.resume.trim().length > 0,
        hasWindowsRemoteSessionLaunchMode: options.windowsRemoteSessionLaunchMode !== undefined,
        hasWindowsRemoteSessionConsole: options.windowsRemoteSessionConsole !== undefined,
        environmentVariableCount,
        environmentVariablesValid: environmentVariablesValidation.ok,
    });

    if (!environmentVariablesValidation.ok) {
        return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_ENVIRONMENT_VARIABLES,
            errorMessage: environmentVariablesValidation.error,
        };
    }

    const {
        sessionId,
        resume,
        existingSessionId,
        agentTarget,
        backendTarget,
    } = options;
    const normalizedResume = readNonBlankOpaqueIdentifier(resume) ?? '';

    const backendIdentityResolution = await resolveSpawnBackendIdentity({
        existingSessionId: typeof existingSessionId === 'string' ? existingSessionId : '',
        resume: normalizedResume,
        agentTarget,
        backendTarget,
        credentials: params.request.credentials,
    });
    if (!backendIdentityResolution.ok) {
        return backendIdentityResolution.error;
    }

    const {
        normalizedExistingSessionId,
        effectiveResume,
        effectiveBackendTargetV2,
        effectiveAgentTarget,
        sessionAttachPayload,
        catalogAgentId,
        ownerMetadata,
        existingSessionWorkspacePath,
    } = backendIdentityResolution;
    const { directory, directoryKind, sessionCreationTag } = resolvePreparedSessionDirectory({
        options, normalizedExistingSessionId, ownerMetadata, existingSessionWorkspacePath,
    });
    let persistedProviderResumeState: ReturnType<typeof readPersistedProviderResumeState>;
    const attachSnapshot = sessionAttachPayload?.snapshot;
    const persistedMetadata = ownerMetadata && attachSnapshot
        ? projectSessionOwnerCompatibilityViewV1({ sharedMetadata: attachSnapshot.metadata, ownerMetadata })
        : attachSnapshot?.metadata ?? null;
    try {
        persistedProviderResumeState = readPersistedProviderResumeState(persistedMetadata);
    } catch (error) {
        if (!(error instanceof PersistedProviderResumeBindingError)) throw error;
        return buildProviderSpawnErrorResult(error.providerError);
    }
    const effectiveSessionAttachPayload = sessionAttachPayload
        ? applyInitialTranscriptAfterSeqToAttachPayload(sessionAttachPayload, options.initialTranscriptAfterSeq)
        : sessionAttachPayload;
    // The catalog is read live, so an Agent installed when the backend target was
    // resolved can be gone by now. That is a request-level refusal, not an
    // exception that unwinds the daemon spawn path.
    const catalogEntry = catalogAgentId ? findCatalogEntry(catalogAgentId) : null;
    if (catalogAgentId && !catalogEntry) {
        return buildAgentNotInstalledSpawnErrorResult(catalogAgentId);
    }
    const daemonSpawnHooks = catalogEntry?.getDaemonSpawnHooks
        ? await catalogEntry.getDaemonSpawnHooks()
        : null;

    let runtimeSelection: ReturnType<typeof readCanonicalSpawnRuntimeSelection>;
    try {
        runtimeSelection = readCanonicalSpawnRuntimeSelection({
            ...options,
            ...(ownerMetadata?.nativeSession?.runtimeDescriptorV1
                ? { runtimeDescriptorV1: ownerMetadata.nativeSession.runtimeDescriptorV1 }
                : {}),
            ...(catalogAgentId ? { agentId: catalogAgentId } : {}),
        });
        if (effectiveAgentTarget?.definitionId && catalogAgentId) {
            const existingDescriptor = runtimeSelection.runtimeDescriptorV1;
            if (existingDescriptor?.agent.definitionId !== undefined
                && existingDescriptor.agent.definitionId !== effectiveAgentTarget.definitionId) {
                throw new Error('Selected ACP definition does not match the runtime descriptor');
            }
            runtimeSelection = { runtimeDescriptorV1: {
                ...(existingDescriptor ?? { v: 1 as const, agentId: catalogAgentId }),
                agent: { ...existingDescriptor?.agent, definitionId: effectiveAgentTarget.definitionId },
            } };
        }
    } catch (error) {
        return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
            errorMessage: error instanceof Error ? error.message : 'Invalid runtime descriptor',
        };
    }

    const contributionIdentity = catalogAgentId
        ? readAgentCatalogSnapshot().agentDefinitionsById.get(catalogAgentId)?.identity : undefined;
    const descriptorDefinitionId = runtimeSelection.runtimeDescriptorV1?.agent.definitionId;
    const configuredBackendId = effectiveAgentTarget?.definitionId
        ?? (contributionIdentity && isCustomAcpAgentContributionIdentityV1(contributionIdentity)
            && typeof descriptorDefinitionId === 'string' ? descriptorDefinitionId : null);
    if (contributionIdentity && isCustomAcpAgentContributionIdentityV1(contributionIdentity)
        && configuredBackendId === null) {
        return {
            type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
            errorMessage: 'Custom ACP Agent requires a configured definition selection.',
        };
    }
    let configuredBackend: ReturnType<typeof resolveConfiguredAcpBackendFromAccountSettings> = null;
    if (configuredBackendId !== null) {
        try {
            const catalog = params.request.readAcpCatalogSnapshot
                ? await params.request.readAcpCatalogSnapshot() : params.request.acpCatalogSnapshot;
            configuredBackend = resolveConfiguredAcpBackendFromAccountSettings(
                params.request.accountSettings ?? {}, configuredBackendId, catalog,
            );
        } catch (error) {
            if (!(error instanceof AcpCatalogUnavailableError)) throw error;
            return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST, errorMessage: error.message };
        }
        if (!configuredBackend) return {
            type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
            errorMessage: `Configured ACP backend '${configuredBackendId}' is unavailable.`,
        };
    }
    if (effectiveResume) {
        if (configuredBackendId !== null) {
            // The declared contribution's selected Account definition owns
            // load-session support, not a per-definition Agent identity.
            // The resume token is the provider Session id, and attach metadata
            // (when rejoining) has already established generation/materialization
            // correspondence. Unsupported or unavailable declarations fail closed.
            if (!await isSessionResumeSupported({ agentId: catalogAgentId, configuredBackend })) {
                return {
                    type: 'error',
                    errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
                    errorMessage: `Resume is not supported for configured ACP backend '${configuredBackendId}'.`,
                };
            }
        }
        if (!catalogAgentId) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Unknown backend target',
            };
        }
        if (configuredBackendId === null) {
            const ok = await isSessionResumeSupported({
                agentId: catalogAgentId,
                ...(runtimeSelection.runtimeDescriptorV1
                    ? { runtimeDescriptorV1: runtimeSelection.runtimeDescriptorV1 }
                    : {}),
            });
            if (!ok) {
                const supportLevel = catalogEntry?.vendorResumeSupport ?? null;
                const qualifier = supportLevel === 'experimental' ? ' (experimental and not enabled)' : '';
                return {
                    type: 'error',
                    errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
                    errorMessage: `Resume is not supported for agent '${catalogAgentId}'${qualifier}.`,
                };
            }
        }
    }

    // Creating the requested workspace is the first irreversible step of
    // admission, so it belongs after every definitive refusal the daemon can
    // already establish — including the Provider decision, which the caller
    // reaches next. Only side-effect-free validation runs here.
    const darwinBackgroundServiceDirectoryFailure = resolveDarwinBackgroundServiceSpawnDirectoryFailure({
        directory,
        startupSource: resolveDaemonStartupSourceFromEnv(process.env),
        env: process.env,
    });
    if (darwinBackgroundServiceDirectoryFailure) {
        return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
            errorMessage: darwinBackgroundServiceDirectoryFailure,
        };
    }

    // Resume RPCs need not carry private launch identity. Read it from the
    // admitted Session owner, using the same selection rules as tracked resumes.
    const runtimeOptions = normalizedExistingSessionId
        ? resolveSessionRuntimeSnapshot({
            incomingOptions: options,
            persistedMetadata,
            acceptedTeamCredentialBinding: attachSnapshot?.acceptedTeamCredentialBinding,
        }).spawnOptions
        : options;
    const accountDefaultModelSelection = !normalizedExistingSessionId && !effectiveResume
        && readSessionSpawnModelChoice(runtimeOptions, effectiveBackendTargetV2) === undefined
        ? readAgentDefaultModelSelectionV1(
            params.request.accountSettings?.providerDefaultModelSelectionsByAgentTargetKeyV1,
            effectiveBackendTargetV2,
        ) ?? undefined
        : undefined;
    // Omitted fresh-launch intent consumes the same Account default owner as
    // CLI/Workflow creators. An explicit native/empty object is still a choice;
    // resumed Sessions retain their admitted identity rather than today's default.
    let connectedServicesDefaults: Awaited<ReturnType<typeof resolveSessionSpawnConnectedServicesDefaultsPayload>> = null;
    if (!normalizedExistingSessionId && !effectiveResume && catalogAgentId
        && runtimeOptions.connectedServices === undefined) {
        try {
            connectedServicesDefaults = await resolveSessionSpawnConnectedServicesDefaultsPayload({
                agentId: catalogAgentId,
                credentials: params.request.credentials,
                ...(params.request.operationContext ? { operationContext: params.request.operationContext } : {}),
                resolveTeamCredentialResourceCatalog: async request =>
                    await createCredentialsSpawnConnectedServicesTeamResourceCatalogResolver(params.request.credentials)?.(request) ?? null,
            });
        } catch (error) {
            if (!(error instanceof ConnectedServicesDefaultUnavailableError)) throw error;
            if (error.code !== 'connected_services_default_unavailable') params.onTeamCredentialRefusal?.({ code: error.code, phase: error.phase });
            return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
                errorMessage: error.code === 'connected_services_default_unavailable' ? error.reason : error.code,
                errorDetail: { kind: 'launch_error', code: error.failureCause.code,
                    message: error.message, failureCause: error.failureCause } };
        }
    }
    const connectedServices = runtimeOptions.connectedServices ?? connectedServicesDefaults?.connectedServices;
    const connectedServicesUpdatedAt = runtimeOptions.connectedServicesUpdatedAt
        ?? connectedServicesDefaults?.connectedServicesUpdatedAt;
    const teamCredentialBindings = mergeSessionTeamCredentialBindingIntents({
        explicit: runtimeOptions.teamCredentialBindings,
        admitted: connectedServicesDefaults?.teamCredentialBindings ?? null,
    });
    const resources = params.request.readMachineResourcesPolicy?.();
    return {
        memoryHighBytes: resolveSessionMemoryCeilingBytes(effectiveSessionAttachPayload?.snapshot?.metadata,
            resources?.status === 'ready' ? resources.policy.guard : undefined),
        directory,
        directoryKind,
        ...(sessionCreationTag ? { sessionCreationTag } : {}),
        sessionId,
        existingSessionId,
        profileId: runtimeOptions.profileId,
        permissionMode: runtimeOptions.permissionMode,
        permissionModeUpdatedAt: runtimeOptions.permissionModeUpdatedAt,
        agentModeId: runtimeOptions.agentModeId,
        agentModeUpdatedAt: runtimeOptions.agentModeUpdatedAt,
        modelSelection: runtimeOptions.modelSelection ?? accountDefaultModelSelection,
        normalizedExistingSessionId,
        effectiveResume,
        effectiveBackendTargetV2,
        sessionAttachPayload: effectiveSessionAttachPayload,
        candidatePersistedSessionFile: isAbsolute(effectiveResume)
            ? effectiveResume
            : catalogAgentId ? resolveAgentNativeTranscriptPathFromSessionMetadata(catalogAgentId, persistedMetadata) : null,
        catalogAgentId,
        daemonSpawnHooks,
        environmentVariablesValidation,
        persistedProviderResumeState,
        ...(connectedServices ? { connectedServices } : {}),
        ...(connectedServicesUpdatedAt !== undefined ? { connectedServicesUpdatedAt } : {}),
        ...(teamCredentialBindings ? { teamCredentialBindings } : {}),
        ...(runtimeOptions.connectedServiceMaterializationIdentityV1
            ? { connectedServiceMaterializationIdentityV1: runtimeOptions.connectedServiceMaterializationIdentityV1 } : {}),
        ...runtimeSelection,
    };
}
