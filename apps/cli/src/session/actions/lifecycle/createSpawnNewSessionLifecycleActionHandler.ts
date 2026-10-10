import { isPermissionMode } from '@/api/types';
import {
    SPAWN_SESSION_ERROR_CODES,
    type SpawnSessionOptions,
} from '@/session/shared/spawnSessionContract';
import {
    pickDefinedSpawnSessionOptions,
    SpawnDaemonSessionRequestSchema,
} from '@/rpc/handlers/spawnSessionOptionsContract';
import {
    createRandomSpawnNonce,
    createStableSpawnNonce,
    normalizeSpawnNonce,
} from '@/session/shared/spawnNonce';
import { logger } from '@/ui/logger';
import { AcpConfigOptionOverridesV1Schema } from '@happier-dev/protocol/sessions/metadata/overrides';
import { AgentSessionStartupInstructionsV1Schema } from '@happier-dev/protocol/runtime/agentSessionStartupInstructionsV1';
import { SessionCreationCorrespondenceV1Schema, sessionCreationCorrespondenceMatchesV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { SessionCreationTagV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { SessionInitialAccessDraftV1Schema } from '@happier-dev/protocol/sessions/access/sessionInitialAccessDraftV1';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionMcpSelectionV1Schema } from '@happier-dev/protocol/mcp/servers/sessionSelectionV1';
import { SpawnSessionExecutionAuthorizationSchema } from '@happier-dev/protocol/spawnSession';
import { findSpawnConfigOptionAliasConflicts, mergeSpawnConfigOptionAliases } from '@happier-dev/protocol/actions/sessionSpawnConfigOptions';
import type { SpawnConfigOptionValue } from '@happier-dev/protocol';
import { canUseCustodianAccountForMachineRequest, RequesterWorkAttributionV1Schema } from '@/daemon/lifecycle/requesterWorkAttribution';
import { isAdmittedRequesterSessionBootstrapCurrent } from '@/daemon/sessionEncryption/requesterSessionCredentials';

import type {
    SessionLifecycleActionHandler,
    SessionLifecycleMachineHandlers,
} from './sessionLifecycleTypes';

export function createSpawnNewSessionLifecycleActionHandler(params: Readonly<{
    spawnSession: SessionLifecycleMachineHandlers['spawnSession'];
    serverId?: string;
}>): SessionLifecycleActionHandler {
    return async (rawParams: unknown, context) => {
        const cancelled = () => ({
            type: 'error' as const,
            errorCode: 'cancelled',
            errorMessage: 'cancelled',
        });
        if (context?.signal?.aborted) return cancelled();
        if (rawParams && typeof rawParams === 'object'
            && (Object.hasOwn(rawParams, 'requesterWorkAttributionV1')
                || Object.hasOwn(rawParams, 'verifyRequesterMachineAdmissionCurrent')
                || Object.hasOwn(rawParams, 'beforeSessionRunnerLaunch')
                || Object.hasOwn(rawParams, 'requesterSessionCredentialFile')
                || Object.hasOwn(rawParams, 'requesterSessionRuntimeContext')
                || Object.hasOwn(rawParams, 'requesterSessionBootstrap'))) {
            return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Requester launch context cannot be authored in spawn input' };
        }
        const requesterAdmission = context?.machineAdmission;
        const requesterBootstrap = context?.requesterSessionBootstrap;
        if ((requesterAdmission || requesterBootstrap) && !params.serverId) {
            // A Machine use grant is not a requester Account credential. No unsigned
            // shared launch may borrow the custodian's settings or subscriptions.
            return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
                errorMessage: 'Requester Session credential unavailable' };
        }
        const {
            directory,
            spawnNonce,
            sessionId,
            machineId,
            approvedNewDirectoryCreation,
            initialAccess,
            primaryTeamId,
            teamCredentialBindings,
            environmentVariables,
            profileId,
            secretReferenceOverlay,
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
            accountSettingsVersionHint,
            initialTranscriptAfterSeq,
            executionAuthorization,
            sessionConfigOptionOverrides,
            configOptions,
            windowsRemoteSessionLaunchMode,
            windowsRemoteSessionConsole,
            windowsTerminalWindowName,
            mcpSelection,
            agentSessionStartupInstructionsV1,
            sessionCreationTag,
            sessionCreationCorrespondence,
            initialTitle,
            identity,
            memoryEnabled,
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
        const parsedInitialAccess = initialAccess === undefined
            ? null
            : SessionInitialAccessDraftV1Schema.safeParse(initialAccess);
        if (parsedInitialAccess && !parsedInitialAccess.success) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Invalid initial Session access',
            };
        }
        const normalizedInitialAccess = parsedInitialAccess?.success
            ? parsedInitialAccess.data
            : undefined;
        const parsedPrimaryTeamId = SessionSpawnNewInputV2Schema.shape.primaryTeamId.safeParse(primaryTeamId);
        if (!parsedPrimaryTeamId.success) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Invalid primary Team identity',
            };
        }
        const normalizedPrimaryTeamId = parsedPrimaryTeamId.data;
        const parsedTeamCredentialBindings = SessionSpawnNewInputV2Schema.shape.teamCredentialBindings.safeParse(
            teamCredentialBindings,
        );
        if (!parsedTeamCredentialBindings.success) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Invalid Team credential binding',
            };
        }
        const normalizedTeamCredentialBindings = parsedTeamCredentialBindings.data;
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
        const parsedProfileId = SessionSpawnNewInputV2Schema.shape.profileId.safeParse(profileId);
        if (!parsedProfileId.success) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Invalid launch profile identity',
            };
        }
        const normalizedProfileId = parsedProfileId.data;
        const parsedSecretReferenceOverlay = SessionSpawnNewInputV2Schema.shape.secretReferenceOverlay.safeParse(
            secretReferenceOverlay,
        );
        if (!parsedSecretReferenceOverlay.success) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Invalid Saved Secret reference overlay',
            };
        }
        const normalizedSecretReferenceOverlay = parsedSecretReferenceOverlay.data;
        const parsedIdentity = SessionSpawnNewInputV2Schema.shape.identity.safeParse(identity);
        const parsedMemoryEnabled = SessionSpawnNewInputV2Schema.shape.memoryEnabled.safeParse(memoryEnabled);
        if (!parsedIdentity.success || !parsedMemoryEnabled.success) {
            return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Invalid initial Session identity or memory choice' };
        }
        if (normalizedSessionCreationCorrespondence && !sessionCreationCorrespondenceMatchesV1(
            normalizedSessionCreationCorrespondence,
            { ...normalizedSessionCreationCorrespondence, recipe: {
                ...normalizedSessionCreationCorrespondence.recipe,
                ...(parsedIdentity.data !== undefined ? { identity: parsedIdentity.data } : {}),
                ...(parsedMemoryEnabled.data !== undefined ? { memoryEnabled: parsedMemoryEnabled.data } : {}),
            } },
        )) {
            return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Initial Session facts conflict with Session creation correspondence' };
        }
        if (
            normalizedSessionCreationCorrespondence
            && normalizedProfileId !== undefined
            && normalizedSessionCreationCorrespondence.recipe.profileId !== normalizedProfileId
        ) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Launch profile conflicts with Session creation correspondence',
            };
        }
        if (
            normalizedSessionCreationCorrespondence
            && normalizedSecretReferenceOverlay !== undefined
            && !sessionCreationCorrespondenceMatchesV1(
                normalizedSessionCreationCorrespondence,
                {
                    ...normalizedSessionCreationCorrespondence,
                    recipe: {
                        ...normalizedSessionCreationCorrespondence.recipe,
                        secretReferenceOverlay: normalizedSecretReferenceOverlay,
                    },
                },
            )
        ) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Saved Secret references conflict with Session creation correspondence',
            };
        }
        const effectiveProfileId = normalizedSessionCreationCorrespondence
            ? normalizedSessionCreationCorrespondence.recipe.profileId ?? undefined
            : normalizedProfileId;
        const effectiveSecretReferenceOverlay = normalizedSessionCreationCorrespondence
            ? normalizedSessionCreationCorrespondence.recipe.secretReferenceOverlay
            : normalizedSecretReferenceOverlay;
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
        // The private transport must retain every admitted daemon option, not
        // recreate a narrower request that loses managed placement or first input.
        const { configOptions: _configOptionsAlias, ...transportRequest } =
            (rawParams && typeof rawParams === 'object' ? rawParams : {}) as Record<string, unknown>;
        let parsedTransportRequest: ReturnType<typeof SpawnDaemonSessionRequestSchema.safeParse>;
        try {
            parsedTransportRequest = SpawnDaemonSessionRequestSchema.safeParse({
                ...transportRequest,
                sessionConfigOptionOverrides: normalizedSessionConfigOptionOverrides,
            });
        } catch (error) {
            // Runtime selection transforms may reject an incompatible descriptor.
            return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: error instanceof Error ? error.message : 'Invalid daemon spawn request' };
        }
        if (!parsedTransportRequest.success) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Invalid daemon spawn request',
            };
        }
        const admittedSpawnOptions = pickDefinedSpawnSessionOptions(parsedTransportRequest.data);
        const requesterMachineId = requesterBootstrap?.attribution.machineId ?? requesterAdmission?.machineId;
        if (requesterMachineId && typeof machineId === 'string' && machineId !== requesterMachineId) {
            return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Requester Machine target mismatch' };
        }
        if (requesterAdmission || requesterBootstrap) {
            const current = requesterBootstrap
                ? requesterBootstrap.attribution.serverId === params.serverId
                    && await isAdmittedRequesterSessionBootstrapCurrent(context)
                : await canUseCustodianAccountForMachineRequest(context);
            if (context?.signal?.aborted) return cancelled();
            if (!current) return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
                errorMessage: 'Requester Machine admission unavailable' };
        }
        const buildBaseSpawnOptions = (resolvedDirectory: string): SpawnSessionOptions => ({
            ...admittedSpawnOptions,
            ...(context?.requesterSessionBootstrap ? { requesterSessionBootstrap: context.requesterSessionBootstrap } : {}),
            ...(context?.beforeSessionRunnerLaunch ? { beforeSessionRunnerLaunch: context.beforeSessionRunnerLaunch } : {}),
            ...(requesterBootstrap || requesterAdmission ? {
                requesterWorkAttributionV1: RequesterWorkAttributionV1Schema.parse(requesterBootstrap?.attribution ?? {
                    serverId: params.serverId, accountId: requesterAdmission.actorAccountId,
                    machineId: requesterAdmission.machineId, installationId: requesterAdmission.installationId,
                }),
                verifyRequesterMachineAdmissionCurrent: requesterBootstrap
                    ? () => requesterBootstrap.isCurrent() : context!.verifyMachineAdmissionCurrent,
            } : {}),
            directory: resolvedDirectory,
            spawnNonce: normalizedSpawnNonce,
            machineId: typeof machineId === 'string' ? machineId : undefined,
            environmentVariables: normalizedEnvironmentVariables,
            profileId: effectiveProfileId,
            secretReferenceOverlay: effectiveSecretReferenceOverlay,
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
            ...(normalizedInitialAccess !== undefined ? { initialAccess: normalizedInitialAccess } : {}),
            ...(normalizedPrimaryTeamId !== undefined ? { primaryTeamId: normalizedPrimaryTeamId } : {}),
            ...(normalizedTeamCredentialBindings !== undefined
                ? { teamCredentialBindings: normalizedTeamCredentialBindings }
                : {}),
            agentModeId: normalizedAgentModeId,
            agentModeUpdatedAt: normalizedAgentModeUpdatedAt,
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
            ...(!isResumeSessionRequest && !parsedTransportRequest.data.existingSessionId ? {
                ...(normalizedSessionCreationCorrespondence?.recipe.identity !== undefined
                    ? { identity: normalizedSessionCreationCorrespondence.recipe.identity }
                    : parsedIdentity.data !== undefined ? { identity: parsedIdentity.data } : {}),
                ...(normalizedSessionCreationCorrespondence?.recipe.memoryEnabled !== undefined
                    ? { memoryEnabled: normalizedSessionCreationCorrespondence.recipe.memoryEnabled }
                    : parsedMemoryEnabled.data !== undefined ? { memoryEnabled: parsedMemoryEnabled.data } : {}),
            } : {}),
            ...(normalizedAgentSessionStartupInstructionsV1
                ? {
                    agentSessionStartupInstructionsV1:
                        normalizedAgentSessionStartupInstructionsV1,
                }
                : {}),
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
            if (context?.signal?.aborted) return cancelled();
            const result = await params.spawnSession({
                ...(context?.creationAuthorization ? { creationAuthorization: context.creationAuthorization } : {}),
                ...(context?.callerInputConstraints ? { callerInputConstraints: context.callerInputConstraints } : {}),
                ...baseSpawnOptions,
                existingSessionId,
                approvedNewDirectoryCreation: typeof approvedNewDirectoryCreation === 'boolean'
                    ? approvedNewDirectoryCreation
                    : undefined,
            });

            if (result.type === 'error') {
                return result;
            }

            return { type: 'success' };
        }

        if (typeof directory !== 'string' || directory.length === 0) {
            return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST, errorMessage: 'Directory is required' };
        }
        if (!parsedTransportRequest.data.agentTarget && !parsedTransportRequest.data.backendTarget) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Agent target is required for fresh session spawn.',
            };
        }
        const baseSpawnOptions = buildBaseSpawnOptions(directory);
        if (context?.signal?.aborted) return cancelled();
        const result = await params.spawnSession({
            ...(context?.creationAuthorization ? { creationAuthorization: context.creationAuthorization } : {}),
            ...(context?.callerInputConstraints ? { callerInputConstraints: context.callerInputConstraints } : {}),
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
