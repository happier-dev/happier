import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props),
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                textSecondary: '#6c6c70',
            },
        },
    });
});

const ImageMock = 'Image' as unknown as React.ComponentType<{ tintColor?: string }>;

describe('AvatarGradient', () => {
    it('tints the legacy gradient image when monochrome is requested', async () => {
        const { AvatarGradient } = await import('./AvatarGradient');

        const screen = await renderScreen(<AvatarGradient id="session-inactive-gradient" monochrome={true} />);
        const image = screen.findAllByType(ImageMock)[0];

        expect(image.props.tintColor).toBe('#6c6c70');
    });
});
