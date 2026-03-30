import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { installMediaCommonModuleMocks } from './mediaTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const codeBlockSpy = vi.fn();

vi.mock('@/components/ui/code/blocks/CodeBlockView', () => ({
    CodeBlockView: (props: any) => {
        codeBlockSpy(props);
        return React.createElement('CodeBlockView', props);
    },
}));

const useSettingSpy = vi.fn((key: string): number | null => {
    if (key === 'filesCodeViewJsonInferenceMaxBytes') return 50_000;
    return null;
});

installMediaCommonModuleMocks({
    storage: async () => createStorageModuleStub({
        useSetting: (key: string) => useSettingSpy(key),
    }),
});

describe('CodeView', () => {
    it('renders CodeBlockView with the provided code and language', async () => {
        codeBlockSpy.mockClear();
        const { CodeView } = await import('./CodeView');

        await renderScreen(React.createElement(CodeView, { code: '{"ok":true}', language: 'json' }));

        expect(codeBlockSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                code: '{"ok":true}',
                language: 'json',
            }),
        );
    });

    it('infers json language for JSON-looking blocks when language is omitted', async () => {
        codeBlockSpy.mockClear();
        useSettingSpy.mockClear();
        const { CodeView } = await import('./CodeView');

        await renderScreen(React.createElement(CodeView, { code: JSON.stringify({ ok: true }, null, 2) }));

        expect(codeBlockSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                language: 'json',
            }),
        );
    });

    it('skips JSON.parse inference when code exceeds the configured max bytes', async () => {
        codeBlockSpy.mockClear();
        useSettingSpy.mockImplementation((key: string) => {
            if (key === 'filesCodeViewJsonInferenceMaxBytes') return 10;
            return null;
        });

        const parseSpy = vi.spyOn(JSON, 'parse');
        parseSpy.mockImplementation(() => {
            throw new Error('should_not_parse');
        });

        const { CodeView } = await import('./CodeView');
        const bigJsonLike = `{${'a'.repeat(100)}}`;

        await renderScreen(React.createElement(CodeView, { code: bigJsonLike }));

        expect(parseSpy).toHaveBeenCalledTimes(0);
        expect(codeBlockSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                language: null,
            }),
        );

        parseSpy.mockRestore();
    });
});
