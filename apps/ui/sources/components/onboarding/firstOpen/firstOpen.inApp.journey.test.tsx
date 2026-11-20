/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { expect, it, vi } from 'vitest';

import { WelcomeEntryView } from '@/components/onboarding/preAuth/WelcomeEntryView';
import { UnauthenticatedRouteShell } from '@/components/onboarding/unauthShell/UnauthenticatedRouteShell';
import { UnauthenticatedSplitShell } from '@/components/onboarding/unauthShell/UnauthenticatedSplitShell';
import { StepMotionStage } from '@/components/ui/motion/stepMotion/StepMotionStage';
import { replacePersistentUiStateForTest } from '@/dev/testkit/harness/persistentUiState';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import { onboardingAuthHistoryState, onboardingHistoryState, readOpeningSeenAt } from '@/sync/domains/state/onboardingUiState';

import { FirstOpenHost, useFirstOpenContentLayout } from './FirstOpenHost';
import { installFirstOpenWebGraphics } from './firstOpenWebGraphics.fixture';
import { resolveFirstOpen } from './resolveFirstOpen';

vi.mock('react-native', async () => await vi.importActual('react-native-web'));
// Vitest uses the source fallback without Metro's web-extension precedence.
vi.mock('@/components/atmosphere/glyph/GlyphSurface', async () =>
    await vi.importActual('@/components/atmosphere/glyph/GlyphSurface.web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
it.each([
    { name: 'Welcome', segments: ['(app)', 'index'], width: 1440 },
    { name: 'Team sign-in', segments: ['(app)', 'teams', '[teamId]', 'sign-in'], width: 390 },
])('builds the real workflow layer on first open of $name, then releases it on input', async ({ name, segments, width }) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('CSS', { escape: (id: string) => id });
    replacePersistentUiStateForTest(onboardingHistoryState, {});
    replacePersistentUiStateForTest(onboardingAuthHistoryState, {});
    setReducedMotionPreferenceOverride(false);
    const decision = resolveFirstOpen({ accountRestored: false, segments });
    if (decision !== 'in-app') throw new Error(`Expected an in-app opening, got ${decision}`);
    const box = document.createElement('div');
    document.body.append(box);
    const root = createRoot(box);
    const frame = { x: 0, y: 0, width, height: 844 };
    const restoreGraphics = installFirstOpenWebGraphics(frame.width, frame.height);
    const onAction = vi.fn();
    const animate = vi.fn(() => ({ onfinish: null, cancel: vi.fn() }));
    const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockReturnValue(new DOMRect(0, 0, width, 844));
    let commitLayout = () => { throw new Error('The destination has not mounted'); };
    function Destination() {
        const layout = useFirstOpenContentLayout();
        commitLayout = () => { layout?.({ nativeEvent: { layout: frame } } as Parameters<NonNullable<typeof layout>>[0]); };
        return name === 'Welcome' ? <UnauthenticatedSplitShell stepId="welcome" isWelcomeStep>
            <WelcomeEntryView model={{
                heading: { title: 'Welcome', subtitle: 'Set up Happier' },
                doors: [{ index: 0, display: { title: 'Continue', testID: 'first-open-next', primary: true } }],
                quietWays: [], notices: [],
            }} compact={false} interaction={{
                admission: { pendingActionId: null, run: async (_id, invoke) => { await invoke(); } },
                getActionId: () => 'first-open-next',
                onAction, onRetry() {}, onSelfHosting() {},
            }} />
        </UnauthenticatedSplitShell> : <UnauthenticatedRouteShell stepId="team-sign-in" testID="team-sign-in-shell">
            <h1>{name}</h1><button data-testid="first-open-next" onClick={onAction}>Continue</button>
        </UnauthenticatedRouteShell>;
    }
    try {
        await act(async () => root.render(
            <SafeAreaProvider initialMetrics={{ frame, insets: { top: 0, right: 0, bottom: 0, left: 0 } }}>
                <StepMotionStage><FirstOpenHost decision={decision}><Destination /></FirstOpenHost></StepMotionStage>
            </SafeAreaProvider>,
        ));
        const scene = () => box.querySelector('[data-testid="first-open.scene"]');
        expect(box.textContent).toContain(name);
        expect(readOpeningSeenAt()).toBeNull();
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(scene()?.querySelector('canvas[data-glyph-linked=true][data-glyph-first-draw-ms]')).toBeTruthy();
            expect(box.querySelectorAll('canvas[data-glyph-linked=true][data-glyph-first-draw-ms]').length).toBeGreaterThan(1);
        });
        animate.mockClear();
        await act(async () => commitLayout());
        expect(readOpeningSeenAt()).toEqual(expect.any(Number));
        expect(scene()).toBeTruthy();
        // The build gives the destination's real leaves compositor keyframes.
        expect(animate).toHaveBeenCalled();
        expect(box.querySelector('[data-testid="first-open-next"]')?.closest('[inert]')).toBeNull();
        await act(async () => {
            const next = box.querySelector<HTMLElement>('[data-testid="first-open-next"]')!;
            if (name === 'Welcome') {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
                expect(document.activeElement).toBe(box.querySelector('[role="heading"],h1,h2'));
            } else next.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
            next.click();
        });
        expect(scene()).toBeNull();
        expect(onAction).toHaveBeenCalledOnce();
        expect(resolveFirstOpen({ accountRestored: false, segments })).toBe('none');
    } finally {
        await act(async () => root.unmount());
        box.remove();
        bounds.mockRestore();
        if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
        else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
        setReducedMotionPreferenceOverride(null);
        restoreGraphics();
        vi.unstubAllGlobals();
    }
});
