import { findCatalogEntry } from '@/agent/catalog/registry';
import { getVendorResumeSupport } from '@/session/runtime/catalogHooks';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import { logger } from '@/ui/logger';

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
    normalizedExistingSessionId: string;
    effectiveResume: string;
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
    | 'sessionId'
    | 'existingSessionId'
    | 'permissionMode'
    | 'permissionModeUpdatedAt'
    | 'agentModeId'
    | 'agentModeUpdatedAt'
    | 'modelSelection'
>;

export type PrepareExecuteSpawnSessionRequestInput = Readonly<{
    options: SpawnSessionOptions;
    credentials: NonNullable<Parameters<typeof resolveSpawnBackendIdentity>[0]['credentials']>;
    loadLocalHandoffMetadataByVendorResumeId: Parameters<typeof resolveSpawnBackendIdentity>[0]['loadLocalHandoffMetadataByVendorResumeId'];
}>;

export async function prepareExecuteSpawnSessionRequest(
    params: Readonly<{
        request: PrepareExecuteSpawnSessionRequestInput;
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
        directory: requestedDirectory,
        sessionId,
        resume,
        existingSessionId,
        permissionMode,
        permissionModeUpdatedAt,
        agentModeId,
        agentModeUpdatedAt,
        modelSelection,
        backendTarget,
    } = options;
    const normalizedResume = typeof resume === 'string' ? resume.trim() : '';

    const backendIdentityResolution = await resolveSpawnBackendIdentity({
        existingSessionId: typeof existingSessionId === 'string' ? existingSessionId : '',
        resume: normalizedResume,
        backendTarget,
        credentials: params.request.credentials,
        loadLocalHandoffMetadataByVendorResumeId: params.request.loadLocalHandoffMetadataByVendorResumeId,
    });
    if (!backendIdentityResolution.ok) {
        return backendIdentityResolution.error;
    }

    const {
        normalizedExistingSessionId,
        effectiveResume,
        effectiveBackendTargetV2,
        sessionAttachPayload,
        catalogAgentId,
        ownerMetadata,
        existingSessionWorkspacePath,
    } = backendIdentityResolution;
    const directory = existingSessionWorkspacePath ?? requestedDirectory;
    let persistedProviderResumeState: ReturnType<typeof readPersistedProviderResumeState>;
    try {
        const ownerProviderResumeMetadata = ownerMetadata
            ? {
                ...(ownerMetadata.runtime?.providerBindingV1
                    ? { providerBindingV1: ownerMetadata.runtime.providerBindingV1 }
                    : {}),
                ...(ownerMetadata.runtime?.modelSelectionIntentV1
                    ? { modelSelectionIntentV1: ownerMetadata.runtime.modelSelectionIntentV1 }
                    : {}),
            }
            : null;
        persistedProviderResumeState = readPersistedProviderResumeState(
            ownerProviderResumeMetadata
                ?? (
                    sessionAttachPayload && 'snapshot' in sessionAttachPayload
                        ? sessionAttachPayload.snapshot?.metadata ?? null
                        : null
                ),
        );
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

    if (effectiveResume) {
        if (effectiveBackendTargetV2.sourceKind === 'configured') {
            const configuredBackendId = (effectiveBackendTargetV2.configuredBackendId ?? effectiveBackendTargetV2.backendId).trim();
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
                errorMessage: `Resume is not supported for configured ACP backend '${configuredBackendId}'.`,
            };
        }
        if (!catalogAgentId) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Unknown backend target',
            };
        }
        const vendorResumeSupport = await getVendorResumeSupport(catalogAgentId);
        const runtimeSelection = readCanonicalSpawnRuntimeSelection(options);
        const ok = vendorResumeSupport({
            ...(runtimeSelection.agentRuntimeSelection
                ? { agentRuntimeSelection: runtimeSelection.agentRuntimeSelection }
                : {}),
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

    return {
        directory,
        sessionId,
        existingSessionId,
        permissionMode,
        permissionModeUpdatedAt,
        agentModeId,
        agentModeUpdatedAt,
        modelSelection: persistedProviderResumeState.selection ?? modelSelection,
        normalizedExistingSessionId,
        effectiveResume,
        effectiveBackendTargetV2,
        sessionAttachPayload: effectiveSessionAttachPayload,
        catalogAgentId,
        daemonSpawnHooks,
        environmentVariablesValidation,
        persistedProviderResumeState,
    };
}
