import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { collectUnexpectedRawTextNodes, renderScreen } from '@/dev/testkit';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    View: 'View',
                    Platform: {
                        OS: 'web',
                        select: (values: any) => values?.default ?? values?.web ?? values?.ios ?? values?.android,
                    },
                }
    );
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: () => <>{'.'}</>,
}));

describe('ScrollEdgeIndicators', () => {
    it('does not emit raw period text nodes under non-Text parents', async () => {
        const { ScrollEdgeIndicators } = await import('./ScrollEdgeIndicators');

        const screen = await renderScreen(
            <ScrollEdgeIndicators
                edges={{ bottom: true }}
                color="#999"
            />,
        );

        expect(collectUnexpectedRawTextNodes(screen.tree.toJSON())).toEqual([]);
    });
});
