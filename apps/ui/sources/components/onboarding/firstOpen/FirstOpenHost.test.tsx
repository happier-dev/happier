/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import React from 'react';
import { Pressable, View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { replacePersistentUiStateForTest } from '@/dev/testkit/harness/persistentUiState';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import { onboardingAuthHistoryState, onboardingHistoryState, readOpeningSeenAt } from '@/sync/domains/state/onboardingUiState';

import { useLaunchCurtainState } from '@/boot/launchCurtain';
import { FirstOpenHost } from './FirstOpenHost';
import { FirstOpenOwnsWelcomePaint, useFirstOpenContentLayout } from './FirstOpenWelcomeModelContext';
import { resolveFirstOpen } from './resolveFirstOpen';
import { createFirstOpenLayoutRecorder } from './useFirstOpenBoot';

function Destination({ onPress }: { onPress: () => void }) {
    const onLayout = useFirstOpenContentLayout('workflow');
    const paint = React.useContext(FirstOpenOwnsWelcomePaint);
    return <View onLayout={onLayout ?? undefined} onTouchEnd={() => paint?.onPainted?.('still')} testID="first-open.fixture-layout">
        <Pressable onPress={onPress} testID="first-open.fixture-action" />
    </View>;
}

const freshWelcome = { accountRestored: false, segments: ['(app)', 'index'] };

describe('FirstOpenHost', () => {
    beforeEach(() => {
        replacePersistentUiStateForTest(onboardingHistoryState, {});
        replacePersistentUiStateForTest(onboardingAuthHistoryState, {});
        setReducedMotionPreferenceOverride(true);
    });

    afterEach(() => {
        standardCleanup();
        setReducedMotionPreferenceOverride(null);
    });

    it('holds the web launch curtain until the Still destination planet paints', async () => {
        if (typeof document === 'undefined') throw new Error('Requires a browser document');
        document.documentElement.classList.add('launch-planet');
        function CurtainProbe() {
            return <View testID="curtain-probe" accessibilityLabel={useLaunchCurtainState()} />;
        }
        const screen = await renderScreen(<>
            <FirstOpenHost opening={{ decision: 'reduced', layoutTarget: 'workflow', release: () => {}, recordLayout: createFirstOpenLayoutRecorder() }}>
                <Destination onPress={() => {}} />
            </FirstOpenHost>
            <CurtainProbe />
        </>);
        const frame = screen.findByTestId('first-open.fixture-layout');
        const advancePaint = () => act(async () => {
            for (let i = 0; i < 3; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        });
        try {
            await act(async () => frame?.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 844 } } }));
            await advancePaint();
            expect(screen.findByTestId('curtain-probe')?.props.accessibilityLabel).toBe('up');
            await act(async () => frame?.props.onTouchEnd());
            await advancePaint();
            expect(screen.findByTestId('curtain-probe')?.props.accessibilityLabel).toBe('leaving');
        } finally {
            await screen.unmount();
            document.documentElement.classList.remove('launch-planet');
        }
    });

    it('keeps the Still destination interactive and only records the first usable layout', async () => {
        const press = vi.fn();
        const decision = resolveFirstOpen(freshWelcome);
        if (decision !== 'reduced') throw new Error(`Expected the Still first open, got ${decision}`);
        const screen = await renderScreen(<FirstOpenHost opening={{ decision, layoutTarget: 'workflow', release: () => {}, recordLayout: createFirstOpenLayoutRecorder() }}><Destination onPress={press} /></FirstOpenHost>);
        const destination = screen.findByTestId('first-open.fixture-layout');
        const onLayout = destination?.props.onLayout;
        if (!onLayout) throw new Error('The destination must be mounted before its layout');
        const layout = (width: number) => act(() => {
            onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height: 844 } } });
        });

        layout(0);
        expect(readOpeningSeenAt()).toBeNull();
        layout(390);
        const firstSeen = readOpeningSeenAt();
        expect(firstSeen).toEqual(expect.any(Number));
        await act(async () => screen.pressByTestId('first-open.fixture-action'));
        expect(press).toHaveBeenCalledOnce();
        const writes = vi.spyOn(onboardingHistoryState, 'set');
        layout(410);
        expect(writes).not.toHaveBeenCalled();
        expect(readOpeningSeenAt()).toBe(firstSeen);
        expect(resolveFirstOpen(freshWelcome)).toBe('none');
        expect(screen.findByTestId('first-open.scene')).toBeNull();
        writes.mockRestore();
    });
});
