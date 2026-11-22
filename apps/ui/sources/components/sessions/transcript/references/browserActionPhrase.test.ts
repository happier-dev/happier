import { describe, expect, it, vi } from 'vitest';

import type { ToolCall } from '@happier-dev/session-core/messages';
import { ApprovalRequestV1Schema, type ApprovalRequestV1 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { listTranscriptApprovalArtifactsForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { TRANSCRIPT_SETTLED_APPROVAL_PRESENTATIONS } from '@/components/tools/shell/approvals/transcriptSettledApprovalPresentations';
import { selectMatchingToolApprovalRequests } from '@/components/tools/shell/views/toolApprovalPromptMatching';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) });
});

import { describeBrowserAction, readBrowserCallOutcome } from './browserActionPhrase';
import { resolveTranscriptBrowserActionReference } from './transcriptBrowserActionReference';

const view = { browserSessionId: 'browser_session_1', viewId: 'browser_view_1' } as const;

function openCall(state: ToolCall['state'], result: unknown = null): ToolCall {
    return {
        name: 'mcp__happier__action_execute',
        state,
        input: { actionId: 'browser.view.open', input: { ...view,
            target: { kind: 'externalUrl', targetId: 'agent-target', url: 'https://en.wikipedia.org/wiki/Checkout' } } },
        createdAt: 1,
        startedAt: 1,
        completedAt: state === 'running' ? null : 2,
        description: null,
        result,
    };
}

function say(tool: ToolCall): string {
    const reference = resolveTranscriptBrowserActionReference({ toolName: tool.name, state: tool.state, input: tool.input, result: tool.result });
    if (!reference) throw new Error('expected a browser reference');
    return describeBrowserAction(reference, readBrowserCallOutcome(tool));
}

const asked = 'browserTool.present.opened:{"page":"en.wikipedia.org/wiki/Checkout"}';
const failed = `approvals.failureNamed:${JSON.stringify({ action: asked })}`;

const receiptActionArgs = { kind: 'openView', commandId: 'command_1', ...view,
    target: { kind: 'externalUrl', targetId: 'agent-target', url: 'https://example.test/page' }, platform: 'web' } as const;
const receiptTool = { ...openCall('completed', { ok: true, result: {
    kind: 'approval_request_created', artifactId: 'approval_1', actionId: 'browser.view.open',
} }), id: 'tool_1', input: { actionId: 'browser.view.open', input: receiptActionArgs } };
const approve = { kind: 'approve', decidedAtMs: 2 } as const;
const executed = { status: 'executed', decision: approve, execution: { executedAtMs: 3, ok: true,
    result: { v: 1, commandId: 'command_1', status: 'dispatched', adapterKind: 'chromiumSidecar', events: [] } } } as const;

function settledArtifact(change: Partial<ApprovalRequestV1>, id = 'approval_1'): DecryptedArtifact {
    const request = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 3,
        createdBy: { surface: 'agent', sessionId: 'session_1' }, requestedSurface: 'agent',
        actionId: 'browser.view.open', actionArgs: receiptActionArgs, summary: 'Open page',
        origin: { kind: 'transcript_tool_call', sessionId: 'session_1', toolCallId: 'tool_1', toolName: receiptTool.name },
        ...change });
    return { id, title: request.summary, isDecrypted: true, headerVersion: 1, bodyVersion: 1,
        header: buildApprovalRequestArtifactHeaderV1(request, { legacyServerId: 'server_1' }),
        body: JSON.stringify(request), seq: 1, createdAt: 1, updatedAt: 3 };
}

function matchingReceipts(artifacts: readonly DecryptedArtifact[]) {
    const requests = listTranscriptApprovalArtifactsForSession(artifacts, { sessionId: 'session_1', serverId: 'server_1' },
        { settledPresentations: TRANSCRIPT_SETTLED_APPROVAL_PRESENTATIONS });
    return selectMatchingToolApprovalRequests({ requests, sessionId: 'session_1', messageId: 'message_1',
        tool: receiptTool, normalizedToolName: receiptTool.name });
}

describe('browser tool row phrase', () => {
    it.each([
        { name: 'executed', request: executed, outcome: 'completed' },
        { name: 'still waiting', request: {}, outcome: 'pending' },
        { name: 'approved but not executed', request: { status: 'approved', decision: approve }, outcome: 'pending' },
        { name: 'rejected', request: { status: 'rejected', decision: { kind: 'reject', decidedAtMs: 2 } }, outcome: 'failed' },
        { name: 'failed', request: { status: 'failed', decision: approve,
            execution: { executedAtMs: 3, ok: false, errorCode: 'browser_view_unavailable', error: 'Unavailable' } }, outcome: 'failed' },
        { name: 'approved but refused by the Action', request: { ...executed,
            execution: { executedAtMs: 3, ok: true, result: { ok: false, errorCode: 'browser_control_denied', error: 'Refused' } } }, outcome: 'failed' },
        { name: 'approved but refused by Browser dispatch', request: { ...executed,
            execution: { executedAtMs: 3, ok: true, result: { v: 1, commandId: 'command_1', status: 'failed',
                error: { code: 'permission_denied', message: 'Refused', retryable: false } } } }, outcome: 'failed' },
        { name: 'accepted provisioning still in progress', request: { ...executed, execution: { executedAtMs: 3, ok: true,
            result: { v: 1, status: 'in_progress', phase: 'browser_runtime_provisioning', commandId: 'command_1',
                ...view, operationId: 'operation_1' } } }, outcome: 'pending' },
    ] as const)('reads $name through the retained settlement and real tool matcher', ({ request, outcome }) => {
        const matches = matchingReceipts([settledArtifact(request)]);
        expect(readBrowserCallOutcome(receiptTool, matches)).toBe(outcome);
    });

    it('does not mistake another receipt at the same call for this waiting request', () => {
        const matches = matchingReceipts([settledArtifact(executed, 'another_approval'), settledArtifact({})]);
        expect(readBrowserCallOutcome(receiptTool, matches)).toBe('pending');
    });

    it('asks in the present while the call runs, and while it waits for a person to approve it', () => {
        expect(say(openCall('running'))).toBe(asked);
        expect(say(openCall('completed', { ok: true, result: { kind: 'approval_request_created', artifactId: 'a1', actionId: 'browser.view.open' } })))
            .toBe(asked);
    });

    it('says the call could not finish when it failed, whether the call or its result carries the failure', () => {
        expect(readBrowserCallOutcome(openCall('error'))).toBe('failed');
        expect(say(openCall('error'))).toBe(failed);
        expect(say(openCall('completed', { ok: false, error: { code: 'browser_view_unavailable', message: 'unavailable' } }))).toBe(failed);
    });

    it('names a workspace Browser open as the page it opens, not as using the browser', () => {
        const tool: ToolCall = { ...openCall('running'), input: { actionId: 'browser.workspace.open', input: { scopeId: 'scope_1',
            target: { kind: 'externalUrl', targetId: 'agent-target', url: 'https://en.wikipedia.org/wiki/Price_point' } } } };
        expect(say(tool)).toBe('browserTool.present.opened:{"page":"en.wikipedia.org/wiki/Price_point"}');
    });

    it('tells the outcome in the past once the call completed', () => {
        expect(say(openCall('completed', { ok: true, result: { browserSessionId: 'browser_session_1', viewId: 'browser_view_1' } })))
            .toBe('browserTool.opened:{"page":"en.wikipedia.org/wiki/Checkout"}');
    });
});
