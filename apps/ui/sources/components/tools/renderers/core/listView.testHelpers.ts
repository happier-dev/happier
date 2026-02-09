import type { ReactTestRenderer } from 'react-test-renderer';
import { expect } from 'vitest';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { collectHostText, makeToolCall } from '../../shell/views/ToolView.testHelpers';

export function makeCompletedTool(
    name: string,
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

export function expectListSummary(params: {
    tree: ReactTestRenderer;
    visibleValues: string[];
    hiddenValues?: string[];
    moreLabel?: string;
}) {
    const rawText = collectHostText(params.tree).join('\n');
    const normalizedText = rawText.replace(/\s+/g, ' ');

    for (const visibleValue of params.visibleValues) {
        expect(normalizedText).toContain(visibleValue);
    }
    for (const hiddenValue of params.hiddenValues ?? []) {
        expect(normalizedText).not.toContain(hiddenValue);
    }
    if (params.moreLabel) {
        const normalizedMoreLabel = params.moreLabel
            .replace(/^\+(\d+)/, '+ $1')
            .replace(/\s+/g, ' ');
        expect(normalizedText).toContain(normalizedMoreLabel);
    }
}
