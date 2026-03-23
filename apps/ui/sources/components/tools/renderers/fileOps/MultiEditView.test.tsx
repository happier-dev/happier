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

describe('MultiEditView', () => {
    function makeTool(overrides: Partial<ToolCall> = {}): ToolCall {
        return makeToolCall({
            name: 'MultiEdit',
            state: 'completed',
            input: {
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
                    makeToolViewProps(tool, detailLevel ? { detailLevel } : {}),
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
            showLineNumbers: false,
            showPlusMinusSymbols: false,
        });
        const renderedText = collectHostText(tree).join('\n').replace(/\s+/g, ' ');
        expect(renderedText).toContain('+2 more');
        expect(renderedText).not.toContain('Replace all');
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
