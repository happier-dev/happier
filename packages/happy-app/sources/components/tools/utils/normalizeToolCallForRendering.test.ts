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

    it('normalizes ACP-style content[] diffs for write into content + file_path', () => {
        const tool = {
            name: 'write',
            state: 'completed' as const,
            input: {
                content: [{ path: '/tmp/a.txt', oldText: 'hello', newText: 'hi', type: 'diff' }],
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

    it('normalizes ACP-style content[] diffs for edit into old_string/new_string + file_path', () => {
        const tool = {
            name: 'edit',
            state: 'completed' as const,
            input: {
                content: [{ path: '/tmp/a.txt', oldText: 'hello', newText: 'hi', type: 'diff' }],
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

    it('normalizes legacy glob results into Glob.matches[] for renderer consumption', () => {
        const tool = {
            name: 'glob',
            state: 'completed' as const,
            input: { pattern: '*.ts' },
            result: ['a.ts', 'b.ts'],
            createdAt: 0,
            startedAt: 0,
            completedAt: 1,
            description: null,
        };

        const normalized = normalizeToolCallForRendering(tool as any);
        expect(normalized.name).toBe('Glob');
        expect(normalized.result).toEqual({ matches: ['a.ts', 'b.ts'] });
    });

    it('normalizes legacy ls results into LS.entries[] for renderer consumption', () => {
        const tool = {
            name: 'ls',
            state: 'completed' as const,
            input: { dir: '/tmp' },
            result: ['a.txt', 'b.txt'],
            createdAt: 0,
            startedAt: 0,
            completedAt: 1,
            description: null,
        };

        const normalized = normalizeToolCallForRendering(tool as any);
        expect(normalized.name).toBe('LS');
        expect(normalized.result).toEqual({ entries: ['a.txt', 'b.txt'] });
    });

    it('normalizes legacy grep results into Grep.matches[] (filePath/line/excerpt)', () => {
        const tool = {
            name: 'grep',
            state: 'completed' as const,
            input: { pattern: 'beta' },
            result: '/tmp/a.txt:2: beta',
            createdAt: 0,
            startedAt: 0,
            completedAt: 1,
            description: null,
        };

        const normalized = normalizeToolCallForRendering(tool as any);
        expect(normalized.name).toBe('Grep');
        expect(normalized.result).toEqual({
            matches: [{ filePath: '/tmp/a.txt', line: 2, excerpt: 'beta' }],
        });
    });

    it('normalizes legacy CodexPatch unified diffs into Patch.changes so PatchView can render', () => {
        const diff = [
            'diff --git a/tmp/a.txt b/tmp/a.txt',
            'index 111..222 100644',
            '--- a/tmp/a.txt',
            '+++ b/tmp/a.txt',
            '@@ -1 +1 @@',
            '-hello',
            '+hi',
            '',
        ].join('\n');

        const tool = {
            name: 'CodexPatch',
            state: 'completed' as const,
            input: { patch: diff },
            result: { ok: true },
            createdAt: 0,
            startedAt: 0,
            completedAt: 1,
            description: null,
        };

        const normalized = normalizeToolCallForRendering(tool as any);
        expect(normalized.name).toBe('Patch');
        expect(normalized.input).toMatchObject({
            changes: {
                'tmp/a.txt': {
                    type: 'update',
                    modify: { old_content: 'hello', new_content: 'hi' },
                },
            },
        });
        expect(normalized.result).toMatchObject({ applied: true });
    });

    it('normalizes legacy patch delete diffs into Patch.changes.delete', () => {
        const diff = [
            'diff --git a/tmp/a.txt b/tmp/a.txt',
            'deleted file mode 100644',
            '--- a/tmp/a.txt',
            '+++ /dev/null',
            '@@ -1 +0,0 @@',
            '-goodbye',
            '',
        ].join('\n');

        const tool = {
            name: 'patch',
            state: 'completed' as const,
            input: { unified_diff: diff },
            result: { ok: true },
            createdAt: 0,
            startedAt: 0,
            completedAt: 1,
            description: null,
        };

        const normalized = normalizeToolCallForRendering(tool as any);
        expect(normalized.name).toBe('Patch');
        expect(normalized.input).toMatchObject({
            changes: {
                'tmp/a.txt': {
                    type: 'delete',
                    delete: { content: 'goodbye' },
                },
            },
        });
        expect(normalized.result).toMatchObject({ applied: true });
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

    it('maps legacy bash tool name variants to Bash', () => {
        const tool = {
            name: 'bash',
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

    it('maps legacy read_file tool name variants to Read and normalizes filePath aliases', () => {
        const tool = {
            name: 'read_file',
            state: 'completed' as const,
            input: { filePath: '/etc/hosts' },
            result: '',
            createdAt: 0,
            startedAt: 0,
            completedAt: 1,
            description: null,
        };

        const normalized = normalizeToolCallForRendering(tool as any);
        expect(normalized.name).toBe('Read');
        expect(normalized.input).toMatchObject({ file_path: '/etc/hosts' });
    });

    it('maps delete/remove tool names to Delete and normalizes file path aliases', () => {
        const tool = {
            name: 'delete',
            state: 'completed' as const,
            input: { filePath: '/tmp/a.txt' },
            result: '',
            createdAt: 0,
            startedAt: 0,
            completedAt: 1,
            description: null,
        };

        const normalized = normalizeToolCallForRendering(tool as any);
        expect(normalized.name).toBe('Delete');
        expect(normalized.input).toMatchObject({ file_paths: ['/tmp/a.txt'] });

        const remove = normalizeToolCallForRendering({
            ...tool,
            name: 'remove',
            input: { file_paths: ['a.txt', 'b.txt'] },
        } as any);
        expect(remove.name).toBe('Delete');
        expect(remove.input).toMatchObject({ file_paths: ['a.txt', 'b.txt'] });
    });

    it('treats delete/remove calls with a changes map as Patch (legacy back-compat)', () => {
        const tool = {
            name: 'delete',
            state: 'completed' as const,
            input: { changes: { '/tmp/a.txt': { delete: { content: '' } } } },
            result: '',
            createdAt: 0,
            startedAt: 0,
            completedAt: 1,
            description: null,
        };

        const normalized = normalizeToolCallForRendering(tool as any);
        expect(normalized.name).toBe('Patch');
        expect(normalized.input).toMatchObject({ changes: expect.any(Object) });
    });

    it('maps legacy write_file tool name variants to Write and normalizes filePath/newText aliases', () => {
        const tool = {
            name: 'write_file',
            state: 'completed' as const,
            input: { filePath: '/tmp/a.txt', newText: 'hi' },
            result: '',
            createdAt: 0,
            startedAt: 0,
            completedAt: 1,
            description: null,
        };

        const normalized = normalizeToolCallForRendering(tool as any);
        expect(normalized.name).toBe('Write');
        expect(normalized.input).toMatchObject({ file_path: '/tmp/a.txt', content: 'hi' });
    });

    it('maps legacy edit_file tool name variants to Edit and normalizes filePath/oldText/newText aliases', () => {
        const tool = {
            name: 'edit_file',
            state: 'completed' as const,
            input: { filePath: '/tmp/a.txt', oldText: 'hello', newText: 'hi' },
            result: '',
            createdAt: 0,
            startedAt: 0,
            completedAt: 1,
            description: null,
        };

        const normalized = normalizeToolCallForRendering(tool as any);
        expect(normalized.name).toBe('Edit');
        expect(normalized.input).toMatchObject({
            file_path: '/tmp/a.txt',
            old_string: 'hello',
            new_string: 'hi',
        });
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

    it('maps delete tool calls to Delete and preserves file_paths', () => {
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
        expect(normalized.name).toBe('Delete');
        expect(normalized.input).toMatchObject({ file_paths: ['tool_validation_results.md'] });
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

    it('normalizes TodoWrite input into todos[] when providers emit items[]', () => {
        const tool = {
            name: 'TodoWrite',
            state: 'completed' as const,
            input: {
                items: ['First todo'],
            },
            result: null,
            createdAt: 0,
            startedAt: 0,
            completedAt: 1,
            description: null,
        };

        const normalized = normalizeToolCallForRendering(tool as any);
        expect(normalized.input).toMatchObject({
            todos: [{ content: 'First todo', status: 'pending' }],
        });
    });

    it('normalizes TodoWrite result.newTodos into result.todos for rendering', () => {
        const tool = {
            name: 'TodoWrite',
            state: 'completed' as const,
            input: {},
            result: {
                newTodos: [{ content: 'Hello', status: 'completed' }],
            },
            createdAt: 0,
            startedAt: 0,
            completedAt: 1,
            description: null,
        };

        const normalized = normalizeToolCallForRendering(tool as any);
        expect(normalized.result).toMatchObject({
            todos: [{ content: 'Hello', status: 'completed' }],
        });
    });

    it('normalizes reasoning result.text into reasoning result.content for rendering', () => {
        const tool = {
            name: 'Reasoning',
            state: 'completed' as const,
            input: {},
            result: { text: 'Hello from reasoning' },
            createdAt: 0,
            startedAt: 0,
            completedAt: 1,
            description: null,
        };

        const normalized = normalizeToolCallForRendering(tool as any);
        expect(normalized.result).toMatchObject({ content: 'Hello from reasoning' });
    });
});
