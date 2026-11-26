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
import { WelcomeDecisionPanel } from '@/components/onboarding/preAuth/WelcomeDecisionPanel';
import { UnauthenticatedSplitShell } from '@/components/onboarding/unauthShell/UnauthenticatedSplitShell';
import { createDesktopHostInternals } from '@/dev/testkit/harness/desktopHttpHost';
import { FirstOpenHost } from './FirstOpenHost';
import { FirstOpenOwnsWelcomePaint, useFirstOpenContentLayout } from './FirstOpenWelcomeModelContext';
import { resolveFirstOpen } from './resolveFirstOpen';
import { createFirstOpenLayoutRecorder, useFirstOpenBoot } from './useFirstOpenBoot';

function Destination({ onPress }: { onPress: () => void }) {
    const onLayout = useFirstOpenContentLayout();
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
        vi.unstubAllGlobals();
    });

    it('holds the web launch curtain until the Still destination planet paints', async () => {
        if (typeof document === 'undefined') throw new Error('Requires a browser document');
        document.documentElement.classList.add('launch-planet');
        function CurtainProbe() {
            return <View testID="curtain-probe" accessibilityLabel={useLaunchCurtainState()} />;
        }
        const screen = await renderScreen(<>
            <FirstOpenHost opening={{ decision: 'reduced', release: () => {}, recordLayout: createFirstOpenLayoutRecorder() }}>
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
        const screen = await renderScreen(<FirstOpenHost opening={{ decision, release: () => {}, recordLayout: createFirstOpenLayoutRecorder() }}><Destination onPress={press} /></FirstOpenHost>);
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

    it('acknowledges desktop first content with the pending Welcome model from the laid-out workflow', async () => {
        const host = createDesktopHostInternals(({ command, args }) =>
            command === 'plugin:event|listen' ? args.handler : true);
        vi.stubGlobal('__TAURI_INTERNALS__', { ...host.internals, metadata: { currentWindow: { label: 'main' } } });
        vi.stubGlobal('__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });

        function Boot({ destinationMounted, status = 'loading' }: {
            destinationMounted: boolean;
            status?: 'loading' | 'unavailable';
        }) {
            const { opening, admitOpening, onShellLayout } = useFirstOpenBoot(true);
            React.useEffect(() => admitOpening('overlay-eligible', 'overlay'), [admitOpening]);
            return opening && <FirstOpenHost opening={opening}>
                <View onLayout={onShellLayout} testID="first-open.fixture-shell">
                    {destinationMounted && <UnauthenticatedSplitShell stepId="welcome" isWelcomeStep frameWidth={1440}>
                        <WelcomeDecisionPanel
                            authEntryOptions={{
                                homeTarget: { kind: 'https_url', url: 'https://home.example.test' },
                                serverAvailability: status,
                                serverUrlForCopy: 'https://home.example.test',
                                authEntryUnavailable: false,
                                showAuthActions: false,
                                retryServerCheck() {},
                            }}
                            onOpenRestore={() => {}}
                            onChangeRelay={() => {}}
                        />
                    </UnauthenticatedSplitShell>}
                </View>
            </FirstOpenHost>;
        }
        const contentCalls = () => host.calls.filter(call => call.command === 'desktop_main_window_content_rendered');
        const screen = await renderScreen(<Boot destinationMounted={false} />);
        const layout = { nativeEvent: { layout: { x: 0, y: 0, width: 450, height: 550 } } };
        await act(async () => screen.findByTestId('first-open.fixture-shell')?.props.onLayout?.(layout));
        expect(contentCalls()).toEqual([]);
        await screen.update(<Boot destinationMounted />);
        const workflow = screen.findByTestId('unauth-shell-step-transition');
        expect(workflow?.props.onLayout).toBeTypeOf('function');
        expect(screen.findByTestId('welcome-auth-loading')).toBeTruthy();
        await act(async () => workflow?.props.onLayout?.(layout));
        expect(contentCalls().map(call => call.args.welcome)).toEqual([
            expect.objectContaining({ notices: expect.arrayContaining([
                expect.objectContaining({ kind: 'loading', testID: 'welcome-auth-loading' }),
            ]) }),
        ]);
        const subscription = host.calls.find(call => call.command === 'plugin:event|listen' && call.args.event === 'first_open:host');
        const handler = subscription?.args.handler;
        if (typeof handler !== 'number') throw new Error('Main did not subscribe to the native handoff');
        const deliver = (payload: unknown) => host.deliver(handler, { event: 'first_open:host', id: handler, payload });
        await act(async () => deliver({ kind: 'overlay', epoch: performance.timeOrigin + performance.now() }));
        const updated = () => host.calls.filter(call => call.command === 'desktop_first_open_welcome').map(call => call.args.welcome);
        expect(updated()).toEqual([]);

        await screen.update(<Boot destinationMounted status="unavailable" />);
        await screen.update(<Boot destinationMounted status="unavailable" />);
        expect(updated()).toEqual([
            expect.objectContaining({ notices: expect.arrayContaining([
                expect.objectContaining({ kind: 'unavailable', testID: 'welcome-auth-blocked' }),
            ]) }),
        ]);
        await act(async () => deliver({ kind: 'settled', outcome: 'completed' }));
        await screen.update(<Boot destinationMounted status="loading" />);
        expect(updated()).toHaveLength(1);
        expect(contentCalls()).toHaveLength(1);
        await screen.unmount();
    });
});
