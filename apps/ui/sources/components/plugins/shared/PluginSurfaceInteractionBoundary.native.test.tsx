import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const nativeFocus = vi.hoisted(() => ({
    input: {},
    focusedInput: null as object | null,
    blurTextInput: vi.fn(),
    focusTextInput: vi.fn(),
    setAccessibilityFocus: vi.fn(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: any) => React.createElement('View', props, props.children),
        TextInput: {
            State: {
                currentlyFocusedInput: () => nativeFocus.focusedInput,
                blurTextInput: nativeFocus.blurTextInput,
                focusTextInput: nativeFocus.focusTextInput,
            },
        },
        AccessibilityInfo: {
            setAccessibilityFocus: nativeFocus.setAccessibilityFocus,
        },
    });
});

describe('PluginSurfaceInteractionBoundary.native', () => {
    it('keeps the snapshot mounted while native input and accessibility descendants are disabled', async () => {
        const { PluginSurfaceInteractionBoundary } = await import('./PluginSurfaceInteractionBoundary.native');
        const element = (enabled: boolean) => (
            <PluginSurfaceInteractionBoundary
                surfaceId="surface-native"
                snapshotTitle="Build summary"
                enabled={enabled}
            >
                <PluginNativeSnapshot testID="plugin-native-snapshot" />
            </PluginSurfaceInteractionBoundary>
        );
        const screen = await renderScreen(element(false));

        expect(screen.findByTestId('plugin-native-snapshot')).toBeTruthy();
        expect(screen.findByTestId('plugin-surface-snapshot:surface-native')?.props).toMatchObject({
            pointerEvents: 'none',
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants',
        });
        expect(screen.findByTestId('plugin-surface-offline-summary:surface-native')?.props).toMatchObject({
            accessible: true,
            accessibilityRole: 'summary',
            accessibilityLiveRegion: 'polite',
        });
        expect(
            screen.findByTestId('plugin-surface-offline-summary:surface-native')?.props.accessibilityLabel,
        ).toContain('Build summary');

        await screen.update(element(true));
        expect(screen.findByTestId('plugin-native-snapshot')).toBeTruthy();
        expect(screen.findByTestId('plugin-surface-snapshot:surface-native')?.props).toMatchObject({
            pointerEvents: 'auto',
            accessibilityElementsHidden: false,
            importantForAccessibility: 'auto',
        });
        expect(screen.findByTestId('plugin-surface-offline-summary:surface-native')).toBeNull();
    });

    it('blurs a captured native input offline and restores it only after re-enable', async () => {
        const { PluginSurfaceInteractionBoundary } = await import('./PluginSurfaceInteractionBoundary.native');
        const element = (enabled: boolean) => (
            <PluginSurfaceInteractionBoundary
                surfaceId="surface-native-focus"
                snapshotTitle="Build summary"
                enabled={enabled}
            >
                <PluginNativeSnapshot testID="plugin-native-focus-snapshot" />
            </PluginSurfaceInteractionBoundary>
        );
        nativeFocus.focusedInput = nativeFocus.input;
        const screen = await renderScreen(element(true));
        screen.findByTestId('plugin-surface-snapshot:surface-native-focus')?.props.onFocusCapture({
            nativeEvent: { target: 42 },
        });

        await screen.update(element(false));
        expect(nativeFocus.blurTextInput).toHaveBeenCalledWith(nativeFocus.input);
        expect(nativeFocus.focusTextInput).not.toHaveBeenCalled();

        await screen.update(element(true));
        expect(nativeFocus.focusTextInput).toHaveBeenCalledWith(nativeFocus.input);
        expect(nativeFocus.setAccessibilityFocus).not.toHaveBeenCalled();
        expect(screen.findByTestId('plugin-native-focus-snapshot')).toBeTruthy();
    });
});

function PluginNativeSnapshot(props: Readonly<{ testID: string }>): React.ReactElement {
    return React.createElement('PluginNativeSnapshot', props);
}
