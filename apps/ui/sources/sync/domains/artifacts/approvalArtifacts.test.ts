import { describe, expect, it } from 'vitest';

import type { DecryptedArtifact } from './artifactTypes';
import { collectOpenApprovalSessionIds, listOpenApprovalArtifactsForSession } from './approvalArtifacts';

function artifact(
    id: string,
    header: NonNullable<DecryptedArtifact['header']>,
    body?: unknown,
): DecryptedArtifact {
    return {
        id,
        header,
        title: header.title ?? null,
        sessions: header.sessions,
        draft: header.draft,
        body: typeof body === 'undefined' ? undefined : JSON.stringify(body),
        headerVersion: 1,
        bodyVersion: typeof body === 'undefined' ? undefined : 1,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        isDecrypted: true,
    };
}

function approvalBody(sessionId: string, actionId = 'session.list') {
    return {
        v: 1,
        status: 'open',
        createdAtMs: 1,
        updatedAtMs: 1,
        createdBy: { surface: 'session_agent', sessionId },
        requestedSurface: 'session_agent',
        actionId,
        actionArgs: {},
        summary: 'List sessions',
    };
}

describe('listOpenApprovalArtifactsForSession', () => {
    it('includes bodyless open approval headers scoped to the session', () => {
        const approvals = listOpenApprovalArtifactsForSession([
            artifact('matching-session-id', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'Approve',
                approvalStatus: 'open',
                sessionId: 's1',
                actionId: 'session.list',
                approvalSummary: 'List sessions',
            }),
            artifact('matching-sessions-array', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'Approve',
                approvalStatus: 'open',
                sessions: ['s1'],
                actionId: 'session.status.get',
                approvalSummary: 'Read status',
            }),
            artifact('closed', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'Approve',
                approvalStatus: 'executed',
                sessionId: 's1',
            }),
            artifact('other-session', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'Approve',
                approvalStatus: 'open',
                sessionId: 's2',
            }),
        ], 's1');

        expect(approvals.map((approval) => approval.artifact.id)).toEqual([
            'matching-session-id',
            'matching-sessions-array',
        ]);
        expect(approvals[0]?.approval.actionId).toBe('session.list');
        expect(approvals[1]?.approval.summary).toBe('Read status');
    });

    it('parses available approval bodies and drops malformed bodies', () => {
        const approvals = listOpenApprovalArtifactsForSession([
            artifact('body', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'Approve',
                approvalStatus: 'open',
                sessionId: 's1',
            }, approvalBody('s1', 'session.history.get')),
            {
                ...artifact('malformed', {
                    v: 1,
                    kind: 'approval_request.v1',
                    title: 'Approve',
                    approvalStatus: 'open',
                    sessionId: 's1',
                }),
                body: '{',
            },
        ], 's1');

        expect(approvals).toHaveLength(1);
        expect(approvals[0]?.artifact.id).toBe('body');
        expect(approvals[0]?.approval.actionId).toBe('session.history.get');
    });
});

describe('collectOpenApprovalSessionIds', () => {
    it('collects only sessions linked to currently open approval artifacts', () => {
        const ids = collectOpenApprovalSessionIds([
            artifact('header-session', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'Approve',
                approvalStatus: 'open',
                sessionId: 's1',
                actionId: 'session.list',
                approvalSummary: 'List sessions',
            }),
            artifact('body-session', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'Approve',
                approvalStatus: 'open',
            }, approvalBody('s2')),
            artifact('closed', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'Approve',
                approvalStatus: 'rejected',
                sessionId: 's3',
                actionId: 'session.list',
                approvalSummary: 'List sessions',
            }),
        ]);

        expect([...ids].sort()).toEqual(['s1', 's2']);
    });

    it('uses server-scoped identities when approval artifacts carry a server id', () => {
        const ids = collectOpenApprovalSessionIds([
            artifact('header-session', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'Approve',
                approvalStatus: 'open',
                sessionId: 's1',
                serverId: 'server-a',
                actionId: 'session.list',
                approvalSummary: 'List sessions',
            }),
        ]);

        expect([...ids]).toEqual(['server-a:s1']);
    });
});
