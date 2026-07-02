import { describe, expect, it } from 'vitest';

import { createMessageRouter } from './messageRouter.js';
import type { RawJSONLines } from './rawJsonLines.js';

describe('createMessageRouter', () => {
    it('drops informational system messages from session emission', () => {
        const emitted: RawJSONLines[] = [];
        const router = createMessageRouter({
            onMessage: (message) => emitted.push(message),
            logEvent: () => undefined,
        });

        router.emitSessionMessage({ type: 'system', uuid: 'sys-1', subtype: 'init' }, true);

        expect(emitted).toEqual([]);
    });

    it('drops compact summary and local-command artifacts from session emission', () => {
        const emitted: RawJSONLines[] = [];
        const router = createMessageRouter({
            onMessage: (message) => emitted.push(message),
            logEvent: () => undefined,
        });

        for (const message of [
            {
                type: 'user',
                uuid: 'compact-summary-1',
                isCompactSummary: true,
                isVisibleInTranscriptOnly: true,
                message: { content: 'This session is being continued from a previous conversation.' },
            },
            {
                type: 'user',
                uuid: 'compact-command-1',
                message: { content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>' },
            },
            {
                type: 'user',
                uuid: 'compact-stdout-1',
                message: {
                    content:
                        '<local-command-stdout>\u001b[2mCompacted\u001b[22m\n'
                        + "\u001b[2mPostCompact [python3 '/tmp/hook.py'] completed successfully\u001b[22m</local-command-stdout>",
                },
            },
        ] satisfies RawJSONLines[]) {
            router.emitSessionMessage(message, true);
        }

        expect(emitted).toEqual([]);
    });

    it('rewrites task notification text into the matching tool result', () => {
        const emitted: RawJSONLines[] = [];
        const router = createMessageRouter({
            onMessage: (message) => emitted.push(message),
            logEvent: () => undefined,
        });

        router.observeSessionMessage({
            type: 'user',
            uuid: 'tool-result-source',
            toolUseResult: { agentId: 'task-1' },
            message: {
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'toolu_1',
                    },
                ],
            },
        } as RawJSONLines);
        router.emitSessionMessage({
            type: 'user',
            uuid: 'task-notification',
            message: {
                content: '<task-notification><task-id>task-1</task-id><result>done</result></task-notification>',
            },
        }, true);

        expect(emitted).toHaveLength(1);
        expect((emitted[0] as { isMeta?: boolean }).isMeta).toBe(true);
        expect((emitted[0] as { message: { content: Array<{ tool_use_id: string; content: Array<{ text: string }> }> } }).message.content[0]).toMatchObject({
            tool_use_id: 'toolu_1',
            content: [{ type: 'text', text: 'done' }],
        });
    });
});
