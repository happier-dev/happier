import { describe, expect, it } from 'vitest';
import type { ToolCall } from '@happier-dev/session-core/messages';

import { resolveToolActionFailure } from './resolveToolActionFailure';
import { resolveToolStatusIndicatorKind } from './resolveToolStatusIndicatorKind';
import { formatApprovalStatusLabel } from '@/components/approvals/approvalStatusLabel';
import { resolveToolErrorSummary } from './resolveToolErrorSummary';

/** A first-party Action call as the transcript stores it: the MCP text envelope around the typed outcome. */
function actionCall(actionId: string, outcome: unknown): ToolCall {
    const text = JSON.stringify(outcome);
    return {
        name: 'mcp__happier__action_execute',
        state: 'completed',
        input: { actionId, input: {} },
        createdAt: 1, startedAt: 1, completedAt: 2, description: null,
        result: { content: [{ type: 'text', text }], structuredContent: null, text, _mcp: { serverId: 'happier', toolId: 'action_execute' } },
    };
}

describe('resolveToolActionFailure', () => {
    it('explains the Machine admission owner Manage refusal', () => {
        const tool = actionCall('action.invoke', { ok: false, errorCode: 'credential_scope_denied',
            error: 'credential_scope_denied', failureCause: { phase: 'execution_authorization',
                errorClass: 'Error', errorCode: 'machine_manage_required', httpStatus: null } });
        expect(resolveToolActionFailure(tool)).toMatchObject({ outcome: 'refused',
            code: 'credential_scope_denied', summary: 'This Action needs Manage on this Machine.' });
    });

    it('explains a host Run tool-policy refusal without exposing its diagnostic code', () => {
        const tool: ToolCall = { ...actionCall('execution.run.start', {}), name: 'SubAgentRun', state: 'error',
            input: { runId: 'run_1' }, result: { status: 'failed', runId: 'run_1',
                error: { code: 'codex_tool_restriction_unsupported_auth', message: 'private diagnostic' } } };
        expect(resolveToolActionFailure(tool)).toMatchObject({ outcome: 'refused',
            code: 'codex_tool_restriction_unsupported_auth', summary: expect.any(String) });
        expect(resolveToolActionFailure(tool)?.summary).not.toContain('codex_tool_restriction_unsupported_auth');
    });
    it.each(['approval_rejected', 'approval_canceled'])('presents a declined approval (%s) as refused: the person said no, nothing failed', (code) => {
        const tool: ToolCall = { ...actionCall('mcp.servers.signIn.start', { errorCode: code, error: code }), state: 'error' };
        expect(resolveToolActionFailure(tool)).toMatchObject({ outcome: 'refused', code });
        const label = formatApprovalStatusLabel(code === 'approval_rejected' ? 'rejected' : 'canceled');
        expect(resolveToolActionFailure(tool)?.summary).toBe(label);
        expect(resolveToolErrorSummary(tool)).toBe(label);
    });
    it('presents a policy refusal as refused, with the cause in words and the typed code kept', () => {
        const tool = actionCall('session.stop', {
            errorCode: 'unsupported_action', error: 'unsupported_action:session.stop', details: { cause: 'target_outside_led_subtree' },
        });
        const failure = resolveToolActionFailure(tool);
        expect(failure).toMatchObject({ outcome: 'refused', code: 'unsupported_action', cause: 'target_outside_led_subtree' });
        expect(failure?.summary).toBeTruthy();
        expect(failure?.summary).not.toContain('target_outside_led_subtree');
        expect(resolveToolStatusIndicatorKind(tool)).toBe('error');
    });

    it('presents an unavailable target as failed with no invented cause line', () => {
        const tool = actionCall('session.spawn_new', { errorCode: 'target_unavailable', error: 'target_unavailable' });
        expect(resolveToolActionFailure(tool)).toMatchObject({ outcome: 'failed', code: 'target_unavailable', summary: null });
        expect(resolveToolStatusIndicatorKind(tool)).toBe('error');
    });

    it('presents a refused authorization named by its reason as refused', () => {
        const tool = actionCall('session.spawn_new', {
            errorCode: 'target_unavailable', error: 'target_unavailable', details: { reason: 'external_authorization_refused' },
        });
        expect(resolveToolActionFailure(tool)).toMatchObject({ outcome: 'refused', cause: 'external_authorization_refused' });
    });

    it('presents a typed spawn error as failed by its launch code', () => {
        const tool = actionCall('session.spawn_new', {
            type: 'error', code: 'spawn_failed', retryable: true, launchError: { kind: 'launch_error', code: 'project_requester_home_unavailable' },
        });
        expect(resolveToolActionFailure(tool)).toMatchObject({ outcome: 'failed', code: 'project_requester_home_unavailable' });
    });

    it('leaves an accepted-pending call and a successful read untouched', () => {
        for (const outcome of [{ type: 'pending', outcome: 'accepted' }, { workState: { v: 1, items: [] } }]) {
            const tool = actionCall('session.spawn_new', outcome);
            expect(resolveToolActionFailure(tool)).toBeNull();
            expect(resolveToolStatusIndicatorKind(tool)).toBe('completed');
        }
    });
});
