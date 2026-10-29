import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { normalizeWorkspaceEdit } from './workspaceEdit';

describe('LSP workspace edit normalization', () => {
    it('previews formatting against an unsaved held buffer with its own hash and leaves saved bytes untouched', async () => {
        await withTempDir('happier-lsp-buffer-format-', async rootPath => {
            await writeFile(join(rootPath, 'a.ts'), 'saved');
            const range = { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } };
            const text = '\uFEFFdraft\r\nvalue\r\n';
            const input = { rootPath, platform: process.platform, document: () => ({ text, version: 2, unsaved: true }),
                edit: { changes: { [pathToFileURL(join(rootPath, 'a.ts')).href]: [{ range, newText: 'next' }] } } };
            await expect(normalizeWorkspaceEdit({ ...input, text: 'held' })).resolves.toEqual([{ path: 'a.ts',
                expectedHash: createHash('sha256').update(text).digest('hex'), edits: [{ range, text: 'next' }] }]);
            await expect(normalizeWorkspaceEdit(input)).rejects.toMatchObject({ code: 'unsaved_editor_changes' });
            expect(await readFile(join(rootPath, 'a.ts'), 'utf8')).toBe('saved');
        });
    });
    it('keeps ordered edits after a RenameFile on the original guarded source without writing', async () => {
        await withTempDir('happier-lsp-resource-edit-', async rootPath => {
            const bytes = Buffer.from('\uFEFFold\r\n');
            await writeFile(join(rootPath, 'a.ts'), bytes);
            const oldUri = pathToFileURL(join(rootPath, 'a.ts')).href;
            const newUri = pathToFileURL(join(rootPath, 'moved.ts')).href;
            const range = { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } };
            const files = await normalizeWorkspaceEdit({ rootPath, platform: process.platform, document: () => undefined,
                edit: { documentChanges: [
                    { kind: 'rename', oldUri, newUri, options: { overwrite: false } },
                    { textDocument: { uri: newUri, version: null }, edits: [{ range, newText: 'x' }, { range, newText: 'x' }] },
                ] },
            });
            expect(files).toEqual([{ path: 'a.ts', renameTo: 'moved.ts', expectedHash: createHash('sha256').update(bytes).digest('hex'),
                edits: [{ range, text: 'x' }, { range, text: 'x' }],
            }]);
            expect(await readFile(join(rootPath, 'a.ts'))).toEqual(bytes);
            await expect(readFile(join(rootPath, 'moved.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
        });
    });
});
