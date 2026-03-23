import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import renderer from 'react-test-renderer';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import { createPartialStorageModuleMock, renderScreen } from '@/dev/testkit';
import { collectHostText, makeToolCall, makeToolViewProps } from '@/dev/testkit';
import {
    fileOpsRendererModuleState,
    installFileOpsRendererCommonModuleMocks,
} from './fileOpsRendererTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installFileOpsRendererCommonModuleMocks({
    storage: async (importOriginal) =>
        await createPartialStorageModuleMock(importOriginal, {
            useSetting: (key: string) => {
                if (key === 'showLineNumbersInToolViews') return false;
                return undefined;
            },
        }),
});

beforeEach(() => {
    fileOpsRendererModuleState.toolDiffSpy.mockClear();
});

describe('WriteView', () => {
    function makeTool(overrides: Partial<ToolCall> = {}): ToolCall {
        return makeToolCall({
            name: 'Write',
            state: 'completed',
            input: { file_path: '/tmp/a.txt', content: Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n') },
            result: null,
            ...overrides,
        });
    }

    async function renderView(tool: ToolCall, detailLevel?: 'title' | 'summary' | 'full') {
        const { WriteView } = await import('./WriteView');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(
                    WriteView,
                    makeToolViewProps(tool, detailLevel ? { detailLevel } : {}),
                ))).tree;
        return tree;
    }

    it('truncates long writes by default', async () => {
        await renderView(makeTool());

        expect(fileOpsRendererModuleState.toolDiffSpy).toHaveBeenCalledTimes(1);
        const last = fileOpsRendererModuleState.toolDiffSpy.mock.calls.at(-1)?.[0];
        expect(last.filePath).toBe('/tmp/a.txt');
        expect(last.newText).toContain('line-0');
        expect(last.newText).toContain('line-19');
        expect(last.newText).not.toContain('line-20');
        expect(last.showLineNumbers).toBe(false);
        expect(last.showPlusMinusSymbols).toBe(false);
    });

    it('shows substantially more content when detailLevel=full', async () => {
        await renderView(makeTool(), 'full');

        expect(fileOpsRendererModuleState.toolDiffSpy).toHaveBeenCalledTimes(1);
        const last = fileOpsRendererModuleState.toolDiffSpy.mock.calls.at(-1)?.[0];
        expect(last.newText).toContain('line-0');
        expect(last.newText).toContain('line-99');
        expect(last.showLineNumbers).toBe(true);
        expect(last.showPlusMinusSymbols).toBe(true);
    });

    it('renders a one-line preview when detailLevel=title', async () => {
        const tree = await renderView(
            makeTool({ input: { file_path: '/tmp/a.txt', content: Array.from({ length: 10 }, (_, i) => `line-${i}`).join('\n') } }),
            'title',
        );

        expect(fileOpsRendererModuleState.toolDiffSpy).toHaveBeenCalledTimes(0);
        expect(collectHostText(tree).join(' ')).toContain('line-0');
    });

    it('falls back to placeholder content when input schema is malformed', async () => {
        await renderView(makeTool({ input: { file_path: '/tmp/a.txt', content: 123 } }));

        expect(fileOpsRendererModuleState.toolDiffSpy).toHaveBeenCalledTimes(1);
        const last = fileOpsRendererModuleState.toolDiffSpy.mock.calls.at(-1)?.[0];
        expect(last.newText).toContain('<no contents>');
    });
});
