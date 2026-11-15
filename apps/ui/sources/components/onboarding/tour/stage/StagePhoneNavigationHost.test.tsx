// @vitest-environment jsdom
import * as React from 'react';
import { View } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from '@/components/ui/lists/uiListsTestHelpers';

installUiListsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        // The host renderer has no native animated text; keep the real navigator and header.
        return createReactNativeWebMock({ Animated: { Text: 'Animated.Text' } });
    },
});
// This regression needs the installed navigator's route lifecycle, not the global SDK port.
vi.unmock('@react-navigation/native');

const { StagePhoneNavigationHost } = await import('./StagePhoneNavigationHost');

describe('StagePhoneNavigationHost', () => {
    afterEach(standardCleanup);

    it('returns to the previous route when the specimen Back control is pressed', async () => {
        const screen = await renderScreen(
            <SafeAreaInsetsContext.Provider value={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                <StagePhoneNavigationHost surface="deployments">
                    <View testID="stage-capture-content" />
                </StagePhoneNavigationHost>
            </SafeAreaInsetsContext.Provider>,
        );

        expect(screen.findAllByTestId('stage-capture-content')).toHaveLength(1);
        await screen.pressByTestIdAsync('demo-stage-phone-back');
        expect(screen.findAllByTestId('stage-capture-content')).toHaveLength(0);
    });
});
