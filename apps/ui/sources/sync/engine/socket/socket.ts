import type { ApiEphemeralActivityUpdate, ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import type { Encryption } from '@/sync/encryption/encryption';
import type { NormalizedMessage } from '@/sync/typesRaw';
import type { EphemeralUpdate } from '@happier-dev/protocol/updates';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { getActiveViewingSessionId } from '@/sync/domains/session/activeViewingSession';
import type { MachineActivityUpdate } from '@/sync/reducer/machineActivityAccumulator';
import { storage } from '@/sync/domains/state/storage';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { notifyExecutionRunActivity } from '@/sync/runtime/executionRuns/executionRunActivityBus';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { ingestWorkspaceMutationMessages } from '@/scm/refresh/workspaceMutationIngestionRuntime';
import { voiceHooks } from '@/voice/context/voiceHooks';
import { reportNewAgentRequestsFromSessionTransition } from '@/voice/context/reportNewAgentRequestsFromSessionTransition';
import { deriveNewAgentRequests } from '@/sync/domains/permissions/deriveNewAgentRequests';
import { notifyActivityAgentRequest } from '@/activity/notifications/runtime/activityLocalNotificationBus';
import { didControlReturnToMobile } from '@/sync/domains/session/control/controlledByUserTransitions';
import {
    createSessionApplyCoalescer,
    type SessionApplyCoalescerSession,
} from '@/sync/engine/sessions/sessionApplyCoalescer';
import { createSessionMessageApplyCoalescer } from '@/sync/engine/sessions/sessionMessageApplyCoalescer';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';
import {
    buildUpdatedSessionFromSocketUpdate,
    handleDeleteSessionSocketUpdate,
    handleMessageUpdatedSocketUpdate,
    handleNewMessageSocketUpdate,
} from '@/sync/engine/sessions/syncSessions';
import {
    handleTranscriptStreamSegmentEphemeralUpdate,
    type TranscriptStreamSegmentSessionMessageEncryption,
} from '@/sync/engine/sessions/handleTranscriptStreamSegmentEphemeralUpdate';
import {
    buildMachineFromMachineActivityEphemeralUpdate,
    buildUpdatedMachineFromSocketUpdate,
} from '@/sync/engine/machines/syncMachines';
import { handleUpdateAccountSocketUpdate } from '@/sync/engine/account/syncAccount';
import {
    handleDeleteArtifactSocketUpdate,
    handleNewArtifactSocketUpdate,
    handleUpdateArtifactSocketUpdate,
} from '@/sync/engine/artifacts/syncArtifacts';
import {
    handleNewFeedPostUpdate,
    handleRelationshipUpdatedSocketUpdate,
    handleTodoKvBatchUpdate,
} from '@/sync/engine/social/syncFeed';
import { applyAutomationSocketUpdate } from '@/sync/engine/automations/automationSocketApply';
import { normalizeRelationshipUpdatedUpdateBody } from '@/sync/engine/social/relationshipUpdate';
import { parseEphemeralUpdate, parseUpdateContainer } from './socketParse';
import type { DirectSessionTranscriptUpdatedEphemeralUpdate } from './socketParse';
import { FeedBodySchema } from '@/sync/domains/social/feedTypes';
export { parseEphemeralUpdate, parseUpdateContainer } from './socketParse';

type ApplySessions = (sessions: Array<Omit<Session, 'presence'> & { presence?: 'online' | number }>) => void;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(value)));
}

type SocketMessageApplyHandlers = Readonly<{
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    onNormalizedMessagesApplied?: (sessionId: string, messages: NormalizedMessage[]) => void;
    markSessionMaterializedMaxSeq?: (sessionId: string, seq: number) => void;
}>;

let socketMessageApplyHandlers: SocketMessageApplyHandlers | null = null;
let socketSessionApplyHandlers: { applySessions: ApplySessions } | null = null;
const socketSessionApplyTuning = loadSyncTuning();

const socketSessionApplyCoalescer = createSessionApplyCoalescer({
    getConfig: () => ({
        enabled: socketSessionApplyTuning.sessionSocketApplyCoalescingEnabled,
        windowMs: socketSessionApplyTuning.sessionSocketApplyCoalescingWindowMs,
        maxBatchSize: socketSessionApplyTuning.sessionSocketApplyCoalescingMaxBatchSize,
    }),
    applyBatch: (sessions) => {
        socketSessionApplyHandlers?.applySessions(sessions);
    },
});

function setSocketSessionApplyHandler(applySessions: ApplySessions): void {
    if (socketSessionApplyHandlers && socketSessionApplyHandlers.applySessions !== applySessions) {
        socketSessionApplyCoalescer.flushAll();
    }
    socketSessionApplyHandlers = { applySessions };
}

function normalizeSocketSession(session: SessionApplyCoalescerSession): Session {
    return {
        ...session,
        presence: session.presence ?? 'online',
    };
}

function getSocketSessionApplyBase(sessionId: string): Session | undefined {
    const queued = socketSessionApplyCoalescer.getQueuedSession(sessionId);
    if (queued) return normalizeSocketSession(queued);
    return storage.getState().sessions[sessionId];
}

function enqueueSocketSessionApplyGuarded(
    applySessions: ApplySessions,
    sessions: SessionApplyCoalescerSession[],
    shouldContinue: () => boolean,
): void {
    setSocketSessionApplyHandler(applySessions);
    socketSessionApplyCoalescer.enqueue(sessions, { shouldContinue });
}

function flushQueuedSocketSessionApplies(applySessions: ApplySessions, sessionIds: readonly string[]): void {
    setSocketSessionApplyHandler(applySessions);
    socketSessionApplyCoalescer.flushSessionIds(sessionIds);
}

function applySessionsAfterFlushingQueued(applySessions: ApplySessions, sessions: SessionApplyCoalescerSession[]): void {
    flushQueuedSocketSessionApplies(applySessions, sessions.map((session) => session.id));
    applySessions(sessions);
}

const socketMessageApplyCoalescer = createSessionMessageApplyCoalescer({
    getConfig: () => {
        const settings = storage.getState().settings;
        return {
            enabled: settings.transcriptStreamingCoalesceEnabled === true,
            windowMs: clampInt(
                settings.transcriptStreamingCoalesceWindowMs,
                settingsDefaults.transcriptStreamingCoalesceWindowMs,
                0,
                200,
            ),
            maxBatchSize: clampInt(
                settings.transcriptStreamingCoalesceMaxBatchSize,
                settingsDefaults.transcriptStreamingCoalesceMaxBatchSize,
                1,
                2000,
            ),
        };
    },
    applyBatch: (sessionId, messages) => {
        socketMessageApplyHandlers?.applyMessages(sessionId, messages);
    },
    onBatchApplied: (sessionId, messages) => {
        socketMessageApplyHandlers?.onNormalizedMessagesApplied?.(sessionId, messages);

        let maxSeq: number | null = null;
        for (const message of messages) {
            const seq = message.seq;
            if (typeof seq !== 'number' || !Number.isFinite(seq)) continue;
            const normalized = Math.trunc(seq);
            maxSeq = maxSeq === null ? normalized : Math.max(maxSeq, normalized);
        }
        if (maxSeq !== null) {
            socketMessageApplyHandlers?.markSessionMaterializedMaxSeq?.(sessionId, maxSeq);
        }
    },
});

export async function handleSocketUpdate(params: {
    update: unknown;
    encryption: Encryption;
    settingsScope?: AccountSettingsScope | null;
    sourceServerId?: string | null;
    shouldContinue?: () => boolean;
    artifactDataKeys: Map<string, Uint8Array>;
    applySessions: ApplySessions;
    fetchSessions: () => void;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    onSessionVisible: (sessionId: string) => void;
    isSessionMessagesLoaded: (sessionId: string) => boolean;
    getSessionMaterializedMaxSeq: (sessionId: string) => number;
    markSessionMaterializedMaxSeq: (sessionId: string, seq: number) => void;
    onMessageGapDetected: (sessionId: string, info: { prevMaterializedMaxSeq: number; messageSeq: number | null }) => void;
    assumeUsers: (userIds: string[]) => Promise<void>;
    applyTodoSocketUpdates: (changes: any[]) => Promise<void>;
    invalidateMachines: () => void;
    invalidateSessions: () => void;
    invalidateArtifacts: () => void;
    invalidateFriends: () => void;
    invalidateFriendRequests: () => void;
    invalidateFeed: () => void;
    invalidateAutomations: () => void;
    invalidateAutomationsCoalesced?: () => void;
    invalidateTodos: () => void;
    onTaskLifecycleEvent?: (sessionId: string, event: import('@/sync/engine/sessions/taskLifecycle').TaskLifecycleEvent) => void;
    log: { log: (message: string) => void };
}): Promise<void> {
    const {
        update,
        encryption,
        settingsScope,
        sourceServerId,
        shouldContinue = () => true,
        artifactDataKeys,
        applySessions,
        fetchSessions,
        applyMessages,
        onSessionVisible,
        isSessionMessagesLoaded,
        getSessionMaterializedMaxSeq,
        markSessionMaterializedMaxSeq,
        onMessageGapDetected,
        assumeUsers,
        applyTodoSocketUpdates,
        invalidateMachines,
        invalidateSessions,
        invalidateArtifacts,
        invalidateFriends,
        invalidateFriendRequests,
        invalidateFeed,
        invalidateAutomations,
        invalidateAutomationsCoalesced,
        invalidateTodos,
        onTaskLifecycleEvent,
        log,
    } = params;

    const updateData = parseUpdateContainer(update);
    if (!updateData) return;
    if (!shouldContinue()) return;

    await handleUpdateContainer({
        updateData,
        encryption,
        settingsScope,
        sourceServerId,
        shouldContinue,
        artifactDataKeys,
        applySessions,
        fetchSessions,
        applyMessages,
        onSessionVisible,
        isSessionMessagesLoaded,
        getSessionMaterializedMaxSeq,
        markSessionMaterializedMaxSeq,
        onMessageGapDetected,
        assumeUsers,
        applyTodoSocketUpdates,
        invalidateMachines,
        invalidateSessions,
        invalidateArtifacts,
        invalidateFriends,
        invalidateFriendRequests,
        invalidateFeed,
        invalidateAutomations,
        invalidateAutomationsCoalesced,
        invalidateTodos,
        onTaskLifecycleEvent,
        log,
    });
}

export async function handleUpdateContainer(params: {
    updateData: ApiUpdateContainer;
    encryption: Encryption;
    settingsScope?: AccountSettingsScope | null;
    sourceServerId?: string | null;
    shouldContinue?: () => boolean;
    artifactDataKeys: Map<string, Uint8Array>;
    applySessions: ApplySessions;
    fetchSessions: () => void;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    onSessionVisible: (sessionId: string) => void;
    isSessionMessagesLoaded: (sessionId: string) => boolean;
    getSessionMaterializedMaxSeq: (sessionId: string) => number;
    markSessionMaterializedMaxSeq: (sessionId: string, seq: number) => void;
    onMessageGapDetected: (sessionId: string, info: { prevMaterializedMaxSeq: number; messageSeq: number | null }) => void;
    assumeUsers: (userIds: string[]) => Promise<void>;
    applyTodoSocketUpdates: (changes: any[]) => Promise<void>;
    invalidateMachines: () => void;
    invalidateSessions: () => void;
    invalidateArtifacts: () => void;
    invalidateFriends: () => void;
    invalidateFriendRequests: () => void;
    invalidateFeed: () => void;
    invalidateAutomations: () => void;
    invalidateAutomationsCoalesced?: () => void;
    invalidateTodos: () => void;
    onTaskLifecycleEvent?: (sessionId: string, event: import('@/sync/engine/sessions/taskLifecycle').TaskLifecycleEvent) => void;
    log: { log: (message: string) => void };
}): Promise<void> {
    const {
        updateData,
        encryption,
        settingsScope,
        sourceServerId,
        shouldContinue = () => true,
        artifactDataKeys,
        applySessions,
        fetchSessions,
        applyMessages,
        onSessionVisible,
        isSessionMessagesLoaded,
        getSessionMaterializedMaxSeq,
        markSessionMaterializedMaxSeq,
        onMessageGapDetected,
        assumeUsers,
        applyTodoSocketUpdates,
        invalidateMachines,
        invalidateSessions,
        invalidateArtifacts,
        invalidateFriends,
        invalidateFriendRequests,
        invalidateFeed,
        invalidateAutomations,
        invalidateAutomationsCoalesced,
        invalidateTodos,
        onTaskLifecycleEvent,
        log,
    } = params;

    if (!shouldContinue()) return;

    if (updateData.body.t === 'new-message') {
        const getSessionMaterializedMaxSeqForGapDetection = (sessionId: string) =>
            Math.max(
                getSessionMaterializedMaxSeq(sessionId),
                socketMessageApplyCoalescer.getQueuedMaxSeq(sessionId),
            );

        socketMessageApplyHandlers = {
            applyMessages,
            onNormalizedMessagesApplied: ingestWorkspaceMutationMessages,
            markSessionMaterializedMaxSeq,
        };
        await handleNewMessageSocketUpdate({
            updateData,
            getSessionEncryption: (sessionId) => encryption.getSessionEncryption(sessionId),
            getSession: getSocketSessionApplyBase,
            applySessions: (sessions) => {
                if (!shouldContinue()) return;
                applySessionsAfterFlushingQueued(applySessions, sessions);
            },
            fetchSessions: () => {
                if (!shouldContinue()) return;
                fetchSessions();
            },
            applyMessages: (sessionId, messages) => {
                if (!shouldContinue()) return;
                applyMessages(sessionId, messages);
            },
            enqueueMessages: (sessionId, messages) => socketMessageApplyCoalescer.enqueue(sessionId, messages, {
                deferLeadingBatch: getActiveViewingSessionId() !== sessionId,
                shouldContinue,
            }),
            isMutableToolCall: (sessionId, toolUseId) => storage.getState().isMutableToolCall(sessionId, toolUseId),
            invalidateScmStatus: (sessionId) => scmStatusSync.invalidate(sessionId),
            isSessionMessagesLoaded,
            getSessionMaterializedMaxSeq: getSessionMaterializedMaxSeqForGapDetection,
            markSessionMaterializedMaxSeq,
            onMessageGapDetected,
            onTaskLifecycleEvent: onTaskLifecycleEvent
                ? (sessionId, event) => {
                    if (!shouldContinue()) return;
                    onTaskLifecycleEvent(sessionId, event);
                }
                : undefined,
        });
    } else if (updateData.body.t === 'message-updated') {
        const getSessionMaterializedMaxSeqForGapDetection = (sessionId: string) =>
            Math.max(
                getSessionMaterializedMaxSeq(sessionId),
                socketMessageApplyCoalescer.getQueuedMaxSeq(sessionId),
            );

        socketMessageApplyCoalescer.dropQueuedMessageIds(updateData.body.sid, [updateData.body.message.id]);

        await handleMessageUpdatedSocketUpdate({
            updateData,
            getSessionEncryption: (sessionId) => encryption.getSessionEncryption(sessionId),
            getSession: getSocketSessionApplyBase,
            applySessions: (sessions) => {
                if (!shouldContinue()) return;
                applySessionsAfterFlushingQueued(applySessions, sessions);
            },
            fetchSessions: () => {
                if (!shouldContinue()) return;
                fetchSessions();
            },
            applyMessages: (sessionId, messages) => {
                if (!shouldContinue()) return;
                applyMessages(sessionId, messages);
            },
            onNormalizedMessagesApplied: ingestWorkspaceMutationMessages,
            isMutableToolCall: (sessionId, toolUseId) => storage.getState().isMutableToolCall(sessionId, toolUseId),
            invalidateScmStatus: (sessionId) => scmStatusSync.invalidate(sessionId),
            isSessionMessagesLoaded,
            getSessionMaterializedMaxSeq: getSessionMaterializedMaxSeqForGapDetection,
            markSessionMaterializedMaxSeq,
            onMessageGapDetected,
            onTaskLifecycleEvent: onTaskLifecycleEvent
                ? (sessionId, event) => {
                    if (!shouldContinue()) return;
                    onTaskLifecycleEvent(sessionId, event);
                }
                : undefined,
        });
    } else if (updateData.body.t === 'new-session') {
        log.log('🆕 New session update received');
        if (!shouldContinue()) return;
        invalidateSessions();
    } else if (updateData.body.t === 'delete-session') {
        log.log('🗑️ Delete session update received');
        if (!shouldContinue()) return;
        socketSessionApplyCoalescer.dropSessionIds([updateData.body.sid]);
        socketMessageApplyCoalescer.dropSessionIds([updateData.body.sid]);
        handleDeleteSessionSocketUpdate({
            sessionId: updateData.body.sid,
            deleteSession: (sessionId) => storage.getState().deleteSession(sessionId),
            removeSessionEncryption: (sessionId) => encryption.removeSessionEncryption(sessionId),
            removeProjectManagerSession: (sessionId) => projectManager.removeSession(sessionId),
            clearScmStatusForSession: (sessionId) => scmStatusSync.clearForSession(sessionId),
            log,
        });
    } else if (updateData.body.t === 'pending-changed') {
        const sessionId = updateData.body.sid;
        const state = storage.getState();
        const session = getSocketSessionApplyBase(sessionId);
        if (!session) {
            const cachedRenderable = state.sessionListRenderables[sessionId];
            if (cachedRenderable) {
                state.replaceSessionListRenderables([
                    ...Object.values(state.sessionListRenderables).filter((entry) => entry.id !== sessionId),
                    {
                        ...cachedRenderable,
                        pendingCount: updateData.body.pendingCount,
                        pendingVersion: updateData.body.pendingVersion,
                    },
                ]);
                return;
            }

            // If we don't have the session locally yet, sessions sync will pick it up later.
            invalidateSessions();
            return;
        }

        enqueueSocketSessionApplyGuarded(applySessions, [{
            ...session,
            pendingCount: updateData.body.pendingCount,
            pendingVersion: updateData.body.pendingVersion,
        }], shouldContinue);
    } else if (updateData.body.t === 'update-session') {
        const session = getSocketSessionApplyBase(updateData.body.id);
        if (!session) {
            const canPatchRenderableWithoutHydration =
                !updateData.body.metadata
                && !updateData.body.agentState
                && (typeof updateData.body.archivedAt === 'number' || updateData.body.archivedAt === null);
            if (canPatchRenderableWithoutHydration) {
                if (!shouldContinue()) return;
                storage.getState().applySessionListRenderablePatches([
                    {
                        sessionId: updateData.body.id,
                        patch: {
                            archivedAt: updateData.body.archivedAt,
                            updatedAt: updateData.createdAt,
                        },
                    },
                ]);
                return;
            }
            invalidateSessions();
            return;
        }

        const sessionEncryptionMode: 'e2ee' | 'plain' = session.encryptionMode === 'plain' ? 'plain' : 'e2ee';
        const sessionEncryption = sessionEncryptionMode === 'plain'
            ? null
            : encryption.getSessionEncryption(updateData.body.id);
        if (sessionEncryptionMode === 'e2ee' && !sessionEncryption) {
            console.error(`Session encryption not found for ${updateData.body.id} - this should never happen`);
            return;
        }

        const { nextSession, agentState } = await buildUpdatedSessionFromSocketUpdate({
            session,
            updateBody: updateData.body,
            updateSeq: updateData.seq,
            updateCreatedAt: updateData.createdAt,
            sessionEncryption,
        });

        if (!shouldContinue()) return;
        enqueueSocketSessionApplyGuarded(applySessions, [nextSession], shouldContinue);

        // Agent state updates can be very frequent and are not a reliable proxy for SCM changes.
        // SCM refresh cadence is handled by screen-scoped intervals (session/files views) and
        // by explicit invalidations after SCM mutations.
        if (updateData.body.agentState) {
            for (const nextRequest of deriveNewAgentRequests(session.agentState?.requests, agentState?.requests)) {
                notifyActivityAgentRequest({
                    sessionId: updateData.body.id,
                    requestId: nextRequest.requestId,
                    requestKind: nextRequest.requestKind,
                    toolName: nextRequest.toolName,
                    toolArgs: nextRequest.toolArgs,
                });
            }

            // Check for new permission requests and notify voice assistant
            reportNewAgentRequestsFromSessionTransition(
                { id: updateData.body.id, agentState: session.agentState ?? null } as Session,
                { id: updateData.body.id, agentState: agentState ?? null } as Session,
            );

            // Re-fetch messages when control returns to mobile (local -> remote mode switch)
            // This catches up on any messages that were exchanged while desktop had control
            const wasControlledByUser = session.agentState?.controlledByUser;
            const isNowControlledByUser = agentState?.controlledByUser;
            if (didControlReturnToMobile(wasControlledByUser, isNowControlledByUser)) {
                log.log(`🔄 Control returned to mobile for session ${updateData.body.id}, re-fetching messages`);
                onSessionVisible(updateData.body.id);
            }
        }
    } else if (updateData.body.t === 'update-account') {
        const accountUpdate = updateData.body;
        const currentProfile = storage.getState().profile;

        await handleUpdateAccountSocketUpdate({
            accountUpdate,
            updateCreatedAt: updateData.createdAt,
            currentProfile,
            encryption,
            settingsScope,
            applyProfile: (profile) => {
                if (!shouldContinue()) return;
                storage.getState().applyProfile(profile);
            },
            applySettings: (settings, version) => {
                if (!shouldContinue()) return;
                storage.getState().applySettings(settings, version);
            },
            applySettingsForScope: (scope, settings, version) =>
                shouldContinue() ? storage.getState().applySettingsForScope(scope, settings, version) : undefined,
            getLocalSettings: () => storage.getState().settings,
            log,
        });
    } else if (updateData.body.t === 'new-machine') {
        log.log('🖥️ New machine update received');
        const machineUpdate = updateData.body;
        const machineId = machineUpdate.machineId;

        // Initialize machine encryption immediately when possible so the subsequent
        // update-machine event (emitted for backward compatibility) can be decrypted
        // without racing a full machines refresh.
        //
        // NOTE: When the dataEncryptionKey is null, we still initialize with null so
        // the machine has a fallback encryptor available (legacy path).
        const decryptedDataKey =
            typeof (machineUpdate as any).dataEncryptionKey === 'string' && (machineUpdate as any).dataEncryptionKey.length > 0
                ? await encryption.decryptEncryptionKey((machineUpdate as any).dataEncryptionKey)
                : null;
        if (!shouldContinue()) return;
        await encryption.initializeMachines(new Map([[machineId, decryptedDataKey]]));
        if (!shouldContinue()) return;

        // Apply a placeholder immediately so UI state (e.g. onboarding) can react
        // even if machine-activity ephemerals arrive before a full machines refresh.
        storage.getState().applyMachines([{
            id: machineId,
            seq: machineUpdate.seq,
            createdAt: machineUpdate.createdAt,
            updatedAt: machineUpdate.updatedAt,
            active: machineUpdate.active,
            activeAt: machineUpdate.activeAt,
            revokedAt: null,
            metadata: null,
            metadataVersion: machineUpdate.metadataVersion,
            daemonState: null,
            daemonStateVersion: machineUpdate.daemonStateVersion,
        }], false, { sourceServerId });

        // Hydrate machine details + encryption keys via the existing machines sync pipeline.
        invalidateMachines();
    } else if (updateData.body.t === 'update-machine') {
        const machineUpdate = updateData.body;
        const machineId = machineUpdate.machineId; // Changed from .id to .machineId
        const machine = storage.getState().machines[machineId];

        // Machine encryption is derived from the machine's dataEncryptionKey, which can
        // arrive slightly later (e.g. after a machines refresh). Fail closed and
        // trigger a rehydrate instead of logging errors or applying undecryptable updates.
        if (!encryption.getMachineEncryption(machineId)) {
            invalidateMachines();
            return;
        }

        const updatedMachine = await buildUpdatedMachineFromSocketUpdate({
            machineUpdate,
            updateSeq: updateData.seq,
            updateCreatedAt: updateData.createdAt,
            existingMachine: machine,
            getMachineEncryption: (id) => encryption.getMachineEncryption(id),
        });
        if (!updatedMachine) return;
        if (!shouldContinue()) return;

        // Update storage using applyMachines which rebuilds sessionListViewData
        storage.getState().applyMachines([updatedMachine], false, { sourceServerId });
    } else if (updateData.body.t === 'relationship-updated') {
        log.log('👥 Received relationship-updated update');
        const normalized = normalizeRelationshipUpdatedUpdateBody(updateData.body, {
            currentUserId: storage.getState().profile?.id ?? null,
        });
        if (!normalized) {
            invalidateFriends();
            invalidateFriendRequests();
            invalidateFeed();
            return;
        }

        handleRelationshipUpdatedSocketUpdate({
            relationshipUpdate: normalized,
            applyRelationshipUpdate: (update) => {
                if (!shouldContinue()) return;
                storage.getState().applyRelationshipUpdate(update);
            },
            invalidateFriends,
            invalidateFriendRequests,
            invalidateFeed,
        });
    } else if (updateData.body.t === 'new-artifact') {
        log.log('📦 Received new-artifact update');
        const artifactUpdate = updateData.body;
        const artifactId = artifactUpdate.artifactId;

        await handleNewArtifactSocketUpdate({
            artifactId,
            dataEncryptionKey: artifactUpdate.dataEncryptionKey,
            header: artifactUpdate.header,
            headerVersion: artifactUpdate.headerVersion,
            body: artifactUpdate.body,
            bodyVersion: artifactUpdate.bodyVersion,
            seq: artifactUpdate.seq,
            createdAt: artifactUpdate.createdAt,
            updatedAt: artifactUpdate.updatedAt,
            encryption,
            artifactDataKeys,
            addArtifact: (artifact) => {
                if (!shouldContinue()) return;
                storage.getState().addArtifact(artifact);
            },
            log,
        });
    } else if (updateData.body.t === 'update-artifact') {
        log.log('📦 Received update-artifact update');
        const artifactUpdate = updateData.body;
        const artifactId = artifactUpdate.artifactId;

        await handleUpdateArtifactSocketUpdate({
            artifactId,
            createdAt: updateData.createdAt,
            header: artifactUpdate.header,
            body: artifactUpdate.body,
            artifactDataKeys,
            getExistingArtifact: (id) => storage.getState().artifacts[id],
            updateArtifact: (artifact) => {
                if (!shouldContinue()) return;
                storage.getState().updateArtifact(artifact);
            },
            invalidateArtifactsSync: invalidateArtifacts,
            log,
        });
    } else if (updateData.body.t === 'delete-artifact') {
        log.log('📦 Received delete-artifact update');
        const artifactUpdate = updateData.body;
        const artifactId = artifactUpdate.artifactId;

        handleDeleteArtifactSocketUpdate({
            artifactId,
            deleteArtifact: (id) => {
                if (!shouldContinue()) return;
                storage.getState().deleteArtifact(id);
            },
            artifactDataKeys,
        });
    } else if (updateData.body.t === 'new-feed-post') {
        log.log('📰 Received new-feed-post update');
        const feedUpdate = updateData.body;

        const parsedBody = FeedBodySchema.safeParse((feedUpdate as any).body);
        if (!parsedBody.success) {
            invalidateFeed();
            return;
        }

        await handleNewFeedPostUpdate({
            feedUpdate: {
                ...feedUpdate,
                body: parsedBody.data,
            },
            assumeUsers,
            getUsers: () => storage.getState().users,
            shouldContinue,
            applyFeedItems: (items) => {
                if (!shouldContinue()) return;
                storage.getState().applyFeedItems(items);
            },
            log,
        });
    } else if (updateData.body.t === 'kv-batch-update') {
        log.log('📝 Received kv-batch-update');
        const kvUpdate = updateData.body;

        await handleTodoKvBatchUpdate({
            kvUpdate,
            applyTodoSocketUpdates: async (changes) => {
                if (!shouldContinue()) return;
                await applyTodoSocketUpdates(changes);
            },
            invalidateTodosSync: invalidateTodos,
            log,
        });
    } else if (applyAutomationSocketUpdate({
        updateType: updateData.body.t,
        invalidateAutomations,
        invalidateAutomationsCoalesced,
    })) {
        // handled by automation domain
    } else if (
        updateData.body.t === 'session-shared' ||
        updateData.body.t === 'session-share-updated' ||
        updateData.body.t === 'session-share-revoked' ||
        updateData.body.t === 'public-share-created' ||
        updateData.body.t === 'public-share-updated' ||
        updateData.body.t === 'public-share-deleted'
    ) {
        // Sharing changes affect which sessions are visible/accessible and some metadata
        // shown in UI. For now, refresh the session list; sharing screens fetch details
        // via explicit endpoints.
        invalidateSessions();
    }
}

export function flushActivityUpdates(params: {
    updates: Map<string, ApiEphemeralActivityUpdate>;
    applySessions: ApplySessions;
    shouldContinue?: () => boolean;
}): void {
    const { updates, applySessions, shouldContinue = () => true } = params;
    if (!shouldContinue()) return;

    const sessions: Session[] = [];
    const renderablePatches: Array<{
        sessionId: string;
        patch: {
            active: boolean;
            activeAt: number;
            thinking: boolean;
            thinkingAt: number;
            presence: 'online' | number;
            updatedAt: number;
        };
    }> = [];

    for (const [sessionId, update] of updates) {
        const session = storage.getState().sessions[sessionId];
        if (session) {
            const nextThinking = update.thinking ?? false;
            const isTurningOff = update.active === false && nextThinking === false;
            const isThinkingResurrection = nextThinking === true && session.thinking !== true;

            // Most activity ephemerals should be ignored when they predate a newer durable/lifecycle update
            // (for example a recent turn_aborted/task_complete clear). Otherwise old "thinking=true" ephemerals
            // can resurrect a completed session into a stuck state.
            //
            // Exception: when we receive a "turn off" activity update (active=false, thinking=false), apply it
            // even if it predates session.updatedAt, as long as it is not older than the session's last-known
            // activity timestamp. This prevents "session ended" updates from being dropped when a terminal
            // shutdown message (or similar durable update) bumps updatedAt slightly after activeAt.
            if (isTurningOff) {
                if (update.activeAt < session.activeAt) continue;
            } else {
                // Be slightly stricter when an activity update would re-enable thinking, because some
                // server clocks/reporting paths can produce equal timestamps for the lifecycle clear and
                // the older "thinking=true" activity update. Using `<=` here prevents resurrecting sessions
                // into a stuck "working" state after the turn has completed.
                if (isThinkingResurrection) {
                    if (update.activeAt <= session.updatedAt) continue;
                } else {
                    if (update.activeAt < session.updatedAt) continue;
                }
            }
            sessions.push({
                ...session,
                active: update.active,
                activeAt: update.activeAt,
                thinking: nextThinking,
                thinkingAt: update.activeAt, // Always use activeAt for consistency
            });
            continue;
        }

        const renderable = storage.getState().sessionListRenderables[sessionId];
        if (renderable) {
            const nextThinking = update.thinking ?? false;
            const isTurningOff = update.active === false && nextThinking === false;
            if (isTurningOff) {
                if (update.activeAt < renderable.activeAt) continue;
            } else if (update.activeAt < renderable.updatedAt) {
                continue;
            }
            renderablePatches.push({
                sessionId,
                patch: {
                    active: update.active,
                    activeAt: update.activeAt,
                    thinking: nextThinking,
                    thinkingAt: update.activeAt,
                    presence: update.active ? 'online' : update.activeAt,
                    updatedAt: update.activeAt,
                },
            });
        }
    }

    if (sessions.length > 0) {
        if (!shouldContinue()) return;
        applySessionsAfterFlushingQueued(applySessions, sessions);
    }
    if (renderablePatches.length > 0) {
        if (!shouldContinue()) return;
        storage.getState().applySessionListRenderablePatches(renderablePatches);
    }
}

export function flushMachineActivityUpdates(params: {
    updates: Map<string, MachineActivityUpdate>;
    applyMachines: (machines: Machine[], options?: { sourceServerId?: string | null }) => void;
    sourceServerId?: string | null;
    shouldContinue?: () => boolean;
}): void {
    const { updates, applyMachines, sourceServerId, shouldContinue = () => true } = params;
    if (!shouldContinue()) return;
    const machines: Machine[] = [];

    for (const [, updateData] of updates) {
        const existing = storage.getState().machines[updateData.id];
        const machine: Machine = existing ?? {
            id: updateData.id,
            seq: 0,
            createdAt: updateData.activeAt,
            updatedAt: updateData.activeAt,
            active: updateData.active,
            activeAt: updateData.activeAt,
            revokedAt: null,
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };
        machines.push(buildMachineFromMachineActivityEphemeralUpdate({ machine, updateData }));
    }

    if (machines.length > 0) {
        if (!shouldContinue()) return;
        applyMachines(machines, { sourceServerId });
    }
}

export function handleEphemeralSocketUpdate(params: {
    update: unknown;
    shouldContinue?: () => boolean;
    addActivityUpdate: (update: ApiEphemeralActivityUpdate) => void;
    addMachineActivityUpdate: (update: MachineActivityUpdate) => void;
    getSessionEncryption: (sessionId: string) => TranscriptStreamSegmentSessionMessageEncryption | null;
    getSession: (sessionId: string) => Session | undefined;
    applyMessages: (sessionId: string, messages: NormalizedMessage[]) => void;
    updateDirectSessionTranscript?: (update: DirectSessionTranscriptUpdatedEphemeralUpdate) => Promise<void> | void;
}): Promise<void> {
    const {
        update,
        shouldContinue = () => true,
        addActivityUpdate,
        addMachineActivityUpdate,
        getSessionEncryption,
        getSession,
        applyMessages,
        updateDirectSessionTranscript,
    } = params;

    const updateData = parseEphemeralUpdate(update);
    if (!updateData) return Promise.resolve();
    if (!shouldContinue()) return Promise.resolve();

    // Process activity updates through smart debounce accumulator
    if (updateData.type === 'activity') {
        if (!shouldContinue()) return Promise.resolve();
        addActivityUpdate(updateData);
    } else if (updateData.type === 'machine-activity') {
        // Handle machine activity updates through batching accumulator
        if (!shouldContinue()) return Promise.resolve();
        addMachineActivityUpdate({ id: updateData.id, active: updateData.active, activeAt: updateData.activeAt });
    } else if (updateData.type === 'execution-run-updated') {
        if (!shouldContinue()) return Promise.resolve();
        notifyExecutionRunActivity(updateData.sessionId);
    } else if (updateData.type === 'direct-session-transcript-delta') {
        if (!shouldContinue()) return Promise.resolve();
        return Promise.resolve(updateDirectSessionTranscript?.(updateData));
    } else if (updateData.type === 'transcript-stream-segment') {
        const currentApplyHandlers = socketMessageApplyHandlers;
        socketMessageApplyHandlers = {
            applyMessages,
            ...(currentApplyHandlers?.onNormalizedMessagesApplied
                ? { onNormalizedMessagesApplied: currentApplyHandlers.onNormalizedMessagesApplied }
                : {}),
            ...(currentApplyHandlers?.markSessionMaterializedMaxSeq
                ? { markSessionMaterializedMaxSeq: currentApplyHandlers.markSessionMaterializedMaxSeq }
                : {}),
        };
        return handleTranscriptStreamSegmentEphemeralUpdate({
            update: updateData,
            getSessionEncryption,
            getSession,
            applyMessages: (sessionId, messages) => socketMessageApplyCoalescer.enqueue(sessionId, messages, {
                deferLeadingBatch: getActiveViewingSessionId() !== sessionId,
                shouldContinue,
            }),
        });
    }

    // daemon-status ephemeral updates are deprecated, machine status is handled via machine-activity
    return Promise.resolve();
}
