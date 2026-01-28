import { describe, expect, it } from 'vitest';
import { normalizeToolCallForRendering } from './normalizeToolCallForRendering';

describe('normalizeToolCallForRendering', () => {
    it('parses JSON-string inputs/results into objects', () => {
        const tool = {
            name: 'unknown',
            state: 'running' as const,
            input: '{"a":1}',
            result: '[1,2,3]',
            createdAt: 0,
            startedAt: 0,
            completedAt: null,
            description: null,
        };

        const normalized = normalizeToolCallForRendering(tool as any);
        expect(normalized).not.toBe(tool);
        expect(normalized.input).toEqual({ a: 1 });
        expect(normalized.result).toEqual([1, 2, 3]);
    });

    it('returns the same reference when no parsing is needed', () => {
        const tool = {
            name: 'Read',
            state: 'completed' as const,
            input: { file_path: '/etc/hosts' },
            result: { ok: true },
            createdAt: 0,
            startedAt: 0,
            completedAt: 1,
            description: null,
        };

        const normalized = normalizeToolCallForRendering(tool as any);
        expect(normalized).toBe(tool);
    });

    it('normalizes common edit aliases into old_string/new_string + file_path', () => {
        const tool = {
            name: 'edit',
            state: 'completed' as const,
            input: {
                filePath: '/tmp/a.txt',
                oldText: 'hello',
                newText: 'hi',
            },
            result: '',
            createdAt: 0,
            startedAt: 0,
            completedAt: 1,
            description: null,
        };

        const normalized = normalizeToolCallForRendering(tool as any);
        expect(normalized.input).toMatchObject({
            file_path: '/tmp/a.txt',
            old_string: 'hello',
            new_string: 'hi',
        });
    });

    it('normalizes ACP-style items[] diffs for write into content + file_path', () => {
        const tool = {
            name: 'write',
            state: 'completed' as const,
            input: {
                items: [{ path: '/tmp/a.txt', oldText: 'hello', newText: 'hi', type: 'diff' }],
            },
            result: '',
            createdAt: 0,
            startedAt: 0,
            completedAt: 1,
            description: null,
        };

        const normalized = normalizeToolCallForRendering(tool as any);
        expect(normalized.input).toMatchObject({
            file_path: '/tmp/a.txt',
            content: 'hi',
        });
    });

    it('normalizes ACP-style items[] diffs for edit into old_string/new_string + file_path', () => {
        const tool = {
            name: 'edit',
            state: 'completed' as const,
            input: {
                items: [{ path: '/tmp/a.txt', oldText: 'hello', newText: 'hi', type: 'diff' }],
            },
            result: '',
            createdAt: 0,
            startedAt: 0,
            completedAt: 1,
            description: null,
        };

        const normalized = normalizeToolCallForRendering(tool as any);
        expect(normalized.input).toMatchObject({
            file_path: '/tmp/a.txt',
            old_string: 'hello',
            new_string: 'hi',
        });
    });

    it('maps legacy tool names to canonical V2 tool names', () => {
        const tool = {
            name: 'CodexPatch',
            state: 'completed' as const,
            input: { changes: { '/tmp/a.txt': { add: { content: 'x' } } } },
            result: { ok: true },
            createdAt: 0,
            startedAt: 0,
            completedAt: 1,
            description: null,
        };

        const normalized = normalizeToolCallForRendering(tool as any);
        expect(normalized.name).toBe('Patch');
    });

    it('maps edit calls with a Codex-style changes map to Patch', () => {
        const tool = {
            name: 'edit',
            state: 'completed' as const,
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
            result: '',
            createdAt: 0,
            startedAt: 0,
            completedAt: 1,
            description: null,
        };

        const normalized = normalizeToolCallForRendering(tool as any);
        expect(normalized.name).toBe('Patch');
    });

    it('normalizes diff aliases into Diff.unified_diff', () => {
        const tool = {
            name: 'CodexDiff',
            state: 'completed' as const,
            input: { diff: 'diff --git a/a b/b\n@@ -1 +1 @@\n-a\n+b\n' },
            result: '',
            createdAt: 0,
            startedAt: 0,
            completedAt: 1,
            description: null,
        };

        const normalized = normalizeToolCallForRendering(tool as any);
        expect(normalized.name).toBe('Diff');
        expect(normalized.input).toMatchObject({
            unified_diff: 'diff --git a/a b/b\n@@ -1 +1 @@\n-a\n+b\n',
        });
    });

    it('maps execute/shell variants to Bash', () => {
        const tool = {
            name: 'execute',
            state: 'completed' as const,
            input: { command: ['bash', '-lc', 'echo hi'] },
            result: '',
            createdAt: 0,
            startedAt: 0,
            completedAt: 1,
            description: null,
        };

        const normalized = normalizeToolCallForRendering(tool as any);
        expect(normalized.name).toBe('Bash');
    });

    it('maps write todos payloads to TodoWrite', () => {
        const tool = {
            name: 'write',
            state: 'completed' as const,
            input: { todos: [{ content: 'x', status: 'pending' }] },
            result: '',
            createdAt: 0,
            startedAt: 0,
            completedAt: 1,
            description: null,
        };

        const normalized = normalizeToolCallForRendering(tool as any);
        expect(normalized.name).toBe('TodoWrite');
    });

    it('maps common legacy lowercase tool names to canonical TitleCase tool names', () => {
        const tools = [
            { name: 'glob', expected: 'Glob', input: { glob: '*.ts' } },
            { name: 'grep', expected: 'Grep', input: { pattern: 'x' } },
            { name: 'ls', expected: 'LS', input: { path: '.' } },
            { name: 'web_fetch', expected: 'WebFetch', input: { href: 'https://example.com' } },
            { name: 'web_search', expected: 'WebSearch', input: { q: 'cats' } },
        ];

        for (const t of tools) {
            const tool = {
                name: t.name,
                state: 'completed' as const,
                input: t.input,
                result: '',
                createdAt: 0,
                startedAt: 0,
                completedAt: 1,
                description: null,
            };
            const normalized = normalizeToolCallForRendering(tool as any);
            expect(normalized.name).toBe(t.expected);
        }
    });

    it('maps delete tool calls to Patch with delete changes', () => {
        const tool = {
            name: 'delete',
            state: 'running' as const,
            input: { file_paths: ['tool_validation_results.md'] },
            result: null,
            createdAt: 0,
            startedAt: 0,
            completedAt: null,
            description: 'Delete tool_validation_results.md',
        };

        const normalized = normalizeToolCallForRendering(tool as any);
        expect(normalized.name).toBe('Patch');
        expect(normalized.input).toMatchObject({
            changes: {
                'tool_validation_results.md': {
                    delete: { content: '' },
                },
            },
        });
    });

    it('maps workspace indexing permission prompts to a known tool name for rendering', () => {
        const tool = {
            name: 'Unknown tool',
            state: 'running' as const,
            input: {
                toolCall: { title: 'Workspace Indexing Permission', toolCallId: 'workspace-indexing-permission' },
                permissionId: 'workspace-indexing-permission',
            },
            result: null,
            createdAt: 0,
            startedAt: 0,
            completedAt: null,
            description: 'Unknown tool',
        };

        const normalized = normalizeToolCallForRendering(tool as any);
        expect(normalized.name).toBe('WorkspaceIndexingPermission');
    });

    it('prefers tool.input._happy.canonicalToolName when present', () => {
        const tool = {
            name: 'TaskUpdate',
            state: 'running' as const,
            input: {
                _happy: { canonicalToolName: 'Task' },
                subject: 'x',
            },
            result: null,
            createdAt: 0,
            startedAt: 0,
            completedAt: null,
            description: null,
        };

        const normalized = normalizeToolCallForRendering(tool as any);
        expect(normalized.name).toBe('Task');
    });
});
