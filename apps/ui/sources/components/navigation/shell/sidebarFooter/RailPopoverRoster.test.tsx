import * as React from 'react';
import { Text } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';

const contentSize = (list: { props: Record<string, unknown> } | null, height: number) =>
    (list!.props.onContentSizeChange as (width: number, height: number) => void)(300, height);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const { RailPopoverRoster, RailPopoverRosterList } = await import('./RailPopoverRoster');

afterEach(standardCleanup);

const VIEWPORT = 360;
const CONTENT = 520;

function fadeOpacity(screen: Awaited<ReturnType<typeof renderRoster>>, edge: 'Top' | 'Bottom'): number {
    const style = screen.findHostByTestId(`roster.list.fade${edge}`)!.props.style as readonly Record<string, unknown>[];
    return [style].flat(2).reduce<number>((opacity, entry) => (typeof entry?.opacity === 'number' ? entry.opacity : opacity), 1);
}

async function renderRoster() {
    return renderScreen(
        <RailPopoverRoster testID="roster" maxHeight={420} title="Bots" actions={[]}>
            <RailPopoverRosterList testID="roster.list">
                <Text>row</Text>
            </RailPopoverRosterList>
        </RailPopoverRoster>,
    );
}

describe('rail popover roster list', () => {
    it('says there is more above or below only while the list overflows and rests away from that edge', async () => {
        const screen = await renderRoster();
        const list = () => screen.findByTestId('roster.list');
        // A list that fits its frame draws no fade at either edge.
        await act(async () => {
            invokeTestInstanceHandler(list(), 'onLayout', { nativeEvent: { layout: { width: 300, height: VIEWPORT } } });
            contentSize(list(), VIEWPORT);
        });
        expect(fadeOpacity(screen, 'Bottom')).toBe(0);
        expect(fadeOpacity(screen, 'Top')).toBe(0);
        // Overflowing at the top: the last row would otherwise be cut mid-text against the footer with no hint.
        await act(async () => { contentSize(list(), CONTENT); });
        expect(fadeOpacity(screen, 'Bottom')).toBe(1);
        expect(fadeOpacity(screen, 'Top')).toBe(0);
        // Scrolled to the end: the rows end whole above the footer, the trailing fade clears.
        await act(async () => {
            invokeTestInstanceHandler(list(), 'onScroll', {
                nativeEvent: {
                    contentOffset: { x: 0, y: CONTENT - VIEWPORT },
                    layoutMeasurement: { width: 300, height: VIEWPORT },
                    contentSize: { width: 300, height: CONTENT },
                },
            });
        });
        expect(fadeOpacity(screen, 'Bottom')).toBe(0);
        expect(fadeOpacity(screen, 'Top')).toBe(1);
        await screen.unmount();
    });
});
