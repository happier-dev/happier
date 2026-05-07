import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { ProfilesList } from '@/components/profiles/ProfilesList';

vi.mock('react-native', async () => {
    const { createPassThroughComponent } = await import('@/dev/testkit/mocks/components');
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: createPassThroughComponent('View'),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                groupped: { background: '#f5f5f5' },
            },
        },
    });
});

vi.mock('@/components/profiles/ProfilesList', () => ({
    ProfilesList: () => React.createElement('ProfilesList'),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('NewSessionProfileChipPopoverContent', () => {
    it('uses an explicit height for the bounded profile list so flex scroll content can measure on native', async () => {
        const { NewSessionProfileChipPopoverContent } = await import('./NewSessionProfileChipPopoverContent');

        const screen = await renderScreen(
            <NewSessionProfileChipPopoverContent
                maxHeight={480}
                profilesListProps={{} as React.ComponentProps<typeof ProfilesList>}
            />,
        );

        const container = screen.findAllByType('View' as never)[0];
        expect(container?.props.style).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    height: 480,
                    maxHeight: 480,
                }),
            ]),
        );
    });
});
