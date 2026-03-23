import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { pressTestInstance, renderScreen } from '@/dev/testkit';
import { t } from '@/text';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
            Platform: {
                OS: 'ios',
                select: (values: any) => values?.ios ?? values?.default,
            },
            View: (props: any) => React.createElement('View', props, props.children),
            Text: (props: any) => React.createElement('Text', props, props.children),
            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
            ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
            AppState: {
                currentState: 'active',
                addEventListener: () => ({ remove: () => {} }),
                removeEventListener: () => {},
            },
            useWindowDimensions: () => ({ width: 390, height: 700, scale: 2, fontScale: 2 }),
        }
    );
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

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                surface: '#fff',
                surfaceHigh: '#f5f5f5',
                divider: '#eee',
                text: '#111',
                textSecondary: '#666',
                shadow: { color: '#000', opacity: 0.1 },
            },
        },
    });
});

vi.mock('@expo/vector-icons', () => {
    const React = require('react');
    return { Ionicons: (props: any) => React.createElement('Ionicons', props) };
});

vi.mock('@/components/ui/text/Text', () => {
    const React = require('react');
    return { Text: (props: any) => React.createElement('Text', props, props.children) };
});

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
