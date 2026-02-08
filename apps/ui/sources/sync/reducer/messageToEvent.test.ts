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
    } as any;
}

describe('parseMessageAsEvent', () => {
    it('supports legacy and new change_title tool names', () => {
        const legacy = parseMessageAsEvent(makeToolCallMessage('mcp__happy__change_title'));
        const renamed = parseMessageAsEvent(makeToolCallMessage('mcp__happier__change_title'));

        expect(legacy).toEqual({
            type: 'message',
            message: 'Title changed to "My title"',
        });
        expect(renamed).toEqual(legacy);
    });
});
