import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: any) => React.createElement('View', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

describe('PluginReactNativeSurface', () => {
    it('uses fallback instead of loading when compatibility does not allow RN execution', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const load = vi.fn();

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            decision={{ state: 'fallback', reason: 'channel_policy_denied', diagnostics: [], fallback: { kind: 'hostedWeb', contributionId: 'web' } }}
            load={load}
        />);

        expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
        expect(load).not.toHaveBeenCalled();
    });

    it('renders a compatible loaded module through the boundary', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            module={{
                renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }),
            }}
        />);

        expect(screen.findByTestId('plugin-native-surface')).toBeTruthy();
    });
});
