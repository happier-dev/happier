import { describe, expect, it } from 'vitest';
import { formatApprovalStatusLabel } from '@/components/approvals/approvalStatusLabel';
import { resolveToolCallsGroupPresentation, resolveToolCallsGroupSummary, shouldShowToolCallsGroupStatusIndicator } from './resolveToolCallsGroupPresentation';
import { createToolCallMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { ReviewFindingsV2Schema } from '@happier-dev/protocol/messages/structured/reviewFindingsV2';
import { resolveInactiveSessionToolCallFailure } from '@/components/tools/shell/permissions/resolveInactiveSessionToolCallFailure';
import { resolveToolStatusIndicatorKind } from '@/components/tools/shell/presentation/resolveToolStatusIndicatorKind';
import { deriveTranscriptInteractionFromSession } from '@/utils/sessions/deriveTranscriptInteraction';
import type { ToolCall } from '@happier-dev/session-core/messages';

const groupStatus = (params: Parameters<typeof resolveToolCallsGroupSummary>[0]) => resolveToolCallsGroupSummary(params).status;

describe('hidden tool group presentation', () => {
    it.each(['denied', 'canceled'] as const)('summarises a person’s Shell %s decision with the approval vocabulary', (status) => {
        const base = createToolCallMessageFixture();
        const message = createToolCallMessageFixture({ tool: { ...base.tool, name: 'Bash', state: 'error',
            permission: { id: 'shell-permission', status, decision: status === 'denied' ? 'denied' : 'abort',
                ...(status === 'denied' ? { decisionActor: { kind: 'accountUser', accountId: 'owner', relationship: 'owner' } } : {}) },
        } });
        expect(resolveToolCallsGroupSummary({ toolMessages: [message] })).toMatchObject({
            status: 'refused', refused: 1, failed: 0,
            refusalLabel: formatApprovalStatusLabel(status === 'denied' ? 'rejected' : 'canceled'),
        });
    });
    it.each([undefined, 'approved', 'pending'] as const)('stops an unsettled tool glyph on a stopped Session with permission %s', (permissionStatus) => {
        const tool: ToolCall = { ...createToolCallMessageFixture().tool,
            ...(permissionStatus ? { permission: { id: 'permission', status: permissionStatus } } : {}) };
        const interaction = deriveTranscriptInteractionFromSession({ active: false });
        const projected = resolveInactiveSessionToolCallFailure({ tool, ...interaction });

        expect(projected.state).toBe('error');
        expect(resolveToolStatusIndicatorKind(projected)).toBe(permissionStatus === 'pending' ? 'permission_blocked' : 'error');
        expect(projected.result).toBe(tool.result);
        expect(projected.permission?.status).toBe(permissionStatus === 'pending' ? 'canceled' : permissionStatus);
        expect(tool.state).toBe('running');
        expect(tool.permission?.status).toBe(permissionStatus);
    });

    it('preserves live calls and settled results at the shared Session projection', () => {
        const running = createToolCallMessageFixture().tool;
        const live = deriveTranscriptInteractionFromSession({ active: true });
        expect(resolveInactiveSessionToolCallFailure({ tool: running, ...live })).toBe(running);
        expect(resolveToolStatusIndicatorKind(running)).toBe('running');
        const stopped = deriveTranscriptInteractionFromSession({ active: false });
        for (const state of ['completed', 'error'] as const) {
            const settled: ToolCall = { ...running, state, completedAt: 2, result: state === 'completed' ? { value: 'done' } : { error: 'failed' } };
            const projected = resolveInactiveSessionToolCallFailure({ tool: settled, ...stopped });
            expect(projected).toBe(settled);
            expect(resolveToolStatusIndicatorKind(projected)).toBe(state);
        }
    });

    it('uses the same stopped-call projection in the group summary', () => {
        const running = createToolCallMessageFixture();
        const stopped = deriveTranscriptInteractionFromSession({ active: false });
        expect(groupStatus({ toolMessages: [running], ...stopped })).toBe('error');
        expect(groupStatus({ toolMessages: [running] })).toBe('running');
    });

    it('settles a published review group while preserving other running tool activity', () => {
        const ordinary = createToolCallMessageFixture({ id: 'ordinary' });
        const review = createToolCallMessageFixture({ id: 'review', tool: { ...ordinary.tool, id: 'review-call',
            name: 'SubAgentRun', input: { intent: 'review', runId: 'review-run' } }, children: [{
            kind: 'agent-text', id: 'findings', localId: null, createdAt: 2, text: 'Reviewed.',
            meta: { happier: { kind: 'review_findings.v2', payload: ReviewFindingsV2Schema.parse({
                runRef: { runId: 'review-run', callId: 'review-call', backendId: 'claude' },
                reviewOutcome: 'complete', summary: 'Reviewed.', overviewMarkdown: 'Overview.', findings: [], generatedAtMs: 2,
            }) } },
        }] });

        expect(groupStatus({ toolMessages: [review] })).toBe('completed');
        expect(groupStatus({ toolMessages: [review, ordinary] })).toBe('running');
        expect(review.tool.state).toBe('running');
    });

    it('retains an error or denied recovery indication while ordinary tool activity continues', () => {
        const running = createToolCallMessageFixture({ id: 'running' });
        const error = createToolCallMessageFixture({ id: 'error', tool: { ...running.tool, state: 'error' } });
        const denied = createToolCallMessageFixture({ id: 'denied', tool: { ...running.tool,
            permission: { id: 'approval', status: 'denied' } } });
        expect(groupStatus({ toolMessages: [running, error], showToolCalls: false })).toBe('error');
        expect(groupStatus({ toolMessages: [running, denied], showToolCalls: false })).toBe('permission_denied');
        expect(groupStatus({ toolMessages: [running, error], showToolCalls: true })).toBe('running');
    });
    it('never summarises a refused or failed Action call as completed, and says refused only when nothing failed', () => {
        const ok = createToolCallMessageFixture({ id: 'ok' });
        const actionCall = (id: string, outcome: unknown) => {
            const text = JSON.stringify(outcome);
            return createToolCallMessageFixture({ id, tool: { ...ok.tool, name: 'mcp__happier__action_execute', state: 'completed',
                input: { actionId: 'session.stop', input: {} }, result: { content: [{ type: 'text', text }], text } } });
        };
        const refused = actionCall('refused', { errorCode: 'unsupported_action', error: 'unsupported_action:session.stop',
            details: { cause: 'target_outside_led_subtree' } });
        const failed = actionCall('failed', { errorCode: 'target_unavailable', error: 'target_unavailable' });
        const completed = { ...ok, tool: { ...ok.tool, state: 'completed' as const } };
        expect(groupStatus({ toolMessages: [refused, completed] })).toBe('refused');
        expect(groupStatus({ toolMessages: [failed, completed] })).toBe('error');
        expect(groupStatus({ toolMessages: [refused, failed] })).toBe('error');
        expect(shouldShowToolCallsGroupStatusIndicator({ showToolCalls: false, status: 'refused' })).toBe(true);
    });
    it('counts each outcome so a mixed group can say both, never a success', () => {
        const ok = createToolCallMessageFixture({ id: 'ok' });
        const actionCall = (id: string, outcome: unknown) => {
            const text = JSON.stringify(outcome);
            return createToolCallMessageFixture({ id, tool: { ...ok.tool, name: 'mcp__happier__action_execute', state: 'completed',
                input: { actionId: 'session.stop', input: {} }, result: { content: [{ type: 'text', text }], text } } });
        };
        const refused = actionCall('refused', { errorCode: 'unsupported_action', error: 'unsupported_action:session.stop' });
        const failed = actionCall('failed', { errorCode: 'target_unavailable', error: 'target_unavailable' });
        const ordinaryError = createToolCallMessageFixture({ id: 'ordinary', tool: { ...ok.tool, state: 'error' } });
        expect(resolveToolCallsGroupSummary({ toolMessages: [refused, failed, refused] })).toEqual({
            status: 'error', failed: 1, refused: 2, failuresAreActionOutcomes: true,
        });
        expect(resolveToolCallsGroupSummary({ toolMessages: [refused] })).toMatchObject({ status: 'refused', failed: 0, refused: 1 });
        // An ordinary tool error keeps its own word; only typed Action failures read as "Failed".
        expect(resolveToolCallsGroupSummary({ toolMessages: [ordinaryError] })).toMatchObject({ failed: 1, failuresAreActionOutcomes: false });
    });
    it('keeps the collapsed group header-only but reveals every tool after explicit disclosure', () => {
        const input = { showToolCalls: false, toolCalls: [1, 2], collapsedPreviewCount: 3 };
        expect(resolveToolCallsGroupPresentation({ ...input, expanded: false })).toMatchObject({
            visibleToolCalls: [], hiddenCount: 2, showBody: false, showExpandMore: false,
        });
        expect(resolveToolCallsGroupPresentation({ ...input, expanded: true })).toMatchObject({
            visibleToolCalls: [1, 2], hiddenCount: 0, showBody: true, showExpandMore: false,
        });
    });
    it('suppresses ordinary tool activity while retaining error and denied recovery indications', () => {
        expect(shouldShowToolCallsGroupStatusIndicator({ showToolCalls: false, status: 'running' })).toBe(false);
        expect(shouldShowToolCallsGroupStatusIndicator({ showToolCalls: false, status: 'completed' })).toBe(false);
        expect(shouldShowToolCallsGroupStatusIndicator({ showToolCalls: false, status: 'error' })).toBe(true);
        expect(shouldShowToolCallsGroupStatusIndicator({ showToolCalls: false, status: 'permission_denied' })).toBe(true);
        expect(shouldShowToolCallsGroupStatusIndicator({ showToolCalls: true, status: 'running' })).toBe(true);
    });

    it('summarises a group holding a call whose Action approval was declined as refused, not completed', () => {
        const ok = createToolCallMessageFixture({ id: 'ok', tool: { ...createToolCallMessageFixture({ id: 'x' }).tool, state: 'completed' } });
        const declinedCall = createToolCallMessageFixture({ id: 'm-declined', tool: { ...ok.tool, id: 'call-declined', state: 'completed' } });
        const approvalRequests = (status: 'rejected' | 'canceled' | 'open') => [{
            artifact: { id: 'approval-1', header: {} } as never,
            approval: {
                v: 1, status, createdAtMs: 1, updatedAtMs: 2, createdBy: { surface: 'agent', sessionId: 's1' },
                actionId: 'mcp.servers.signIn.start', actionArgs: {}, summary: 'Sign in',
                origin: { kind: 'transcript_tool_call', sessionId: 's1', toolCallId: 'call-declined' },
            },
        }] as never;
        const group = { toolMessages: [ok, declinedCall], sessionId: 's1' } as const;
        expect(groupStatus({ ...group, approvalRequests: approvalRequests('rejected') })).toBe('refused');
        expect(groupStatus({ ...group, approvalRequests: approvalRequests('canceled') })).toBe('refused');
        for (const status of ['rejected', 'canceled'] as const) {
            expect(resolveToolCallsGroupSummary({ ...group, approvalRequests: approvalRequests(status) }).refusalLabel)
                .toBe(formatApprovalStatusLabel(status));
        }
        expect(groupStatus({ ...group, approvalRequests: approvalRequests('open') })).toBe('completed');
        expect(groupStatus({ ...group })).toBe('completed');
    });
});
