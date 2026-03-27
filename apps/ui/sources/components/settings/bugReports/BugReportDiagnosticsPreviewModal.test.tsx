import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { pressTestInstance, renderScreen } from '@/dev/testkit';
import { installBugReportComponentCommonModuleMocks } from './bugReportComponentTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installBugReportComponentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: (values: any) => values?.ios ?? values?.default,
            },
            useWindowDimensions: () => ({ width: 390, height: 700, scale: 2, fontScale: 2 }),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, params?: Record<string, unknown>) =>
                key === 'common.back'
                    ? 'Back'
                    : key === 'common.close'
                        ? 'Close'
                        : key === 'bugReports.composer.diagnostics.preview.openArtifactA11y' && typeof params?.filename === 'string'
                            ? `Open ${params.filename}`
                            : key,
        });
    },
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 20, bottom: 20, left: 0, right: 0 }),
}));

describe('BugReportDiagnosticsPreviewModal', () => {
    it('sets card chrome to use a fixed-height layout so the scroll body can measure', async () => {
        const { BugReportDiagnosticsPreviewModal } = await import('./BugReportDiagnosticsPreviewModal');

        const onClose = vi.fn();
        const setChrome = vi.fn();
        const artifacts = [
            {
                filename: 'app-context.json',
                sourceKind: 'ui-mobile',
                contentType: 'application/json',
                sizeBytes: 10,
                content: '{"hello":"world"}',
            },
        ];

        await renderScreen(
            <BugReportDiagnosticsPreviewModal artifacts={artifacts} onClose={onClose} setChrome={setChrome} />,
        );

        expect(setChrome).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'card',
                layout: 'fill',
            }),
        );
    });

    it('drills into an artifact and shows its content', async () => {
        const { BugReportDiagnosticsPreviewModal } = await import('./BugReportDiagnosticsPreviewModal');

        const onClose = vi.fn();
        const setChrome = vi.fn();
        const artifacts = [
            {
                filename: 'app-context.json',
                sourceKind: 'ui-mobile',
                contentType: 'application/json',
                sizeBytes: 10,
                content: '{"hello":"world"}',
            },
        ];

        const screen = await renderScreen(
            <BugReportDiagnosticsPreviewModal artifacts={artifacts} onClose={onClose} setChrome={setChrome} />,
        );

        const artifactButton = screen.find((node) => (
            node.props?.accessibilityRole === 'button'
            && String(node.props?.accessibilityLabel ?? '').includes(artifacts[0]!.filename)
        ));

        act(() => {
            pressTestInstance(artifactButton, 'artifact row');
        });

        const textContent = screen.getTextContent();
        expect(textContent).toContain('{"hello":"world"}');

        const nextChrome = setChrome.mock.calls.at(-1)?.[0];
        expect(nextChrome).toEqual(
            expect.objectContaining({
                kind: 'card',
                title: 'app-context.json',
            }),
        );
    });
});
