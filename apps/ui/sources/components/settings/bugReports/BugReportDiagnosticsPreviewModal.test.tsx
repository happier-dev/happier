import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { pressTestInstance, renderScreen } from '@/dev/testkit';
import { t } from '@/text';
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

function findStyleValue(style: any, key: string) {
  const list = Array.isArray(style) ? style : [style];
  for (const entry of list) {
    if (entry && typeof entry === 'object' && key in entry) return (entry as any)[key];
  }
  return undefined;
}

describe('BugReportDiagnosticsPreviewModal', () => {
    it('sets an explicit height so the scroll body can measure on native', async () => {
        const { BugReportDiagnosticsPreviewModal } = await import('./BugReportDiagnosticsPreviewModal');

        const onClose = vi.fn();
        const artifacts = [
            {
                filename: 'app-context.json',
                sourceKind: 'ui-mobile',
                contentType: 'application/json',
                sizeBytes: 10,
                content: '{"hello":"world"}',
            },
        ];

        const screen = await renderScreen(<BugReportDiagnosticsPreviewModal artifacts={artifacts as any} onClose={onClose} />);

        // window.height=700, insets top+bottom=40, extra padding=96 => 564
        const expected = 564;
        const rootView = screen.find((node) => {
            const style = node.props?.style;
            return findStyleValue(style, 'height') === expected && findStyleValue(style, 'maxHeight') === expected;
        });
        expect(findStyleValue(rootView.props.style, 'height')).toBe(expected);
        expect(findStyleValue(rootView.props.style, 'maxHeight')).toBe(expected);
    });

    it('drills into an artifact and shows its content', async () => {
        const { BugReportDiagnosticsPreviewModal } = await import('./BugReportDiagnosticsPreviewModal');

        const onClose = vi.fn();
        const artifacts = [
            {
                filename: 'app-context.json',
                sourceKind: 'ui-mobile',
                contentType: 'application/json',
                sizeBytes: 10,
                content: '{"hello":"world"}',
            },
        ];

        const screen = await renderScreen(<BugReportDiagnosticsPreviewModal artifacts={artifacts as any} onClose={onClose} />);

        const artifactButton = screen.find((node) => (
            node.props?.accessibilityRole === 'button'
            && String(node.props?.accessibilityLabel ?? '').includes(artifacts[0]!.filename)
        ));

        act(() => {
            pressTestInstance(artifactButton, 'artifact row');
        });

        const textContent = screen.getTextContent();
        expect(screen.findByProps({ accessibilityLabel: t('common.back') })).toBeTruthy();
        expect(textContent).toContain('app-context.json');
        expect(textContent).toContain('{"hello":"world"}');
    });
});
