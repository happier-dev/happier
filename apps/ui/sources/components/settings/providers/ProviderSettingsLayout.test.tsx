import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { Text } from '@/components/ui/text/Text';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({
    storage: importOriginal => importOriginal(),
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/settings/providers' }).module,
    reactNative: async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
        useWindowDimensions: () => ({ width: 1200, height: 800, scale: 1, fontScale: 1 }),
    }),
});
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());

afterEach(standardCleanup);

const { ProviderCollectionPane, ProviderSettingsLayout, useClaimProviderCollectionPane } = await import('./ProviderSettingsLayout');

it('shows the provider rail beside the detail while nothing claims the pane', async () => {
    const screen = await renderScreen(<ProviderSettingsLayout />);
    await act(async () => {
        screen.findHostByTestId('settings-providers-layout')!.props.onLayout({
            nativeEvent: { layout: { width: 1200, height: 800, x: 0, y: 0 } },
        });
    });
    // The rail lists Account connections; it no longer waits for a machine to exist.
    expect(screen.findByTestId('settings-providers-screen')).not.toBeNull();
});

function Landing(props: Readonly<{ claimed: boolean }>) {
    useClaimProviderCollectionPane(props.claimed);
    return null;
}

it('gives the whole pane to a landing that shows a page state, and takes it back when it leaves', async () => {
    const render = (landing: React.ReactNode) => (
        <ProviderCollectionPane>
            {(owned) => (
                <>
                    <Text testID={owned ? 'pane.owned' : 'pane.shared'}>pane</Text>
                    {landing}
                </>
            )}
        </ProviderCollectionPane>
    );
    const screen = await renderScreen(render(<Landing claimed />));
    expect(screen.findHostByTestId('pane.owned')).not.toBeNull();
    await screen.update(render(<Landing claimed={false} />));
    expect(screen.findHostByTestId('pane.shared')).not.toBeNull();
    await screen.update(render(<Landing claimed />));
    expect(screen.findHostByTestId('pane.owned')).not.toBeNull();
    await screen.update(render(null));
    expect(screen.findHostByTestId('pane.shared')).not.toBeNull();
});
