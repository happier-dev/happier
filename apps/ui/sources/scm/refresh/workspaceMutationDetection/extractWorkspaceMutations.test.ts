import { describe, expect, it } from 'vitest';

import type { NormalizedMessage } from "@happier-dev/session-core/raw";

import { extractWorkspaceMutationsFromNormalizedMessages, readToolCallMutationPaths } from './extractWorkspaceMutations';
import { isToolPotentiallyMutableForScm } from '@/sync/domains/tools/toolMutationClassification';

describe('readToolCallMutationPaths', () => {
    it('keeps a captured turn Diff as SCM invalidation evidence without reporting a live file mutation', () => {
        // FILES-LIVE63, nested Session cmvyp4poc009bmcn1dqvcedld: the summary is
        // repository-relative, unlike its actual Patch calls' absolute targets.
        const result = readToolCallMutationPaths({ name: 'Diff', input: {
            files: [{ file_path: 'live63-1102/nested/tracking.ts', change_kind: 'modified',
                source: 'provider_tool', confidence: 'exact', provider: 'codex' }],
            _happier: { v: 2, protocol: 'acp', provider: 'codex', rawToolName: 'Diff', canonicalToolName: 'Diff',
                workspaceMutationSignal: 'turn-change-set', sessionChangeScope: 'turn', turnStatus: 'completed' },
        }, state: 'running' });
        expect([...result.paths]).toEqual(['live63-1102/nested/tracking.ts']);
        expect(result.hasUnknownMutations).toBe(false);
        expect([...result.mutations]).toEqual([]);
    });

    it('keeps code reads, previews and restart out of workspace mutation classification', () => {
        for (const name of ['code_hover_get', 'code_definition_get', 'code_references_list', 'code_symbols_list',
            'code_diagnostics_list', 'code_restart', 'code_rename_preview', 'code_file_rename_preview', 'code_code_actions_list']) {
            expect(isToolPotentiallyMutableForScm(`mcp__happier__${name}`), name).toBe(false);
            expect([...readToolCallMutationPaths({ name: `mcp__happier__${name}`, input: { path: 'read.ts' } }).paths]).toEqual([]);
        }
        expect(isToolPotentiallyMutableForScm('mcp__happier__code_rename_apply')).toBe(true);
    });
    it('shares canonical provider normalization and retains per-path mutation kinds', () => {
        const result = readToolCallMutationPaths({ name: 'NativePatch', input: {
            _happier: { canonicalToolName: 'Patch' },
            changes: {
                'src/new.ts': { type: 'add', content: 'new' },
                'src/gone.ts': { type: 'delete', content: 'old' },
                'src/moved.ts': { type: 'update', previous_file_path: 'src/old.ts', old_content: 'old', new_content: 'new' },
            },
        } });
        expect([...result.paths]).toEqual(['src/new.ts', 'src/gone.ts', 'src/moved.ts', 'src/old.ts']);
        expect([...result.mutations].map(([path, mutation]) => [path, mutation.kind])).toEqual([
            ['src/new.ts', 'create'], ['src/gone.ts', 'delete'], ['src/moved.ts', 'rename'], ['src/old.ts', 'rename'],
        ]);
    });

    it('reads raw apply_patch through the protocol patch normalizer and never guesses shell paths', () => {
        const patch = readToolCallMutationPaths({ name: 'apply_patch', input: {
            patch: '*** Begin Patch\n*** Add File: src/new.ts\n+hello\n*** End Patch',
        } });
        expect([...patch.paths]).toEqual(['src/new.ts']);
        const shell = readToolCallMutationPaths({ name: 'Bash', input: { command: 'echo hi > fake.ts', path: 'fake.ts' } });
        expect([...shell.paths]).toEqual([]);
        expect(shell.hasUnknownMutations).toBe(true);
    });
});

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
                input: toolInput,
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
    it('refreshes for committed rootless writer receipts without attributing their relative paths to the Session workspace', () => {
        const result = extractWorkspaceMutationsFromNormalizedMessages({ messages: [{
            id: 'semantic-result', localId: null, createdAt: 20, role: 'agent', isSidechain: false,
            content: [{ type: 'tool-result', tool_use_id: 'semantic', content: { structuredContent: {
                ok: true, results: [
                    { path: 'one.ts', renameTo: 'two.ts', status: 'replaced' },
                    { path: 'importer.ts', status: 'replaced' }, { path: 'failed.ts', status: 'failed' },
                    { path: 'undo.ts', renameTo: 'original.ts', status: 'restored' },
                    { path: 'partial.ts', renameTo: 'moved.ts', status: 'replaced', hash: 'a'.repeat(64), edits: [], reason: 'importer failed' },
                ],
            } }, is_error: false, uuid: 'result-uuid', parentUUID: null }],
        }] });
        expect([...result.paths]).toEqual([]);
        expect(result.hasUnknownMutations).toBe(true);
    });

    it('does not infer committed writes from a preview or an unrecognized ok/results receipt', () => {
        for (const receipt of [
            { ok: true, results: [{ path: 'not-written.ts', status: 'changed' }] },
            { ok: true, results: [{ path: 'not-written.ts', status: 'replaced', unexpected: true }] },
            { status: 'ok', kind: 'rename', files: [{ path: 'not-written.ts' }] },
        ]) {
            const result = extractWorkspaceMutationsFromNormalizedMessages({ messages: [{
                id: 'result', localId: null, createdAt: 20, role: 'agent', isSidechain: false,
                content: [{ type: 'tool-result', tool_use_id: 'semantic', content: receipt, is_error: false,
                    uuid: 'result-uuid', parentUUID: null }],
            }] });
            expect([...result.paths]).toEqual([]);
        }
    });
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

    it.each([
        ['named Task and SubAgent', [
            toolCallMessage('Task', { description: 'delegate workspace changes' }),
            toolCallMessage('SubAgent', { prompt: 'update files in parallel' }),
        ]],
        ['whose canonical metadata resolves to Task or SubAgent', [
            toolCallMessageWithCanonicalToolName('DelegateTask', 'Task', {
                description: 'delegate without direct command payload',
            }),
            toolCallMessageWithCanonicalToolName('SpawnWorker', 'SubAgent', {
                role: 'implement',
            }),
        ]],
    ])('treats tool calls %s as containers until nested mutating tools provide evidence', (_label, messages) => {
        const result = extractWorkspaceMutationsFromNormalizedMessages({ messages });

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
