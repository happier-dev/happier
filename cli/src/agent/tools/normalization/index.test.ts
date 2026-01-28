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
                    { file_path: '/tmp/a.txt', old_string: 'a', new_string: 'b' },
                    { file_path: '/tmp/b.txt', old_string: 'c', new_string: 'd' },
                ],
            },
            callId: 'call-multiedit',
        });

        expect(normalized.canonicalToolName).toBe('MultiEdit');
        expect(normalized.input).toMatchObject({
            edits: expect.any(Array),
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
        expect(
            normalizeToolCallV2({ protocol: 'claude', provider: 'claude', toolName: 'TaskCreate', rawInput: { subject: 'x' }, callId: 't1' })
                .canonicalToolName
        ).toBe('Task');
        expect(
            normalizeToolCallV2({ protocol: 'claude', provider: 'claude', toolName: 'TaskList', rawInput: {}, callId: 't2' })
                .canonicalToolName
        ).toBe('Task');
        expect(
            normalizeToolCallV2({ protocol: 'claude', provider: 'claude', toolName: 'TaskUpdate', rawInput: { taskId: '1' }, callId: 't3' })
                .canonicalToolName
        ).toBe('Task');
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
});
