// @vitest-environment jsdom
import * as React from 'react';
import { NavigationContainer, useNavigation } from '@react-navigation/native';
import { SafeAreaProviderCompat, Screen } from '@react-navigation/elements';
import { Pressable, View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';

vi.unmock('@react-navigation/native');

function Subject({ transparent }: { transparent: boolean }) {
    const navigation = useNavigation();
    return (
        <SafeAreaProviderCompat>
            <Screen
                focused
                navigation={navigation}
                route={{ key: 'home', name: 'home' }}
                headerTransparent={transparent}
                header={<Pressable testID="header-control" />}
            >
                <Pressable testID="content-control" />
            </Screen>
        </SafeAreaProviderCompat>
    );
}

describe('installed navigation Screen header hit testing', () => {
    // The host renderer has no native/browser hit testing. Assert the actual
    // wrapper's platform contract; loaded-browser QA verifies pointer delivery.
    it.each([true, false])('passes through only a transparent header (%s)', async (transparent) => {
        const screen = await renderScreen(
            <NavigationContainer><Subject transparent={transparent} /></NavigationContainer>,
        );
        try {
            const control = screen.findByTestId('header-control');
            expect(control).not.toBeNull();
            let innerHeader = control!.parent;
            while (innerHeader && innerHeader.type !== View) innerHeader = innerHeader.parent;
            expect(innerHeader?.type).toBe(View);
            expect(innerHeader?.props.pointerEvents).toBe('box-none');
            let outerHeader = innerHeader?.parent;
            while (outerHeader && outerHeader.type !== View) outerHeader = outerHeader.parent;
            expect(outerHeader?.type).toBe(View);
            expect(outerHeader?.props.pointerEvents).toBe(transparent ? 'box-none' : undefined);
            expect(screen.findByTestId('content-control')).not.toBeNull();
        } finally {
            await screen.unmount();
        }
    });
});
