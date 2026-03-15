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
});
