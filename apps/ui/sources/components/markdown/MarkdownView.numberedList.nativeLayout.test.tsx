import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./MermaidRenderer', () => ({
    MermaidRenderer: () => null,
}));

vi.mock('../ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: (props: any) => React.createElement('TextInput', props, props.children),
    TextSelectabilityScope: (props: any) => props.children,
}));

vi.mock('./MarkdownSpansView', () => ({
    MarkdownSpansView: ({ spans }: { spans: Array<{ text: string }> }) =>
        React.createElement(
            React.Fragment,
            null,
            spans.map((span, index) => React.createElement('Text', { key: index }, span.text)),
        ),
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const visit = (node: unknown) => {
        if (!node) return;
        if (Array.isArray(node)) {
            for (const child of node) visit(child);
            return;
        }
        if (typeof node === 'object') Object.assign(out, node);
    };
    visit(style);
    return out;
}

function mockPlatform(os: 'ios' | 'web') {
    installMarkdownCommonModuleMocks({
        reactNative: async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock({
                Platform: {
                    OS: os,
                },
            });
        },
    });
}

describe('MarkdownView (native numbered lists)', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('uses shrink-wrap-safe row styles on native so user bubbles do not collapse to markers', async () => {
        mockPlatform('ios');
        const { MarkdownView } = await import('./MarkdownView');

        let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
        try {
            screen = await renderScreen(
                <MarkdownView
                    markdown={[
                        '1. The notification type drop down does not appear on mobile for editing templates.',
                        '2. The preview for gpu_indices is lacking the [].',
                    ].join('\n')}
                />,
            );

            const rows = screen.findAll((node) => node.props?.testID === 'markdown-list-item-row');
            expect(rows).toHaveLength(2);

            const markers = rows.map((row) =>
                row.findAll((node) => node.props?.testID === 'markdown-list-item-marker')[0],
            );
            expect(markers.map((node) => React.Children.toArray(node.props.children).join(''))).toEqual(['1.', '2.']);

            expect(rows.every((row) => flattenStyle(row.props.style).width === '100%')).toBe(true);

            const contentColumns = rows.map((row) =>
                row.findAll((node) => {
                    if (node === row) return false;
                    const flatStyle = flattenStyle(node.props?.style);
                    return flatStyle.minWidth === 0;
                })[0],
            );
            expect(contentColumns).toHaveLength(2);
            expect(contentColumns.every(Boolean)).toBe(true);
            expect(flattenStyle(contentColumns[0]?.props.style)).toMatchObject({
                flexShrink: 1,
                minWidth: 0,
                maxWidth: '100%',
            });
            expect(flattenStyle(contentColumns[0]?.props.style).flex).toBeUndefined();
        } finally {
            act(() => {
                screen?.tree.unmount();
            });
        }
    }, 60_000);
});
