import { describe, expect, it } from 'vitest';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1, buildTargetActionApprovalArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { readOpenApprovalInboxEntry } from '@/sync/domains/artifacts/approvalArtifactAdmission';
import { readApprovalQuickActions } from './approvalQuickActions';

describe('readApprovalQuickActions', () => {
    it('offers simple approval decisions only for the exact open, readable request', () => {
        const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'cli' }, actionId: 'account.name.set', actionArgs: { name: 'Captain' }, summary: 'Change name',
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
                serverId: 'request-home', actionId: 'account.name.set', requestId: 'request-a' } });
        const artifact = { id: 'approval-a', isDecrypted: true, title: request.summary,
            header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } satisfies DecryptedArtifact;
        const quickActionsFor = (value: DecryptedArtifact) => readApprovalQuickActions(readOpenApprovalInboxEntry(value), 'request-home');
        expect(quickActionsFor(artifact)).toEqual({ artifactId: artifact.id, serverId: 'request-home',
            actionId: 'approval.request.decide', decisions: ['reject', 'approve'] });
        expect(readApprovalQuickActions(readOpenApprovalInboxEntry(artifact), '')).toBeNull();
        for (const unavailable of [
            { ...artifact, body: null },
            { ...artifact, body: '{broken' },
            { ...artifact, header: { ...artifact.header, actionId: 'session.stop' } },
            { ...artifact, body: JSON.stringify({ ...request, actionArgs: { name: 'Captain', unreviewed: true } }) },
            { ...artifact, body: JSON.stringify({ ...request, unknownAuthority: true }) },
            { ...artifact, header: { ...artifact.header, actionId: 'unknown.action' }, body: JSON.stringify({ ...request,
                actionId: 'unknown.action', executionOriginV1: { ...request.executionOriginV1, actionId: 'unknown.action' } }) },
            { ...artifact, body: JSON.stringify({ ...request, actionArgs: {} }) },
            { ...artifact, header: buildApprovalRequestArtifactHeaderV1({ ...request, status: 'rejected' }),
                body: JSON.stringify({ ...request, status: 'rejected' }) },
        ]) expect(quickActionsFor(unavailable)).toBeNull();
        const plugin = TargetActionApprovalRequestV1Schema.parse({ v: 1, kind: 'plugin_target_action', status: 'open',
            createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'agent' }, requestedSurface: 'agent',
            qualifiedActionId: 'acme.publisher/actions/publish', sourceCustody: { kind: 'development', registeredRootId: 'root-a' },
            policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64), summary: 'Publish',
            input: { destination: 'releases' }, secretInputPaths: [] });
        expect(quickActionsFor({ ...artifact, header: buildTargetActionApprovalArtifactHeaderV1(plugin), body: JSON.stringify(plugin) }))
            .toBeNull();
    });
});
