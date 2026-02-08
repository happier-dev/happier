import { describe, expect, it } from 'vitest';

import { normalizeToolCallForRendering } from './normalizeToolCallForRendering';
import { makeTool } from './normalizeToolCallForRendering._testHelpers';

describe('normalizeToolCallForRendering (results)', () => {
    it('normalizes legacy glob/ls result arrays into named result objects', () => {
        const glob = normalizeToolCallForRendering(
            makeTool({
                name: 'glob',
                input: { pattern: '*.ts' },
                result: ['a.ts', 'b.ts'],
            }),
        );
        expect(glob.result).toEqual({ matches: ['a.ts', 'b.ts'] });

        const ls = normalizeToolCallForRendering(
            makeTool({
                name: 'ls',
                input: { dir: '/tmp' },
                result: ['a.txt', 'b.txt'],
            }),
        );
        expect(ls.result).toEqual({ entries: ['a.txt', 'b.txt'] });
    });

    it('normalizes legacy grep strings into structured matches', () => {
        const normalized = normalizeToolCallForRendering(
            makeTool({
                name: 'grep',
                input: { pattern: 'beta' },
                result: '/tmp/a.txt:2: beta',
            }),
        );
        expect(normalized.result).toEqual({
            matches: [{ filePath: '/tmp/a.txt', line: 2, excerpt: 'beta' }],
        });
    });

    it('normalizes legacy CodexPatch unified diffs into Patch.changes', () => {
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

        const normalized = normalizeToolCallForRendering(
            makeTool({
                name: 'CodexPatch',
                input: { patch: diff },
                result: { ok: true },
            }),
        );

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

    it('normalizes patch delete diffs into Patch.changes.delete', () => {
        const diff = [
            'diff --git a/tmp/a.txt b/tmp/a.txt',
            'deleted file mode 100644',
            '--- a/tmp/a.txt',
            '+++ /dev/null',
            '@@ -1 +0,0 @@',
            '-goodbye',
            '',
        ].join('\n');

        const normalized = normalizeToolCallForRendering(
            makeTool({
                name: 'patch',
                input: { unified_diff: diff },
                result: { ok: true },
            }),
        );
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

    it('normalizes TodoWrite and Reasoning result aliases', () => {
        const todo = normalizeToolCallForRendering(
            makeTool({
                name: 'TodoWrite',
                result: { newTodos: [{ content: 'Hello', status: 'completed' }] },
            }),
        );
        expect(todo.result).toMatchObject({
            todos: [{ content: 'Hello', status: 'completed' }],
        });

        const reasoning = normalizeToolCallForRendering(
            makeTool({
                name: 'Reasoning',
                result: { text: 'Hello from reasoning' },
            }),
        );
        expect(reasoning.result).toMatchObject({ content: 'Hello from reasoning' });
    });
});
