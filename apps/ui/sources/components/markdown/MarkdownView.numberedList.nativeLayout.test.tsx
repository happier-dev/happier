import React from 'react';
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

    it('routes numbered list prose to the enriched renderer on native', async () => {
        mockPlatform('ios');
        const { MarkdownView } = await import('./MarkdownView');

        const markdown = [
            '1. The notification type drop down does not appear on mobile for editing templates.',
            '2. The preview for gpu_indices is lacking the [].',
        ].join('\n');
        const screen = await renderScreen(<MarkdownView markdown={markdown} />);

        const enrichedRun = screen.findByType('EnrichedMarkdownText');
        expect(enrichedRun.props.markdown).toBe(markdown);
        expect(screen.findAll((node) => node.props?.testID === 'markdown-list-item-row')).toHaveLength(0);
    }, 60_000);
});
