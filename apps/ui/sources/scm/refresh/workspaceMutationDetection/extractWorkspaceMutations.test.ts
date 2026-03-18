import { describe, expect, it } from 'vitest';

import type { NormalizedMessage } from '@/sync/typesRaw';

import { extractWorkspaceMutationsFromNormalizedMessages } from './extractWorkspaceMutations';

function toolCallMessage(toolName: string, toolInput: unknown): NormalizedMessage {
    return {
        id: `msg-${toolName}`,
        localId: null,
        createdAt: 1000,
        role: 'agent',
        isSidechain: false,
        content: [
            {
                type: 'tool-call',
                id: `tool-${toolName}`,
                name: toolName,
                input: toolInput as any,
                description: null,
                uuid: `uuid-${toolName}`,
                parentUUID: null,
            },
        ],
    };
}

function toolCallMessageWithCanonicalToolName(
    toolName: string,
    canonicalToolName: string,
    toolInput: Record<string, unknown>,
): NormalizedMessage {
    return toolCallMessage(toolName, {
        ...toolInput,
        _happier: {
            canonicalToolName,
        },
    });
}

describe('extractWorkspaceMutationsFromNormalizedMessages', () => {
    it('extracts filePath from file-edit tool calls', () => {
        const result = extractWorkspaceMutationsFromNormalizedMessages({
            messages: [toolCallMessage('file-edit', { filePath: 'apps/ui/src/app.ts' })],
        });
        expect(Array.from(result.paths)).toEqual(['apps/ui/src/app.ts']);
        expect(result.hasUnknownMutations).toBe(false);
    });

    it('extracts change paths from patch tool calls', () => {
        const result = extractWorkspaceMutationsFromNormalizedMessages({
            messages: [
                toolCallMessage('patch', { changes: [{ path: 'a.ts' }, { path: 'b.ts' }] }),
            ],
        });
        expect(new Set(result.paths)).toEqual(new Set(['a.ts', 'b.ts']));
        expect(result.hasUnknownMutations).toBe(false);
    });

    it('extracts write_file path variants and marks unknown for bash', () => {
        const result = extractWorkspaceMutationsFromNormalizedMessages({
            messages: [
                toolCallMessage('write_file', { path: 'c.ts', content: 'x' }),
                toolCallMessage('write_file', { file_path: 'd.ts', content: 'y' }),
                toolCallMessage('bash', { command: 'echo hi > e.ts' }),
            ],
        });
        expect(new Set(result.paths)).toEqual(new Set(['c.ts', 'd.ts']));
        expect(result.hasUnknownMutations).toBe(true);
    });

    it('ignores read-only Diff inspection while still extracting apply_patch map-shaped change paths', () => {
        const result = extractWorkspaceMutationsFromNormalizedMessages({
            messages: [
                toolCallMessage('Diff', {
                    files: [
                        { file_path: 'src/app.ts', oldText: 'old', newText: 'new' },
                        { file_path: 'src/feature.ts', unified_diff: 'diff --git a/src/feature.ts b/src/feature.ts' },
                    ],
                }),
                toolCallMessage('apply_patch', {
                    changes: {
                        'src/alpha.ts': { type: 'modify' },
                        'src/beta.ts': { type: 'create' },
                    },
                }),
            ],
        });
        expect(new Set(result.paths)).toEqual(new Set([
            'src/alpha.ts',
            'src/beta.ts',
        ]));
        expect(result.hasUnknownMutations).toBe(false);
    });

    it('extracts paths from canonical Diff mutation signals without making generic Diff mutating', () => {
        const result = extractWorkspaceMutationsFromNormalizedMessages({
            messages: [
                toolCallMessage('ProviderDiff', {
                    files: [
                        { file_path: 'src/native-a.ts', oldText: 'before', newText: 'after' },
                        { file_path: 'src/native-b.ts', unified_diff: 'diff --git a/src/native-b.ts b/src/native-b.ts' },
                    ],
                    _happier: {
                        canonicalToolName: 'Diff',
                        workspaceMutationSignal: 'turn-change-set',
                        sessionChangeScope: 'turn',
                    },
                }),
                toolCallMessage('Diff', {
                    files: [
                        { file_path: 'src/read-only.ts', oldText: 'before', newText: 'after' },
                    ],
                }),
            ],
        });

        expect(new Set(result.paths)).toEqual(new Set([
            'src/native-a.ts',
            'src/native-b.ts',
        ]));
        expect(result.hasUnknownMutations).toBe(false);
    });

    it('extracts paths from canonical normalized file mutation tool names', () => {
        const result = extractWorkspaceMutationsFromNormalizedMessages({
            messages: [
                toolCallMessage('Write', { file_path: 'src/write.ts', content: 'export {};' }),
                toolCallMessage('Edit', {
                    file_path: 'src/edit.ts',
                    old_string: 'before',
                    new_string: 'after',
                }),
                toolCallMessage('MultiEdit', {
                    file_path: 'src/multi-edit.ts',
                    edits: [{ old_string: 'before', new_string: 'after' }],
                }),
            ],
        });

        expect(new Set(result.paths)).toEqual(new Set([
            'src/write.ts',
            'src/edit.ts',
            'src/multi-edit.ts',
        ]));
        expect(result.hasUnknownMutations).toBe(false);
    });

    it('extracts both source and destination paths from rename and move tool calls', () => {
        const result = extractWorkspaceMutationsFromNormalizedMessages({
            messages: [
                toolCallMessage('rename', {
                    from: 'src/old-name.ts',
                    to: 'src/new-name.ts',
                }),
                toolCallMessage('move', {
                    src: 'docs/old/location.md',
                    dest: 'docs/new/location.md',
                }),
            ],
        });

        expect(new Set(result.paths)).toEqual(new Set([
            'src/old-name.ts',
            'src/new-name.ts',
            'docs/old/location.md',
            'docs/new/location.md',
        ]));
        expect(result.hasUnknownMutations).toBe(false);
    });

    it('treats canonical Task and SubAgent tool calls as containers until nested mutating tools provide evidence', () => {
        const result = extractWorkspaceMutationsFromNormalizedMessages({
            messages: [
                toolCallMessage('Task', { description: 'delegate workspace changes' }),
                toolCallMessage('SubAgent', { prompt: 'update files in parallel' }),
            ],
        });

        expect(Array.from(result.paths)).toEqual([]);
        expect(result.hasUnknownMutations).toBe(false);
    });

    it('prefers canonical normalized file mutation tool names from _happier metadata', () => {
        const result = extractWorkspaceMutationsFromNormalizedMessages({
            messages: [
                toolCallMessageWithCanonicalToolName('CodexPatch', 'Patch', {
                    changes: {
                        'src/from-canonical-patch.ts': { type: 'modify' },
                    },
                }),
                toolCallMessageWithCanonicalToolName('DeleteFile', 'Delete', {
                    file_path: 'src/from-canonical-delete.ts',
                }),
            ],
        });

        expect(new Set(result.paths)).toEqual(new Set([
            'src/from-canonical-patch.ts',
            'src/from-canonical-delete.ts',
        ]));
        expect(result.hasUnknownMutations).toBe(false);
    });

    it('treats provider tool calls whose canonical metadata resolves to Task or SubAgent as containers', () => {
        const result = extractWorkspaceMutationsFromNormalizedMessages({
            messages: [
                toolCallMessageWithCanonicalToolName('DelegateTask', 'Task', {
                    description: 'delegate without direct command payload',
                }),
                toolCallMessageWithCanonicalToolName('SpawnWorker', 'SubAgent', {
                    role: 'implement',
                }),
            ],
        });

        expect(Array.from(result.paths)).toEqual([]);
        expect(result.hasUnknownMutations).toBe(false);
    });

    it('extracts nested mutating tool evidence without marking container tools as unknown mutations', () => {
        const result = extractWorkspaceMutationsFromNormalizedMessages({
            messages: [
                toolCallMessage('Task', { description: 'delegate workspace changes' }),
                toolCallMessage('Write', { file_path: 'src/generated.ts', content: 'export {};' }),
            ],
        });

        expect(Array.from(result.paths)).toEqual(['src/generated.ts']);
        expect(result.hasUnknownMutations).toBe(false);
    });
});
