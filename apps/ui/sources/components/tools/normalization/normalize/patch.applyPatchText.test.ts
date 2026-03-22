import { describe, expect, it } from 'vitest';

import { normalizeToolInputForRendering } from './inputNormalization';

describe('normalizeToolInputForRendering (Patch apply_patch patchText)', () => {
    it('infers changes from apply_patch patchText blocks', () => {
        const normalized = normalizeToolInputForRendering({
            toolName: 'Patch',
            canonicalToolName: 'Patch',
            input: {
                patchText: [
                    '*** Begin Patch',
                    '*** Update File: src/a.txt',
                    '*** Add File: src/new.txt',
                    '*** Delete File: src/old.txt',
                    '*** End Patch',
                ].join('\n'),
            },
        }) as any;

        expect(normalized).toEqual(
            expect.objectContaining({
                changes: {
                    'src/a.txt': { type: 'update' },
                    'src/new.txt': { type: 'add' },
                    'src/old.txt': { type: 'delete' },
                },
            }),
        );
    });

    it('tracks move destinations for renamed apply_patch file blocks', () => {
        const normalized = normalizeToolInputForRendering({
            toolName: 'Patch',
            canonicalToolName: 'Patch',
            input: {
                patchText: [
                    '*** Begin Patch',
                    '*** Update File: src/old-name.ts',
                    '*** Move to: src/new-name.ts',
                    '@@',
                    '-old',
                    '+new',
                    '*** End Patch',
                ].join('\n'),
            },
        }) as any;

        expect(normalized).toEqual(
            expect.objectContaining({
                changes: {
                    'src/new-name.ts': { type: 'update' },
                },
            }),
        );
    });

    it('normalizes Codex patch permission change arrays into canonical changes maps', () => {
        const normalized = normalizeToolInputForRendering({
            toolName: 'CodexPatch',
            canonicalToolName: 'Patch',
            input: {
                changes: [
                    {
                        path: '/tmp/happier-codex-qa-1774030477/NOTES.md',
                        kind: { type: 'update', move_path: null },
                        diff: [
                            '@@ -2 +2,2 @@',
                            '-old line',
                            '+old line',
                            '+new line',
                        ].join('\n'),
                    },
                ],
            },
        }) as any;

        expect(normalized).toEqual(
            expect.objectContaining({
                changes: {
                    '/tmp/happier-codex-qa-1774030477/NOTES.md': {
                        type: 'update',
                        modify: {
                            old_content: 'old line',
                            new_content: 'old line\nnew line',
                        },
                    },
                },
            }),
        );
    });
});
