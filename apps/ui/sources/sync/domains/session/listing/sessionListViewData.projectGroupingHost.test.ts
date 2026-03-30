import { describe, expect, it } from 'vitest';

import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

import { buildSessionListViewData } from './sessionListViewData';

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

describe('buildSessionListViewData (project grouping)', () => {
    it('groups sessions by host when machine ids differ', () => {
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
            groupInactiveSessionsByProject: true,
            activeGroupingV1: 'project',
            inactiveGroupingV1: 'project',
        });

        const projectHeaders = list.filter((item) => item.type === 'header' && item.headerKind === 'project');
        expect(projectHeaders).toHaveLength(1);

        const sessionRows = list.filter((item) => item.type === 'session');
        expect(sessionRows).toHaveLength(2);
    });

    it('groups sessions by machine host when session metadata host is missing', () => {
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
            groupInactiveSessionsByProject: true,
            activeGroupingV1: 'project',
            inactiveGroupingV1: 'project',
        });

        const projectHeaders = list.filter((item): item is Extract<typeof item, { type: 'header' }> =>
            item.type === 'header' && item.headerKind === 'project',
        );
        expect(projectHeaders).toHaveLength(1);
        expect(projectHeaders[0]?.subtitle).toBe(host);

        const sessionRows = list.filter((item) => item.type === 'session');
        expect(sessionRows).toHaveLength(2);
    });
});
