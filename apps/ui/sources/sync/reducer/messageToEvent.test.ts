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

describe('parseMessageAsEvent', () => {
    it('supports legacy + new + canonical change_title tool names', () => {
        const events = [
            parseMessageAsEvent(makeToolCallMessage('mcp__happy__change_title')),
            parseMessageAsEvent(makeToolCallMessage('mcp__happier__change_title')),
            parseMessageAsEvent(makeToolCallMessage('happy__change_title')),
            parseMessageAsEvent(makeToolCallMessage('happier__change_title')),
            parseMessageAsEvent(makeToolCallMessage('change_title')),
            parseMessageAsEvent(makeToolCallMessage('change-title')),
        ];

        for (const event of events) {
            expect(event).toEqual({
                type: 'message',
                message: 'Title changed to "My title"',
            });
        }
    });
});
