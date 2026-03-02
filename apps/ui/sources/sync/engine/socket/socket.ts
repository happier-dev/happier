import type { ApiEphemeralActivityUpdate, ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import type { Encryption } from '@/sync/encryption/encryption';
import type { NormalizedMessage } from '@/sync/typesRaw';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { MachineActivityUpdate } from '@/sync/reducer/machineActivityAccumulator';
import { storage } from '@/sync/domains/state/storage';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { ingestWorkspaceMutationMessages } from '@/scm/refresh/workspaceMutationIngestionRuntime';
import { voiceHooks } from '@/voice/context/voiceHooks';
import { deriveNewPermissionRequests } from '@/sync/domains/permissions/deriveNewPermissionRequests';
import { didControlReturnToMobile } from '@/sync/domains/session/control/controlledByUserTransitions';
import { createSessionMessageApplyCoalescer } from '@/sync/engine/sessions/sessionMessageApplyCoalescer';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import {
    buildUpdatedSessionFromSocketUpdate,
    handleDeleteSessionSocketUpdate,
    handleNewMessageSocketUpdate,
} from '@/sync/engine/sessions/syncSessions';
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
    invalidateTodos: () => void;
    onTaskLifecycleEvent?: (sessionId: string, event: import('@/sync/engine/sessions/taskLifecycle').TaskLifecycleEvent) => void;
    log: { log: (message: string) => void };
}): Promise<void> {
    const {
        update,
        encryption,
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
        invalidateTodos,
        onTaskLifecycleEvent,
        log,
    } = params;

    const updateData = parseUpdateContainer(update);
    if (!updateData) return;

    await handleUpdateContainer({
        updateData,
        encryption,
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
        invalidateTodos,
        onTaskLifecycleEvent,
        log,
    });
}

export async function handleUpdateContainer(params: {
    updateData: ApiUpdateContainer;
    encryption: Encryption;
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
    invalidateTodos: () => void;
    onTaskLifecycleEvent?: (sessionId: string, event: import('@/sync/engine/sessions/taskLifecycle').TaskLifecycleEvent) => void;
    log: { log: (message: string) => void };
}): Promise<void> {
    const {
        updateData,
        encryption,
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
        invalidateTodos,
        onTaskLifecycleEvent,
        log,
    } = params;

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
            getSession: (sessionId) => storage.getState().sessions[sessionId],
            applySessions: (sessions) => applySessions(sessions),
            fetchSessions,
            applyMessages,
            enqueueMessages: (sessionId, messages) => socketMessageApplyCoalescer.enqueue(sessionId, messages),
            isMutableToolCall: (sessionId, toolUseId) => storage.getState().isMutableToolCall(sessionId, toolUseId),
            invalidateScmStatus: (sessionId) => scmStatusSync.invalidate(sessionId),
            isSessionMessagesLoaded,
            getSessionMaterializedMaxSeq: getSessionMaterializedMaxSeqForGapDetection,
            markSessionMaterializedMaxSeq,
            onMessageGapDetected,
            onTaskLifecycleEvent,
        });
    } else if (updateData.body.t === 'new-session') {
        log.log('🆕 New session update received');
        invalidateSessions();
    } else if (updateData.body.t === 'delete-session') {
        log.log('🗑️ Delete session update received');
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
        const session = storage.getState().sessions[sessionId];
        if (!session) {
            // If we don't have the session locally yet, sessions sync will pick it up later.
            invalidateSessions();
            return;
        }

        applySessions([{
            ...session,
            pendingCount: updateData.body.pendingCount,
            pendingVersion: updateData.body.pendingVersion,
        }]);
    } else if (updateData.body.t === 'update-session') {
        const session = storage.getState().sessions[updateData.body.id];
        if (session) {
            // Get session encryption
            const sessionEncryption = encryption.getSessionEncryption(updateData.body.id);
            if (!sessionEncryption) {
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

            applySessions([nextSession]);

            // Agent state updates can be very frequent and are not a reliable proxy for SCM changes.
            // SCM refresh cadence is handled by screen-scoped intervals (session/files views) and
            // by explicit invalidations after SCM mutations.
            if (updateData.body.agentState) {
                // Check for new permission requests and notify voice assistant
                for (const nextRequest of deriveNewPermissionRequests(session.agentState?.requests, agentState?.requests)) {
                    voiceHooks.onPermissionRequested(
                        updateData.body.id,
                        nextRequest.requestId,
                        nextRequest.toolName,
                        nextRequest.toolArgs,
                    );
                }

                // Re-fetch messages when control returns to mobile (local -> remote mode switch)
                // This catches up on any messages that were exchanged while desktop had control
                const wasControlledByUser = session.agentState?.controlledByUser;
                const isNowControlledByUser = agentState?.controlledByUser;
                if (didControlReturnToMobile(wasControlledByUser, isNowControlledByUser)) {
                    log.log(`🔄 Control returned to mobile for session ${updateData.body.id}, re-fetching messages`);
                    onSessionVisible(updateData.body.id);
                }
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
            applyProfile: (profile) => storage.getState().applyProfile(profile),
            applySettings: (settings, version) => storage.getState().applySettings(settings, version),
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
        await encryption.initializeMachines(new Map([[machineId, decryptedDataKey]]));

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
        }]);

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

        // Update storage using applyMachines which rebuilds sessionListViewData
        storage.getState().applyMachines([updatedMachine]);
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
            applyRelationshipUpdate: (update) => storage.getState().applyRelationshipUpdate(update),
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
            addArtifact: (artifact) => storage.getState().addArtifact(artifact),
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
            updateArtifact: (artifact) => storage.getState().updateArtifact(artifact),
            invalidateArtifactsSync: invalidateArtifacts,
            log,
        });
    } else if (updateData.body.t === 'delete-artifact') {
        log.log('📦 Received delete-artifact update');
        const artifactUpdate = updateData.body;
        const artifactId = artifactUpdate.artifactId;

        handleDeleteArtifactSocketUpdate({
            artifactId,
            deleteArtifact: (id) => storage.getState().deleteArtifact(id),
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
            applyFeedItems: (items) => storage.getState().applyFeedItems(items),
            log,
        });
    } else if (updateData.body.t === 'kv-batch-update') {
        log.log('📝 Received kv-batch-update');
        const kvUpdate = updateData.body;

        await handleTodoKvBatchUpdate({
            kvUpdate,
            applyTodoSocketUpdates,
            invalidateTodosSync: invalidateTodos,
            log,
        });
    } else if (applyAutomationSocketUpdate({
        updateType: updateData.body.t,
        invalidateAutomations,
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

export function flushActivityUpdates(params: { updates: Map<string, ApiEphemeralActivityUpdate>; applySessions: ApplySessions }): void {
    const { updates, applySessions } = params;

    const sessions: Session[] = [];

    for (const [sessionId, update] of updates) {
        const session = storage.getState().sessions[sessionId];
        if (session) {
            // Ignore stale activity updates that predate a newer durable/lifecycle update
            // (for example a recent turn_aborted/task_complete clear). Otherwise old
            // "thinking=true" ephemerals can resurrect a completed session into a stuck state.
            if (update.activeAt < session.updatedAt) {
                continue;
            }
            sessions.push({
                ...session,
                active: update.active,
                activeAt: update.activeAt,
                thinking: update.thinking ?? false,
                thinkingAt: update.activeAt, // Always use activeAt for consistency
            });
        }
    }

    if (sessions.length > 0) {
        applySessions(sessions);
    }
}

export function flushMachineActivityUpdates(params: {
    updates: Map<string, MachineActivityUpdate>;
    applyMachines: (machines: Machine[]) => void;
}): void {
    const { updates, applyMachines } = params;
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
        applyMachines(machines);
    }
}

export function handleEphemeralSocketUpdate(params: {
    update: unknown;
    addActivityUpdate: (update: ApiEphemeralActivityUpdate) => void;
    addMachineActivityUpdate: (update: MachineActivityUpdate) => void;
}): void {
    const { update, addActivityUpdate, addMachineActivityUpdate } = params;

    const updateData = parseEphemeralUpdate(update);
    if (!updateData) return;

    // Process activity updates through smart debounce accumulator
    if (updateData.type === 'activity') {
        addActivityUpdate(updateData);
    } else if (updateData.type === 'machine-activity') {
        // Handle machine activity updates through batching accumulator
        addMachineActivityUpdate({ id: updateData.id, active: updateData.active, activeAt: updateData.activeAt });
    }

    // daemon-status ephemeral updates are deprecated, machine status is handled via machine-activity
}
