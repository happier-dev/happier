import { describe, expect, it } from 'vitest';

import { buildExecutionRunsGuidanceBlock } from './executionRunsGuidance';

describe('executionRunsGuidance', () => {
    it('does not dedupe entries that share description but differ in suggested backend/model', () => {
        const result = buildExecutionRunsGuidanceBlock({
            entries: [
                {
                    id: '1',
                    description: 'Prefer Claude for UI work',
                    suggestedBackendId: 'claude',
                    suggestedModelId: 'claude-sonnet-4-5',
                },
                {
                    id: '2',
                    description: 'Prefer Claude for UI work',
                    suggestedBackendId: 'claude',
                    suggestedModelId: 'claude-opus-4-6',
                },
            ],
            maxChars: 10_000,
        });

        expect(result.includedCount).toBe(2);
        expect(result.text).toContain('Prefer Claude for UI work');
        expect(result.text).toContain('backend=claude');
        expect(result.text).toContain('model=claude-sonnet-4-5');
    });

    it('adds an overflow note when rules exceed the max char budget', () => {
        const entry1 = { id: '1', description: 'Rule one' };
        const entry2 = { id: '2', description: 'Rule two' };

        const one = buildExecutionRunsGuidanceBlock({ entries: [entry1], maxChars: 10_000 });
        const capped = buildExecutionRunsGuidanceBlock({
            entries: [entry1, entry2],
            // Budget that fits exactly the single-entry block.
            maxChars: one.text.length,
        });

        expect(capped.includedCount).toBe(1);
        expect(capped.remainingCount).toBe(1);
        expect(capped.text).toContain('(+1 more rules in settings)');
    });

    it('excludes disabled entries', () => {
        const result = buildExecutionRunsGuidanceBlock({
            entries: [
                { id: '1', description: 'Enabled rule' },
                { id: '2', description: 'Disabled rule', enabled: false },
            ],
            maxChars: 10_000,
        });

        expect(result.text).toContain('Enabled rule');
        expect(result.text).not.toContain('Disabled rule');
    });

    it('appends example tool calls when present', () => {
        const result = buildExecutionRunsGuidanceBlock({
            entries: [
                {
                    id: '1',
                    description: 'Prefer Claude for UI work',
                    exampleToolCalls: ['mcp.execution.run', 'mcp.execution.list'],
                },
            ],
            maxChars: 10_000,
        });

        expect(result.text).toContain('## Example tool calls (MCP)');
        expect(result.text).toContain('- mcp.execution.run');
        expect(result.text).toContain('- mcp.execution.list');
    });
});
