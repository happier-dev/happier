import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer from 'react-test-renderer';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { collectHostText, makeToolCall, makeToolViewProps } from '@/dev/testkit';
import { renderScreen } from '@/dev/testkit';
import {
    fileOpsRendererModuleState,
    installFileOpsRendererCommonModuleMocks,
    resetFileOpsRendererCommonModuleMockState,
} from './fileOpsRendererTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

resetFileOpsRendererCommonModuleMockState();
installFileOpsRendererCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key, params) => {
                if (key === 'tools.common.more' && typeof params?.count === 'number') {
                    return `+${params.count} more`;
                }
                if (key === 'tools.multiEdit.editNumber' && typeof params?.index === 'number' && typeof params?.total === 'number') {
                    return `Edit ${params.index}/${params.total}`;
                }
                if (key === 'tools.multiEdit.replaceAll') {
                    return 'Replace all';
                }
                return key;
            },
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: (key: string) => {
                if (key === 'showLineNumbersInToolViews') return false;
                return undefined;
            },
        });
    },
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

describe('MultiEditView', () => {
    function makeTool(overrides: Partial<ToolCall> = {}): ToolCall {
        return makeToolCall({
            name: 'MultiEdit',
            state: 'completed',
            input: {
                file_path: '/tmp/a.txt',
                edits: [
                    { old_string: 'a', new_string: 'b' },
                    { old_string: 'c', new_string: 'd', replace_all: true },
                    { old_string: 'e', new_string: 'f' },
                ],
            },
            result: null,
            ...overrides,
        });
    }

    async function renderView(tool: ToolCall, detailLevel?: 'title' | 'summary' | 'full') {
        const { MultiEditView } = await import('./MultiEditView');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(
                    MultiEditView,
                    makeToolViewProps(tool, { ...(detailLevel ? { detailLevel } : {}), sessionId: 'session-1' }),
                ))).tree;
        return tree;
    }

    it('renders a compact summary by default (first edit only)', async () => {
        fileOpsRendererModuleState.toolDiffSpy.mockClear();
        const tree = await renderView(makeTool());

        expect(fileOpsRendererModuleState.toolDiffSpy).toHaveBeenCalledTimes(1);
        expect(fileOpsRendererModuleState.toolDiffSpy.mock.calls[0]?.[0]).toMatchObject({
            oldText: 'a',
            newText: 'b',
            filePath: '/tmp/a.txt',
            sessionId: 'session-1',
            showLineNumbers: false,
            showPlusMinusSymbols: false,
        });
        const renderedText = collectHostText(tree).join('\n').replace(/\s+/g, ' ');
        expect(renderedText).toContain('+2 more');
        expect(renderedText).not.toContain('Replace all');
    });

    it('does not force flex sizing around inline edit diffs', async () => {
        const tree = await renderView(makeTool());

        const flexContainers = tree.root.findAllByType('View' as any).filter((node) => (
            flattenStyle(node.props.style).flex === 1
        ));
        expect(flexContainers).toHaveLength(0);
    });

    it('renders all edits with headers when detailLevel=full', async () => {
        fileOpsRendererModuleState.toolDiffSpy.mockClear();
        const tree = await renderView(makeTool(), 'full');

        expect(fileOpsRendererModuleState.toolDiffSpy).toHaveBeenCalledTimes(3);
        expect(fileOpsRendererModuleState.toolDiffSpy.mock.calls[0]?.[0]).toMatchObject({
            oldText: 'a',
            newText: 'b',
            showLineNumbers: true,
            showPlusMinusSymbols: true,
        });
        const renderedText = collectHostText(tree).join('\n').replace(/\s+/g, ' ');
        expect(renderedText).toContain('Edit 1/3');
        expect(renderedText).toContain('Edit 2/3');
        expect(renderedText).toContain('Replace all');
        expect(renderedText).not.toContain('+2 more');
    });
});
