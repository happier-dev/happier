import type { ReactTestRenderer } from 'react-test-renderer';
import { expect } from 'vitest';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { collectHostText, makeToolCall } from '@/dev/testkit';

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
    const normalizedPlusText = normalizedText.replace(/\+\s*(\d+)/g, '+$1');

    for (const visibleValue of params.visibleValues) {
        expect(normalizedPlusText).toContain(visibleValue);
    }
    for (const hiddenValue of params.hiddenValues ?? []) {
        expect(normalizedPlusText).not.toContain(hiddenValue.replace(/\+\s*(\d+)/g, '+$1'));
    }
    if (params.moreLabel) {
        const normalizedMoreLabel = params.moreLabel.replace(/\s+/g, ' ').replace(/\+\s*(\d+)/g, '+$1');
        expect(normalizedPlusText).toContain(normalizedMoreLabel);
    }
}
