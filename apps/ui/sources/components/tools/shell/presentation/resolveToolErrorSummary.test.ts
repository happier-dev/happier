import { describe, expect, it } from 'vitest';
import type { ToolCall } from '@happier-dev/session-core/messages';
import { resolveToolErrorSummary } from './resolveToolErrorSummary';

describe('resolveToolErrorSummary', () => {
    const content = '{"errorCode":"change_title_failed","error":"target_unavailable"}';
    it.each([
        { errorMessage: 'target_unavailable', tool_use_result: `Error: ${content}` },
        // Stored native failure at seq 8 of cmv22orej0085tm3p0v0vi230.
        { content, tool_use_result: `Error: ${content}`, title: 'errorCode' },
    ])('uses the shared typed error instead of a native JSON report', (result) => {
        const tool = {
            name: 'change_title', state: 'error', input: { title: 'Explore directory' },
            createdAt: 1, startedAt: 1, completedAt: 2, description: null, result,
        } satisfies ToolCall;
        expect(resolveToolErrorSummary(tool)).toBe('target_unavailable');
    });
});
