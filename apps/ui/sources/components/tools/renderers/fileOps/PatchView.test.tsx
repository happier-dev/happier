import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { createPartialStorageModuleMock, renderScreen } from '@/dev/testkit';
import { collectHostText, findPressableByText, makeToolCall, makeToolViewProps, pressTestInstanceAsync } from '@/dev/testkit';
import { makeCompletedTool, normalizedHostText } from '../core/truncationView.testHelpers';
import {
    fileOpsRendererModuleState,
    installFileOpsRendererCommonModuleMocks,
    resetFileOpsRendererCommonModuleMockState,
} from './fileOpsRendererTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const reviewCommentsState = vi.hoisted(() => ({
    enabled: false,
    workspaceScope: null as null | { serverId: string; machineId: string; rootPath: string },
}));

resetFileOpsRendererCommonModuleMockState();
installFileOpsRendererCommonModuleMocks({
    storage: async (importOriginal) =>
        createPartialStorageModuleMock(importOriginal, {
            useSetting: () => true,
            useWorkspaceReviewCommentsDrafts: () => [],
            storage: {
                getState: () => ({
                    upsertWorkspaceReviewCommentDraft: () => undefined,
                    deleteWorkspaceReviewCommentDraft: () => undefined,
                    clearWorkspaceReviewCommentDrafts: () => undefined,
                }),
            },
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

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) =>
        featureId === 'files.reviewComments' ? reviewCommentsState.enabled : false,
}));

vi.mock('@/sync/domains/session/resolveWorkspaceScopeForSession', () => ({
    useWorkspaceScopeForSession: () => reviewCommentsState.workspaceScope,
}));

const codeLinesSpy = vi.fn();
const syntaxHookSpy = vi.fn();

function getUniqueCodeLinesViews() {
    const unique = new Map<string, Record<string, unknown>>();
    for (const [props] of codeLinesSpy.mock.calls) {
        const codeLineProps = props as Record<string, unknown>;
        const key = JSON.stringify(codeLineProps.lines ?? []);
        if (!unique.has(key)) unique.set(key, codeLineProps);
    }
    return [...unique.values()];
}

vi.mock('@/components/ui/code/view/CodeLinesView', () => ({
    CodeLinesView: (props: Record<string, unknown>) => {
        codeLinesSpy(props);
        return React.createElement('CodeLinesView', props);
    },
}));

vi.mock('@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting', () => ({
    useCodeLinesSyntaxHighlighting: (filePath: string | null) => {
        syntaxHookSpy(filePath);
        return {
            mode: 'simple',
            language: filePath?.endsWith('.txt') ? 'text' : 'typescript',
            maxBytes: 250_000,
            maxLines: 5_000,
            maxLineLength: 2_000,
        };
    },
}));

describe('PatchView', () => {
    beforeEach(() => {
        reviewCommentsState.enabled = false;
        reviewCommentsState.workspaceScope = null;
    });

    async function renderView(tool: ToolCall, detailLevel?: 'title' | 'summary' | 'full') {
        const { PatchView } = await import('./PatchView');
        return renderScreen(React.createElement(
                    PatchView,
                    makeToolViewProps(tool, { ...(detailLevel ? { detailLevel } : {}), sessionId: 'session-1' }),
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

    it('renders a compact diff list from Codex fileChange diffs in summary mode', async () => {
        codeLinesSpy.mockClear();
        syntaxHookSpy.mockClear();
        const screen = await renderView(
            makeCompletedTool(
                'Patch',
                {
                    changes: [
                        {
                            path: 'src/app.ts',
                            kind: { type: 'update', move_path: null },
                            diff: [
                                '--- a/src/app.ts',
                                '+++ b/src/app.ts',
                                '@@ -1 +1 @@',
                                '-old',
                                '+new',
                            ].join('\n'),
                        },
                    ],
                },
                { applied: true },
            ),
            'summary',
        );

        expect(getUniqueCodeLinesViews()).toHaveLength(0);
        expect(collectHostText(screen.tree).join(' ')).toContain('src/app.ts');

        const fileRow = findPressableByText(screen.tree, 'src/app.ts', ['Pressable']);
        expect(fileRow).toBeTruthy();

        await pressTestInstanceAsync(fileRow!, 'patch file row');

        expect(getUniqueCodeLinesViews()).toHaveLength(1);
        expect(syntaxHookSpy).toHaveBeenCalledWith('src/app.ts');
    });

    it('renders a diff preview when detailLevel=full', async () => {
        codeLinesSpy.mockClear();
        syntaxHookSpy.mockClear();
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

        expect(screen.findAllByType('ToolDiffView' as any)).toHaveLength(0);
        expect(getUniqueCodeLinesViews()).toHaveLength(1);
        expect(syntaxHookSpy).toHaveBeenCalledWith('/tmp/a.txt');
    });

    it('renders a diff preview in full mode using result.metadata.files before/after when input content is unavailable', async () => {
        codeLinesSpy.mockClear();
        syntaxHookSpy.mockClear();
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

        expect(screen.findAllByType('ToolDiffView' as any)).toHaveLength(0);
        expect(getUniqueCodeLinesViews()).toHaveLength(1);
        expect(syntaxHookSpy).toHaveBeenCalledWith('qa/opencode_permission_inside.txt');
    });

    it('renders text diff payloads when review comments are enabled', async () => {
        reviewCommentsState.enabled = true;
        reviewCommentsState.workspaceScope = {
            serverId: 'server-1',
            machineId: 'machine-1',
            rootPath: '/repo',
        };
        codeLinesSpy.mockClear();
        syntaxHookSpy.mockClear();

        await renderView(
            makeCompletedTool(
                'Patch',
                {
                    changes: {
                        'docs/plan.md': { type: 'add' },
                    },
                },
                {
                    metadata: {
                        files: [
                            {
                                relativePath: 'docs/plan.md',
                                before: '',
                                after: 'first\nsecond\n',
                            },
                        ],
                    },
                },
            ),
            'full',
        );

        expect(getUniqueCodeLinesViews()).toHaveLength(1);
        expect(syntaxHookSpy).toHaveBeenCalledWith('docs/plan.md');
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
