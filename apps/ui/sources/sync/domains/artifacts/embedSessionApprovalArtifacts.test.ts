import { describe, expect, it } from 'vitest';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import type { ServerFetch } from '@/sync/http/client';

import { fetchEmbedSessionApprovalArtifacts } from './embedSessionApprovalArtifacts';
import { listOpenApprovalArtifactsForSession } from './approvalArtifacts';

describe('embedded Session approval projection', () => {
    it('reads only the mounted Session approval through target-bound public Actions', async () => {
        const approval = ApprovalRequestV2Schema.parse({
            v: 2,
            status: 'open',
            createdAtMs: 10,
            updatedAtMs: 11,
            createdBy: { surface: 'agent', sessionId: 'session-1' },
            requestedSurface: 'agent',
            actionId: 'action.invoke',
            actionArgs: { action: { pluginId: 'crm', localId: 'update-stage' }, input: { leadId: 'verdant', stage: 'qualified' } },
            summary: 'Move Verdant to Qualified',
            executionOriginV1: {
                v: 1,
                authority: 'account_automation',
                surface: 'agent',
                caller: { kind: 'session', sessionId: 'session-1', starterDepth: 0, turnDepth: 0 },
                actionId: 'action.invoke',
                accountId: 'account-1',
                serverId: 'https://home.test',
                sessionId: 'session-1',
                requestId: 'request-1',
            },
            origin: { kind: 'transcript_tool_call', sessionId: 'session-1', toolCallId: 'tool-1', toolName: 'action_execute' },
        });
        const requests: Array<{ actionId: string; target: unknown; input: unknown }> = [];
        const request: ServerFetch = async (path, init) => {
            const actionId = decodeURIComponent(path.slice('/v1/actions/'.length));
            const body = JSON.parse(String(init?.body)) as { target?: unknown; input?: unknown };
            requests.push({ actionId, target: body.target, input: body.input });
            const result = actionId === 'approval.request.list'
                ? { items: [{ artifactId: 'approval-1', status: 'open', actionId: 'action.invoke', summary: approval.summary,
                    sessionId: 'session-1', serverId: 'https://home.test', updatedAtMs: 11 }], nextCursor: null,
                    queryPlan: { kind: 'approval_artifact_header_scan', backingStore: 'ArtifactStore',
                        boundedBy: 'ArtifactStore source exhaustion', serverLimit: 100, hydratedTranscripts: false } }
                : { artifactId: 'approval-1', request: approval, queryPlan: { kind: 'approval_artifact_id_lookup',
                    backingStore: 'ArtifactStore', boundedBy: 'approval artifact id', hydratedTranscripts: false } };
            return new Response(JSON.stringify({ v: 1, actionId, execution: { ok: true, result } }));
        };

        const artifacts = await fetchEmbedSessionApprovalArtifacts({
            request,
            serverId: 'https://home.test',
            accountId: 'account-1',
            sessionId: 'session-1',
        });

        expect(requests).toEqual([
            { actionId: 'approval.request.list', target: { kind: 'session', sessionId: 'session-1' }, input: { status: 'open', limit: 100 } },
            { actionId: 'approval.request.get', target: { kind: 'session', sessionId: 'session-1' }, input: { artifactId: 'approval-1' } },
        ]);
        expect(artifacts).toMatchObject([{ id: 'approval-1', title: approval.summary, sessions: ['session-1'],
            header: { kind: 'approval_request.v1', approvalStatus: 'open', actionId: 'action.invoke', sessionId: 'session-1' },
            body: JSON.stringify(approval), isDecrypted: true }]);
    });

    it('drops rows that are not bound to the mounted Session', async () => {
        const request: ServerFetch = async (path) => new Response(JSON.stringify({
            v: 1,
            actionId: decodeURIComponent(path.slice('/v1/actions/'.length)),
            execution: { ok: true, result: { items: [{ artifactId: 'other', status: 'open', actionId: 'action.invoke',
                summary: 'Other', sessionId: 'session-2', updatedAtMs: 1 }], nextCursor: null,
                queryPlan: { kind: 'approval_artifact_header_scan', hydratedTranscripts: false } } },
        }));
        await expect(fetchEmbedSessionApprovalArtifacts({ request, serverId: 'home', accountId: 'account-1', sessionId: 'session-1' }))
            .resolves.toEqual([]);
    });

    it('projects the contributed Action approval family used by plugin Ask-first Actions', async () => {
        const approval = TargetActionApprovalRequestV1Schema.parse({
            v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 10, updatedAtMs: 11,
            createdBy: { surface: 'agent', sessionId: 'session-1' }, requestedSurface: 'agent',
            qualifiedActionId: 'dev.leads-fixture/actions/update-stage', input: { leadId: 'verdant', stage: 'qualified' },
            sourceCustody: { kind: 'managed', immutableGenerationId: 'fixture-generation', installSource: 'npm' },
            policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64), approvalInputCustody: 'live_only',
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent',
                caller: { kind: 'session', sessionId: 'session-1', starterDepth: 0, turnDepth: 0 },
                accountId: 'account-1', serverId: 'daemon-local-profile', sessionId: 'session-1',
                actionId: 'action.invoke', requestId: 'request-1' },
            summary: 'Update this lead’s stage?',
        });
        const request: ServerFetch = async (path) => new Response(JSON.stringify({
            v: 1, actionId: decodeURIComponent(path.slice('/v1/actions/'.length)), execution: { ok: true, result:
                path.endsWith('/approval.request.list')
                    ? { items: [{ artifactId: 'target-approval', status: 'open', actionId: 'action.invoke',
                        summary: approval.summary, sessionId: 'session-1', updatedAtMs: 11 }], nextCursor: null,
                        queryPlan: { kind: 'approval_artifact_header_scan', hydratedTranscripts: false } }
                    : { artifactId: 'target-approval', request: approval, queryPlan: { kind: 'approval_artifact_id_lookup',
                        backingStore: 'ArtifactStore', boundedBy: 'approval artifact id', hydratedTranscripts: false } } },
        }));
        const artifacts = await fetchEmbedSessionApprovalArtifacts({ request, serverId: 'https://home.test',
            accountId: 'account-1', sessionId: 'session-1' });
        expect(artifacts).toMatchObject([{ id: 'target-approval',
            header: { kind: 'target_action_approval.v1', qualifiedActionId: approval.qualifiedActionId },
            body: JSON.stringify(approval), sessions: ['session-1'] }]);
        // The public read is bound to this Home and Session. A daemon's private
        // profile name is not a browser alias, nor a reason to hide this card.
        expect(listOpenApprovalArtifactsForSession(artifacts, { serverId: 'https://home.test', sessionId: 'session-1' }))
            .toMatchObject([{ artifact: { id: 'target-approval' }, approval }]);
        expect(listOpenApprovalArtifactsForSession(artifacts, { serverId: 'https://other-home.test', sessionId: 'session-1' }))
            .toEqual([]);
        expect(listOpenApprovalArtifactsForSession(artifacts, { serverId: 'https://home.test', sessionId: 'session-2' }))
            .toEqual([]);
    });
});
