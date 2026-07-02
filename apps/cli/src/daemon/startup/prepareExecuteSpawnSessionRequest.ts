import { getVendorResumeSupport, requireCatalogEntry } from '@/backends/catalog';
import { DEFAULT_CATALOG_AGENT_ID, type CatalogAgentId } from '@/backends/types';
import {
    normalizeDaemonInitialPrompt,
} from '@/agent/runtime/daemonInitialPrompt';
import { logger } from '@/ui/logger';

import type {
    SpawnSessionOptions,
    SpawnSessionResult,
} from '@/rpc/handlers/registerSessionHandlers';
import { readCanonicalSpawnRuntimeSelection } from '@/rpc/handlers/spawnRuntimeSelection';
import {
    SPAWN_SESSION_ERROR_CODES,
} from '@/rpc/handlers/registerSessionHandlers';
import type { ExecuteSpawnSessionRequestParams } from './executeSpawnSessionRequest';
import { ensureSessionDirectory } from './ensureSessionDirectory';
import { resolveSpawnBackendIdentity } from '../spawn/resolveSpawnBackendIdentity';
import type { DaemonSpawnHooks } from '@/daemon/spawnHooks';
import { resolveDaemonStartupSourceFromEnv } from '@/daemon/ownership/daemonOwnershipMetadata';
import { resolveDarwinBackgroundServiceSpawnDirectoryFailure } from '../spawn/resolveDarwinBackgroundServiceSpawnDirectoryFailure';
import { applyInitialTranscriptAfterSeqToAttachPayload } from '../sessionEncryption/applyInitialTranscriptAfterSeqToAttachPayload';

type DaemonVendorResumeSupportHook = Readonly<{
    resolveVendorResumeSupportParams?: (params: Readonly<{
        catalogAgentId: string | null;
        options: ReturnType<typeof readCanonicalSpawnRuntimeSelection>;
    }>) => Readonly<Record<string, unknown>>;
}>;

function resolveVendorResumeSupportParamsForSpawn(params: Readonly<{
    catalogAgentId: string | null;
    options: SpawnSessionOptions;
    daemonSpawnHooks: unknown;
}>): Readonly<Record<string, unknown>> {
    const runtimeSelection = readCanonicalSpawnRuntimeSelection(params.options);
    const hook = (params.daemonSpawnHooks as DaemonVendorResumeSupportHook | null)?.resolveVendorResumeSupportParams;
    if (hook) {
        return hook({
            catalogAgentId: params.catalogAgentId,
            options: runtimeSelection,
        });
    }
    return runtimeSelection;
}

type BackendIdentitySuccess = Extract<
    Awaited<ReturnType<typeof resolveSpawnBackendIdentity>>,
    { ok: true }
>;

export type PreparedExecuteSpawnSessionRequest = Readonly<{
    directoryCreated: boolean;
    normalizedInitialPrompt: string | null;
    normalizedExistingSessionId: string;
    effectiveResume: string;
    effectiveBackendTargetV2: BackendIdentitySuccess['effectiveBackendTargetV2'];
    sessionAttachPayload: BackendIdentitySuccess['sessionAttachPayload'];
    catalogAgentId: CatalogAgentId | null;
    catalogAgentIdForConnectedServices: CatalogAgentId;
    daemonSpawnHooks: DaemonSpawnHooks | null;
    environmentVariablesValidation: Readonly<{
        ok: true;
        env: Record<string, string>;
    }>;
}> & Pick<
    SpawnSessionOptions,
    | 'directory'
    | 'sessionId'
    | 'existingSessionId'
    | 'permissionMode'
    | 'permissionModeUpdatedAt'
    | 'agentModeId'
    | 'agentModeUpdatedAt'
    | 'modelId'
    | 'modelUpdatedAt'
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
    const envKeysPreview = options.environmentVariables && typeof options.environmentVariables === 'object'
        ? Object.keys(options.environmentVariables as Record<string, unknown>)
        : [];
    const environmentVariablesValidation = params.validateEnvVarRecordStrict(options.environmentVariables);
    logger.debugLargeJson('[DAEMON RUN] Spawning session', {
        directory: options.directory,
        sessionId: options.sessionId,
        machineId: options.machineId,
        approvedNewDirectoryCreation: options.approvedNewDirectoryCreation,
        backendTarget: options.backendTarget,
        profileId: options.profileId,
        hasInitialPrompt: typeof options.initialPrompt === 'string' && options.initialPrompt.trim().length > 0,
        hasInitialTranscriptAfterSeq: typeof options.initialTranscriptAfterSeq === 'number',
        hasResume: typeof options.resume === 'string' && options.resume.trim().length > 0,
        windowsRemoteSessionLaunchMode: options.windowsRemoteSessionLaunchMode,
        windowsRemoteSessionConsole: options.windowsRemoteSessionConsole,
        environmentVariableCount: envKeysPreview.length,
        environmentVariableKeys: envKeysPreview,
        environmentVariablesValid: environmentVariablesValidation.ok,
        environmentVariablesError: environmentVariablesValidation.ok ? null : environmentVariablesValidation.error,
    });

    if (!environmentVariablesValidation.ok) {
        return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_ENVIRONMENT_VARIABLES,
            errorMessage: environmentVariablesValidation.error,
        };
    }

    const {
        directory,
        sessionId,
        approvedNewDirectoryCreation = true,
        resume,
        existingSessionId,
        permissionMode,
        permissionModeUpdatedAt,
        agentModeId,
        agentModeUpdatedAt,
        modelId,
        modelUpdatedAt,
        initialPrompt,
        backendTarget,
    } = options;
    const normalizedResume = typeof resume === 'string' ? resume.trim() : '';
    const normalizedInitialPrompt = normalizeDaemonInitialPrompt(initialPrompt);

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
    } = backendIdentityResolution;
    const effectiveSessionAttachPayload = sessionAttachPayload
        ? applyInitialTranscriptAfterSeqToAttachPayload(sessionAttachPayload, options.initialTranscriptAfterSeq)
        : sessionAttachPayload;
    const catalogAgentIdForConnectedServices = (catalogAgentId ?? DEFAULT_CATALOG_AGENT_ID) as CatalogAgentId;
    const daemonSpawnHooks = catalogAgentId
        ? await (async () => {
            const entry = requireCatalogEntry(catalogAgentId);
            return entry.getDaemonSpawnHooks ? await entry.getDaemonSpawnHooks() : null;
        })()
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
        const ok = vendorResumeSupport(resolveVendorResumeSupportParamsForSpawn({
            catalogAgentId,
            options,
            daemonSpawnHooks,
        }));
        if (!ok) {
            const supportLevel = requireCatalogEntry(catalogAgentId).vendorResumeSupport;
            const qualifier = supportLevel === 'experimental' ? ' (experimental and not enabled)' : '';
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
                errorMessage: `Resume is not supported for agent '${catalogAgentId}'${qualifier}.`,
            };
        }
    }

    const ensuredDirectory = await ensureSessionDirectory({
        directory,
        approvedNewDirectoryCreation,
    });
    if (!ensuredDirectory.ok) {
        logger.debug(`[DAEMON RUN] Directory setup failed for ${directory}`, ensuredDirectory.response);
        return ensuredDirectory.response;
    }

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
        modelId,
        modelUpdatedAt,
        directoryCreated: ensuredDirectory.directoryCreated,
        normalizedInitialPrompt,
        normalizedExistingSessionId,
        effectiveResume,
        effectiveBackendTargetV2,
        sessionAttachPayload: effectiveSessionAttachPayload,
        catalogAgentId: catalogAgentId as CatalogAgentId | null,
        catalogAgentIdForConnectedServices,
        daemonSpawnHooks,
        environmentVariablesValidation,
    };
}
