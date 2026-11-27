import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mockThemeDark = false;
let mockThemeName = 'light';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    const base = await createUnistylesMock();
    return {
        ...base,
        useUnistyles: () => ({
            ...base.useUnistyles(),
            theme: { ...base.useUnistyles().theme, dark: mockThemeDark },
            rt: { ...base.useUnistyles().rt, themeName: mockThemeName },
        }),
    };
});

vi.mock('@/components/ui/media/SafeExpoImage', () => ({
    SafeExpoImage: (props: Record<string, unknown>) => React.createElement('SafeExpoImage', props),
}));

const { HeaderLogo } = await import('./HeaderLogo');

describe('HeaderLogo', () => {
    it('selects the light mark from theme.dark even when rt.themeName does not equal dark', async () => {
        mockThemeDark = true;
        mockThemeName = 'custom-dark';
        const darkScreen = await renderScreen(<HeaderLogo size={20} />);
        const darkImage = darkScreen.root.findByType('SafeExpoImage' as never);
        expect(String(darkImage.props.source)).toContain('logo-white.png');

        mockThemeDark = false;
        mockThemeName = 'light';
        const lightScreen = await renderScreen(<HeaderLogo size={20} />);
        const lightImage = lightScreen.root.findByType('SafeExpoImage' as never);
        expect(String(lightImage.props.source)).toContain('logo-black.png');
    });
});
