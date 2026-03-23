import React from 'react';
import { describe, expect, it } from 'vitest';

import { makeToolCall, makeToolViewProps } from '@/dev/testkit';
import { renderScreen } from '@/dev/testkit';
import {
    fileOpsRendererModuleState,
    installFileOpsRendererCommonModuleMocks,
} from './fileOpsRendererTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installFileOpsRendererCommonModuleMocks({
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

describe('EditView', () => {
    it('truncates long edit strings by default', async () => {
        fileOpsRendererModuleState.toolDiffSpy.mockClear();
        const { EditView } = await import('./EditView');

        const longText = Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\n');
        const tool = makeToolCall({
            name: 'Edit',
            state: 'completed',
            input: { old_string: longText, new_string: longText },
            result: null,
        });

        await renderScreen(React.createElement(EditView, makeToolViewProps(tool)));

        expect(fileOpsRendererModuleState.toolDiffSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                showLineNumbers: false,
                showPlusMinusSymbols: false,
            })
        );
        expect(fileOpsRendererModuleState.toolDiffSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                oldText: Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n'),
                newText: Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n'),
            })
        );
    });

    it('passes filePath to ToolDiffView when present in input', async () => {
        fileOpsRendererModuleState.toolDiffSpy.mockClear();
        const { EditView } = await import('./EditView');

        const tool = makeToolCall({
            name: 'Edit',
            state: 'completed',
            input: { file_path: '/tmp/a.ts', old_string: 'const x = 1', new_string: 'const x = 2' },
            result: null,
        });

        await renderScreen(React.createElement(EditView, makeToolViewProps(tool)));

        expect(fileOpsRendererModuleState.toolDiffSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                filePath: '/tmp/a.ts',
            }),
        );
    });

    it('shows full edit content when detailLevel=full', async () => {
        fileOpsRendererModuleState.toolDiffSpy.mockClear();
        const { EditView } = await import('./EditView');

        const longText = Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\n');
        const tool = makeToolCall({
            name: 'Edit',
            state: 'completed',
            input: { old_string: longText, new_string: longText },
            result: null,
        });

        await renderScreen(React.createElement(EditView, makeToolViewProps(tool, { detailLevel: 'full' })));

        expect(fileOpsRendererModuleState.toolDiffSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                showLineNumbers: true,
                showPlusMinusSymbols: true,
                oldText: longText,
                newText: longText,
            })
        );
    });
});
