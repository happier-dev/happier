import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { createPartialStorageModuleMock, renderScreen } from '@/dev/testkit';
import { makeToolCall, makeToolViewProps } from '@/dev/testkit';
import { makeCompletedTool, normalizedHostText } from '../core/truncationView.testHelpers';
import {
    fileOpsRendererModuleState,
    installFileOpsRendererCommonModuleMocks,
    resetFileOpsRendererCommonModuleMockState,
} from './fileOpsRendererTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

resetFileOpsRendererCommonModuleMockState();
installFileOpsRendererCommonModuleMocks({
    storage: async (importOriginal) =>
        createPartialStorageModuleMock(importOriginal, {
            useSetting: () => true,
        }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => {
                if (key === 'common.applied') return 'Applied';
                if (key === 'common.deleted') return 'Deleted';
                return key;
            },
        });
    },
});

vi.mock('@/utils/path/pathUtils', () => ({
    resolvePath: (p: string) => p,
}));

describe('PatchView', () => {
    async function renderView(tool: ToolCall, detailLevel?: 'title' | 'summary' | 'full') {
        const { PatchView } = await import('./PatchView');
        return renderScreen(React.createElement(
                    PatchView,
                    makeToolViewProps(tool, detailLevel ? { detailLevel } : {}),
                ));
    }

    it('shows an applied indicator when result.applied=true', async () => {
        const screen = await renderView(
            makeCompletedTool(
                'Patch',
                { changes: { '/tmp/a.txt': { type: 'add', add: { content: 'hi' } } } },
                { applied: true },
            ),
        );
        const renderedText = normalizedHostText(screen.tree);
        expect(renderedText).toContain('Applied');
    });

    it('shows a deleted indicator when all changes are delete operations', async () => {
        const screen = await renderView(
            makeCompletedTool(
                'Patch',
                {
                    changes: {
                        '/tmp/a.txt': { type: 'delete', delete: { content: '' } },
                        '/tmp/b.txt': { type: 'delete', delete: { content: '' } },
                    },
                },
                { applied: true },
            ),
        );
        const renderedText = normalizedHostText(screen.tree);
        expect(renderedText).toContain('Deleted');
    });

    it('renders a diff preview when detailLevel=full', async () => {
        fileOpsRendererModuleState.toolDiffSpy.mockClear();
        const screen = await renderView(
            makeCompletedTool(
                'Patch',
                {
                    changes: {
                        '/tmp/a.txt': {
                            type: 'modify',
                            modify: { old_content: 'a\n', new_content: 'b\n' },
                        },
                    },
                },
                { applied: true },
            ),
            'full',
        );

        expect(screen.findAllByType('ToolDiffView' as any)).toHaveLength(1);
        expect(fileOpsRendererModuleState.toolDiffSpy).toHaveBeenCalledWith(
            expect.objectContaining({ filePath: '/tmp/a.txt' }),
        );
    });

    it('renders a diff preview in full mode using result.metadata.files before/after when input content is unavailable', async () => {
        fileOpsRendererModuleState.toolDiffSpy.mockClear();
        const screen = await renderView(
            makeCompletedTool(
                'Patch',
                {
                    changes: {
                        'qa/opencode_permission_inside.txt': { type: 'add' },
                    },
                },
                {
                    metadata: {
                        files: [
                            {
                                relativePath: 'qa/opencode_permission_inside.txt',
                                before: '',
                                after: 'INSIDE_WRITE_TEST_V1\n',
                            },
                        ],
                    },
                },
            ),
            'full',
        );

        expect(screen.findAllByType('ToolDiffView' as any)).toHaveLength(1);
        expect(fileOpsRendererModuleState.toolDiffSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                filePath: 'qa/opencode_permission_inside.txt',
                oldText: '',
                newText: 'INSIDE_WRITE_TEST_V1\n',
            }),
        );
    });

    it('falls back to summary rendering in full mode when diff extraction is not possible', async () => {
        const screen = await renderView(
            makeCompletedTool(
                'Patch',
                {
                    changes: {
                        '/tmp/a.txt': { type: 'modify', modify: { old_content: 1, new_content: 2 } },
                    },
                },
                { applied: true },
            ),
            'full',
        );

        expect(screen.findAllByType('ToolDiffView' as any)).toHaveLength(0);
        const text = normalizedHostText(screen.tree);
        expect(text).toContain('a.txt');
        expect(text).toContain('Applied');
    });

    it('does not show Deleted when changes include non-delete operations', async () => {
        const screen = await renderView(
            makeCompletedTool(
                'Patch',
                {
                    changes: {
                        '/tmp/a.txt': { type: 'delete', delete: { content: '' } },
                        '/tmp/b.txt': { type: 'add', add: { content: 'x' } },
                    },
                },
                { applied: true },
            ),
        );

        const text = normalizedHostText(screen.tree);
        expect(text).toContain('Applied');
        expect(text).not.toContain('Deleted');
    });

    it('renders a human-readable error when tool.state=error', async () => {
        const screen = await renderView(
            makeToolCall({
                name: 'Patch',
                state: 'error',
                input: {
                    changes: {
                        '/tmp/happier_multi_hunk_test.txt': { type: 'update' },
                    },
                },
                result: {
                    status: 'failed',
                    errorMessage: 'Error: The user rejected permission to use this specific tool call.',
                },
            }),
            'full',
        );

        const text = normalizedHostText(screen.tree);
        expect(text).toContain('rejected permission');
    });
});
