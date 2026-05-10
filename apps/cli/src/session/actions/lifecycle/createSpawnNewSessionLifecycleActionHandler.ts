import { isPermissionMode } from '@/api/types';
import {
    SPAWN_SESSION_ERROR_CODES,
    type SpawnSessionOptions,
} from '@/rpc/handlers/registerSessionHandlers';
import { readCanonicalSpawnRuntimeSelectionFromCompatIngress } from '@/rpc/handlers/spawnRuntimeSelection';
import { canonicalizeSpawnBackendTargetFromTransportInput } from '@/rpc/handlers/spawnSessionOptionsContract';
import { logger } from '@/ui/logger';
import {
    AcpConfigOptionOverridesV1Schema,
    SessionMcpSelectionV1Schema,
} from '@happier-dev/protocol';

import type {
    SessionLifecycleActionHandler,
    SessionLifecycleMachineHandlers,
} from './sessionLifecycleTypes';

export function createSpawnNewSessionLifecycleActionHandler(params: Readonly<{
    spawnSession: SessionLifecycleMachineHandlers['spawnSession'];
}>): SessionLifecycleActionHandler {
    return async (rawParams: unknown) => {
        const {
            directory,
            spawnNonce,
            initialPrompt,
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
            transcriptStorage,
            attachMetadataIdentityPolicy,
            permissionMode,
            permissionModeUpdatedAt,
            agentModeId,
            agentModeUpdatedAt,
            modelId,
            modelUpdatedAt,
            accountSettingsVersionHint,
            sessionConfigOptionOverrides,
            windowsRemoteSessionLaunchMode,
            windowsRemoteSessionConsole,
            windowsTerminalWindowName,
            experimentalCodexAcp,
            codexBackendMode,
            runtimeDescriptorV1,
            agentRuntimeDescriptorV1: legacyAgentRuntimeDescriptorV1,
            mcpSelection,
        } = (rawParams && typeof rawParams === 'object' ? rawParams : {}) as Record<string, unknown>;

        const normalizedModelId = typeof modelId === 'string' && modelId.trim().length > 0 ? modelId : undefined;
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
        const normalizedEnvironmentVariables = environmentVariables && typeof environmentVariables === 'object'
            ? environmentVariables as Record<string, string>
            : undefined;
        const normalizedResume = typeof resume === 'string' ? resume : undefined;
        const normalizedInitialPrompt = typeof initialPrompt === 'string' ? initialPrompt : undefined;
        const normalizedSpawnNonce = typeof spawnNonce === 'string' && spawnNonce.trim().length > 0 ? spawnNonce : undefined;
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
        const normalizedMcpSelection = (() => {
            if (mcpSelection === undefined) return undefined;
            const parsed = SessionMcpSelectionV1Schema.safeParse(mcpSelection);
            return parsed.success ? parsed.data : undefined;
        })();
        const normalizedSessionConfigOptionOverrides = (() => {
            if (sessionConfigOptionOverrides === undefined) return undefined;
            const parsed = AcpConfigOptionOverridesV1Schema.safeParse(sessionConfigOptionOverrides);
            return parsed.success ? parsed.data : undefined;
        })();
        const normalizedRuntimeSelection = readCanonicalSpawnRuntimeSelectionFromCompatIngress({
            codexBackendMode,
            experimentalCodexAcp,
            runtimeDescriptorV1,
            legacyAgentRuntimeDescriptorV1,
        });
        const normalizedRuntimeDescriptorV1 = normalizedRuntimeSelection.runtimeDescriptorV1;
        const normalizedCodexBackendMode = normalizedRuntimeSelection.codexBackendMode;
        const envKeys = normalizedEnvironmentVariables ? Object.keys(normalizedEnvironmentVariables) : [];
        const maxEnvKeysToLog = 20;
        const envKeySample = envKeys.slice(0, maxEnvKeysToLog);
        logger.debug('[API MACHINE] Spawning session', {
            directory,
            sessionId,
            machineId,
            backendTarget: normalizedBackendTarget,
            approvedNewDirectoryCreation,
            profileId,
            terminal,
            permissionMode: normalizedPermissionMode,
            permissionModeUpdatedAt: normalizedPermissionModeUpdatedAt,
            accountSettingsVersionHint: normalizedAccountSettingsVersionHint,
            agentModeId: normalizedAgentModeId,
            agentModeUpdatedAt: normalizedAgentModeUpdatedAt,
            modelId: normalizedModelId,
            modelUpdatedAt: typeof modelUpdatedAt === 'number' ? modelUpdatedAt : undefined,
            sessionConfigOptionOverrides: normalizedSessionConfigOptionOverrides,
            environmentVariableCount: envKeys.length,
            environmentVariableKeySample: envKeySample,
            environmentVariableKeysTruncated: envKeys.length > maxEnvKeysToLog,
            hasMcpSelection: normalizedMcpSelection !== undefined,
            mcpSelectionForceIncludeCount: normalizedMcpSelection?.forceIncludeServerIds.length ?? 0,
            mcpSelectionForceExcludeCount: normalizedMcpSelection?.forceExcludeServerIds.length ?? 0,
            hasResume: normalizedResume !== undefined,
            codexBackendMode: normalizedCodexBackendMode,
        });

        const buildBaseSpawnOptions = (resolvedDirectory: string): SpawnSessionOptions => ({
            directory: resolvedDirectory,
            spawnNonce: normalizedSpawnNonce,
            initialPrompt: normalizedInitialPrompt,
            machineId: typeof machineId === 'string' ? machineId : undefined,
            backendTarget: normalizedBackendTarget,
            environmentVariables: normalizedEnvironmentVariables,
            profileId: typeof profileId === 'string' ? profileId : undefined,
            terminal: terminal as SpawnSessionOptions['terminal'],
            resume: normalizedResume,
            connectedServices,
            transcriptStorage: normalizedTranscriptStorage,
            attachMetadataIdentityPolicy: normalizedAttachMetadataIdentityPolicy,
            permissionMode: normalizedPermissionMode,
            permissionModeUpdatedAt: normalizedPermissionModeUpdatedAt,
            accountSettingsVersionHint: normalizedAccountSettingsVersionHint,
            agentModeId: normalizedAgentModeId,
            agentModeUpdatedAt: normalizedAgentModeUpdatedAt,
            modelId: normalizedModelId,
            modelUpdatedAt: typeof modelUpdatedAt === 'number' ? modelUpdatedAt : undefined,
            sessionConfigOptionOverrides: normalizedSessionConfigOptionOverrides,
            windowsRemoteSessionLaunchMode: windowsRemoteSessionLaunchMode as SpawnSessionOptions['windowsRemoteSessionLaunchMode'],
            windowsRemoteSessionConsole: windowsRemoteSessionConsole as SpawnSessionOptions['windowsRemoteSessionConsole'],
            windowsTerminalWindowName: typeof windowsTerminalWindowName === 'string' ? windowsTerminalWindowName : undefined,
            mcpSelection: normalizedMcpSelection,
            ...(normalizedRuntimeDescriptorV1 ? { runtimeDescriptorV1: normalizedRuntimeDescriptorV1 } : {}),
            ...(normalizedCodexBackendMode ? { codexBackendMode: normalizedCodexBackendMode } : {}),
        });

        if ((rawParams as { type?: unknown } | null)?.type === 'resume-session') {
            const existingSessionId = typeof sessionId === 'string' ? sessionId : '';
            logger.debug(`[API MACHINE] Resuming inactive session ${existingSessionId}`);

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
        const result = await params.spawnSession({
            ...baseSpawnOptions,
            sessionId: typeof sessionId === 'string' ? sessionId : undefined,
            approvedNewDirectoryCreation: approvedNewDirectoryCreation as SpawnSessionOptions['approvedNewDirectoryCreation'],
        });

        switch (result.type) {
            case 'success':
                logger.debug(`[API MACHINE] Spawned session ${result.sessionId}`);
                return { type: 'success', sessionId: result.sessionId };

            case 'requestToApproveDirectoryCreation':
                logger.debug(`[API MACHINE] Requesting directory creation approval for: ${result.directory}`);
                return { type: 'requestToApproveDirectoryCreation', directory: result.directory };

            case 'error':
                return result;
        }
    };
}
