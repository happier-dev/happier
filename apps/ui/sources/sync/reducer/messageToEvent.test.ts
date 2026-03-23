import { describe, expect, it } from 'vitest';

import { parseMessageAsEvent } from './messageToEvent';

function makeToolCallMessage(toolName: string) {
    return {
        isSidechain: false,
        role: 'agent',
        content: [
            {
                type: 'tool-call',
                name: toolName,
                input: { title: 'My title' },
            },
        ],
        // test fixture: minimal NormalizedMessage shape
    } as any;
}

function makeShellBridgeToolCallMessage(command: string) {
    return {
        isSidechain: false,
        role: 'agent',
        content: [
            {
                type: 'tool-call',
                name: 'Bash',
                input: { command },
            },
        ],
    } as any;
}

describe('parseMessageAsEvent', () => {
    it('does not convert change_title tool calls into generic transcript events', () => {
        const events = [
            parseMessageAsEvent(makeToolCallMessage('mcp__happy__change_title')),
            parseMessageAsEvent(makeToolCallMessage('mcp__happier__change_title')),
            parseMessageAsEvent(makeToolCallMessage('happy__change_title')),
            parseMessageAsEvent(makeToolCallMessage('happier__change_title')),
            parseMessageAsEvent(makeToolCallMessage('change_title')),
            parseMessageAsEvent(makeToolCallMessage('change-title')),
        ];

        for (const event of events) {
            expect(event).toBeNull();
        }
    });

    it('does not convert Happier shell-bridge change_title calls into generic transcript events', () => {
        expect(
            parseMessageAsEvent(
                makeShellBridgeToolCallMessage(
                    `happier tools call --source happier --tool change_title --args-json '{"title":"Bridge title"}' --json`,
                ),
            ),
        ).toBeNull();
    });
});
