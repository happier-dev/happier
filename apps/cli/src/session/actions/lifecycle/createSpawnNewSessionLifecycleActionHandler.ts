import { isPermissionMode } from '@/api/types';
import {
    SPAWN_SESSION_ERROR_CODES,
    type SpawnSessionOptions,
} from '@/session/shared/spawnSessionContract';
import { readCanonicalSpawnRuntimeSelection } from '@/rpc/handlers/spawnRuntimeSelection';
import { canonicalizeSpawnBackendTargetFromTransportInput } from '@/rpc/handlers/spawnSessionOptionsContract';
import {
    createRandomSpawnNonce,
    createStableSpawnNonce,
    normalizeSpawnNonce,
} from '@/session/shared/spawnNonce';
import { logger } from '@/ui/logger';
import {
    AcpConfigOptionOverridesV1Schema,
    AgentSessionStartupInstructionsV1Schema,
    SessionModelSelectionV1Schema,
    SessionCreationCorrespondenceV1Schema,
    SessionCreationTagV1Schema,
    RuntimeDescriptorV1Schema,
    buildBackendTargetKeyV2,
    SessionMcpSelectionV1Schema,
    SpawnSessionExecutionAuthorizationSchema,
    findSpawnConfigOptionAliasConflicts,
    mergeSpawnConfigOptionAliases,
    type SpawnConfigOptionValue,
} from '@happier-dev/protocol';

import type {
    SessionLifecycleActionHandler,
    SessionLifecycleMachineHandlers,
} from './sessionLifecycleTypes';

export function createSpawnNewSessionLifecycleActionHandler(params: Readonly<{
    spawnSession: SessionLifecycleMachineHandlers['spawnSession'];
}>): SessionLifecycleActionHandler {
    return async (rawParams: unknown, context) => {
        const cancelled = () => ({
            type: 'error' as const,
            errorCode: 'cancelled',
            errorMessage: 'cancelled',
        });
        if (context?.signal.aborted) return cancelled();
        const {
            directory,
            spawnNonce,
            sessionId,
            machineId,
            approvedNewDirectoryCreation,
            backendTarget,
            agent,
            environmentVariables,
            profileId,
            terminal,
            resume,
            connectedServices,
            connectedServicesUpdatedAt,
            transcriptStorage,
            attachMetadataIdentityPolicy,
            permissionMode,
            permissionModeUpdatedAt,
            agentModeId,
            agentModeUpdatedAt,
            modelId,
            modelUpdatedAt,
            modelSelection,
            accountSettingsVersionHint,
            initialTranscriptAfterSeq,
            executionAuthorization,
            sessionConfigOptionOverrides,
            configOptions,
            windowsRemoteSessionLaunchMode,
            windowsRemoteSessionConsole,
            windowsTerminalWindowName,
            runtimeDescriptorV1,
            mcpSelection,
            agentSessionStartupInstructionsV1,
            sessionCreationTag,
            sessionCreationCorrespondence,
            initialTitle,
        } = (rawParams && typeof rawParams === 'object' ? rawParams : {}) as Record<string, unknown>;

        const parsedAgentSessionStartupInstructionsV1 =
            agentSessionStartupInstructionsV1 === undefined
                ? null
                : AgentSessionStartupInstructionsV1Schema.safeParse(
                    agentSessionStartupInstructionsV1,
                );
        if (
            parsedAgentSessionStartupInstructionsV1
            && !parsedAgentSessionStartupInstructionsV1.success
        ) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Invalid agent session startup instructions',
            };
        }
        const normalizedAgentSessionStartupInstructionsV1 =
            parsedAgentSessionStartupInstructionsV1?.success
                ? parsedAgentSessionStartupInstructionsV1.data
                : undefined;
        const parsedSessionCreationTag = sessionCreationTag === undefined
            ? null
            : SessionCreationTagV1Schema.safeParse(sessionCreationTag);
        if (parsedSessionCreationTag && !parsedSessionCreationTag.success) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Invalid Session creation identity',
            };
        }
        const normalizedSessionCreationTag = parsedSessionCreationTag?.success
            ? parsedSessionCreationTag.data
            : undefined;
        const parsedSessionCreationCorrespondence = sessionCreationCorrespondence === undefined
            ? null
            : SessionCreationCorrespondenceV1Schema.safeParse(sessionCreationCorrespondence);
        if (parsedSessionCreationCorrespondence && !parsedSessionCreationCorrespondence.success) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Invalid Session creation correspondence',
            };
        }
        const normalizedSessionCreationCorrespondence = parsedSessionCreationCorrespondence?.success
            ? parsedSessionCreationCorrespondence.data
            : undefined;
        if (
            normalizedSessionCreationCorrespondence
            && (
                !normalizedSessionCreationTag
                || normalizedSessionCreationCorrespondence.sessionCreationTag !== normalizedSessionCreationTag
            )
        ) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Session creation correspondence requires its matching identity',
            };
        }
        const normalizedInitialTitle = typeof initialTitle === 'string'
            ? initialTitle.trim()
            : '';
        if (initialTitle !== undefined && !normalizedInitialTitle) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Invalid initial Session title',
            };
        }
        const normalizedModelId = typeof modelId === 'string' && modelId.trim().length > 0 ? modelId.trim() : undefined;
        const normalizedPermissionMode =
            typeof permissionMode === 'string' && isPermissionMode(permissionMode) ? permissionMode : undefined;
        const normalizedPermissionModeUpdatedAt =
            normalizedPermissionMode && typeof permissionModeUpdatedAt === 'number' ? permissionModeUpdatedAt : undefined;
        const normalizedAgentModeId =
            typeof agentModeId === 'string' && agentModeId.trim().length > 0 ? agentModeId.trim() : undefined;
        const normalizedAgentModeUpdatedAt =
            normalizedAgentModeId && typeof agentModeUpdatedAt === 'number' ? agentModeUpdatedAt : undefined;
        const normalizedAccountSettingsVersionHint =
            typeof accountSettingsVersionHint === 'number'
            && Number.isInteger(accountSettingsVersionHint)
            && accountSettingsVersionHint >= 0
                ? accountSettingsVersionHint
                : undefined;
        const normalizedInitialTranscriptAfterSeq =
            typeof initialTranscriptAfterSeq === 'number'
            && Number.isInteger(initialTranscriptAfterSeq)
            && initialTranscriptAfterSeq >= 0
                ? initialTranscriptAfterSeq
                : undefined;
        const parsedExecutionAuthorization = SpawnSessionExecutionAuthorizationSchema.safeParse(executionAuthorization);
        const normalizedExecutionAuthorization = parsedExecutionAuthorization.success
            ? parsedExecutionAuthorization.data
            : undefined;
        const normalizedEnvironmentVariables = environmentVariables && typeof environmentVariables === 'object'
            ? environmentVariables as Record<string, string>
            : undefined;
        const normalizedConfigOptions = (() => {
            if (!configOptions || typeof configOptions !== 'object' || Array.isArray(configOptions)) return undefined;
            const entries = Object.entries(configOptions as Record<string, unknown>);
            if (!entries.every(([, value]) => (
                typeof value === 'string'
                || typeof value === 'number' && Number.isFinite(value)
                || typeof value === 'boolean'
                || value === null
            ))) {
                return undefined;
            }
            return Object.fromEntries(entries) as Record<string, SpawnConfigOptionValue>;
        })();
        const normalizedResume = typeof resume === 'string' ? resume : undefined;
        const normalizedSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId.trim() : undefined;
        const isResumeSessionRequest = (rawParams as { type?: unknown } | null)?.type === 'resume-session';
        const normalizedExplicitSpawnNonce = normalizeSpawnNonce(spawnNonce);
        const normalizedSpawnNonce = normalizedExplicitSpawnNonce
            ?? (
                isResumeSessionRequest
                    ? undefined
                    : normalizedSessionId
                        ? createStableSpawnNonce('session.spawn_new', { sessionId: normalizedSessionId })
                        : createRandomSpawnNonce('session.spawn_new')
            );
        const normalizedTranscriptStorage =
            transcriptStorage === 'persisted' || transcriptStorage === 'direct' ? transcriptStorage : undefined;
        const normalizedAttachMetadataIdentityPolicy =
            attachMetadataIdentityPolicy === 'preserve_current_identity'
            || attachMetadataIdentityPolicy === 'replace_with_runtime_identity'
                ? attachMetadataIdentityPolicy
                : undefined;
        const normalizedBackendTargetResolution = canonicalizeSpawnBackendTargetFromTransportInput({
            backendTarget,
            legacyAgent: agent,
        });
        if (normalizedBackendTargetResolution.errorMessage) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: normalizedBackendTargetResolution.errorMessage,
            };
        }
        const normalizedBackendTarget = normalizedBackendTargetResolution.backendTarget;
        const parsedModelSelection = modelSelection === undefined
            ? null
            : SessionModelSelectionV1Schema.safeParse(modelSelection);
        if (parsedModelSelection && !parsedModelSelection.success) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Invalid model selection',
            };
        }
        const modelTargetKey = normalizedBackendTarget ? buildBackendTargetKeyV2(normalizedBackendTarget) : null;
        if ((parsedModelSelection?.success || normalizedModelId) && !modelTargetKey) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'backendTarget is required for model selection',
            };
        }
        if (parsedModelSelection?.success && parsedModelSelection.data.ref.agentTargetKey !== modelTargetKey) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Model selection agent target must match backendTarget',
            };
        }
        const normalizedModelSelection = parsedModelSelection?.success
            ? parsedModelSelection.data
            : normalizedModelId && modelTargetKey
                ? SessionModelSelectionV1Schema.parse({
                    v: 1,
                    updatedAt: typeof modelUpdatedAt === 'number' ? modelUpdatedAt : Date.now(),
                    ref: {
                        agentTargetKey: modelTargetKey,
                        providerConnectionId: null,
                        modelId: normalizedModelId,
                    },
                })
                : undefined;
        const normalizedMcpSelection = (() => {
            if (mcpSelection === undefined) return undefined;
            const parsed = SessionMcpSelectionV1Schema.safeParse(mcpSelection);
            return parsed.success ? parsed.data : undefined;
        })();
        const parsedSessionConfigOptionOverrides = sessionConfigOptionOverrides === undefined
            ? null
            : AcpConfigOptionOverridesV1Schema.safeParse(sessionConfigOptionOverrides);
        const canonicalSessionConfigOptionOverrides = parsedSessionConfigOptionOverrides?.success
            ? parsedSessionConfigOptionOverrides.data
            : undefined;
        const configOptionConflicts = findSpawnConfigOptionAliasConflicts({
            sessionConfigOptionOverrides: canonicalSessionConfigOptionOverrides,
            configOptions: normalizedConfigOptions,
        });
        if (configOptionConflicts.length > 0) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: `Conflicting config option override: ${configOptionConflicts[0]?.id ?? 'unknown'}`,
            };
        }
        const normalizedSessionConfigOptionOverrides = mergeSpawnConfigOptionAliases({
            sessionConfigOptionOverrides: canonicalSessionConfigOptionOverrides,
            configOptions: normalizedConfigOptions,
        });
        let normalizedRuntimeDescriptorV1;
        try {
            const parsedRuntimeDescriptorV1 = runtimeDescriptorV1 === undefined
                ? undefined
                : RuntimeDescriptorV1Schema.parse(runtimeDescriptorV1);
            normalizedRuntimeDescriptorV1 = readCanonicalSpawnRuntimeSelection({
                agentId: normalizedBackendTarget?.sourceKind === 'built_in'
                    ? normalizedBackendTarget.backendId
                    : undefined,
                runtimeDescriptorV1: parsedRuntimeDescriptorV1,
            }).runtimeDescriptorV1;
        } catch (error) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: error instanceof Error
                    ? error.message
                    : 'Invalid runtime descriptor identity',
            };
        }
        const buildBaseSpawnOptions = (resolvedDirectory: string): SpawnSessionOptions => ({
            directory: resolvedDirectory,
            spawnNonce: normalizedSpawnNonce,
            machineId: typeof machineId === 'string' ? machineId : undefined,
            backendTarget: normalizedBackendTarget,
            environmentVariables: normalizedEnvironmentVariables,
            profileId: typeof profileId === 'string' ? profileId : undefined,
            terminal: terminal as SpawnSessionOptions['terminal'],
            resume: normalizedResume,
            connectedServices,
            connectedServicesUpdatedAt: typeof connectedServicesUpdatedAt === 'number' ? connectedServicesUpdatedAt : undefined,
            transcriptStorage: normalizedTranscriptStorage,
            attachMetadataIdentityPolicy: normalizedAttachMetadataIdentityPolicy,
            permissionMode: normalizedPermissionMode,
            permissionModeUpdatedAt: normalizedPermissionModeUpdatedAt,
            accountSettingsVersionHint: normalizedAccountSettingsVersionHint,
            initialTranscriptAfterSeq: normalizedInitialTranscriptAfterSeq,
            executionAuthorization: normalizedExecutionAuthorization,
            agentModeId: normalizedAgentModeId,
            agentModeUpdatedAt: normalizedAgentModeUpdatedAt,
            modelSelection: normalizedModelSelection,
            sessionConfigOptionOverrides: normalizedSessionConfigOptionOverrides,
            windowsRemoteSessionLaunchMode: windowsRemoteSessionLaunchMode as SpawnSessionOptions['windowsRemoteSessionLaunchMode'],
            windowsRemoteSessionConsole: windowsRemoteSessionConsole as SpawnSessionOptions['windowsRemoteSessionConsole'],
            windowsTerminalWindowName: typeof windowsTerminalWindowName === 'string' ? windowsTerminalWindowName : undefined,
            mcpSelection: normalizedMcpSelection,
            ...(normalizedSessionCreationTag
                ? { sessionCreationTag: normalizedSessionCreationTag }
                : {}),
            ...(normalizedSessionCreationCorrespondence
                ? { sessionCreationCorrespondence: normalizedSessionCreationCorrespondence }
                : {}),
            ...(normalizedInitialTitle ? { initialTitle: normalizedInitialTitle } : {}),
            ...(normalizedAgentSessionStartupInstructionsV1
                ? {
                    agentSessionStartupInstructionsV1:
                        normalizedAgentSessionStartupInstructionsV1,
                }
                : {}),
            ...(normalizedRuntimeDescriptorV1 ? { runtimeDescriptorV1: normalizedRuntimeDescriptorV1 } : {}),
        });

        if (isResumeSessionRequest) {
            const existingSessionId = normalizedSessionId ?? '';
            logger.debug('[API MACHINE] Resuming inactive session');

            if (typeof directory !== 'string' || directory.length === 0) {
                return {
                    type: 'error',
                    errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                    errorMessage: 'Directory is required',
                };
            }
            if (!existingSessionId) {
                return {
                    type: 'error',
                    errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                    errorMessage: 'Session ID is required for resume',
                };
            }

            const baseSpawnOptions = buildBaseSpawnOptions(directory);
            if (context?.signal.aborted) return cancelled();
            const result = await params.spawnSession({
                ...baseSpawnOptions,
                existingSessionId,
                approvedNewDirectoryCreation: true,
            });

            if (result.type === 'error') {
                return result;
            }

            return { type: 'success' };
        }

        if (typeof directory !== 'string' || directory.length === 0) {
            return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST, errorMessage: 'Directory is required' };
        }
        if (!normalizedBackendTarget) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Backend target is required for fresh session spawn.',
            };
        }
        const baseSpawnOptions = buildBaseSpawnOptions(directory);
        if (context?.signal.aborted) return cancelled();
        const result = await params.spawnSession({
            ...baseSpawnOptions,
            sessionId: normalizedSessionId,
            approvedNewDirectoryCreation: approvedNewDirectoryCreation as SpawnSessionOptions['approvedNewDirectoryCreation'],
        });

        switch (result.type) {
            case 'success':
                logger.debug('[API MACHINE] Session spawn succeeded');
                return result;

            case 'requestToApproveDirectoryCreation':
                logger.debug('[API MACHINE] Session directory creation requires approval');
                return { type: 'requestToApproveDirectoryCreation', directory: result.directory };

            case 'error':
                return result;
        }
    };
}
