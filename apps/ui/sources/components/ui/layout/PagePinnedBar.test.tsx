import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StyleSheet, View } from 'react-native';
import { KeyboardStickyFooter } from '@/components/ui/keyboardAvoidance/KeyboardStickyFooter';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { ModalBoundaryProvider } from '@/modal/context/ModalBoundaryContext';
import { SessionCockpitBottomChromeHeightContext } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const boundary = vi.hoisted(() => ({ platform: 'web' }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Platform: { get OS() { return boundary.platform; }, select: (values: Record<string, unknown>) => values[boundary.platform] ?? values.default },
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// The device's home-indicator inset is the platform boundary.
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));

const { PagePinnedBar } = await import('./PagePinnedBar');

afterEach(() => { boundary.platform = 'web'; standardCleanup(); });

async function bottomPadding(input: Readonly<{ chromeHeight: number; inModal?: boolean }>): Promise<number> {
    const bar = (
        <SessionCockpitBottomChromeHeightContext.Provider value={input.chromeHeight}>
            <PagePinnedBar testID="bar" />
        </SessionCockpitBottomChromeHeightContext.Provider>
    );
    const screen = await renderScreen(input.inModal ? <ModalBoundaryProvider>{bar}</ModalBoundaryProvider> : bar);
    return Number(StyleSheet.flatten(screen.findByTestId('bar')!.props.style)?.paddingBottom);
}

describe('PagePinnedBar', () => {
    it.each(['web', 'ios', 'android'])('keeps raw sticky-footer actions above measured cockpit chrome without doubling a nested page bar on %s', async platform => {
        boundary.platform = platform;
        const renderFooter = (pageBar: boolean, inModal = false) => {
            const footer = <KeyboardStickyFooter testID="sticky" style={{ paddingVertical: 12 }}>
                {pageBar ? <PagePinnedBar testID="bar" /> : <View testID="action" />}
            </KeyboardStickyFooter>;
            return <SessionCockpitBottomChromeHeightContext.Provider value={84}>
                {inModal ? <ModalBoundaryProvider>{footer}</ModalBoundaryProvider> : footer}
            </SessionCockpitBottomChromeHeightContext.Provider>;
        };
        const raw = await renderScreen(renderFooter(false));
        expect(StyleSheet.flatten(raw.findByTestId('sticky')!.props.style).paddingBottom).toBe(96);
        const nested = await renderScreen(renderFooter(true));
        expect(StyleSheet.flatten(nested.findByTestId('sticky')!.props.style).paddingBottom).toBe(96);
        expect(StyleSheet.flatten(nested.findByTestId('bar')!.props.style).paddingBottom).toBe(12);
        const modal = await renderScreen(renderFooter(false, true));
        expect(StyleSheet.flatten(modal.findByTestId('sticky')!.props.style).paddingBottom ?? 12).toBe(12);
        const nestedModal = await renderScreen(
            <SessionCockpitBottomChromeHeightContext.Provider value={84}>
                <KeyboardStickyFooter>
                    <ModalBoundaryProvider><PagePinnedBar testID="modal-bar" /></ModalBoundaryProvider>
                </KeyboardStickyFooter>
            </SessionCockpitBottomChromeHeightContext.Provider>,
        );
        expect(StyleSheet.flatten(nestedModal.findByTestId('modal-bar')!.props.style).paddingBottom).toBe(34);
    });
    it('keeps its actions above a floating tab bar by the bar\'s measured height', async () => {
        const clear = await bottomPadding({ chromeHeight: 0 });
        expect(await bottomPadding({ chromeHeight: 84 })).toBeGreaterThanOrEqual(84);
        // Reserving the chrome replaces the safe-area clearance (the tab bar already carries it).
        expect(await bottomPadding({ chromeHeight: 84 })).toBeLessThan(84 + clear);
    });

    it('clears the system safe area when no tab bar overlays the page', async () => {
        expect(await bottomPadding({ chromeHeight: 0 })).toBe(34);
    });

    it('does not reserve a tab bar that a modal covers', async () => {
        expect(await bottomPadding({ chromeHeight: 84, inModal: true })).toBe(34);
    });
});
