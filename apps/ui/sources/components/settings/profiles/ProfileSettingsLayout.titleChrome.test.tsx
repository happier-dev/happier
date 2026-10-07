import * as React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ pathname: '/settings/profiles/default-environment' }).module;
    },
    // The settings read, collection and child-route resolver stay real. Only their
    // platform/locale/navigation boundaries use the shared harness above.
    storage: (importOriginal) => importOriginal(),
});

const { getStorage } = await import('@/sync/domains/state/storage');
const { ProfileSettingsLayout } = await import('./ProfileSettingsLayout');
const { ProfileDefaultEnvironmentScreen } = await import('./ProfileDefaultEnvironmentScreen');
const { NavigationTitleChromeProvider } = await import('@/components/ui/layout/PageHeader');

describe('Profiles phone title ownership', () => {
    beforeEach(() => {
        getStorage().getState().applySettingsLocal({ useProfiles: false });
    });

    it('titles the active child through the collection chrome even when profiles are disabled', async () => {
        const screen = await renderScreen(<ProfileSettingsLayout />);
        const activeHeader = screen.root.findAll((node) =>
            node.type === ('StackScreen' as never) && node.props.options !== undefined,
        )[0];
        expect(activeHeader?.props.options).toMatchObject({ headerTitle: 'profiles.noProfile' });
    });

    it('keeps the default-environment purpose and controls while navigation owns its title', async () => {
        const screen = await renderScreen(
            <NavigationTitleChromeProvider showsTitle>
                <ProfileDefaultEnvironmentScreen />
            </NavigationTitleChromeProvider>,
        );
        const headings = screen.root.findAll((node) =>
            typeof node.type === 'string' && node.props.accessibilityRole === 'header',
        ).map((node) => node.props.children);
        expect(headings.filter((heading) => heading === 'profiles.noProfile')).toHaveLength(0);
        expect(screen.findAllByProps({ children: 'profiles.noProfileDescription' }).length).toBeGreaterThan(0);
        expect(screen.findByTestId('settings.profiles.defaultEnvironment.favorite')).not.toBeNull();
    });
});
