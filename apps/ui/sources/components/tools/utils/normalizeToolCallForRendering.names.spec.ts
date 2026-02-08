import { describe, expect, it } from 'vitest';

import { normalizeToolCallForRendering } from './normalizeToolCallForRendering';
import { makeTool } from './normalizeToolCallForRendering._testHelpers';

describe('normalizeToolCallForRendering (names)', () => {
    it('maps legacy tool names to canonical V2 tool names', () => {
        const normalized = normalizeToolCallForRendering(
            makeTool({
                name: 'CodexPatch',
                input: { changes: { '/tmp/a.txt': { add: { content: 'x' } } } },
                result: { ok: true },
            }),
        );
        expect(normalized.name).toBe('Patch');
    });

    it('maps edit calls with a changes map to Patch', () => {
        const normalized = normalizeToolCallForRendering(
            makeTool({
                name: 'edit',
                input: {
                    changes: {
                        '/tmp/a.txt': {
                            type: 'update',
                            old_content: 'a',
                            new_content: 'b',
                            unified_diff: '@@ -1 +1 @@\n-a\n+b\n',
                        },
                    },
                },
            }),
        );
        expect(normalized.name).toBe('Patch');
    });

    it('maps execute/shell variants to Bash', () => {
        const execute = normalizeToolCallForRendering(
            makeTool({
                name: 'execute',
                input: { command: ['bash', '-lc', 'echo hi'] },
            }),
        );
        expect(execute.name).toBe('Bash');

        const bash = normalizeToolCallForRendering(
            makeTool({
                name: 'bash',
                input: { command: ['bash', '-lc', 'echo hi'] },
            }),
        );
        expect(bash.name).toBe('Bash');
    });

    it('maps common lowercase tool names to canonical TitleCase names', () => {
        const tools = [
            { name: 'glob', expected: 'Glob', input: { glob: '*.ts' } },
            { name: 'grep', expected: 'Grep', input: { pattern: 'x' } },
            { name: 'ls', expected: 'LS', input: { path: '.' } },
            { name: 'web_fetch', expected: 'WebFetch', input: { href: 'https://example.com' } },
            { name: 'web_search', expected: 'WebSearch', input: { q: 'cats' } },
        ];

        for (const item of tools) {
            const normalized = normalizeToolCallForRendering(
                makeTool({
                    name: item.name,
                    input: item.input,
                }),
            );
            expect(normalized.name).toBe(item.expected);
        }
    });

    it('maps workspace indexing permission prompts to known tool name', () => {
        const normalized = normalizeToolCallForRendering(
            makeTool({
                name: 'Unknown tool',
                state: 'running',
                input: {
                    toolCall: { title: 'Workspace Indexing Permission', toolCallId: 'workspace-indexing-permission' },
                    permissionId: 'workspace-indexing-permission',
                },
                result: null,
                completedAt: null,
                description: 'Unknown tool',
            }),
        );

        expect(normalized.name).toBe('WorkspaceIndexingPermission');
    });

    it('prefers explicit canonical tool metadata from _happier/_happy', () => {
        const happier = normalizeToolCallForRendering(
            makeTool({
                name: 'TaskUpdate',
                state: 'running',
                input: {
                    _happier: { canonicalToolName: 'Task' },
                    subject: 'x',
                },
                result: null,
                completedAt: null,
            }),
        );
        expect(happier.name).toBe('Task');

        const happy = normalizeToolCallForRendering(
            makeTool({
                name: 'future_tool',
                state: 'running',
                input: { _happy: { canonicalToolName: 'FutureTool' } },
                completedAt: null,
            }),
        );
        expect(happy.name).toBe('FutureTool');
    });
});
