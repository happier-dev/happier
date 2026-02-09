import { describe, expect, it } from 'vitest';

import { normalizeToolCallForRendering } from './normalizeToolCallForRendering';
import { makeTool } from './normalizeToolCallForRendering._testHelpers';

describe('normalizeToolCallForRendering (input shapes)', () => {
    it('parses JSON string inputs into objects', () => {
        const normalized = normalizeToolCallForRendering(
            makeTool({
                input: '{"a":1}',
                result: '{"ok":true}',
            }),
        );
        expect(normalized.input).toEqual({ a: 1 });
    });

    it('normalizes edit aliases into old_string/new_string + file_path', () => {
        const normalized = normalizeToolCallForRendering(
            makeTool({
                name: 'edit',
                input: {
                    filePath: '/tmp/a.txt',
                    oldText: 'hello',
                    newText: 'hi',
                },
            }),
        );
        expect(normalized.input).toMatchObject({
            file_path: '/tmp/a.txt',
            old_string: 'hello',
            new_string: 'hi',
        });
    });

    it('normalizes ACP-style diff arrays for write into content + file_path', () => {
        const fromItems = normalizeToolCallForRendering(
            makeTool({
                name: 'write',
                input: {
                    items: [{ path: '/tmp/a.txt', oldText: 'hello', newText: 'hi', type: 'diff' }],
                },
            }),
        );
        expect(fromItems.input).toMatchObject({
            file_path: '/tmp/a.txt',
            content: 'hi',
        });

        const fromContent = normalizeToolCallForRendering(
            makeTool({
                name: 'write',
                input: {
                    content: [{ path: '/tmp/a.txt', oldText: 'hello', newText: 'hi', type: 'diff' }],
                },
            }),
        );
        expect(fromContent.input).toMatchObject({
            file_path: '/tmp/a.txt',
            content: 'hi',
        });
    });

    it('normalizes ACP-style diff arrays for edit into old/new strings + file_path', () => {
        const fromItems = normalizeToolCallForRendering(
            makeTool({
                name: 'edit',
                input: {
                    items: [{ path: '/tmp/a.txt', oldText: 'hello', newText: 'hi', type: 'diff' }],
                },
            }),
        );
        expect(fromItems.input).toMatchObject({
            file_path: '/tmp/a.txt',
            old_string: 'hello',
            new_string: 'hi',
        });

        const fromContent = normalizeToolCallForRendering(
            makeTool({
                name: 'edit',
                input: {
                    content: [{ path: '/tmp/a.txt', oldText: 'hello', newText: 'hi', type: 'diff' }],
                },
            }),
        );
        expect(fromContent.input).toMatchObject({
            file_path: '/tmp/a.txt',
            old_string: 'hello',
            new_string: 'hi',
        });
    });

    it('normalizes legacy write_file and edit_file aliases', () => {
        const write = normalizeToolCallForRendering(
            makeTool({
                name: 'write_file',
                input: { filePath: '/tmp/a.txt', newText: 'hi' },
            }),
        );
        expect(write.name).toBe('Write');
        expect(write.input).toMatchObject({ file_path: '/tmp/a.txt', content: 'hi' });

        const edit = normalizeToolCallForRendering(
            makeTool({
                name: 'edit_file',
                input: { filePath: '/tmp/a.txt', oldText: 'hello', newText: 'hi' },
            }),
        );
        expect(edit.name).toBe('Edit');
        expect(edit.input).toMatchObject({ file_path: '/tmp/a.txt', old_string: 'hello', new_string: 'hi' });
    });

    it('maps write todos payloads to TodoWrite and items[] into todos[]', () => {
        const directTodos = normalizeToolCallForRendering(
            makeTool({
                name: 'write',
                input: { todos: [{ content: 'x', status: 'pending' }] },
            }),
        );
        expect(directTodos.name).toBe('TodoWrite');

        const items = normalizeToolCallForRendering(
            makeTool({
                name: 'TodoWrite',
                input: { items: ['First todo'] },
            }),
        );
        expect(items.input).toMatchObject({
            todos: [{ content: 'First todo', status: 'pending' }],
        });
    });
});
