import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StyleSheet } from 'react-native';
import { KeyboardStickyFooter } from '@/components/ui/keyboardAvoidance/KeyboardStickyFooter';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { SessionCockpitBottomChromeHeightContext } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));

const { FloatingChromeClearedFrame } = await import('./FloatingChromeClearedFrame');

afterEach(() => standardCleanup());

describe('FloatingChromeClearedFrame', () => {
    it('clears the floating chrome once for a page whose pinned footer sits inside it', async () => {
        // A pushed detail's footer inside a page frame that already stops above the bar and a dock (D17): the footer
        // must not reserve them again, or its padding swallows the story above it.
        const screen = await renderScreen(
            <SessionCockpitBottomChromeHeightContext.Provider value={84}>
                <FloatingChromeClearedFrame testID="frame">
                    <KeyboardStickyFooter testID="sticky" style={{ paddingVertical: 12 }} />
                </FloatingChromeClearedFrame>
            </SessionCockpitBottomChromeHeightContext.Provider>,
        );
        expect(StyleSheet.flatten(screen.findByTestId('frame')!.props.style).paddingBottom).toBe(84);
        const sticky = StyleSheet.flatten(screen.findByTestId('sticky')!.props.style);
        expect(sticky.paddingBottom ?? sticky.paddingVertical).toBe(12);
    });

    it('adds nothing where no chrome floats over the page', async () => {
        const screen = await renderScreen(<FloatingChromeClearedFrame testID="frame" />);
        expect(StyleSheet.flatten(screen.findByTestId('frame')!.props.style)?.paddingBottom ?? 0).toBe(0);
    });
});
