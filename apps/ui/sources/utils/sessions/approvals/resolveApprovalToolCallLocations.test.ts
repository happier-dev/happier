import { describe, expect, it } from 'vitest';
import type { ApprovalRequestV1 } from '@happier-dev/protocol';

import type { ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import { buildMessageRouteId } from '@/sync/domains/messages/messageRouteIds';

import { resolveApprovalToolCallLocations } from './resolveApprovalToolCallLocations';

function approval(params: Partial<ApprovalRequestV1> & Pick<ApprovalRequestV1, 'origin'>): ApprovalRequestV1 {
    return {
        v: 1,
        status: 'open',
        createdAtMs: 1,
        updatedAtMs: 1,
        createdBy: { surface: 'session_agent', sessionId: 's1' },
        actionId: 'session.list',
        actionArgs: {},
        summary: 'List sessions',
        ...params,
    };
}

function toolMessage(params: Readonly<{
    id: string;
    seq?: number;
    toolId?: string | null;
    name?: string;
    input?: unknown;
    children?: ToolCallMessage[];
}>): ToolCallMessage {
    return {
        kind: 'tool-call',
        id: params.id,
        localId: null,
        createdAt: 1,
        tool: {
            ...(typeof params.toolId === 'string' ? { id: params.toolId } : params.toolId === null ? {} : { id: `call:${params.id}` }),
            name: params.name ?? 'session_list',
            state: 'completed',
            input: params.input ?? {},
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null,
            result: {},
        } as any,
        ...(typeof params.seq === 'number' ? { seq: params.seq } : {}),
        children: params.children ?? [],
    } as any;
}

describe('resolveApprovalToolCallLocations', () => {
    it('resolves approval origins by message id', () => {
        const top = toolMessage({ id: 'msg-1', seq: 10, toolId: 'tool-1' });

        const out = resolveApprovalToolCallLocations({
            approvals: [
                {
                    artifactId: 'approval-1',
                    approval: approval({
                        origin: {
                            kind: 'transcript_tool_call',
                            sessionId: 's1',
                            messageId: 'msg-1',
                            toolName: 'session_list',
                        },
                    }),
                },
            ],
            sessionId: 's1',
            messageIdsOldestFirst: ['msg-1'],
            messagesById: { 'msg-1': top },
            resolveRouteMessageId: (_messageId, message) => (message ? buildMessageRouteId(message) : null),
        });

        expect(out.get('approval-1')).toEqual({ kind: 'top', messageId: 'tool:tool-1', seq: 10 });
    });

    it('resolves approval origins by a unique tool name and input fallback', () => {
        const first = toolMessage({ id: 'msg-1', seq: 10, name: 'session_list', input: { limit: 10 } });
        const second = toolMessage({ id: 'msg-2', seq: 11, name: 'session_list', input: { limit: 20 } });

        const out = resolveApprovalToolCallLocations({
            approvals: [
                {
                    artifactId: 'approval-1',
                    approval: approval({
                        origin: {
                            kind: 'transcript_tool_call',
                            sessionId: 's1',
                            toolName: 'session_list',
                            toolInput: { limit: 20 },
                        },
                    }),
                },
            ],
            sessionId: 's1',
            messageIdsOldestFirst: ['msg-1', 'msg-2'],
            messagesById: { 'msg-1': first, 'msg-2': second },
        });

        expect(out.get('approval-1')).toEqual({ kind: 'top', messageId: 'msg-2', seq: 11 });
    });

    it('does not resolve ambiguous tool-name fallbacks', () => {
        const first = toolMessage({ id: 'msg-1', seq: 10, name: 'session_list' });
        const second = toolMessage({ id: 'msg-2', seq: 11, name: 'session_list' });

        const out = resolveApprovalToolCallLocations({
            approvals: [
                {
                    artifactId: 'approval-1',
                    approval: approval({
                        origin: {
                            kind: 'transcript_tool_call',
                            sessionId: 's1',
                            toolName: 'session_list',
                        },
                    }),
                },
            ],
            sessionId: 's1',
            messageIdsOldestFirst: ['msg-1', 'msg-2'],
            messagesById: { 'msg-1': first, 'msg-2': second },
        });

        expect(out.get('approval-1')).toBeNull();
    });

    it('does not fall back to tool name and input when an exact message origin is stale', () => {
        const current = toolMessage({ id: 'msg-current', seq: 10, name: 'session_list', input: { limit: 20 } });

        const out = resolveApprovalToolCallLocations({
            approvals: [
                {
                    artifactId: 'approval-1',
                    approval: approval({
                        origin: {
                            kind: 'transcript_tool_call',
                            sessionId: 's1',
                            messageId: 'msg-missing',
                            toolName: 'session_list',
                            toolInput: { limit: 20 },
                        },
                    }),
                },
            ],
            sessionId: 's1',
            messageIdsOldestFirst: ['msg-current'],
            messagesById: { 'msg-current': current },
        });

        expect(out.get('approval-1')).toBeNull();
    });

    it('does not fall back to tool name and input when an exact tool call origin is stale', () => {
        const current = toolMessage({ id: 'msg-current', seq: 10, toolId: 'tool-current', name: 'session_list', input: { limit: 20 } });

        const out = resolveApprovalToolCallLocations({
            approvals: [
                {
                    artifactId: 'approval-1',
                    approval: approval({
                        origin: {
                            kind: 'transcript_tool_call',
                            sessionId: 's1',
                            toolCallId: 'tool-missing',
                            toolName: 'session_list',
                            toolInput: { limit: 20 },
                        },
                    }),
                },
            ],
            sessionId: 's1',
            messageIdsOldestFirst: ['msg-current'],
            messagesById: { 'msg-current': current },
        });

        expect(out.get('approval-1')).toBeNull();
    });
});
