import { describe, expect, it } from 'vitest';

import { createCodexAppServerStreamEventBridge } from './streamEventBridge';

describe('createCodexAppServerStreamEventBridge', () => {
    it('maps app-server v2 agent message, plan, and reasoning notifications', () => {
        const bridge = createCodexAppServerStreamEventBridge();

        expect(
            bridge.onNotification({
                method: 'item/agentMessage/delta',
                params: {
                    itemId: 'msg_1',
                    delta: 'Hello',
                },
            }),
        ).toEqual([{ type: 'assistant-text-delta', itemId: 'msg_1', text: 'Hello' }]);

        expect(
            bridge.onNotification({
                method: 'item/plan/delta',
                params: {
                    itemId: 'plan_1',
                    delta: '## Proposed plan',
                },
            }),
        ).toEqual([{ type: 'assistant-text-delta', itemId: 'plan_1', text: '## Proposed plan' }]);

        expect(
            bridge.onNotification({
                method: 'item/completed',
                params: {
                    item: {
                        id: 'msg_1',
                        type: 'agentMessage',
                        text: 'Hello world',
                    },
                },
            }),
        ).toEqual([{ type: 'assistant-text-final', itemId: 'msg_1', text: 'Hello world' }]);

        expect(
            bridge.onNotification({
                method: 'rawResponseItem/completed',
                params: {
                    item: {
                        type: 'message',
                        role: 'assistant',
                        content: [
                            { type: 'output_text', text: 'Raw assistant final' },
                        ],
                    },
                },
            }),
        ).toEqual([{ type: 'assistant-raw-final', text: 'Raw assistant final' }]);

        expect(
            bridge.onNotification({
                method: 'item/reasoning/summaryTextDelta',
                params: {
                    itemId: 'reason_1',
                    delta: 'thinking...',
                    summaryIndex: 0,
                },
            }),
        ).toEqual([{ type: 'reasoning-delta', itemId: 'reason_1', text: 'thinking...' }]);

        expect(
            bridge.onNotification({
                method: 'item/reasoning/textDelta',
                params: {
                    itemId: 'reason_1',
                    delta: 'more detail',
                    contentIndex: 0,
                },
            }),
        ).toEqual([{ type: 'reasoning-delta', itemId: 'reason_1', text: 'more detail' }]);

        expect(
            bridge.onNotification({
                method: 'item/completed',
                params: {
                    item: {
                        id: 'plan_1',
                        type: 'Plan',
                        text: '## Proposed plan\n1. Inspect\n2. Implement\n3. Verify',
                    },
                },
            }),
        ).toEqual([
            {
                type: 'assistant-text-final',
                itemId: 'plan_1',
                text: '## Proposed plan\n1. Inspect\n2. Implement\n3. Verify',
            },
        ]);

        expect(
            bridge.onNotification({
                method: 'item/completed',
                params: {
                    item: {
                        id: 'reason_1',
                        type: 'reasoning',
                        content: ['final reasoning'],
                    },
                },
            }),
        ).toEqual([{ type: 'reasoning-final', itemId: 'reason_1', text: 'final reasoning' }]);
    });

    it('maps command execution items and approval requests', () => {
        const bridge = createCodexAppServerStreamEventBridge();

        expect(
            bridge.onNotification({
                method: 'item/started',
                params: {
                    item: {
                        id: 'cmd_1',
                        type: 'commandExecution',
                        command: 'ls -la',
                        cwd: '/repo',
                    },
                },
            }),
        ).toEqual([
            {
                type: 'tool-call',
                toolKind: 'command',
                callId: 'cmd_1',
                name: 'CodexBash',
                input: {
                    command: 'ls -la',
                    cwd: '/repo',
                },
            },
        ]);

        expect(
            bridge.onServerRequest({
                method: 'item/commandExecution/requestApproval',
                params: {
                    itemId: 'cmd_1',
                    reason: 'Needs approval',
                },
            }),
        ).toEqual([
            {
                type: 'approval-request',
                requestKind: 'command-execution',
                callId: 'cmd_1',
                toolName: 'CodexBash',
                input: {
                    command: 'ls -la',
                    cwd: '/repo',
                },
                approval: {
                    reason: 'Needs approval',
                },
            },
        ]);

        expect(
            bridge.onNotification({
                method: 'item/completed',
                params: {
                    item: {
                        id: 'cmd_1',
                        type: 'commandExecution',
                        stdout: 'done',
                        exitCode: 0,
                    },
                },
            }),
        ).toEqual([
            {
                type: 'tool-result',
                toolKind: 'command',
                callId: 'cmd_1',
                output: {
                    stdout: 'done',
                    exitCode: 0,
                },
            },
        ]);
    });

    it('synthesizes a command tool-call before the result when completion arrives without a prior started event', () => {
        const bridge = createCodexAppServerStreamEventBridge();

        expect(
            bridge.onNotification({
                method: 'item/completed',
                params: {
                    item: {
                        id: 'cmd_failed',
                        type: 'commandExecution',
                        command: 'mkdir -p /tmp/demo',
                        cwd: '/repo',
                        stderr: 'Rejected("rejected by user")',
                        exitCode: 1,
                    },
                },
            }),
        ).toEqual([
            {
                type: 'tool-call',
                toolKind: 'command',
                callId: 'cmd_failed',
                name: 'CodexBash',
                input: {
                    command: 'mkdir -p /tmp/demo',
                    cwd: '/repo',
                },
            },
            {
                type: 'tool-result',
                toolKind: 'command',
                callId: 'cmd_failed',
                output: {
                    stderr: 'Rejected("rejected by user")',
                    exitCode: 1,
                },
            },
        ]);
    });

    it('maps tool items and tool user-input requests', () => {
        const bridge = createCodexAppServerStreamEventBridge();

        expect(
            bridge.onNotification({
                method: 'item/started',
                params: {
                    item: {
                        id: 'tool_1',
                        type: 'mcpToolCall',
                        server: 'playwright',
                        tool: 'browser_navigate',
                        arguments: { url: 'https://example.com' },
                    },
                },
            }),
        ).toEqual([
            {
                type: 'tool-call',
                toolKind: 'mcp',
                callId: 'tool_1',
                name: 'mcp__playwright__browser_navigate',
                input: { url: 'https://example.com' },
            },
        ]);

        expect(
            bridge.onNotification({
                method: 'item/started',
                params: {
                    item: {
                        id: 'tool_title',
                        type: 'mcpToolCall',
                        server: 'happier__happier',
                        tool: 'change_title',
                        arguments: { title: 'Normalized title' },
                    },
                },
            }),
        ).toEqual([
            {
                type: 'tool-call',
                toolKind: 'mcp',
                callId: 'tool_title',
                name: 'mcp__happier__change_title',
                input: { title: 'Normalized title' },
            },
        ]);

        expect(
            bridge.onServerRequest({
                method: 'item/tool/requestUserInput',
                params: {
                    itemId: 'tool_1',
                    questions: [{ id: 'tool_questions', options: [] }],
                },
            }),
        ).toEqual([
            {
                type: 'user-input-request',
                callId: 'tool_1',
                toolName: 'mcp__playwright__browser_navigate',
                input: { url: 'https://example.com' },
                questions: [{ id: 'tool_questions', options: [] }],
            },
        ]);

        expect(
            bridge.onNotification({
                method: 'item/completed',
                params: {
                    item: {
                        id: 'tool_1',
                        type: 'mcpToolCall',
                        result: { Ok: { status: 'ok' } },
                    },
                },
            }),
        ).toEqual([
            {
                type: 'tool-result',
                toolKind: 'mcp',
                callId: 'tool_1',
                output: { status: 'ok' },
            },
        ]);

        expect(
            bridge.onNotification({
                method: 'item/completed',
                params: {
                    item: {
                        id: 'tool_title',
                        type: 'mcpToolCall',
                        result: { output: { title: 'Normalized title' } },
                    },
                },
            }),
        ).toEqual([
            {
                type: 'tool-result',
                toolKind: 'mcp',
                callId: 'tool_title',
                output: { title: 'Normalized title' },
            },
        ]);
    });

    it('maps file-change items and approval requests', () => {
        const bridge = createCodexAppServerStreamEventBridge();

        expect(
            bridge.onNotification({
                method: 'item/started',
                params: {
                    item: {
                        id: 'patch_1',
                        type: 'fileChange',
                        auto_approved: true,
                        changes: {
                            'src/file.ts': { hunks: 2 },
                        },
                    },
                },
            }),
        ).toEqual([
            {
                type: 'tool-call',
                toolKind: 'file-change',
                callId: 'patch_1',
                name: 'CodexPatch',
                input: {
                    auto_approved: true,
                    changes: {
                        'src/file.ts': { hunks: 2 },
                    },
                },
            },
        ]);

        expect(
            bridge.onServerRequest({
                method: 'item/fileChange/requestApproval',
                params: {
                    itemId: 'patch_1',
                    reason: 'Review file edits',
                },
            }),
        ).toEqual([
            {
                type: 'approval-request',
                requestKind: 'file-change',
                callId: 'patch_1',
                toolName: 'CodexPatch',
                input: {
                    auto_approved: true,
                    changes: {
                        'src/file.ts': { hunks: 2 },
                    },
                },
                approval: {
                    reason: 'Review file edits',
                },
            },
        ]);

        expect(
            bridge.onNotification({
                method: 'item/completed',
                params: {
                    item: {
                        id: 'patch_1',
                        type: 'fileChange',
                        stdout: 'patched',
                        success: true,
                    },
                },
            }),
        ).toEqual([
            {
                type: 'tool-result',
                toolKind: 'file-change',
                callId: 'patch_1',
                output: {
                    stdout: 'patched',
                    success: true,
                },
            },
        ]);
    });

    it('maps turn diff update notifications', () => {
        const bridge = createCodexAppServerStreamEventBridge();

        expect(
            bridge.onNotification({
                method: 'turn/diff/updated',
                params: {
                    turnId: 'turn_1',
                    unifiedDiff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
                },
            }),
        ).toEqual([
            {
                type: 'turn-diff-updated',
                turnId: 'turn_1',
                unifiedDiff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
            },
        ]);
    });
});
