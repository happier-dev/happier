import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

/**
 * `animationEnabled` shipped as a web-only branch, and the native path spread the whole prop bag
 * into `ActivityIndicator`. So every call site that threaded the flag to pause ambient motion
 * paused nothing at all on iOS or Android — the spinner kept turning and an unknown prop went to
 * the platform component. A pause flag that silently does nothing on two of three platforms is
 * worse than no flag: it makes the corridor *look* gated.
 */

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' }, {
        View: 'View',
        ActivityIndicator: 'ActivityIndicator',
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: { colors: { text: { secondary: 'theme-secondary-text' } } },
    });
});

async function renderNativeSpinner(props: Record<string, unknown>) {
    const { ActivitySpinner } = await import('./ActivitySpinner');
    const screen = await renderScreen(<ActivitySpinner testID="spinner" size={16} {...props} />);
    const nodes = screen.findAllByType('ActivityIndicator' as never);
    expect(nodes.length).toBe(1);
    return nodes[0]!.props as Record<string, unknown>;
}

describe('ActivitySpinner (native)', () => {
    it('animates by default and never hands the platform component an unknown prop', async () => {
        const props = await renderNativeSpinner({});

        expect(props.animating).toBeUndefined();
        expect(props).not.toHaveProperty('animationEnabled');
    });

    it('actually stops the native spinner when ambient motion is paused, and keeps it visible', async () => {
        const props = await renderNativeSpinner({ animationEnabled: false });

        // Stopped, not hidden: `hidesWhenStopped` defaults to true, so pausing without this would
        // make the running mark vanish — the row would read as "no longer working".
        expect(props.animating).toBe(false);
        expect(props.hidesWhenStopped).toBe(false);
        expect(props).not.toHaveProperty('animationEnabled');
    });

    it('leaves an explicitly stopped spinner alone, so hiding it stays the caller\'s decision', async () => {
        const props = await renderNativeSpinner({ animating: false });

        expect(props.animating).toBe(false);
        expect(props.hidesWhenStopped).toBeUndefined();
    });
});
