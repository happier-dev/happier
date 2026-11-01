import { describe, expect, it } from 'vitest';

import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { resolveSessionWorkspacePresentation } from '@/sync/domains/session/listing/sessionWorkspacePresentation';

import { buildInboxSessionContextByKey } from './inboxSessionContextPresentation';

function makeSession(path: string): SessionListRenderableSession {
    return {
        id: 'session-1',
        seq: 1,
        updatedAt: 1,
        createdAt: 1,
        active: false,
        activeAt: 1,
        archivedAt: null,
        metadata: { path, homeDir: '/home/leeroy', machineId: 'machine-1' },
        metadataVersion: 1,
        agentStateVersion: 1,
        pendingCount: 0,
        pendingBlockedCount: 0,
        pendingRequestObservedAt: null,
        hasPendingPermissionRequests: false,
        hasPendingUserActionRequests: false,
        hasUnreadMessages: true,
        latestTurnStatus: 'completed',
        latestTurnStatusObservedAt: 1,
        latestReadyEventSeq: 1,
        latestReadyEventAt: 1,
        lastViewedSessionSeq: 0,
        meaningfulActivityAt: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 0,
    };
}

describe('buildInboxSessionContextByKey', () => {
    it('exposes the same session override and project inheritance as session rows', () => {
        const session = makeSession('/home/leeroy/project');
        const workspaceKey = resolveSessionWorkspacePresentation({ metadata: session.metadata, machines: {} }).workspaceKey;
        const workspaceColor = { kind: 'accent', key: 'blue' } as const;
        const sessionColor = { kind: 'custom', hex: '#AABBCC' } as const;
        const params = {
            sessionByKey: new Map([['server-a:session-1', { serverId: 'server-a', sessionId: session.id, session }]]),
            machines: {}, workspaceLabelsByLabelKey: {
                [`server-a:workspace:${workspaceKey}`]: { labelKind: 'workspace', scopeKey: workspaceKey, display: { t: 'plain', v: { color: workspaceColor } }, archivedAt: null, createdAt: 1, updatedAt: 1 },
            },
        } as const;
        expect(buildInboxSessionContextByKey(params).get('server-a:session-1')).toMatchObject({ appearanceColor: workspaceColor });
        expect(buildInboxSessionContextByKey({ ...params, sessionColorsByKey: new Map([['server-a:session-1', sessionColor]]) }).get('server-a:session-1')).toMatchObject({ appearanceColor: sessionColor });
    });
    it('uses the canonical workspace name instead of the raw full path', () => {
        const session = makeSession('/home/leeroy/Happier Core');
        const result = buildInboxSessionContextByKey({
            sessionByKey: new Map([['server-a:session-1', { serverId: 'server-a', sessionId: session.id, session }]]),
            machines: {},
            workspaceLabelsByLabelKey: {},
        });

        expect(result.get('server-a:session-1')?.workspaceName).toBe('Happier Core');
        expect(result.get('server-a:session-1')?.workspaceName).not.toContain('/home/leeroy');
    });

    it('preserves each Home workspace label and colour when workspace and session ids collide', () => {
        const session = makeSession('/home/leeroy/project');
        const workspaceKey = resolveSessionWorkspacePresentation({ metadata: session.metadata, machines: {} }).workspaceKey;
        const result = buildInboxSessionContextByKey({
            sessionByKey: new Map(['server-a', 'server-b', 'server-c'].map((serverId) => [`${serverId}:session-1`, { serverId, sessionId: session.id, session }])),
            machines: {},
            workspaceLabelsByLabelKey: {
                [`server-a:workspace:${workspaceKey}`]: { labelKind: 'workspace', scopeKey: workspaceKey, display: { t: 'plain', v: { label: 'Design System', color: { kind: 'accent', key: 'blue' } } }, archivedAt: null, createdAt: 1, updatedAt: 1 },
                [`server-b:workspace:${workspaceKey}`]: { labelKind: 'workspace', scopeKey: workspaceKey, display: { t: 'plain', v: { label: 'Other Home', color: { kind: 'custom', hex: '#AABBCC' } } }, archivedAt: null, createdAt: 1, updatedAt: 1 },
            },
        });

        expect(result.get('server-a:session-1')).toMatchObject({ workspaceName: 'Design System', appearanceColor: { kind: 'accent', key: 'blue' } });
        expect(result.get('server-b:session-1')).toMatchObject({ workspaceName: 'Other Home', appearanceColor: { kind: 'custom', hex: '#AABBCC' } });
        expect(result.get('server-c:session-1')).toMatchObject({ workspaceName: 'project', appearanceColor: null });
    });
});
