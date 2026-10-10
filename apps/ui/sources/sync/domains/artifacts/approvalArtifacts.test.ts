import { describe, expect, it } from 'vitest';
import { ApprovalRequestV2Schema, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol';

import type { DecryptedArtifact } from './artifactTypes';
import {
    collectOpenApprovalSessionReferences,
    isOpenApprovalInboxArtifact,
    listOpenApprovalArtifactsForSession,
    resolveOpenApprovalSessionKeys,
} from './approvalArtifacts';
import { buildSessionListServerScopedRowKey } from '@/sync/domains/session/listing/sessionListKeyNormalization';

function artifact(
    id: string,
    header: NonNullable<DecryptedArtifact['header']>,
    body?: unknown,
): Extract<DecryptedArtifact, { isDecrypted: true }> {
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
        createdBy: { surface: 'agent', sessionId },
        requestedSurface: 'agent',
        actionId,
        actionArgs: {},
        summary: 'List sessions',
    };
}

function durableApprovalBody(sessionId: string) {
    return {
        v: 2,
        status: 'open',
        createdAtMs: 1,
        updatedAtMs: 1,
        createdBy: { surface: 'system', sessionId },
        requestedSurface: 'api',
        executionOriginV1: {
            v: 1,
            authority: 'account_automation',
            surface: 'api',
            caller: { kind: 'host' },
            serverId: 'server-a',
            accountId: 'account-1',
            principalId: 'principal-1',
            credentialId: 'credential-1',
            sessionId,
            machineId: 'machine-1',
            target: { kind: 'session', sessionId },
            actionId: 'session.title.set',
            requestId: 'request-1',
        },
        actionId: 'session.title.set',
        actionArgs: { sessionId, title: 'Current title' },
        summary: 'Set session title',
    };
}

describe('listOpenApprovalArtifactsForSession', () => {
    it('keeps draft requests out of the canonical Inbox approval predicate', () => {
        const body = approvalBody('s1');
        const header = { title: 'Approve', v: 1, kind: 'approval_request.v1', approvalStatus: 'open', sessionId: 's1', actionId: 'session.list', approvalSummary: 'List sessions' };
        expect(isOpenApprovalInboxArtifact(artifact('open', header, body))).toBe(true);
        expect(isOpenApprovalInboxArtifact(artifact('draft', { ...header, draft: true }, body))).toBe(false);
    });
    it('rejects bodyless approval indexes until the authoritative body is hydrated', () => {
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
        ], { serverId: 'home-a', sessionId: 's1' }, {
            knownSessionAddresses: [{ serverId: 'home-a', sessionId: 's1' }],
        });

        expect(approvals).toEqual([]);
    });

    it('parses available approval bodies and drops malformed bodies', () => {
        const approvals = listOpenApprovalArtifactsForSession([
            artifact('body', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'List sessions',
                approvalStatus: 'open',
                sessionId: 's1',
                sessions: ['s1'],
                actionId: 'session.history.get',
            }, approvalBody('s1', 'session.history.get')),
            {
                ...artifact('malformed', {
                    v: 1,
                    kind: 'approval_request.v1',
                    title: 'List sessions',
                    approvalStatus: 'open',
                    sessionId: 's1',
                    sessions: ['s1'],
                    actionId: 'session.history.get',
                }),
                body: '{',
            },
        ], { serverId: 'home-a', sessionId: 's1' }, {
            knownSessionAddresses: [{ serverId: 'home-a', sessionId: 's1' }],
        });

        expect(approvals).toHaveLength(1);
        expect(approvals[0]?.artifact.id).toBe('body');
        expect(approvals[0]?.approval.actionId).toBe('session.history.get');
    });

    it('projects current V2 durable approvals into the Session approval surface', () => {
        const request = ApprovalRequestV2Schema.parse(durableApprovalBody('s1'));
        const approvals = listOpenApprovalArtifactsForSession([
            artifact('durable', buildApprovalRequestArtifactHeaderV1(request), request),
        ], buildSessionListServerScopedRowKey('server-a', 's1')!);

        expect(approvals).toHaveLength(1);
        expect(approvals[0]?.approval).toMatchObject({ v: 2, actionId: 'session.title.set' });
    });

    it('admits a legacy unscoped approval only when canonical membership resolves one exact Home', () => {
        const legacy = artifact('legacy', {
            v: 1,
            kind: 'approval_request.v1',
            title: 'List sessions',
            approvalStatus: 'open',
            sessionId: 'same',
            sessions: ['same'],
            actionId: 'session.list',
        }, approvalBody('same'));

        expect(collectOpenApprovalSessionReferences([legacy])).toEqual([
            { kind: 'legacy_unscoped', sessionId: 'same' },
        ]);

        expect(listOpenApprovalArtifactsForSession([legacy], { serverId: 'home-a', sessionId: 'same' }, {
            knownSessionAddresses: [{ serverId: 'home-a', sessionId: 'same' }],
        })).toHaveLength(1);
        expect(listOpenApprovalArtifactsForSession([legacy], { serverId: 'home-a', sessionId: 'same' }, {
            knownSessionAddresses: [
                { serverId: 'home-a', sessionId: 'same' },
                { serverId: 'home-b', sessionId: 'same' },
            ],
        })).toEqual([]);
    });
});

describe('collectOpenApprovalSessionReferences', () => {
    it('collects only sessions linked to currently open approval artifacts', () => {
        const references = collectOpenApprovalSessionReferences([
            artifact('header-session', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'List sessions',
                approvalStatus: 'open',
                sessionId: 's1',
                sessions: ['s1'],
                actionId: 'session.list',
                approvalSummary: 'List sessions',
            }, approvalBody('s1')),
            artifact('body-session', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'List sessions',
                approvalStatus: 'open',
                sessionId: 's2',
                sessions: ['s2'],
                actionId: 'session.list',
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

        expect(references).toEqual([
            { kind: 'legacy_unscoped', sessionId: 's1' },
            { kind: 'legacy_unscoped', sessionId: 's2' },
        ]);
    });

    it('uses server-scoped identities when approval artifacts carry a server id', () => {
        const references = collectOpenApprovalSessionReferences([
            artifact('header-session', {
                v: 1,
                kind: 'approval_request.v1',
                title: 'List sessions',
                approvalStatus: 'open',
                sessionId: 's1',
                sessions: ['s1'],
                serverId: 'server-a',
                actionId: 'session.list',
                approvalSummary: 'List sessions',
            }, approvalBody('s1')),
        ]);

        expect(references).toEqual([{
            kind: 'exact',
            address: { serverId: 'server-a', sessionId: 's1' },
        }]);
    });

    it('resolves legacy references once and never broadcasts them across duplicate Homes', () => {
        const references = [{ kind: 'legacy_unscoped', sessionId: 'same' }] as const;
        expect([...resolveOpenApprovalSessionKeys(references, [
            { serverId: 'home-a', sessionId: 'same' },
        ])]).toEqual([buildSessionListServerScopedRowKey('home-a', 'same')]);
        expect([...resolveOpenApprovalSessionKeys(references, [
            { serverId: 'home-a', sessionId: 'same' },
            { serverId: 'home-b', sessionId: 'same' },
        ])]).toEqual([]);
    });
});
