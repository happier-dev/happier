import { createSessionAccessFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { describe, expect, it } from 'vitest';

import { buildSessionListRenderableFromSession, type SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';

import { createSessionActionTarget } from './sessionActionContext';
import {
    SESSION_ACTION_SET_APPEARANCE_COLOR_ID,
    SESSION_ACTION_PIN_ID,
    SESSION_ACTION_UNPIN_ID,
    SESSION_ACTION_ARCHIVE_ID,
    SESSION_ACTION_DELETE_ID,
    SESSION_ACTION_MOVE_TO_FOLDER_ID,
    SESSION_ACTION_MARK_UNREAD_ID,
    SESSION_ACTION_PUT_UNDER_ID,
    SESSION_ACTION_RENAME_ID,
    SESSION_ACTION_RESUME_ID,
    SESSION_ACTION_STOP_ID,
} from './sessionActionIds';
import { listVisibleSessionActionIds } from './sessionActionAvailability';
import { createSessionActionDropdownItem } from './sessionActionPresentation';

function createOwnedRawSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session_resume',
        active: false,
        archivedAt: null,
        owner: 'current_user',
        access: createSessionAccessFixture(),
        seq: 4,
        lastViewedSessionSeq: 4,
        latestTurnStatus: 'completed',
        createdAt: 1,
        updatedAt: 1,
        activeAt: 0,
        metadataLayoutVersion: 1,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: { path: '/shared', host: 'shared' },
        ownerMetadataView: { path: '/shared', host: 'shared' },
        agentState: null,
        thinking: false,
        thinkingAt: 0,
        presence: 0,
        ...overrides,
    };
}

describe('session action availability', () => {
    it.each(['sessionInfo', 'sessionHeader', 'rowMenu', 'nativeContextMenu'] as const)(
        'offers the stop-and-delete intent separately from immediate deletion on %s', surface => {
        const session = createOwnedRawSession({ active: true });
        const target = createSessionActionTarget({ session, serverId: 'home', isConnected: true });
        expect(target).toMatchObject({ canDelete: false, canStopAndDelete: true });
        expect(listVisibleSessionActionIds({ target, surface })).toContain(SESSION_ACTION_DELETE_ID);
        expect(listVisibleSessionActionIds({ target, surface: 'selectionActionBar' })).not.toContain(SESSION_ACTION_DELETE_ID);
        const noStop = createSessionActionTarget({ session: { ...session,
            access: createSessionAccessFixture('owner', { stopSession: false }) }, serverId: 'home', isConnected: true });
        expect(listVisibleSessionActionIds({ target: noStop, surface })).not.toContain(SESSION_ACTION_DELETE_ID);
        const shared = createSessionActionTarget({ session: { ...session, access: createSessionAccessFixture('admin') },
            serverId: 'home', isConnected: true });
        expect(listVisibleSessionActionIds({ target: shared, surface })).not.toContain(SESSION_ACTION_DELETE_ID);
    });

    it('uses readable archived owner-row metadata without weakening explicit terminal preservation', () => {
        const row = createSessionListRenderableSessionFixture({ archivedAt: 42, active: false,
            metadataLayoutVersion: 1, metadata: { path: '/repo', host: 'tester.local' } });
        const target = createSessionActionTarget({ session: row, serverId: 'home', isConnected: false });
        expect(target.canDelete).toBe(true);
        expect(listVisibleSessionActionIds({ target, surface: 'rowMenu' })).toContain(SESSION_ACTION_DELETE_ID);
        expect(createSessionActionTarget({ session: { ...row, metadata: { ...row.metadata, path: '/repo',
            terminalControlServiceabilityV1: { v: 1, state: 'recoverable_unservable', observedAt: 123 },
        } }, serverId: 'home', isConnected: false }).canDelete).toBe(false);
    });

    it.each(['sessionInfo', 'sessionHeader', 'rowMenu', 'nativeContextMenu'] as const)('offers Delete for eligible stopped sessions on %s', (surface) => {
        const session = createOwnedRawSession({ archivedAt: 42 });
        const target = createSessionActionTarget({ session, serverId: 'home', isConnected: false });
        expect(listVisibleSessionActionIds({ target, surface })).toContain(SESSION_ACTION_DELETE_ID);
        expect(listVisibleSessionActionIds({ target: { ...target, isArchived: false }, surface })).toContain(SESSION_ACTION_DELETE_ID);
        expect(listVisibleSessionActionIds({ target: { ...target, canDelete: false }, surface })).not.toContain(SESSION_ACTION_DELETE_ID);
    });

    it.each([false, true])('offers the current list pin action in the session header (pinned=%s)', (isPinned) => {
        const target = createSessionActionTarget({ session: createOwnedRawSession(), serverId: 'home', isConnected: true, isPinned });
        const ids = listVisibleSessionActionIds({ target, surface: 'sessionHeader' });
        expect(ids).toContain(isPinned ? SESSION_ACTION_UNPIN_ID : SESSION_ACTION_PIN_ID);
        expect(ids).not.toContain(isPinned ? SESSION_ACTION_PIN_ID : SESSION_ACTION_UNPIN_ID);
        expect(listVisibleSessionActionIds({ target: { ...target, isArchived: true }, surface: 'sessionHeader' }))
            .not.toContain(isPinned ? SESSION_ACTION_UNPIN_ID : SESSION_ACTION_PIN_ID);
    });

    it('offers Make coordinator on a plain session, and Edit/Stop greyed with reasons on one that only manages', () => {
        const coordinatorIds = (session: Session) => listVisibleSessionActionIds({
            target: createSessionActionTarget({ session, serverId: 'home', isConnected: true }), surface: 'rowMenu',
        }).filter((id) => id.startsWith('ui.session.coordinator.'));
        expect(coordinatorIds(createOwnedRawSession({ receivedRuleCount: 0, managedSessions: { total: 0 } } as Partial<Session>)))
            .toEqual(['ui.session.coordinator.make']);
        // Unknown relation counts never guess: no coordinator entries at all.
        expect(coordinatorIds(createOwnedRawSession())).toEqual([]);

        const managing = createSessionActionTarget({ session: createOwnedRawSession({ receivedRuleCount: 0, managedSessions: { total: 3 } } as Partial<Session>),
            serverId: 'home', isConnected: true });
        expect(listVisibleSessionActionIds({ target: managing, surface: 'sessionHeader' }).filter((id) => id.startsWith('ui.session.coordinator.')))
            .toEqual(['ui.session.coordinator.make', 'ui.session.coordinator.edit', 'ui.session.coordinator.answers', 'ui.session.coordinator.stop']);
        // "Answers its workers' questions" is the coordinator's one toggle, on unless the session turned it off.
        expect(createSessionActionDropdownItem({ actionId: 'ui.session.coordinator.answers', target: managing, iconColor: '#000' }))
            .toMatchObject({ checked: true });
        const item = (actionId: 'ui.session.coordinator.make' | 'ui.session.coordinator.stop') =>
            createSessionActionDropdownItem({ actionId, target: managing, iconColor: '#000' });
        expect(item('ui.session.coordinator.make')).toMatchObject({ disabled: true });
        expect(item('ui.session.coordinator.stop')).toMatchObject({ disabled: true });

        const following = createSessionActionTarget({ session: createOwnedRawSession({ receivedRuleCount: 2, managedSessions: { total: 0 } } as Partial<Session>),
            serverId: 'home', isConnected: true });
        expect(createSessionActionDropdownItem({ actionId: 'ui.session.coordinator.stop', target: following, iconColor: '#000' })?.disabled).toBeUndefined();
        expect(listVisibleSessionActionIds({ target: { ...following, isArchived: true }, surface: 'rowMenu' })
            .filter((id) => id.startsWith('ui.session.coordinator.'))).toEqual([]);
    });

    it('offers the existing Work pane to exact-Home Bot readers across single-session menus only', () => {
        const target = createSessionActionTarget({ session: createOwnedRawSession({
            owner: 'someone_else', access: createSessionAccessFixture('view'),
            metadata: { path: '/shared', host: 'shared', bot: { kind: 'bot' } },
        }), serverId: 'home', isConnected: false });
        for (const surface of ['rowMenu', 'nativeContextMenu', 'sessionHeader', 'sessionInfo'] as const) {
            expect(listVisibleSessionActionIds({ target, surface })).toContain('ui.session.work.open');
            expect(listVisibleSessionActionIds({ target, surface })).toContain('ui.session.talk');
        }
        expect(listVisibleSessionActionIds({ target, surface: 'selectionActionBar' })).not.toContain('ui.session.work.open');
        expect(listVisibleSessionActionIds({ target, surface: 'selectionActionBar' })).not.toContain('ui.session.talk');
        expect(listVisibleSessionActionIds({ target: { ...target, serverId: null }, surface: 'rowMenu' })).not.toContain('ui.session.work.open');
        expect(listVisibleSessionActionIds({ target: { ...target, serverId: null }, surface: 'rowMenu' })).not.toContain('ui.session.talk');
        expect(listVisibleSessionActionIds({ target: { ...target, session: { ...target.session, access: null } }, surface: 'rowMenu' }))
            .not.toContain('ui.session.work.open');
        expect(listVisibleSessionActionIds({ target: { ...target, session: { ...target.session, access: null } }, surface: 'rowMenu' }))
            .not.toContain('ui.session.talk');
    });
    it('offers an independent personal rail choice to Bot readers and allows clearing a demoted retained choice', () => {
        const ordinary = createSessionActionTarget({ session: createOwnedRawSession({
            owner: 'someone_else', access: createSessionAccessFixture('view'),
        }), currentUserId: 'current_user', serverId: 'home', isConnected: false });
        const bot = { ...ordinary, session: createOwnedRawSession({
            owner: 'someone_else', access: createSessionAccessFixture('view'),
            metadata: { path: '/shared', host: 'shared', bot: { kind: 'bot' } },
        }), isRailPinned: false };
        const visible = listVisibleSessionActionIds({ target: bot, surface: 'rowMenu' });
        expect(visible).toContain('ui.session.rail.pin');
        expect(visible).not.toContain('ui.session.make-bot');
        expect(listVisibleSessionActionIds({ target: ordinary, surface: 'rowMenu' })).not.toContain('ui.session.rail.pin');
        expect(listVisibleSessionActionIds({ target: ordinary, surface: 'rowMenu' })).not.toContain('ui.session.talk');
        expect(listVisibleSessionActionIds({ target: { ...ordinary, isRailPinned: true }, surface: 'rowMenu' }))
            .toContain('ui.session.rail.unpin');
        expect(listVisibleSessionActionIds({ target: { ...bot, serverId: null }, surface: 'rowMenu' }))
            .not.toContain('ui.session.rail.pin');
        expect(listVisibleSessionActionIds({ target: bot, surface: 'selectionActionBar' })).not.toContain('ui.session.rail.pin');
    });

    it('offers the reversible Bot marker and owner-private tool choices without requiring a connected execution host', () => {
        const target = createSessionActionTarget({ session: createOwnedRawSession(), currentUserId: 'current_user', serverId: 'home', isConnected: false });
        expect(listVisibleSessionActionIds({ target, surface: 'sessionHeader' })).toEqual(expect.arrayContaining([
            'ui.session.make-bot', 'ui.session.tool-calls.toggle', 'ui.session.tool-calls.use-default',
        ]));
        const bot = { ...target, session: createOwnedRawSession({ metadata: { path: '/shared', host: 'shared', bot: { kind: 'bot' } } }) };
        expect(listVisibleSessionActionIds({ target: bot, surface: 'rowMenu' })).toContain('ui.session.make-regular');
        expect(listVisibleSessionActionIds({ target: bot, surface: 'rowMenu' })).not.toContain('ui.session.make-bot');
        const viewer = { ...target, canRename: false, canWriteOwnerMetadata: false, isOwnedByCurrentUser: false };
        expect(listVisibleSessionActionIds({ target: viewer, surface: 'sessionHeader' })).not.toContain('ui.session.make-bot');
        expect(listVisibleSessionActionIds({ target: viewer, surface: 'sessionHeader' })).not.toContain('ui.session.tool-calls.toggle');
    });
    it('keeps owner-work setters unavailable to shared editors even when they may rename the shared record', () => {
        const editor = createSessionActionTarget({ session: createOwnedRawSession({
            owner: 'someone_else', access: createSessionAccessFixture('admin', { renameSession: true }),
        }), currentUserId: 'current_user', serverId: 'home' });
        expect(editor.canRename).toBe(true);
        const visible = listVisibleSessionActionIds({ target: editor, surface: 'sessionHeader' });
        expect(visible).toContain(SESSION_ACTION_RENAME_ID);
        expect(visible).not.toContain('ui.session.make-bot');
        expect(visible).not.toContain('ui.session.make-regular');
        expect(visible).not.toContain('ui.session.tool-calls.toggle');
    });
    it('does not offer owner-work setters when the owner projection is unreadable', () => {
        const target = createSessionActionTarget({ session: createOwnedRawSession({ ownerMetadataView: null }),
            serverId: 'home', currentUserId: 'current_user' });
        const visible = listVisibleSessionActionIds({ target, surface: 'sessionHeader' });
        expect(visible).not.toContain('ui.session.make-bot');
        expect(visible).not.toContain('ui.session.tool-calls.toggle');
    });
    it('offers "Put under…" to whoever can send to the Session, in its menus, never when archived', () => {
        const target = createSessionActionTarget({ session: createOwnedRawSession() });
        for (const surface of ['rowMenu', 'nativeContextMenu', 'sessionHeader'] as const) {
            expect(listVisibleSessionActionIds({ target, surface })).toContain(SESSION_ACTION_PUT_UNDER_ID);
        }
        const viewer = createSessionActionTarget({ session: createOwnedRawSession({ access: createSessionAccessFixture('view') }) });
        expect(listVisibleSessionActionIds({ target: viewer, surface: 'rowMenu' })).not.toContain(SESSION_ACTION_PUT_UNDER_ID);
        const archived = createSessionActionTarget({ session: createOwnedRawSession({ archivedAt: 5 }) });
        expect(listVisibleSessionActionIds({ target: archived, surface: 'rowMenu' })).not.toContain(SESSION_ACTION_PUT_UNDER_ID);
    });

    it('offers one coordinator entry: the role-only "Make this an orchestrator" is retired for "Make coordinator…"', () => {
        const target = createSessionActionTarget({ session: createOwnedRawSession() });
        for (const surface of ['sessionHeader', 'rowMenu'] as const) {
            expect(listVisibleSessionActionIds({ target, surface })).not.toContain('ui.session.make-orchestrator');
        }
    });
    it('fails unavailable projections closed despite a matching legacy owner id', () => {
        const target = createSessionActionTarget({ session: createOwnedRawSession({ access: null }), currentUserId: 'current_user' });
        expect(target).toMatchObject({ isOwnedByCurrentUser: false, canUnarchive: false, canStop: false, canArchive: false, canRename: false, canResume: false, canDelete: false });
    });
    it('uses each capability independently of owner role and access level', () => {
        const target = createSessionActionTarget({ session: createOwnedRawSession({ access: createSessionAccessFixture('admin', { manageAccess: false, archiveSession: false, renameSession: true }) }) });
        expect(target).toMatchObject({ canUnarchive: false, canArchive: false, canRename: true });
    });
    it('offers personal Follow to a view-only reader on every single-session host only with exact Home availability', () => {
        const base = createSessionActionTarget({
            session: createOwnedRawSession({ owner: 'someone_else', access: createSessionAccessFixture('view') }),
            serverId: 'home_b',
            currentUserId: 'current_user',
        });
        for (const surface of ['rowMenu', 'nativeContextMenu', 'sessionHeader', 'sessionInfo'] as const) {
            expect(listVisibleSessionActionIds({ target: { ...base, followEnabled: true }, surface }))
                .toContain('ui.session.follow');
            expect(listVisibleSessionActionIds({ target: base, surface })).not.toContain('ui.session.follow');
            expect(listVisibleSessionActionIds({ target: { ...base, serverId: null, followEnabled: true }, surface }))
                .not.toContain('ui.session.follow');
        }
    });
    it('offers standalone Resume only for an inactive resumable owner metadata view', () => {
        const createTarget = (overrides: Partial<Session>) => createSessionActionTarget({
            session: createOwnedRawSession(overrides),
            currentUserId: 'current_user',
            isConnected: overrides.active === true,
            resumeCapabilityOptions: { accountSettings: {} },
        });
        const resumableTarget = createTarget({
            ownerMetadataView: {
                path: '/workspace',
                host: 'machine',
                flavor: 'claude',
                claudeSessionId: 'claude_vendor_session',
                claudeTranscriptPath: '/tmp/claude_vendor_session.jsonl',
            },
        });
        const activeTarget = createTarget({
            active: true,
            ownerMetadataView: {
                path: '/workspace',
                host: 'machine',
                flavor: 'claude',
                claudeSessionId: 'claude_vendor_session',
                claudeTranscriptPath: '/tmp/claude_vendor_session.jsonl',
            },
        });
        const nonResumableTarget = createTarget({
            ownerMetadataView: { path: '/workspace', host: 'machine', flavor: 'unknown-provider' },
        });

        expect(listVisibleSessionActionIds({ target: resumableTarget, surface: 'sessionHeader' }))
            .toContain(SESSION_ACTION_RESUME_ID);
        expect(listVisibleSessionActionIds({ target: activeTarget, surface: 'sessionHeader' }))
            .not.toContain(SESSION_ACTION_RESUME_ID);
        expect(listVisibleSessionActionIds({ target: nonResumableTarget, surface: 'sessionHeader' }))
            .not.toContain(SESSION_ACTION_RESUME_ID);
    });

    it('preserves Resume owner metadata while read-state actions use the current lightweight row', () => {
        const shell = createOwnedRawSession({
            ownerMetadataView: {
                path: '/workspace', host: 'machine', flavor: 'claude',
                claudeSessionId: 'claude_vendor_session',
                claudeTranscriptPath: '/tmp/claude_vendor_session.jsonl',
            },
        });
        const row = buildSessionListRenderableFromSession({
            ...shell, seq: 6, latestReadyEventSeq: 6, lastViewedSessionSeq: 4,
        });
        expect('agentState' in row).toBe(false);
        const input = {
            session: row,
            ownerSession: shell,
            currentUserId: 'current_user',
            resumeCapabilityOptions: { accountSettings: {} },
        };
        const target = createSessionActionTarget(input);
        expect(target.readStateAction.kind).toBe('mark-read');
        expect(listVisibleSessionActionIds({ target, surface: 'sessionHeader' }))
            .toContain(SESSION_ACTION_RESUME_ID);
    });

    it('keeps session-info shared actions as a superset of row lifecycle actions', () => {
        const session: SessionListRenderableSession = {
            id: 'session_1',
            viewer: {
                latestFailureSeq: null,
                readState: { state: 'tracking', lastViewedSessionSeq: 4, unreadSince: null },
                relevance: { relevant: true, reasons: ['owned_by_me'] },
                attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
                follow: { follows: false, notificationLevel: null },
                notification: { level: 'important', source: 'owner' },
            },
            active: true,
            archivedAt: null,
            owner: 'user_1',
            access: createSessionAccessFixture(),
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
        }).filter((id) => id !== SESSION_ACTION_MOVE_TO_FOLDER_ID && id !== SESSION_ACTION_PUT_UNDER_ID);
        const infoActionIds = listVisibleSessionActionIds({
            target,
            surface: 'sessionInfo',
        });

        expect(rowLifecycleActionIds).toEqual([
            SESSION_ACTION_MARK_UNREAD_ID,
            SESSION_ACTION_RENAME_ID,
            SESSION_ACTION_STOP_ID,
            SESSION_ACTION_ARCHIVE_ID,
            SESSION_ACTION_DELETE_ID,
        ]);
        expect(infoActionIds).toEqual(expect.arrayContaining(rowLifecycleActionIds));
    });

    it('keeps delete owner-only for inactive admin-access shared sessions', () => {
        const session: SessionListRenderableSession = {
            id: 'session_shared',
            active: false,
            archivedAt: null,
            owner: 'owner_user',
            access: createSessionAccessFixture('admin'),
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
            currentUserId: 'admin_user',
            isConnected: false,
            isPinned: false,
        });

        expect(target.canUnarchive).toBe(true);
        expect(target.isOwnedByCurrentUser).toBe(false);
        expect(target.canDelete).toBe(false);
        expect(listVisibleSessionActionIds({ target, surface: 'sessionInfo' })).not.toContain(SESSION_ACTION_DELETE_ID);
    });

    it('offers canonical Stop for an owned inactive session with a recoverable preserved terminal host', () => {
        const session: SessionListRenderableSession = {
            id: 'recoverable_session',
            active: false,
            archivedAt: null,
            owner: 'current_user',
            access: createSessionAccessFixture(),
            seq: 4,
            lastViewedSessionSeq: 4,
            latestTurnStatus: 'completed',
            createdAt: 1,
            updatedAt: 1,
            activeAt: 0,
            metadataVersion: 1,
            agentStateVersion: 1,
            metadata: {
                path: '/repo',
                terminalControlServiceabilityV1: {
                    v: 1,
                    state: 'recoverable_unservable',
                    observedAt: 123,
                    reason: 'control_descriptor_missing',
                },
            },
            thinking: false,
            thinkingAt: 0,
            presence: 0,
        };
        const target = createSessionActionTarget({
            session,
            currentUserId: 'current_user',
            isConnected: false,
        });

        expect(listVisibleSessionActionIds({ target, surface: 'sessionInfo' })).toContain(SESSION_ACTION_STOP_ID);
        expect(listVisibleSessionActionIds({ target, surface: 'rowMenu' })).toContain(SESSION_ACTION_STOP_ID);
        expect(target.canDelete).toBe(false);
    });

    it.each([
        ['unknown', { v: 1, state: 'unknown', observedAt: 123 }],
        ['servable', { v: 1, state: 'servable', observedAt: 123 }],
    ])('fails Delete closed for %s terminal lifecycle evidence', (_label, lifecycle) => {
        const session = {
            id: 'delete_fail_closed',
            active: false,
            archivedAt: null,
            owner: 'current_user',
            access: createSessionAccessFixture(),
            seq: 4,
            lastViewedSessionSeq: 4,
            latestTurnStatus: 'completed',
            createdAt: 1,
            updatedAt: 1,
            activeAt: 0,
            metadataVersion: 1,
            agentStateVersion: 1,
            metadata: lifecycle ? { terminalControlServiceabilityV1: lifecycle } : null,
            thinking: false,
            thinkingAt: 0,
            presence: 0,
        } as SessionListRenderableSession;
        expect(createSessionActionTarget({
            session,
            currentUserId: 'current_user',
            isConnected: false,
        }).canDelete).toBe(false);
    });

    it('permits Delete for an inactive owned session with explicit retirement evidence', () => {
        const session = {
            id: 'delete_retired',
            active: false,
            archivedAt: null,
            owner: 'current_user',
            access: createSessionAccessFixture(),
            seq: 4,
            lastViewedSessionSeq: 4,
            latestTurnStatus: 'completed',
            createdAt: 1,
            updatedAt: 1,
            activeAt: 0,
            metadataVersion: 1,
            agentStateVersion: 1,
            metadata: {
                path: '/repo',
                terminalControlServiceabilityV1: {
                    v: 1,
                    state: 'unknown',
                    observedAt: 123,
                    retired: true,
                },
            },
            thinking: false,
            thinkingAt: 0,
            presence: 0,
        } as SessionListRenderableSession;
        expect(createSessionActionTarget({
            session,
            currentUserId: 'current_user',
            isConnected: false,
        }).canDelete).toBe(true);
    });

    it('offers the server-owned Delete Action for an archived pre-launch Session without terminal retirement metadata', () => {
        const session = createOwnedRawSession({
            active: false,
            archivedAt: 5,
            ownerMetadataView: { path: '/managed', host: 'offline-machine' },
        });
        const target = createSessionActionTarget({
            session,
            serverId: 'home',
            currentUserId: 'current_user',
            isConnected: false,
        });
        expect(target.canDelete).toBe(true);
        expect(listVisibleSessionActionIds({ target, surface: 'sessionInfo' }))
            .toContain(SESSION_ACTION_DELETE_ID);
        expect(createSessionActionTarget({
            session: { ...session, archivedAt: null },
            serverId: 'home',
            currentUserId: 'current_user',
            isConnected: false,
        }).canDelete).toBe(false);
    });

    it('offers server-authoritative Delete for an archived locked owner shell', () => {
        const session = createOwnedRawSession({
            active: false,
            archivedAt: 5,
            metadata: null,
            ownerMetadataView: null,
            encryptedContentAvailability: 'encrypted_content_unavailable',
        });
        const target = createSessionActionTarget({
            session,
            serverId: 'home',
            currentUserId: 'current_user',
            isConnected: false,
        });
        expect(target.canDelete).toBe(true);
        expect(listVisibleSessionActionIds({ target, surface: 'sessionInfo' }))
            .toContain(SESSION_ACTION_DELETE_ID);
        expect(createSessionActionTarget({
            session: { ...session, archivedAt: null },
            serverId: 'home',
            currentUserId: 'current_user',
            isConnected: false,
        }).canDelete).toBe(false);
    });

    it('does not mistake unsettled encrypted owner content for a settled locked archive', () => {
        for (const encryptedContentAvailability of [null, undefined]) {
            const target = createSessionActionTarget({
                session: createOwnedRawSession({ active: false, archivedAt: 5, metadata: null,
                    ownerMetadataView: null, encryptionMode: 'e2ee', encryptedContentAvailability }),
                serverId: 'home', currentUserId: 'current_user', isConnected: false,
            });
            expect(target.canDelete).toBe(false);
            expect(listVisibleSessionActionIds({ target, surface: 'sessionInfo' })).not.toContain(SESSION_ACTION_DELETE_ID);
        }
    });

    it('uses layout-v1 owner terminal lifecycle evidence and never falls back to shared metadata', () => {
        const base: Session = {
            id: 'layout_v1_retired',
            active: false,
            archivedAt: null,
            owner: 'current_user',
            access: createSessionAccessFixture(),
            seq: 4,
            lastViewedSessionSeq: 4,
            latestTurnStatus: 'completed',
            createdAt: 1,
            updatedAt: 1,
            activeAt: 0,
            metadataLayoutVersion: 1,
            metadataVersion: 1,
            agentStateVersion: 1,
            metadata: {
                path: '',
                host: '',
                terminalControlServiceabilityV1: {
                    v: 1,
                    state: 'unknown',
                    observedAt: 123,
                    retired: false,
                },
            },
            agentState: null,
            thinking: false,
            thinkingAt: 0,
            presence: 0,
        };

        expect(createSessionActionTarget({
            session: {
                ...base,
                ownerMetadataView: {
                    path: '',
                    host: '',
                    terminal: {
                        controlServiceabilityV1: {
                            v: 1,
                            state: 'unknown',
                            observedAt: 456,
                            retired: true,
                        },
                    },
                },
            },
            currentUserId: 'current_user',
            isConnected: false,
        }).canDelete).toBe(true);

        expect(createSessionActionTarget({
            session: {
                ...base,
                ownerMetadataView: null,
            },
            currentUserId: 'current_user',
            isConnected: false,
        }).canDelete).toBe(false);
    });

    it('offers a session colour on the row and header menus only where the session\'s server stores it', () => {
        const target = createSessionActionTarget({ session: createOwnedRawSession(), serverId: 'home', isConnected: false });
        for (const surface of ['rowMenu', 'nativeContextMenu', 'sessionHeader'] as const) {
            expect(listVisibleSessionActionIds({ target, surface, sessionAppearancesSupported: true })).toContain(SESSION_ACTION_SET_APPEARANCE_COLOR_ID);
            expect(listVisibleSessionActionIds({ target, surface, sessionAppearancesSupported: false })).not.toContain(SESSION_ACTION_SET_APPEARANCE_COLOR_ID);
            expect(listVisibleSessionActionIds({ target, surface })).not.toContain(SESSION_ACTION_SET_APPEARANCE_COLOR_ID);
        }
        expect(listVisibleSessionActionIds({ target, surface: 'sessionInfo', sessionAppearancesSupported: true }))
            .not.toContain(SESSION_ACTION_SET_APPEARANCE_COLOR_ID);
        const unscoped = createSessionActionTarget({ session: createOwnedRawSession(), serverId: null, isConnected: false });
        expect(listVisibleSessionActionIds({ target: unscoped, surface: 'rowMenu', sessionAppearancesSupported: true }))
            .not.toContain(SESSION_ACTION_SET_APPEARANCE_COLOR_ID);
    });
});
