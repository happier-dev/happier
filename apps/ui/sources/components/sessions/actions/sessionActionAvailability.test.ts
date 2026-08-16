import { describe, expect, it } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { deriveSessionRuntimePresentationState } from '@/sync/domains/session/attention/deriveSessionRuntimePresentationState';

import { createSessionActionTarget } from './sessionActionContext';
import {
    SESSION_ACTION_ARCHIVE_ID,
    SESSION_ACTION_DELETE_ID,
    SESSION_ACTION_MOVE_TO_FOLDER_ID,
    SESSION_ACTION_MARK_UNREAD_ID,
    SESSION_ACTION_RENAME_ID,
    SESSION_ACTION_RESUME_ID,
    SESSION_ACTION_STOP_ID,
} from './sessionActionIds';
import { listVisibleSessionActionIds } from './sessionActionAvailability';

function createOwnedRawSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session_1',
        active: false,
        owner: 'current_user',
        accessLevel: undefined,
        seq: 4,
        lastViewedSessionSeq: 4,
        latestTurnStatus: 'completed',
        createdAt: 1,
        updatedAt: 1,
        activeAt: 0,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 0,
        ...overrides,
    };
}

describe('session action availability', () => {
    it('offers standalone Resume only for an inactive resumable session', () => {
        const createTarget = (overrides: Partial<Session>) => createSessionActionTarget({
            session: createOwnedRawSession(overrides),
            currentUserId: 'current_user',
            isConnected: overrides.active === true,
            resumeCapabilityOptions: { accountSettings: {} },
        });
        const resumableTarget = createTarget({
            active: false,
            metadata: {
                path: '/workspace',
                host: 'machine',
                flavor: 'claude',
                claudeSessionId: 'claude_vendor_session',
            },
        });
        const activeTarget = createTarget({
            active: true,
            metadata: {
                path: '/workspace',
                host: 'machine',
                flavor: 'claude',
                claudeSessionId: 'claude_vendor_session',
            },
        });
        const nonResumableTarget = createTarget({
            active: false,
            metadata: { path: '/workspace', host: 'machine', flavor: 'unknown-provider' },
        });

        expect(listVisibleSessionActionIds({ target: resumableTarget, surface: 'sessionHeader' }))
            .toContain(SESSION_ACTION_RESUME_ID);
        expect(listVisibleSessionActionIds({ target: activeTarget, surface: 'sessionHeader' }))
            .not.toContain(SESSION_ACTION_RESUME_ID);
        expect(listVisibleSessionActionIds({ target: nonResumableTarget, surface: 'sessionHeader' }))
            .not.toContain(SESSION_ACTION_RESUME_ID);
    });

    it('keeps a created-but-unregistered row non-working and hides Stop without terminal-host evidence', () => {
        const session = createOwnedRawSession({
            resumingAt: 900,
            runtimeActivityState: 'unknown',
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: null,
            runtimeActivityRevision: 0,
        });
        const target = createSessionActionTarget({
            session,
            currentUserId: 'current_user',
            isConnected: false,
        });
        const presentation = deriveSessionRuntimePresentationState(session, 1_000);

        expect(presentation).toMatchObject({
            isActive: false,
            working: false,
            backgroundActive: false,
            activityState: 'idle',
        });
        expect(listVisibleSessionActionIds({ target, surface: 'rowMenu' })).not.toContain(SESSION_ACTION_STOP_ID);
        expect(listVisibleSessionActionIds({ target, surface: 'sessionInfo' })).not.toContain(SESSION_ACTION_STOP_ID);
    });

    it('keeps session-info shared actions as a superset of row lifecycle actions', () => {
        const session: SessionListRenderableSession = {
            id: 'session_1',
            active: true,
            archivedAt: null,
            owner: 'user_1',
            accessLevel: undefined,
            seq: 4,
            lastViewedSessionSeq: 4,
            latestTurnStatus: 'completed',
            createdAt: 1,
            updatedAt: 1,
            activeAt: 1,
            metadataVersion: 1,
            agentStateVersion: 1,
            metadata: null,
            thinking: false,
            thinkingAt: 0,
            presence: 1,
        };
        const target = createSessionActionTarget({
            session,
            serverId: 'server_1',
            currentUserId: 'user_1',
            isConnected: true,
            isPinned: false,
        });

        const rowLifecycleActionIds = listVisibleSessionActionIds({
            target,
            surface: 'rowMenu',
        }).filter((id) => id !== SESSION_ACTION_MOVE_TO_FOLDER_ID);
        const infoActionIds = listVisibleSessionActionIds({
            target,
            surface: 'sessionInfo',
        });

        expect(rowLifecycleActionIds).toEqual([
            SESSION_ACTION_MARK_UNREAD_ID,
            SESSION_ACTION_RENAME_ID,
            SESSION_ACTION_STOP_ID,
            SESSION_ACTION_ARCHIVE_ID,
        ]);
        expect(infoActionIds).toEqual(expect.arrayContaining(rowLifecycleActionIds));
    });

    it('shows session-info delete only for inactive sessions owned by the current user', () => {
        const sharedSession: SessionListRenderableSession = {
            id: 'shared_session',
            active: false,
            archivedAt: null,
            owner: 'owner_user',
            accessLevel: 'view',
            seq: 4,
            lastViewedSessionSeq: 4,
            latestTurnStatus: 'completed',
            createdAt: 1,
            updatedAt: 1,
            activeAt: 0,
            metadataVersion: 1,
            agentStateVersion: 1,
            metadata: null,
            thinking: false,
            thinkingAt: 0,
            presence: 1,
        };
        const ownedSession: SessionListRenderableSession = {
            ...sharedSession,
            id: 'owned_session',
            owner: 'current_user',
            accessLevel: undefined,
        };

        const sharedTarget = createSessionActionTarget({
            session: sharedSession,
            currentUserId: null,
            isConnected: false,
            isPinned: false,
        });
        const ownedTarget = createSessionActionTarget({
            session: ownedSession,
            currentUserId: 'current_user',
            isConnected: false,
            isPinned: false,
        });
        const adminTarget = createSessionActionTarget({
            session: { ...sharedSession, accessLevel: 'admin' },
            currentUserId: 'current_user',
            isConnected: false,
            isPinned: false,
        });
        const activeTarget = createSessionActionTarget({
            session: { ...ownedSession, active: true },
            currentUserId: 'current_user',
            isConnected: false,
            isPinned: false,
        });
        const connectedTarget = createSessionActionTarget({
            session: ownedSession,
            currentUserId: 'current_user',
            isConnected: true,
            isPinned: false,
        });

        expect(listVisibleSessionActionIds({ target: sharedTarget, surface: 'sessionInfo' })).not.toContain(SESSION_ACTION_DELETE_ID);
        expect(listVisibleSessionActionIds({ target: ownedTarget, surface: 'sessionInfo' })).toContain(SESSION_ACTION_DELETE_ID);
        expect(listVisibleSessionActionIds({ target: adminTarget, surface: 'sessionInfo' })).not.toContain(SESSION_ACTION_DELETE_ID);
        expect(listVisibleSessionActionIds({ target: activeTarget, surface: 'sessionInfo' })).not.toContain(SESSION_ACTION_DELETE_ID);
        expect(listVisibleSessionActionIds({ target: connectedTarget, surface: 'sessionInfo' })).not.toContain(SESSION_ACTION_DELETE_ID);
    });

    it('keeps missing Activity quiet while offering Stop for an exact control-serviceable host', () => {
        const session = createOwnedRawSession({
            metadata: {
                path: '',
                host: 'local',
                terminal: {
                    mode: 'zellij',
                    controlServiceabilityV1: {
                        v: 1,
                        attachmentId: 'attachment-serviceable',
                        state: 'servable',
                        observedAt: 123,
                    },
                },
            },
            runtimeActivityState: null,
            runtimeActivityActiveCount: 0,
            runtimeActivityObservedAt: null,
            runtimeActivityRevision: 0,
        });
        const target = createSessionActionTarget({
            session,
            currentUserId: 'current_user',
            isConnected: false,
        });
        const presentation = deriveSessionRuntimePresentationState(session, 1_000);

        expect(presentation.activityState).toBe('idle');
        expect(presentation.working).toBe(false);
        expect(listVisibleSessionActionIds({ target, surface: 'sessionInfo' })).toContain(SESSION_ACTION_STOP_ID);
        expect(listVisibleSessionActionIds({ target, surface: 'rowMenu' })).toContain(SESSION_ACTION_STOP_ID);
        expect(target.canDelete).toBe(false);
    });

    it('offers canonical Stop for an exact recoverable preserved terminal host', () => {
        const session = createOwnedRawSession({
            id: 'recoverable_session',
            metadata: {
                path: '',
                host: 'local',
                terminal: {
                    mode: 'zellij',
                    controlServiceabilityV1: {
                        v: 1,
                        attachmentId: 'attachment-preserved',
                        state: 'recoverable_unservable',
                        observedAt: 123,
                        reason: 'control_descriptor_missing',
                    },
                },
            },
        });
        const target = createSessionActionTarget({
            session,
            currentUserId: 'current_user',
            isConnected: false,
        });

        expect(listVisibleSessionActionIds({ target, surface: 'sessionInfo' })).toContain(SESSION_ACTION_STOP_ID);
        expect(listVisibleSessionActionIds({ target, surface: 'rowMenu' })).toContain(SESSION_ACTION_STOP_ID);
        expect(target.canDelete).toBe(false);
    });

    it('withholds Delete without exposing Stop for an exact unknown preserved terminal host', () => {
        const createTargetForEvidence = (
            controlServiceabilityV1: NonNullable<NonNullable<Session['metadata']>['terminal']>['controlServiceabilityV1'],
        ) => createSessionActionTarget({
            session: createOwnedRawSession({
                metadata: {
                    path: '',
                    host: 'local',
                    terminal: {
                        mode: 'zellij',
                        controlServiceabilityV1,
                    },
                },
            }),
            currentUserId: 'current_user',
            isConnected: false,
        });

        const target = createTargetForEvidence({
            v: 1,
            attachmentId: 'attachment-unknown',
            state: 'unknown',
            observedAt: 124,
            reason: 'attachment_changed',
        });

        expect(listVisibleSessionActionIds({ target, surface: 'sessionInfo' })).not.toContain(SESSION_ACTION_STOP_ID);
        expect(listVisibleSessionActionIds({ target, surface: 'sessionInfo' })).not.toContain(SESSION_ACTION_DELETE_ID);
        expect(target.canDelete).toBe(false);
    });

    it('fails Delete closed for non-retired terminal evidence even when its attachment descriptor is missing', () => {
        const createTargetForEvidence = (
            controlServiceabilityV1: NonNullable<NonNullable<Session['metadata']>['terminal']>['controlServiceabilityV1'],
        ) => createSessionActionTarget({
            session: createOwnedRawSession({
                metadata: {
                    path: '',
                    host: 'local',
                    terminal: {
                        mode: 'zellij',
                        controlServiceabilityV1,
                    },
                },
            }),
            currentUserId: 'current_user',
            isConnected: false,
        });

        const preservedTargets = [
            createTargetForEvidence({
                v: 1,
                state: 'recoverable_unservable',
                observedAt: 123,
                reason: 'control_descriptor_missing',
            }),
            createTargetForEvidence({
                v: 1,
                attachmentId: '   ',
                state: 'unknown',
                observedAt: 124,
                reason: 'attachment_changed',
            }),
        ];

        for (const target of preservedTargets) {
            expect(listVisibleSessionActionIds({ target, surface: 'sessionInfo' })).not.toContain(SESSION_ACTION_STOP_ID);
            expect(listVisibleSessionActionIds({ target, surface: 'sessionInfo' })).not.toContain(SESSION_ACTION_DELETE_ID);
            expect(target.canDelete).toBe(false);
        }

        const retiredTarget = createTargetForEvidence({
            v: 1,
            attachmentId: 'attachment-retired',
            state: 'recoverable_unservable',
            observedAt: 125,
            reason: 'attachment_retired',
            retired: true,
        });
        expect(listVisibleSessionActionIds({ target: retiredTarget, surface: 'sessionInfo' })).toContain(SESSION_ACTION_DELETE_ID);
        expect(retiredTarget.canDelete).toBe(true);
    });
});
