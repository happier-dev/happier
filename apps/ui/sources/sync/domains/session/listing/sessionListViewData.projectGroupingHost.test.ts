import { describe, expect, it } from 'vitest';

import { t } from '@/text';

import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

import { buildSessionListViewData, type SessionListViewItem } from './sessionListViewData';

function makeMachineDisplay(partial: Partial<MachineDisplayRenderable> & Pick<MachineDisplayRenderable, 'id'>): MachineDisplayRenderable {
    const updatedAt = partial.updatedAt ?? 0;
    const active = partial.active ?? false;
    const activeAt = partial.activeAt ?? updatedAt;
    return {
        id: partial.id,
        updatedAt,
        active,
        activeAt,
        revokedAt: partial.revokedAt ?? null,
        metadataVersion: partial.metadataVersion ?? 0,
        metadata: partial.metadata ?? null,
    };
}

function makeRenderableSession(
    partial: Partial<SessionListRenderableSession> & Pick<SessionListRenderableSession, 'id'>,
): SessionListRenderableSession {
    const active = partial.active ?? true;
    const createdAt = partial.createdAt ?? 0;
    const activeAt = partial.activeAt ?? createdAt;
    const updatedAt = partial.updatedAt ?? createdAt;
    return {
        id: partial.id,
        seq: partial.seq ?? 0,
        createdAt,
        updatedAt,
        active,
        activeAt,
        archivedAt: partial.archivedAt ?? null,
        pendingCount: partial.pendingCount,
        pendingVersion: partial.pendingVersion,
        metadataVersion: partial.metadataVersion ?? 0,
        agentStateVersion: partial.agentStateVersion ?? 0,
        metadata: partial.metadata ?? null,
        thinking: partial.thinking ?? false,
        thinkingAt: partial.thinkingAt ?? 0,
        presence: active ? 'online' : activeAt,
        accessLevel: partial.accessLevel,
        canApprovePermissions: partial.canApprovePermissions,
        hasPendingPermissionRequests: partial.hasPendingPermissionRequests,
        hasPendingUserActionRequests: partial.hasPendingUserActionRequests,
    };
}

function isProjectHeader(item: SessionListViewItem): item is Extract<SessionListViewItem, { type: 'header' }> {
    return item.type === 'header' && item.headerKind === 'project';
}

describe('buildSessionListViewData (project grouping)', () => {
    it('does not group sessions by host when machine ids differ', () => {
        const host = 'lima-happier-wsrepl-qa-0324';

        const sessions: Record<string, SessionListRenderableSession> = {
            s_new: makeRenderableSession({
                id: 's_new',
                createdAt: 10,
                updatedAt: 20,
                metadata: {
                    machineId: 'm_new',
                    host,
                    path: '/Users/leeroy/wsrepl-large',
                    homeDir: '/home/leeroy.guest',
                },
            }),
            s_old: makeRenderableSession({
                id: 's_old',
                createdAt: 11,
                updatedAt: 21,
                metadata: {
                    machineId: 'm_old',
                    host,
                    path: '/Users/leeroy/wsrepl-large',
                    homeDir: '/home/leeroy.guest',
                },
            }),
        };

        const machines: Record<string, MachineDisplayRenderable> = {
            m_new: makeMachineDisplay({
                id: 'm_new',
                active: true,
                activeAt: 200,
                metadata: { host, homeDir: '/home/u', displayName: null },
            }),
            m_old: makeMachineDisplay({
                id: 'm_old',
                active: false,
                activeAt: 100,
                metadata: { host, homeDir: '/home/u', displayName: null },
            }),
        };

        const list = buildSessionListViewData(sessions, machines, {
            layoutV1: 'projects',
        });

        const projectHeaders = list.filter(isProjectHeader);
        expect(projectHeaders).toHaveLength(2);
        expect(projectHeaders.map((item) => item.machine?.id).sort()).toEqual(['m_new', 'm_old']);

        const sessionRows = list.filter((item) => item.type === 'session');
        expect(sessionRows).toHaveLength(2);
    });

    it('does not use machine host as grouping identity when session metadata host is missing', () => {
        const host = 'lima-happier-wsrepl-qa-0324';

        const sessions: Record<string, SessionListRenderableSession> = {
            s_new: makeRenderableSession({
                id: 's_new',
                createdAt: 10,
                updatedAt: 20,
                metadata: {
                    machineId: 'm_new',
                    path: '~/wsrepl-large',
                },
            }),
            s_old: makeRenderableSession({
                id: 's_old',
                createdAt: 11,
                updatedAt: 21,
                metadata: {
                    machineId: 'm_old',
                    path: '~/wsrepl-large',
                },
            }),
        };

        const machines: Record<string, MachineDisplayRenderable> = {
            m_new: makeMachineDisplay({
                id: 'm_new',
                active: true,
                activeAt: 200,
                metadata: { host, homeDir: '/Users/leeroy', displayName: null },
            }),
            m_old: makeMachineDisplay({
                id: 'm_old',
                active: false,
                activeAt: 100,
                metadata: { host, homeDir: '/Users/leeroy', displayName: null },
            }),
        };

        const list = buildSessionListViewData(sessions, machines, {
            layoutV1: 'projects',
        });

        const projectHeaders = list.filter((item): item is Extract<typeof item, { type: 'header' }> =>
            item.type === 'header' && item.headerKind === 'project',
        );
        expect(projectHeaders).toHaveLength(2);
        expect(projectHeaders.map((item) => item.machine?.id).sort()).toEqual(['m_new', 'm_old']);
        // Two machines on the same host are still two machines: the naming owner tells them apart.
        const subtitles = projectHeaders.map((item) => item.subtitle ?? '');
        expect(subtitles.every((subtitle) => subtitle.startsWith(`${host} · `))).toBe(true);
        expect(new Set(subtitles).size).toBe(2);

        const sessionRows = list.filter((item) => item.type === 'session');
        expect(sessionRows).toHaveLength(2);
    });

    it('groups a machine’s no-folder sessions under one “Chats” group, never one group per private folder', () => {
        const managed = { v: 1, kind: 'managed' } as const;
        const sessions: Record<string, SessionListRenderableSession> = {
            chat_a: makeRenderableSession({
                id: 'chat_a',
                createdAt: 10,
                metadata: { machineId: 'm1', path: '/home/u/.happier/servers/s/session-directories/aaa', homeDir: '/home/u', sessionDirectoryV1: managed },
            }),
            chat_b: makeRenderableSession({
                id: 'chat_b',
                createdAt: 11,
                metadata: { machineId: 'm1', path: '/home/u/.happier/servers/s/session-directories/bbb', homeDir: '/home/u', sessionDirectoryV1: managed },
            }),
            repo: makeRenderableSession({
                id: 'repo',
                createdAt: 9,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
            }),
        };
        const machines: Record<string, MachineDisplayRenderable> = {
            m1: makeMachineDisplay({ id: 'm1', active: true, metadata: { host: 'mbp', homeDir: '/home/u', displayName: 'MacBook Pro' } }),
        };

        const list = buildSessionListViewData(sessions, machines, {
            layoutV1: 'projects',
        });

        const headers = list.filter(isProjectHeader);
        expect(headers.map((header) => header.title).sort()).toEqual([t('session.folderless.chats'), '~/repo'].sort());
        const chats = headers.find((header) => header.title === t('session.folderless.chats'));
        // No workspace (and so no project, no "Add as project") is derived from a private folder.
        expect(chats?.workspaceScopeHint ?? null).toBeNull();
        expect(JSON.stringify(headers)).not.toContain('session-directories');
        expect(list.filter((item) => item.type === 'session')).toHaveLength(3);
    });

    it('keeps path sessions at machine home separate from the managed Chats bucket', () => {
        const managed = { v: 1, kind: 'managed' } as const;
        const sessions: Record<string, SessionListRenderableSession> = {
            chat: makeRenderableSession({
                id: 'chat',
                createdAt: 10,
                metadata: { machineId: 'm1', path: '/home/u/.happier/servers/s/session-directories/aaa', homeDir: '/home/u', sessionDirectoryV1: managed },
            }),
            home: makeRenderableSession({
                id: 'home',
                createdAt: 11,
                metadata: { machineId: 'm1', path: '/home/u', homeDir: '/home/u' },
            }),
            otherMachineHome: makeRenderableSession({
                id: 'otherMachineHome',
                createdAt: 8,
                metadata: { machineId: 'm2', path: '~', homeDir: '/home/v' },
            }),
            repo: makeRenderableSession({
                id: 'repo',
                createdAt: 9,
                metadata: { machineId: 'm1', path: '/home/u/repo', homeDir: '/home/u' },
            }),
        };
        const machines: Record<string, MachineDisplayRenderable> = {
            m1: makeMachineDisplay({ id: 'm1', active: true, metadata: { host: 'mbp', homeDir: '/home/u', displayName: 'MacBook Pro' } }),
            m2: makeMachineDisplay({ id: 'm2', active: true, metadata: { host: 'box', homeDir: '/home/v', displayName: 'Build box' } }),
        };

        const list = buildSessionListViewData(sessions, machines, {
            layoutV1: 'projects',
            serverScope: { serverId: 's' },
        });

        const headers = list.filter(isProjectHeader);
        const titles = headers.map((header) => header.title);
        // Only the marker-backed managed Session belongs to Chats. A path Session at home
        // remains a real workspace group; its visible label is a separate UI-copy decision.
        expect(headers).toHaveLength(4);
        expect(titles.filter((title) => title === t('session.folderless.chats'))).toHaveLength(1);
        expect(headers.filter((header) => header.workspaceScopeHint?.rootPath === '/home/u')).toHaveLength(1);
        expect(headers.filter((header) => header.workspaceScopeHint?.rootPath === '/home/v')).toHaveLength(1);
        expect(titles).toContain('~/repo');
        expect(list.filter((item) => item.type === 'session')).toHaveLength(4);
    });
});
