import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'ios', select: (spec: any) => spec?.ios ?? spec?.default },
    });
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'files.diffSyntaxHighlighting' || featureId === 'files.syntaxHighlighting.advanced',
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSetting: (key: string) => {
                if (key === 'filesDiffSyntaxHighlightingMode') return 'simple';
                if (key === 'filesDiffTokenizationMaxBytes') return 100_000;
                if (key === 'filesDiffTokenizationMaxLines') return 5_000;
                if (key === 'filesDiffTokenizationMaxLineLength') return 1_000;
                return null;
            },
        },
    });
});

vi.mock('@/utils/code/fileLanguage', () => ({
    getFileLanguageFromPath: (path: string) => path.endsWith('.ts') ? 'typescript' : null,
}));

describe('useCodeSyntaxHighlighting', () => {
    it('keeps equivalent syntax highlighting config referentially stable', async () => {
        const { useCodeSyntaxHighlighting } = await import('./useCodeSyntaxHighlighting');

        let latestConfig: ReturnType<typeof useCodeSyntaxHighlighting> | null = null;

        function Harness(props: Readonly<{ filePath: string }>) {
            latestConfig = useCodeSyntaxHighlighting({ filePath: props.filePath });
            return null;
        }

        const screen = await renderScreen(<Harness filePath="src/a.ts" />);
        const firstConfig = latestConfig;
        expect(firstConfig).not.toBeNull();

        await act(async () => {
            screen.tree.update(<Harness filePath="src/a.ts" />);
        });

        expect(latestConfig).toBe(firstConfig);
    });
});
