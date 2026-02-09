import type { ReactTestRenderer } from 'react-test-renderer';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { collectHostText, makeToolCall } from '../../shell/views/ToolView.testHelpers';

export function makeCompletedTool(
    name: ToolCall['name'],
    input: ToolCall['input'],
    result: ToolCall['result'],
): ToolCall {
    return makeToolCall({
        name,
        state: 'completed',
        input,
        result,
    });
}

export function normalizedHostText(tree: ReactTestRenderer): string {
    return collectHostText(tree).join(' ').replace(/\s+/g, ' ').trim();
}
