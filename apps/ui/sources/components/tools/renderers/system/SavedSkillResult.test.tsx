import { describe, expect, it } from 'vitest';
import { makeToolCall } from '@/dev/testkit';
import { ApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { APPROVAL_ARTIFACT_KINDS_V1, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { createUsageNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { listTranscriptApprovalArtifactsForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import { TRANSCRIPT_SETTLED_APPROVAL_PRESENTATIONS } from '@/components/tools/shell/approvals/transcriptSettledApprovalPresentations';
import { readApprovedSavedSkillResult, readSavedSkillAttachFailure, readSavedSkillResult } from './savedSkillResultModel';

describe('saved skill Action results', () => {
    const result = { ok: true, skillId: 'review', revision: '1:1', includedInSessionId: null, incomplete: 'session_include',
        summary: { name: 'Review code', description: 'Catch regressions' } };
    const call = (output: unknown, name = 'mcp__happier__action_execute') => makeToolCall({ name, state: 'completed',
        input: { actionId: 'skills.create', input: { name: 'Review code', files: [] } },
        result: { content: [{ type: 'text', text: JSON.stringify(output) }] } });
    it('preserves acknowledged saved identity when inclusion is incomplete through executor and MCP envelopes', () => {
        expect(readSavedSkillResult(call({ ok: true, result }))).toEqual(result);
        expect(readSavedSkillResult(call(result))).toEqual(result);
        expect(readSavedSkillResult({ ...call(result), name: 'mcp__happier__skills_create', input: { name: 'Review code', files: [] } })).toEqual(result);
    });
    it('keeps historical id-only successes readable without fabricating summaries, and refuses failures or other tools', () => {
        const historical = { ok: true, skillId: 'review', revision: '1:1' };
        expect(readSavedSkillResult(call(historical))).toEqual(historical);
        for (const output of [{ ok: false, errorCode: 'permission_denied', error: 'Denied' }, { ok: true }, null]) {
            expect(readSavedSkillResult(call(output))).toBeNull();
        }
        expect(readSavedSkillResult(call(result, 'mcp__other__skills_create'))).toBeNull();
        expect(readSavedSkillResult({ ...call(result), state: 'running' })).toBeNull();
    });
    it('retains deferred create acknowledgment at its original call, including an already persisted identity-only result', () => {
        const sessionId = 'c123456789012345678901234';
        const request = ApprovalRequestV1Schema.parse({
            v: 1, status: 'executed', createdAtMs: 1, updatedAtMs: 3,
            createdBy: { surface: 'agent', sessionId }, requestedSurface: 'agent', actionId: 'skills.create',
            actionArgs: {}, summary: 'Create a skill', origin: { kind: 'transcript_tool_call', sessionId, toolCallId: 'create-call' },
            decision: { kind: 'approve', decidedAtMs: 2 }, execution: { executedAtMs: 3, ok: true, result: {
                ok: true, skillId: 'review', revision: '1:1',
            } },
        });
        const header = buildApprovalRequestArtifactHeaderV1(request, { legacyServerId: 'home' });
        const artifact = { ...createUsageNoticeArtifactFixture({ id: 'create-approval' }), sourceServerId: 'home',
            header, rawHeader: header, kindHint: APPROVAL_ARTIFACT_KINDS_V1.builtIn, body: JSON.stringify(request), sessions: [sessionId] };
        expect(readApprovedSavedSkillResult(request)).toEqual(request.execution?.result);
        expect(listTranscriptApprovalArtifactsForSession([artifact], { serverId: 'home', sessionId }, {
            settledPresentations: TRANSCRIPT_SETTLED_APPROVAL_PRESENTATIONS,
        })).toHaveLength(1);
        expect(readApprovedSavedSkillResult({ ...request, status: 'failed' })).toBeNull();
        expect(readApprovedSavedSkillResult({ ...request, status: 'open' })).toBeNull();
        expect(readApprovedSavedSkillResult({ ...request, origin: undefined })).toBeNull();
        expect(readApprovedSavedSkillResult({ ...request, actionId: 'skills.duplicate' })).toBeNull();
    });
    it('says why attaching failed in a sentence, never by its raw code', () => {
        for (const outcome of [{ ok: false, errorCode: 'session_unavailable', error: 'session_unavailable' },
            { ok: true, result: { ok: false, code: 'conflict' } }, { ok: true, result: { unexpected: true } }]) {
            const sentence = readSavedSkillAttachFailure(outcome);
            expect(sentence).toMatch(/\s/);
            expect(sentence).not.toMatch(/session_unavailable|conflict|invalid_action_output/);
        }
        expect(readSavedSkillAttachFailure({ ok: true, result: { ok: true, state: 'on', previous: 'off', applyTiming: { t: 'next_turn' } } })).toBeNull();
    });
});
