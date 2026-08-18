import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

/**
 * Web AgentContentView: the outer wrapper shrinks by the floating cockpit bar's height so the
 * composer clears it. With the software keyboard OPEN the whole scaffold already translates up
 * by the full keyboard inset; keeping the wrapper reservation slides the composer + bar stack
 * a full reservation above the visual viewport bottom (measured on-device: a ~76 CSS px band
 * above the keyboard on Firefox Android). The reservation must collapse to 0 while the
 * keyboard is open — the scaffold's own geometry still clears the (still-mounted, per product
 * contract) cockpit bar via layoutBottomInset.
 */

const state = vi.hoisted(() => ({
    bottomChromeHeight: 76,
    keyboardHeight: 0,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 56,
}));

vi.mock('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry', () => ({
    useSessionCockpitBottomChromeHeight: () => state.bottomChromeHeight,
}));

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => state.keyboardHeight,
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { surface: { base: '#000' } } } }),
}));

vi.mock('./useKeyboardDismissOnTap', () => ({
    useKeyboardDismissOnTap: () => ({}),
}));

vi.mock('@/components/sessions/keyboardAvoidance', () => ({
    ComposerKeyboardScaffold: ({ children, testID }: { children?: React.ReactNode; testID?: string }) => (
        <div data-testid={testID}>{children}</div>
    ),
}));

describe('AgentContentView.web bottom-chrome reservation', () => {
    beforeEach(() => {
        standardCleanup();
        state.bottomChromeHeight = 76;
        state.keyboardHeight = 0;
    });

function readOuterWrapperPaddingBottom(screen: Awaited<ReturnType<typeof renderScreen>>): number | undefined {
    const scaffold = screen.findByProps({ 'data-testid': 'agent-content-keyboard-host' });
    let wrapper = scaffold.parent;
    while (wrapper && wrapper.props.style === undefined) wrapper = wrapper.parent;
    if (!wrapper) throw new Error('outer wrapper not found');
    const styles = Array.isArray(wrapper.props.style) ? wrapper.props.style : [wrapper.props.style];
    const flattened = styles.reduce(
        (acc: Record<string, unknown>, style: Record<string, unknown> | null | undefined) => ({ ...acc, ...(style ?? {}) }),
        {},
    );
    return flattened.paddingBottom as number | undefined;
}

describe('AgentContentView.web bottom-chrome reservation', () => {
    beforeEach(() => {
        standardCleanup();
        state.bottomChromeHeight = 76;
        state.keyboardHeight = 0;
    });

    it('reserves the floating bar height with the keyboard down', async () => {
        const { AgentContentView } = await import('./AgentContentView.web');
        const screen = await renderScreen(<AgentContentView input={<div />} />);

        expect(readOuterWrapperPaddingBottom(screen)).toBe(76);
    });

    it('collapses the bar reservation while the software keyboard is open', async () => {
        state.keyboardHeight = 297;

        const { AgentContentView } = await import('./AgentContentView.web');
        const screen = await renderScreen(<AgentContentView input={<div />} />);

        // The scaffold translates the stack by the full keyboard inset; the bar stays mounted
        // above the keyboard, so the wrapper must not double-shift everything one reservation.
        expect(readOuterWrapperPaddingBottom(screen)).toBe(0);
    });
});
});
