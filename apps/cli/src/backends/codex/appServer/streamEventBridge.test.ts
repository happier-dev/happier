import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createCodexAppServerStreamEventBridge } from './streamEventBridge';

describe('createCodexAppServerStreamEventBridge', () => {
    it('keeps native completed command output in the tool result when no started event was observed', () => {
        const updates = createCodexAppServerStreamEventBridge().onNotification({ method: 'item/completed', params: {
            item: { id: 'native-command', type: 'commandExecution', command: 'pwd', cwd: '/project',
                status: 'completed', aggregatedOutput: '/project\n', exitCode: 0 },
        } });
        expect(updates).toEqual([
            expect.objectContaining({ type: 'tool-call', input: expect.not.objectContaining({ aggregatedOutput: expect.anything() }) }),
            expect.objectContaining({ type: 'tool-result', output: expect.objectContaining({ stdout: '/project\n', exitCode: 0 }) }),
        ]);
    });
    it('maps provider-native user messages while preserving Happier correlation', () => {
        const bridge = createCodexAppServerStreamEventBridge();

        expect(
            bridge.onNotification({
                method: 'item/started',
                params: {
                    item: {
                        id: 'native_user_1',
                        type: 'userMessage',
                        content: [
                            { type: 'text', text: 'hello from Codex TUI' },
                            { type: 'mention', name: 'README.md', path: '/repo/README.md' },
                            { type: 'text', text: 'second paragraph' },
                        ],
                    },
                },
            }),
        ).toEqual([{
            type: 'provider-user-text',
            itemId: 'native_user_1',
            clientId: null,
            text: 'hello from Codex TUI\nsecond paragraph',
        }]);

        expect(
            bridge.onNotification({
                method: 'item/started',
                params: {
                    item: {
                        id: 'happier_user_1',
                        type: 'userMessage',
                        clientId: 'happier-local-1',
                        content: [{ type: 'text', text: 'hello from Happier' }],
                    },
                },
            }),
        ).toEqual([{
            type: 'provider-user-text',
            itemId: 'happier_user_1',
            clientId: 'happier-local-1',
            text: 'hello from Happier',
        }]);
    });

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
                method: 'item/completed',
                params: {
                    item: {
                        id: 'async_question_1',
                        type: 'agentMessage',
                        text: 'Choose an environment\n- Staging\n- Production',
                        delivery: 'async',
                        questions: [{ title: 'Choose an environment', options: ['Staging', 'Production'] }],
                    },
                },
            }),
        ).toEqual([{
            type: 'async-user-input-request',
            itemId: 'async_question_1',
            text: 'Choose an environment\n- Staging\n- Production',
            questions: [{ title: 'Choose an environment', options: ['Staging', 'Production'] }],
        }]);

        expect(
            bridge.onNotification({
                method: 'rawResponseItem/completed',
                params: {
                    item: {
                        id: 'raw_msg_1',
                        type: 'message',
                        role: 'assistant',
                        content: [
                            { type: 'output_text', text: 'Raw assistant final' },
                        ],
                    },
                },
            }),
        ).toEqual([{ type: 'assistant-raw-final', itemId: 'raw_msg_1', text: 'Raw assistant final' }]);

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

    it('maps app-server context compaction item lifecycle notifications', () => {
        const bridge = createCodexAppServerStreamEventBridge();

        expect(
            bridge.onNotification({
                method: 'item/started',
                params: {
                    item: {
                        id: 'compact_1',
                        type: 'contextCompaction',
                    },
                },
            }),
        ).toEqual([{ type: 'context-compaction', phase: 'started', itemId: 'compact_1' }]);

        expect(
            bridge.onNotification({
                method: 'item/completed',
                params: {
                    item: {
                        id: 'compact_1',
                        type: 'contextCompaction',
                    },
                },
            }),
        ).toEqual([{ type: 'context-compaction', phase: 'completed', itemId: 'compact_1' }]);
    });

    it('maps native review-mode lifecycle notifications', () => {
        const bridge = createCodexAppServerStreamEventBridge();

        expect(
            bridge.onNotification({
                method: 'item/started',
                params: {
                    item: {
                        id: 'review_entered_1',
                        type: 'enteredReviewMode',
                        review: 'current changes',
                    },
                },
            }),
        ).toEqual([
            {
                type: 'review-mode-started',
                itemId: 'review_entered_1',
                review: 'current changes',
            },
        ]);

        expect(
            bridge.onNotification({
                method: 'item/completed',
                params: {
                    item: {
                        id: 'review_entered_1',
                        type: 'enteredReviewMode',
                        review: 'current changes',
                    },
                },
            }),
        ).toEqual([]);

        expect(
            bridge.onNotification({
                method: 'item/started',
                params: {
                    item: {
                        id: 'review_exited_1',
                        type: 'exitedReviewMode',
                        review: 'Native review text',
                    },
                },
            }),
        ).toEqual([]);

        expect(
            bridge.onNotification({
                method: 'item/completed',
                params: {
                    item: {
                        id: 'review_exited_1',
                        type: 'exitedReviewMode',
                        review: 'Native review text',
                    },
                },
            }),
        ).toEqual([
            {
                type: 'review-mode-completed',
                itemId: 'review_exited_1',
                review: 'Native review text',
            },
        ]);
    });

    it('maps final image generation results to transient session media and ignores partials', () => {
        const bridge = createCodexAppServerStreamEventBridge();

        expect(
            bridge.onNotification({
                method: 'response.image_generation_call.partial_image',
                params: {
                    item: {
                        id: 'img_1',
                        type: 'image_generation_call',
                        partial_image_b64: 'PARTIAL',
                    },
                },
            }),
        ).toEqual([]);

        expect(
            bridge.onNotification({
                method: 'item/completed',
                params: {
                    item: {
                        id: 'img_1',
                        type: 'image_generation_call',
                        status: 'completed',
                        result: 'iVBORw0KGgo=',
                        revised_prompt: 'safe prompt',
                    },
                },
            }),
        ).toEqual([
            {
                type: 'session-media',
                itemId: 'img_1',
                media: [
                    {
                        kind: 'base64',
                        data: 'iVBORw0KGgo=',
                        mimeType: 'image/png',
                        origin: {
                            source: 'provider-generated',
                            generationId: 'img_1',
                            providerEventId: 'img_1',
                        },
                        dedupeKey: 'codex:image-generation:img_1:result',
                        provenance: {
                            revisedPrompt: 'safe prompt',
                        },
                    },
                ],
            },
        ]);
    });

    it('maps Codex app-server imageGeneration items with result-bearing generating status', async () => {
        const bridge = createCodexAppServerStreamEventBridge();
        const dir = join(tmpdir(), `happier-codex-stream-media-${process.pid}`);
        await mkdir(dir, { recursive: true });
        const imagePath = join(dir, 'generated.png');
        await writeFile(imagePath, Buffer.from('iVBORw0KGgo=', 'base64'));

        expect(
            bridge.onNotification({
                method: 'item/completed',
                params: {
                    item: {
                        id: 'img_generating_final',
                        type: 'imageGeneration',
                        status: 'generating',
                        result: 'iVBORw0KGgo=',
                        savedPath: imagePath,
                    },
                },
            }),
        ).toEqual([
            {
                type: 'session-media',
                itemId: 'img_generating_final',
                media: [
                    {
                        kind: 'local-file',
                        path: imagePath,
                        origin: {
                            source: 'provider-generated',
                            generationId: 'img_generating_final',
                            providerEventId: 'img_generating_final',
                        },
                        dedupeKey: 'codex:image-generation:img_generating_final:saved_path',
                    },
                ],
            },
        ]);
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
                name: 'CodexBash',
                input: {
                    command: 'ls -la',
                    cwd: '/repo',
                },
                output: {
                    stdout: 'done',
                    exitCode: 0,
                },
            },
        ]);
    });

    it('maps permission escalation approval requests without requiring a prior tool item', () => {
        const bridge = createCodexAppServerStreamEventBridge();

        expect(
            bridge.onServerRequest({
                method: 'item/permissions/requestApproval',
                params: {
                    threadId: 'thread_1',
                    turnId: 'turn_1',
                    itemId: 'perm_1',
                    cwd: '/repo',
                    reason: 'Needs network access',
                    permissions: {
                        network: { enabled: true },
                    },
                },
            }),
        ).toEqual([
            {
                type: 'permissions-request',
                callId: 'perm_1',
                toolName: 'request_permissions',
                input: {
                    cwd: '/repo',
                    reason: 'Needs network access',
                    permissions: {
                        network: { enabled: true },
                    },
                },
                permissions: {
                    network: { enabled: true },
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
                name: 'CodexBash',
                input: {
                    command: 'mkdir -p /tmp/demo',
                    cwd: '/repo',
                },
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
                name: 'mcp__playwright__browser_navigate',
                input: { url: 'https://example.com' },
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
                name: 'mcp__happier__change_title',
                input: { title: 'Normalized title' },
                output: { title: 'Normalized title' },
            },
        ]);
    });

    it('maps file-change items and approval requests', () => {
        const bridge = createCodexAppServerStreamEventBridge();
        const changes = [
            {
                path: '/tmp/probe/existing.txt',
                kind: { type: 'update', move_path: null },
                diff: [
                    '@@ -1,3 +1,4 @@',
                    ' Alpha',
                    '-Beta',
                    '+Beta-updated',
                    ' Gamma',
                    '+Delta',
                ].join('\n'),
            },
        ];

        expect(
            bridge.onNotification({
                method: 'item/started',
                params: {
                    item: {
                        id: 'patch_1',
                        type: 'fileChange',
                        auto_approved: true,
                        changes,
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
                    changes,
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
                    changes,
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
                name: 'CodexPatch',
                input: {
                    auto_approved: true,
                    changes,
                },
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
