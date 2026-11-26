import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { ApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { createToolCallMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { listTranscriptApprovalArtifactsForSession, type OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { resolveMessageRouteIdForDisplay } from '@happier-dev/session-core/messages';
import { doesApprovalMatchToolCall, selectScriptChildApprovalRequest, selectMatchingToolApprovalRequests, selectToolApprovalRequestsForMessages, useToolApprovalRequestsIndex } from './toolApprovalPromptMatching';

afterEach(standardCleanup);

const fixtureSession = { serverId: 'fixture-home', sessionId: 'fixture' };

function requestArtifact(index: number): Extract<DecryptedArtifact, { isDecrypted: true }> {
    const approval = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 'fixture' }, actionId: 'skills.rules.set',
            actionArgs: { id: String(index), state: 'on' }, summary: 'Change reach',
            origin: { kind: 'transcript_tool_call', sessionId: 'fixture', toolName: 'action_execute' } });
    return { id: `approval-${index}`, title: approval.summary, isDecrypted: true, headerVersion: 1, bodyVersion: 1,
        header: buildApprovalRequestArtifactHeaderV1(approval, { legacyServerId: fixtureSession.serverId }),
        body: JSON.stringify(approval), seq: index, createdAt: 1, updatedAt: 1 };
}

function request(index: number): OpenApprovalArtifactForSession {
    return listTranscriptApprovalArtifactsForSession([requestArtifact(index)], fixtureSession)[0]!;
}

describe('transcript approval matching cost', () => {
    it('indexes 12 child approvals once for 200 collapsed Script cards with unhydrated children', () => {
        const requests = Array.from({ length: 12 }, (_, i) => {
            const base = request(i);
            return { ...base, approval: { ...base.approval, origin: { ...base.approval.origin!,
                parentMessageId: `script-${i}`, toolCallId: `child-${i}` } } };
        });
        let iterations = 0;
        const iterate = requests[Symbol.iterator].bind(requests);
        requests[Symbol.iterator] = () => { iterations++; return iterate(); };
        for (let i = 0; i < 200; i++) {
            const id = `script-${i}`;
            const message = createToolCallMessageFixture({ id, children: [],
                tool: { ...createToolCallMessageFixture().tool, id, name: 'Script' } });
            const selected = selectToolApprovalRequestsForMessages({ requests, sessionId: 'fixture', rowId: id, messages: [message] });
            expect(selectScriptChildApprovalRequest({ requests: selected, sessionId: 'fixture',
                messageId: id, parentToolCallId: id })).toBe(requests[i]);
            expect(selectScriptChildApprovalRequest({ requests: selected, sessionId: 'fixture',
                messageId: id, parentToolCallId: id })).toBe(requests[i]);
            expect(selectMatchingToolApprovalRequests({ requests: selected, sessionId: 'fixture', messageId: id,
                tool: message.tool, normalizedToolName: 'Script' })).toEqual([]);
            if (i < 12) {
                const child = { ...message.tool, name: 'action_execute', id: `child-${i}` };
                expect(selectMatchingToolApprovalRequests({ requests: selected, sessionId: 'fixture', messageId: 'child-message',
                    tool: child, normalizedToolName: child.name })).toEqual([requests[i]]);
            }
        }
        expect(iterations).toBe(1);
    });
    it('normalizes omitted contextual operands without sharing Session scope across cached inputs', () => {
        const makeRequest = (sessionId: string): OpenApprovalArtifactForSession => {
            const base = request(1);
            return { ...base, artifact: { ...base.artifact, id: `approval-${sessionId}` }, approval: ApprovalRequestV1Schema.parse({ ...base.approval,
                actionId: 'session.title.set', actionArgs: { sessionId, title: 'Scoped title' },
                origin: { kind: 'transcript_tool_call', sessionId, toolName: 'action_execute' },
            }) };
        };
        const tool = { ...createToolCallMessageFixture().tool, name: 'mcp__happier__action_execute',
            input: { actionId: 'session.title.set', input: { title: 'Scoped title' } } };
        const requests = [makeRequest('session-a'), makeRequest('session-b')];
        for (const [i, sessionId] of ['session-a', 'session-b'].entries()) {
            expect(selectMatchingToolApprovalRequests({ requests, sessionId, messageId: undefined, tool, normalizedToolName: 'MCP' }))
                .toEqual([requests[i]]);
        }
        const wrong = { ...tool, input: { ...tool.input, input: { title: 'Scoped title', sessionId: 'session-b' } } };
        expect(selectMatchingToolApprovalRequests({ requests, sessionId: 'session-a', messageId: undefined,
            tool: wrong, normalizedToolName: 'MCP' })).toEqual([]);
    });
    it('changes only the affected tool row when an approval arrives in a 1,000-row transcript', async () => {
        const artifacts = Array.from({ length: 12 }, (_, i) => requestArtifact(i));
        const requests = listTranscriptApprovalArtifactsForSession(artifacts, fixtureSession);
        const tools = Array.from({ length: 1000 }, (_, i) => createToolCallMessageFixture({ id: `message-${i}`,
            tool: { ...createToolCallMessageFixture({ id: 'base' }).tool, id: `tool-${i}`, name: 'mcp__happier__action_execute',
                input: { actionId: 'skills.rules.set', input: { id: String(i), state: 'on' } } } }).tool);
        let renders = 0;
        const Row = React.memo((_props: { requests: readonly OpenApprovalArtifactForSession[] }) => { renders++; return null; });
        function Transcript(props: { requests: readonly OpenApprovalArtifactForSession[] }) {
            useToolApprovalRequestsIndex(props.requests);
            return React.createElement(React.Fragment, null, ...tools.map((tool, i) => React.createElement(Row, { key: i,
                requests: selectMatchingToolApprovalRequests({ requests: props.requests, sessionId: 'fixture', messageId: `message-${i}`, tool, normalizedToolName: tool.name }),
            })));
        }
        const screen = await renderScreen(React.createElement(Transcript, { requests }));
        renders = 0;
        const incoming = requestArtifact(12);
        const stringify = vi.spyOn(JSON, 'stringify');
        try {
            // Exercise the real producer; the matcher must not repair freshly cloned siblings.
            await screen.update(React.createElement(Transcript, {
                requests: listTranscriptApprovalArtifactsForSession([...artifacts, incoming], fixtureSession),
            }));
            expect(renders).toBe(1);
            // TOTAL work: one new Session reference fact plus one new input signature.
            // The producer's separate two-scale contract also includes every serialization.
            expect(stringify.mock.calls.length).toBe(2);
            renders = 0;
            await screen.update(React.createElement(Transcript, {
                requests: listTranscriptApprovalArtifactsForSession([...artifacts.slice(1), incoming], fixtureSession),
            }));
            expect(renders).toBe(1);
        } finally { stringify.mockRestore(); }
    });

    it('keeps index selection equivalent to the correlation owner for explicit ids, fallback names and multiple approvals', () => {
        const base = request(1);
        const origin = base.approval.origin!;
        const requests = [
            { ...base, approval: { ...base.approval, origin: { ...origin, messageId: 'message', toolCallId: 'other' } } },
            { ...request(2), approval: { ...base.approval, origin: { ...origin, messageId: 'other', toolCallId: 'call' } } },
            { ...request(3), approval: { ...base.approval, origin: { ...origin, messageId: 'other' } } },
            { ...request(4), approval: { ...base.approval, origin: { ...origin, toolCallId: 'other' } } },
            { ...request(5), approval: { ...base.approval, origin: { ...origin, sessionId: 'another' } } },
            base,
            { ...request(6), approval: { ...base.approval, origin: { ...origin, toolName: 'normalized',
                toolInput: { actionId: 'skills.rules.set', input: { id: '1', state: 'on' } } } } },
        ];
        const tool = { ...createToolCallMessageFixture().tool, id: 'call', name: 'mcp__happier__action_execute',
            input: { input: { state: 'on', id: '1' }, actionId: 'skills.rules.set' } };
        for (const messageId of ['message', 'other', undefined]) {
            const params = { sessionId: 'fixture', messageId, tool, normalizedToolName: 'normalized' };
            const expected = requests.filter(request => doesApprovalMatchToolCall({ ...params, request }));
            expect(selectMatchingToolApprovalRequests({ ...params, requests })).toEqual(expected);
        }
        const message = createToolCallMessageFixture({ id: 'message', tool: { ...tool, name: 'unknown' } });
        const candidates = selectToolApprovalRequestsForMessages({ requests, sessionId: 'fixture', rowId: 'row', messages: [message] });
        // Parent narrowing must retain an input match that the leaf's name inference will resolve.
        expect(candidates).toContain(requests[6]);
        expect(selectMatchingToolApprovalRequests({ requests: candidates, sessionId: 'fixture', messageId: message.id,
            tool: message.tool, normalizedToolName: 'normalized' })).toContain(requests[6]);
        expect(selectMatchingToolApprovalRequests({ requests, sessionId: 'unrelated', messageId: 'message', tool, normalizedToolName: 'normalized' })).toHaveLength(0);
    });

    it('withdraws old associations when an approval changes its origin or disappears', async () => {
        const initialArtifact = requestArtifact(1);
        const initial = listTranscriptApprovalArtifactsForSession([initialArtifact], fixtureSession)[0]!;
        const hook = await renderHook((props: { requests: readonly OpenApprovalArtifactForSession[] }) => {
            useToolApprovalRequestsIndex(props.requests);
            return props.requests;
        }, { initialProps: { requests: [initial] } });
        const tool = { ...createToolCallMessageFixture().tool, id: 'call', name: 'mcp__happier__action_execute',
            input: { actionId: 'skills.rules.set', input: { id: '1', state: 'on' } } };
        const select = () => selectMatchingToolApprovalRequests({ requests: hook.getCurrent(), sessionId: 'fixture', messageId: 'message', tool, normalizedToolName: tool.name });
        expect(select()).toHaveLength(1);
        const changedApproval = { ...initial.approval, origin: { ...initial.approval.origin!, toolCallId: 'other' } };
        const changed = listTranscriptApprovalArtifactsForSession([
            { ...initialArtifact, bodyVersion: 2, body: JSON.stringify(changedApproval) },
        ], fixtureSession)[0]!;
        await hook.rerender({ requests: [changed] });
        expect(select()).toHaveLength(0);
        await hook.rerender({ requests: [] });
        expect(select()).toHaveLength(0);
    });

    it('retains approvals addressed by the displayed route rather than the internal message id', () => {
        const message = createToolCallMessageFixture({ id: 'internal-message',
            tool: { ...createToolCallMessageFixture().tool, id: 'call' } });
        const route = { messagesById: { [message.id]: message }, reducerState: null };
        const messageId = resolveMessageRouteIdForDisplay({ message, ...route });
        expect(messageId).not.toBe(message.id);
        const base = request(1);
        const approval = { ...base, approval: { ...base.approval, origin: { ...base.approval.origin!, messageId } } };
        const params = { requests: [approval], sessionId: 'fixture', rowId: 'row', messages: [message], messageId };
        const candidates = selectToolApprovalRequestsForMessages(params);
        expect(selectMatchingToolApprovalRequests({ requests: candidates, sessionId: 'fixture', messageId,
            tool: message.tool, normalizedToolName: message.tool.name })).toEqual([approval]);
    });

    it('serializes each unchanged reviewed input and tool input once across a long transcript', () => {
        const requests = Array.from({ length: 12 }, (_, i) => request(i));
        const tools = Array.from({ length: 1000 }, (_, i) => createToolCallMessageFixture({ id: `message-${i}`,
            tool: { ...createToolCallMessageFixture({ id: 'base' }).tool, id: `tool-${i}`, name: 'mcp__happier__action_execute',
                input: { actionId: 'skills.rules.set', input: { id: String(i), state: 'on' } } } }).tool);
        const stringify = vi.spyOn(JSON, 'stringify');
        try {
            const match = () => tools.map((tool, index) => requests.filter(request => doesApprovalMatchToolCall({
                request, sessionId: 'fixture', messageId: `message-${index}`, tool, normalizedToolName: tool.name,
            })));
            expect(match().filter(xs => xs.length > 0)).toHaveLength(12);
            expect(stringify.mock.calls.length).toBeLessThanOrEqual(1012);
            stringify.mockClear();
            expect(match().filter(xs => xs.length > 0)).toHaveLength(12);
            expect(stringify).not.toHaveBeenCalled();
            // The reducer replaces input while retaining the ToolCall identity; current input must win.
            tools[0]!.input = { actionId: 'skills.rules.set', input: { id: 'changed', state: 'on' } };
            expect(match()[0]).toHaveLength(0);
            expect(stringify).toHaveBeenCalledTimes(1);
        } finally { stringify.mockRestore(); }
    });

    it('reuses unchanged input across rendering-normalizer ToolCall projections', () => {
        const approval = request(1);
        const tool = { ...createToolCallMessageFixture().tool, id: 'call', name: 'mcp__happier__action_execute',
            input: { actionId: 'skills.rules.set', input: { id: '1', state: 'on' } } };
        const params = { request: approval, sessionId: 'fixture', messageId: 'message', normalizedToolName: tool.name };
        expect(doesApprovalMatchToolCall({ ...params, tool })).toBe(true);
        const stringify = vi.spyOn(JSON, 'stringify');
        try {
            expect(doesApprovalMatchToolCall({ ...params, tool: { ...tool, result: 'new output' } })).toBe(true);
            expect(stringify).not.toHaveBeenCalled();
        } finally { stringify.mockRestore(); }
    });
});
