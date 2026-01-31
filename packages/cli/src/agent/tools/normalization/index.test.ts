import { describe, expect, it } from 'vitest';
import { normalizeToolCallV2, normalizeToolResultV2 } from './index';

describe('normalizeToolCallV2', () => {
    it('maps execute/shell variants to Bash and extracts a shell -lc command', () => {
        const normalized = normalizeToolCallV2({
            protocol: 'acp',
            provider: 'opencode',
            toolName: 'execute',
            rawInput: { command: ['bash', '-lc', 'echo hi'] },
            callId: 'call-1',
        });

        expect(normalized.canonicalToolName).toBe('Bash');
        expect(normalized.input).toMatchObject({
            command: 'echo hi',
            _happy: expect.objectContaining({ v: 2, protocol: 'acp', provider: 'opencode', rawToolName: 'execute', canonicalToolName: 'Bash' }),
            _raw: expect.anything(),
        });
    });

    it('maps read to Read and normalizes file_path aliases', () => {
        const normalized = normalizeToolCallV2({
            protocol: 'acp',
            provider: 'opencode',
            toolName: 'read',
            rawInput: { filePath: '/etc/hosts' },
            callId: 'call-2',
        });

        expect(normalized.canonicalToolName).toBe('Read');
        expect(normalized.input).toMatchObject({
            file_path: '/etc/hosts',
        });
    });

    it('maps edit to Edit and normalizes old_string/new_string aliases', () => {
        const normalized = normalizeToolCallV2({
            protocol: 'acp',
            provider: 'gemini',
            toolName: 'edit',
            rawInput: { filePath: '/tmp/a.txt', oldText: 'hello', newText: 'hi' },
            callId: 'call-3',
        });

        expect(normalized.canonicalToolName).toBe('Edit');
        expect(normalized.input).toMatchObject({
            file_path: '/tmp/a.txt',
            old_string: 'hello',
            new_string: 'hi',
        });
    });

    it('maps write_todos callIds to TodoWrite', () => {
        const normalized = normalizeToolCallV2({
            protocol: 'acp',
            provider: 'gemini',
            toolName: 'write',
            rawInput: { todos: [{ content: 'x', status: 'pending' }] },
            callId: 'write_todos-1',
        });

        expect(normalized.canonicalToolName).toBe('TodoWrite');
    });

    it('maps glob/search/grep/ls to their canonical tool names', () => {
        expect(
            normalizeToolCallV2({ protocol: 'acp', provider: 'opencode', toolName: 'glob', rawInput: { pattern: '*.ts' }, callId: 'c1' })
                .canonicalToolName
        ).toBe('Glob');
        expect(
            normalizeToolCallV2({ protocol: 'acp', provider: 'opencode', toolName: 'search', rawInput: { query: 'beta' }, callId: 'c2' })
                .canonicalToolName
        ).toBe('CodeSearch');
        expect(
            normalizeToolCallV2({ protocol: 'acp', provider: 'opencode', toolName: 'grep', rawInput: { pattern: 'beta' }, callId: 'c3' })
                .canonicalToolName
        ).toBe('Grep');
        expect(
            normalizeToolCallV2({ protocol: 'acp', provider: 'opencode', toolName: 'ls', rawInput: { path: '.' }, callId: 'c4' })
                .canonicalToolName
        ).toBe('LS');
    });

    it('maps edit calls with edits[] to MultiEdit (preserves edits payload)', () => {
        const normalized = normalizeToolCallV2({
            protocol: 'acp',
            provider: 'gemini',
            toolName: 'edit',
            rawInput: {
                edits: [
                    { filePath: '/tmp/a.txt', oldText: 'a', newText: 'b', replaceAll: true },
                    { path: '/tmp/b.txt', old_string: 'c', new_string: 'd' },
                ],
            },
            callId: 'call-multiedit',
        });

        expect(normalized.canonicalToolName).toBe('MultiEdit');
        expect(normalized.input).toMatchObject({ edits: expect.any(Array) });
        expect((normalized.input as any).edits).toEqual([
            { file_path: '/tmp/a.txt', old_string: 'a', new_string: 'b', replace_all: true },
            { file_path: '/tmp/b.txt', old_string: 'c', new_string: 'd' },
        ]);
    });

    it('treats edit calls that include full content as Write (OpenCode ACP compatibility)', () => {
        const normalized = normalizeToolCallV2({
            protocol: 'acp',
            provider: 'opencode',
            toolName: 'edit',
            rawInput: { file_path: '/tmp/a.txt', content: 'hello' },
            callId: 'call-edit-as-write-content',
        });

        expect(normalized.canonicalToolName).toBe('Write');
        expect(normalized.input).toMatchObject({
            file_path: '/tmp/a.txt',
            content: 'hello',
        });
    });

    it('treats edit calls that include full file_content as Write (Auggie compatibility)', () => {
        const normalized = normalizeToolCallV2({
            protocol: 'acp',
            provider: 'auggie',
            toolName: 'Edit',
            rawInput: { path: 'tool_validation_results.md', file_content: '# hi' },
            callId: 'call-edit-as-write',
        });

        expect(normalized.canonicalToolName).toBe('Write');
        expect(normalized.input).toMatchObject({
            file_path: 'tool_validation_results.md',
            content: '# hi',
        });
    });

    it('normalizes LS dir/path aliases into LS.path', () => {
        const normalized = normalizeToolCallV2({
            protocol: 'acp',
            provider: 'opencode',
            toolName: 'ls',
            rawInput: { dir: '/tmp' },
            callId: 'call-ls',
        });

        expect(normalized.canonicalToolName).toBe('LS');
        expect(normalized.input).toMatchObject({ path: '/tmp' });
    });

    it('maps Task* variants to Task (unifies task helpers)', () => {
        const created = normalizeToolCallV2({
            protocol: 'claude',
            provider: 'claude',
            toolName: 'TaskCreate',
            rawInput: { subject: 'x' },
            callId: 't1',
        });
        expect(created.canonicalToolName).toBe('Task');
        expect(created.input).toMatchObject({ operation: 'create' });

        const listed = normalizeToolCallV2({
            protocol: 'claude',
            provider: 'claude',
            toolName: 'TaskList',
            rawInput: {},
            callId: 't2',
        });
        expect(listed.canonicalToolName).toBe('Task');
        expect(listed.input).toMatchObject({ operation: 'list' });

        const updated = normalizeToolCallV2({
            protocol: 'claude',
            provider: 'claude',
            toolName: 'TaskUpdate',
            rawInput: { taskId: '1' },
            callId: 't3',
        });
        expect(updated.canonicalToolName).toBe('Task');
        expect(updated.input).toMatchObject({ operation: 'update' });

        const ran = normalizeToolCallV2({
            protocol: 'claude',
            provider: 'claude',
            toolName: 'Task',
            rawInput: { description: 'Explore' },
            callId: 't4',
        });
        expect(ran.canonicalToolName).toBe('Task');
        expect(ran.input).toMatchObject({ operation: 'run' });
    });

    it('maps fetch to WebFetch/WebSearch based on payload shape', () => {
        expect(
            normalizeToolCallV2({ protocol: 'acp', provider: 'auggie', toolName: 'fetch', rawInput: { query: 'cats' }, callId: 'f1' })
                .canonicalToolName
        ).toBe('WebSearch');

        expect(
            normalizeToolCallV2({ protocol: 'acp', provider: 'auggie', toolName: 'fetch', rawInput: { url: 'https://example.com' }, callId: 'f2' })
                .canonicalToolName
        ).toBe('WebFetch');
    });

    it('maps mcp__happy__change_title to change_title', () => {
        expect(
            normalizeToolCallV2({ protocol: 'codex', provider: 'codex', toolName: 'mcp__happy__change_title', rawInput: { title: 'x' }, callId: 'ct1' })
                .canonicalToolName
        ).toBe('change_title');

        expect(
            normalizeToolCallV2({ protocol: 'acp', provider: 'gemini', toolName: 'change_title', rawInput: { title: 'x' }, callId: 'ct2' })
                .canonicalToolName
        ).toBe('change_title');
    });

    it('normalizes common search aliases into canonical Glob/CodeSearch inputs', () => {
        const glob = normalizeToolCallV2({
            protocol: 'acp',
            provider: 'opencode',
            toolName: 'glob',
            rawInput: { glob: '.tmp/*.txt' },
            callId: 'g1',
        });
        expect(glob.canonicalToolName).toBe('Glob');
        expect(glob.input).toMatchObject({ pattern: '.tmp/*.txt' });

        const codeSearch = normalizeToolCallV2({
            protocol: 'acp',
            provider: 'opencode',
            toolName: 'search',
            rawInput: { q: 'beta' },
            callId: 's1',
        });
        expect(codeSearch.canonicalToolName).toBe('CodeSearch');
        expect(codeSearch.input).toMatchObject({ query: 'beta' });
    });

    it('normalizes common file/write and web aliases into canonical inputs', () => {
        const write = normalizeToolCallV2({
            protocol: 'acp',
            provider: 'opencode',
            toolName: 'write',
            rawInput: { filePath: '/tmp/a.txt', text: 'hello' },
            callId: 'w1',
        });
        expect(write.canonicalToolName).toBe('Write');
        expect(write.input).toMatchObject({ file_path: '/tmp/a.txt', content: 'hello' });

        const writeFromFilepath = normalizeToolCallV2({
            protocol: 'acp',
            provider: 'opencode',
            toolName: 'write',
            rawInput: { filepath: '/tmp/b.txt', content: 'hello' },
            callId: 'w2',
        });
        expect(writeFromFilepath.canonicalToolName).toBe('Write');
        expect(writeFromFilepath.input).toMatchObject({ file_path: '/tmp/b.txt', content: 'hello' });

        const webFetch = normalizeToolCallV2({
            protocol: 'acp',
            provider: 'opencode',
            toolName: 'web_fetch',
            rawInput: { href: 'https://example.com' },
            callId: 'f1',
        });
        expect(webFetch.canonicalToolName).toBe('WebFetch');
        expect(webFetch.input).toMatchObject({ url: 'https://example.com' });

        const webSearch = normalizeToolCallV2({
            protocol: 'acp',
            provider: 'opencode',
            toolName: 'web_search',
            rawInput: { q: 'cats' },
            callId: 'ws1',
        });
        expect(webSearch.canonicalToolName).toBe('WebSearch');
        expect(webSearch.input).toMatchObject({ query: 'cats' });
    });

    it('maps edit calls with a Codex-style changes map to Patch', () => {
        const normalized = normalizeToolCallV2({
            protocol: 'acp',
            provider: 'codex',
            toolName: 'edit',
            rawInput: {
                changes: {
                    '/tmp/a.txt': {
                        type: 'update',
                        old_content: 'a',
                        new_content: 'b',
                        unified_diff: '@@ -1 +1 @@\n-a\n+b\n',
                        move_path: null,
                    },
                },
            },
            callId: 'call-4',
        });

        expect(normalized.canonicalToolName).toBe('Patch');
        expect(normalized.input).toMatchObject({
            changes: {
                '/tmp/a.txt': {
                    modify: { old_content: 'a', new_content: 'b' },
                    unified_diff: '@@ -1 +1 @@\n-a\n+b\n',
                },
            },
        });
    });

    it('normalizes CodexPatch add shapes into Patch.changes[...].add', () => {
        const normalized = normalizeToolCallV2({
            protocol: 'codex',
            provider: 'codex',
            toolName: 'CodexPatch',
            rawInput: {
                auto_approved: false,
                changes: {
                    '/tmp/new.txt': {
                        type: 'add',
                        content: 'one\ntwo\n',
                    },
                },
            },
            callId: 'call-5',
        });

        expect(normalized.canonicalToolName).toBe('Patch');
        expect(normalized.input).toMatchObject({
            auto_approved: false,
            changes: {
                '/tmp/new.txt': {
                    add: { content: 'one\ntwo\n' },
                },
            },
        });
    });

    it('derives Patch.modify.old_content/new_content from unified_diff when providers omit old/new', () => {
        const normalized = normalizeToolCallV2({
            protocol: 'codex',
            provider: 'codex',
            toolName: 'CodexPatch',
            rawInput: {
                changes: {
                    '/tmp/a.txt': {
                        type: 'update',
                        unified_diff: 'diff --git a/a b/b\n--- a/a\n+++ b/b\n@@ -1 +1 @@\n-old\n+new\n',
                        move_path: null,
                    },
                },
            },
            callId: 'call-patch-preview',
        });

        expect(normalized.canonicalToolName).toBe('Patch');
        expect(normalized.input).toMatchObject({
            changes: {
                '/tmp/a.txt': {
                    modify: {
                        old_content: 'old',
                        new_content: 'new',
                    },
                },
            },
        });
    });

    it('normalizes delete Patch changes into Patch.changes[...].delete even when providers omit content', () => {
        const normalized = normalizeToolCallV2({
            protocol: 'codex',
            provider: 'codex',
            toolName: 'CodexPatch',
            rawInput: {
                changes: {
                    '/tmp/deleted.txt': {
                        type: 'delete',
                    },
                },
            },
            callId: 'call-patch-delete-empty',
        });

        expect(normalized.canonicalToolName).toBe('Patch');
        expect(normalized.input).toMatchObject({
            changes: {
                '/tmp/deleted.txt': {
                    delete: { content: '' },
                },
            },
        });
    });

    it('normalizes diff aliases into Diff.unified_diff', () => {
        const normalized = normalizeToolCallV2({
            protocol: 'codex',
            provider: 'codex',
            toolName: 'CodexDiff',
            rawInput: { diff: 'diff --git a/a b/b\n@@ -1 +1 @@\n-a\n+b\n' },
            callId: 'call-6',
        });

        expect(normalized.canonicalToolName).toBe('Diff');
        expect(normalized.input).toMatchObject({
            unified_diff: 'diff --git a/a b/b\n@@ -1 +1 @@\n-a\n+b\n',
        });
    });

    it('maps delete/remove to Delete when no changes map is present (stable file_paths schema)', () => {
        const normalized = normalizeToolCallV2({
            protocol: 'acp',
            provider: 'auggie',
            toolName: 'delete',
            rawInput: { filePath: '/tmp/a.txt' },
            callId: 'del-1',
        });

        expect(normalized.canonicalToolName).toBe('Delete');
        expect(normalized.input).toMatchObject({ file_paths: ['/tmp/a.txt'] });

        const remove = normalizeToolCallV2({
            protocol: 'acp',
            provider: 'opencode',
            toolName: 'remove',
            rawInput: { file_paths: ['a.txt', 'b.txt'] },
            callId: 'del-2',
        });
        expect(remove.canonicalToolName).toBe('Delete');
        expect(remove.input).toMatchObject({ file_paths: ['a.txt', 'b.txt'] });
    });

    it('treats delete calls with a changes map as Patch (back-compat)', () => {
        const normalized = normalizeToolCallV2({
            protocol: 'acp',
            provider: 'codex',
            toolName: 'delete',
            rawInput: { changes: { '/tmp/a.txt': { delete: { content: '' } } } },
            callId: 'del-3',
        });

        expect(normalized.canonicalToolName).toBe('Patch');
        expect(normalized.input).toMatchObject({ changes: expect.any(Object) });
    });
});

describe('normalizeToolResultV2', () => {
    it('wraps string bash outputs as stdout', () => {
        const normalized = normalizeToolResultV2({
            protocol: 'acp',
            provider: 'opencode',
            rawToolName: 'execute',
            canonicalToolName: 'Bash',
            rawOutput: 'TRACE_OK\n',
        });

        expect(normalized).toMatchObject({
            stdout: 'TRACE_OK\n',
            _happy: expect.objectContaining({ v: 2, protocol: 'acp', provider: 'opencode', rawToolName: 'execute', canonicalToolName: 'Bash' }),
            _raw: expect.anything(),
        });
    });

    it('extracts <return-code>/<output> blocks from tagged bash stdout (Auggie)', () => {
        const rawOutput = [
            'Here are the results from executing the command.',
            '<return-code>',
            '0',
            '</return-code>',
            '<output>',
            'HELLO',
            '</output>',
        ].join('\n');

        const normalized = normalizeToolResultV2({
            protocol: 'acp',
            provider: 'auggie',
            rawToolName: 'execute',
            canonicalToolName: 'Bash',
            rawOutput: { stdout: rawOutput },
        });

        expect(normalized).toMatchObject({
            stdout: 'HELLO',
            exit_code: 0,
            _happy: expect.anything(),
            _raw: expect.anything(),
        });
    });

    it('normalizes Delete results into a stable deleted boolean and error message', () => {
        const ok = normalizeToolResultV2({
            protocol: 'acp',
            provider: 'auggie',
            rawToolName: 'delete',
            canonicalToolName: 'Delete',
            rawOutput: { ok: true },
        });
        expect(ok).toMatchObject({ deleted: true });

        const notFound = normalizeToolResultV2({
            protocol: 'acp',
            provider: 'auggie',
            rawToolName: 'delete',
            canonicalToolName: 'Delete',
            rawOutput: { ok: false, error: 'Not found' },
        });
        expect(notFound).toMatchObject({ deleted: false, error: 'Not found' });
    });

    it('parses opencode <file> read outputs into a canonical Read.file.content', () => {
        const normalized = normalizeToolResultV2({
            protocol: 'acp',
            provider: 'opencode',
            rawToolName: 'read',
            canonicalToolName: 'Read',
            rawOutput: `<file>\n00001| a\n00002| b\n\n(End of file - total 2 lines)\n</file>`,
        });

        expect(normalized).toMatchObject({
            file: {
                content: 'a\nb',
                startLine: 1,
                totalLines: 2,
            },
            _happy: expect.objectContaining({ v: 2, canonicalToolName: 'Read' }),
            _raw: expect.anything(),
        });
    });

    it('preserves read file wrapper shape while attaching _happy/_raw', () => {
        const normalized = normalizeToolResultV2({
            protocol: 'acp',
            provider: 'codex',
            rawToolName: 'read',
            canonicalToolName: 'Read',
            rawOutput: { file: { filePath: '/etc/hosts', content: 'a', numLines: 1, startLine: 1, totalLines: 1 } },
        });

        expect(normalized).toMatchObject({
            file: { filePath: '/etc/hosts', content: 'a' },
            _happy: expect.objectContaining({ v: 2, protocol: 'acp', provider: 'codex', rawToolName: 'read', canonicalToolName: 'Read' }),
            _raw: expect.anything(),
        });
    });

    it('wraps string reasoning outputs as Reasoning.content', () => {
        const normalized = normalizeToolResultV2({
            protocol: 'codex',
            provider: 'codex',
            rawToolName: 'CodexReasoning',
            canonicalToolName: 'Reasoning',
            rawOutput: 'I thought about it.',
        });

        expect(normalized).toMatchObject({
            content: 'I thought about it.',
            _happy: expect.objectContaining({
                v: 2,
                protocol: 'codex',
                provider: 'codex',
                rawToolName: 'CodexReasoning',
                canonicalToolName: 'Reasoning',
            }),
            _raw: expect.anything(),
        });
    });

    it('normalizes empty TodoWrite outputs into a stable todos list', () => {
        const normalized = normalizeToolResultV2({
            protocol: 'acp',
            provider: 'gemini',
            rawToolName: 'write',
            canonicalToolName: 'TodoWrite',
            rawOutput: [],
        });

        expect(normalized).toMatchObject({
            todos: [],
            _happy: expect.objectContaining({ canonicalToolName: 'TodoWrite' }),
            _raw: expect.anything(),
        });
    });

    it('parses opencode search output into CodeSearch.matches', () => {
        const normalized = normalizeToolResultV2({
            protocol: 'acp',
            provider: 'opencode',
            rawToolName: 'search',
            canonicalToolName: 'CodeSearch',
            rawOutput: [
                'Found 1 matches',
                '/tmp/happy-tool-trace.txt:',
                '  Line 2: beta',
            ].join('\n'),
        });

        expect(normalized).toMatchObject({
            matches: [
                {
                    filePath: '/tmp/happy-tool-trace.txt',
                    line: 2,
                    excerpt: 'beta',
                },
            ],
        });
    });

    it('coerces Gemini content-block results into a minimal Glob.matches list', () => {
        const normalized = normalizeToolResultV2({
            protocol: 'acp',
            provider: 'gemini',
            rawToolName: 'glob',
            canonicalToolName: 'Glob',
            rawOutput: [
                { type: 'content', content: { type: 'text', text: 'Found 3 matching file(s)' } },
            ],
        });

        expect(normalized).toMatchObject({
            matches: ['Found 3 matching file(s)'],
        });
    });

    it('coerces Gemini content-block results into a minimal CodeSearch.matches list', () => {
        const normalized = normalizeToolResultV2({
            protocol: 'acp',
            provider: 'gemini',
            rawToolName: 'search',
            canonicalToolName: 'CodeSearch',
            rawOutput: [
                { type: 'content', content: { type: 'text', text: 'Found 5 matches' } },
            ],
        });

        expect(normalized).toMatchObject({
            matches: [{ excerpt: 'Found 5 matches' }],
        });
    });

    it('normalizes Glob result arrays into Glob.matches', () => {
        const normalized = normalizeToolResultV2({
            protocol: 'claude',
            provider: 'claude',
            rawToolName: 'Glob',
            canonicalToolName: 'Glob',
            rawOutput: ['a.txt', 'b.txt'],
        });

        expect(normalized).toMatchObject({
            matches: ['a.txt', 'b.txt'],
        });
    });

    it('normalizes Grep output lines into Grep.matches', () => {
        const normalized = normalizeToolResultV2({
            protocol: 'claude',
            provider: 'claude',
            rawToolName: 'Grep',
            canonicalToolName: 'Grep',
            rawOutput: [
                '/tmp/a.txt:3: hello world',
                '/tmp/b.txt:10: goodbye',
            ].join('\n'),
        });

        expect(normalized).toMatchObject({
            matches: [
                { filePath: '/tmp/a.txt', line: 3, excerpt: 'hello world' },
                { filePath: '/tmp/b.txt', line: 10, excerpt: 'goodbye' },
            ],
        });
    });

    it('normalizes WebSearch results into a stable list', () => {
        const normalized = normalizeToolResultV2({
            protocol: 'claude',
            provider: 'claude',
            rawToolName: 'WebSearch',
            canonicalToolName: 'WebSearch',
            rawOutput: [{ title: 'Example', url: 'https://example.com', snippet: 'hi' }],
        });

        expect(normalized).toMatchObject({
            results: [{ title: 'Example', url: 'https://example.com', snippet: 'hi' }],
        });
    });

    it('normalizes WebFetch into {status,text} when available', () => {
        const normalized = normalizeToolResultV2({
            protocol: 'claude',
            provider: 'claude',
            rawToolName: 'WebFetch',
            canonicalToolName: 'WebFetch',
            rawOutput: { status: 200, text: 'ok' },
        });

        expect(normalized).toMatchObject({
            status: 200,
            text: 'ok',
        });
    });

    it('coerces Gemini content-block WebSearch outputs into a minimal results list', () => {
        const normalized = normalizeToolResultV2({
            protocol: 'acp',
            provider: 'gemini',
            rawToolName: 'web_search',
            canonicalToolName: 'WebSearch',
            rawOutput: [{ type: 'content', content: { type: 'text', text: 'Found 2 results' } }],
        });

        expect(normalized).toMatchObject({
            results: [{ snippet: 'Found 2 results' }],
        });
    });

    it('coerces Gemini content-block WebFetch outputs into a minimal text payload', () => {
        const normalized = normalizeToolResultV2({
            protocol: 'acp',
            provider: 'gemini',
            rawToolName: 'web_fetch',
            canonicalToolName: 'WebFetch',
            rawOutput: [{ type: 'content', content: { type: 'text', text: 'Fetched ok' } }],
        });

        expect(normalized).toMatchObject({
            text: 'Fetched ok',
        });
    });

    it('coerces Gemini content-block Read outputs into a canonical file.content', () => {
        const normalized = normalizeToolResultV2({
            protocol: 'acp',
            provider: 'gemini',
            rawToolName: 'read_file',
            canonicalToolName: 'Read',
            rawOutput: [{ type: 'content', content: { type: 'text', text: 'Line 1\nLine 2' } }],
        });

        expect(normalized).toMatchObject({
            file: { content: 'Line 1\nLine 2' },
        });
    });

    it('normalizes Edit results into a stable applied shape when providers return ok=true', () => {
        const normalized = normalizeToolResultV2({
            protocol: 'acp',
            provider: 'gemini',
            rawToolName: 'edit',
            canonicalToolName: 'Edit',
            rawOutput: { ok: true },
        });

        expect(normalized).toMatchObject({
            applied: true,
            ok: true,
        });
    });

    it('normalizes Edit results into a stable applied/error shape when providers return failures', () => {
        const normalized = normalizeToolResultV2({
            protocol: 'acp',
            provider: 'gemini',
            rawToolName: 'edit',
            canonicalToolName: 'Edit',
            rawOutput: { ok: false, error: 'Permission denied' },
        });

        expect(normalized).toMatchObject({
            applied: false,
            ok: false,
            error: 'Permission denied',
        });
    });

    it('normalizes Write results into a stable applied shape when providers return ok=true', () => {
        const normalized = normalizeToolResultV2({
            protocol: 'acp',
            provider: 'gemini',
            rawToolName: 'write',
            canonicalToolName: 'Write',
            rawOutput: { ok: true },
        });

        expect(normalized).toMatchObject({
            applied: true,
            ok: true,
        });
    });

    it('normalizes Write results into a stable applied/error shape when providers return failures', () => {
        const normalized = normalizeToolResultV2({
            protocol: 'acp',
            provider: 'gemini',
            rawToolName: 'write',
            canonicalToolName: 'Write',
            rawOutput: { ok: false, error: 'Permission denied' },
        });

        expect(normalized).toMatchObject({
            applied: false,
            ok: false,
            error: 'Permission denied',
        });
    });

    it('normalizes change_title tool results into a stable title/message shape', () => {
        const normalized = normalizeToolResultV2({
            protocol: 'codex',
            provider: 'codex',
            rawToolName: 'mcp__happy__change_title',
            canonicalToolName: 'change_title',
            rawOutput: { content: [{ type: 'text', text: 'Successfully changed chat title to: \"Hello\"' }], isError: false },
        });

        expect(normalized).toMatchObject({
            title: 'Hello',
        });
    });

    it('normalizes Patch results into a stable applied/message shape', () => {
        const normalized = normalizeToolResultV2({
            protocol: 'codex',
            provider: 'codex',
            rawToolName: 'CodexPatch',
            canonicalToolName: 'Patch',
            rawOutput: { stdout: 'Success. Updated files.', stderr: '', success: true },
        });

        expect(normalized).toMatchObject({
            applied: true,
            stdout: 'Success. Updated files.',
            stderr: '',
        });
    });

    it('normalizes Patch results into a stable applied/errorMessage shape on failure', () => {
        const normalized = normalizeToolResultV2({
            protocol: 'codex',
            provider: 'codex',
            rawToolName: 'CodexPatch',
            canonicalToolName: 'Patch',
            rawOutput: { stdout: '', stderr: 'Permission denied', success: false },
        });

        expect(normalized).toMatchObject({
            applied: false,
            errorMessage: 'Permission denied',
        });
    });

    it('normalizes Diff results into a stable status shape', () => {
        const normalized = normalizeToolResultV2({
            protocol: 'codex',
            provider: 'codex',
            rawToolName: 'CodexDiff',
            canonicalToolName: 'Diff',
            rawOutput: { status: 'completed' },
        });

        expect(normalized).toMatchObject({
            status: 'completed',
        });
    });

    it('normalizes Task tool_result content blocks into Task.content', () => {
        const normalized = normalizeToolResultV2({
            protocol: 'claude',
            provider: 'claude',
            rawToolName: 'Task',
            canonicalToolName: 'Task',
            rawOutput: [
                { type: 'text', text: 'Line 1' },
                { type: 'text', text: 'Line 2' },
            ],
        });

        expect(normalized).toMatchObject({
            content: 'Line 1\nLine 2',
        });
    });

    it('surfaces a stable errorMessage field for unknown tool results that include error-like keys', () => {
        const normalized = normalizeToolResultV2({
            protocol: 'codex',
            provider: 'codex',
            rawToolName: 'SomeNewTool',
            canonicalToolName: 'SomeNewTool',
            rawOutput: { status: 403, error: 'Forbidden' },
        });

        expect(normalized).toMatchObject({
            status: 403,
            error: 'Forbidden',
            errorMessage: 'Forbidden',
            _happy: expect.objectContaining({ v: 2, protocol: 'codex', provider: 'codex', rawToolName: 'SomeNewTool' }),
            _raw: expect.anything(),
        });
    });
});
