import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ View: 'View', Pressable: 'Pressable' });
});
vi.mock('@/components/ui/text/Text', () => ({ Text: 'Text' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));

const theme = {
    colors: {
        border: { default: '#ddd' },
        surface: { inset: '#eee', base: '#fff' },
        text: { primary: '#111' },
    },
};

describe('ChangedFilesReviewDiffAreaSelector', () => {
    it('keeps a trailing contextual action visible when there is only one diff area', async () => {
        const { ChangedFilesReviewDiffAreaSelector } = await import('./ChangedFilesReviewDiffAreaSelector');
        const screen = await renderScreen(
            <ChangedFilesReviewDiffAreaSelector
                theme={theme}
                diffArea="pending"
                availableModes={['pending']}
                labels={{ pending: 'Pending', included: 'Included', both: 'Both' }}
                onChange={() => {}}
                trailingElement={React.createElement('TrailingAction')}
            />,
        );

        expect(screen.findAllByType('TrailingAction' as never)).toHaveLength(1);
        expect(screen.findAllByType('Pressable' as never)).toHaveLength(0);
    });
});
