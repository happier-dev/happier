/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { expect, it, vi } from 'vitest';

import { runAppBootSequence } from '@/boot/runAppBootSequence';
import { WelcomeDecisionPanel } from '@/components/onboarding/preAuth/WelcomeDecisionPanel';
import { UnauthenticatedSplitShell } from '@/components/onboarding/unauthShell/UnauthenticatedSplitShell';
import { StepMotionStage, useStepMotionStage } from '@/components/ui/motion/stepMotion/StepMotionStage';
import { replacePersistentUiStateForTest } from '@/dev/testkit/harness/persistentUiState';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import { onboardingAuthHistoryState, onboardingHistoryState, readOpeningSeenAt } from '@/sync/domains/state/onboardingUiState';

import { useFirstOpenContentLayout } from './FirstOpenWelcomeModelContext';
import { installFirstOpenWebGraphics } from './firstOpenWebGraphics.fixture';
import { openingClimbSeconds } from './openingTimeline';
import { resolveFirstOpen } from './resolveFirstOpen';
import { useFirstOpenBoot } from './useFirstOpenBoot';

vi.mock('react-native', async () => await vi.importActual('react-native-web'));
// The source barrel re-exports Native under Vitest. Use the same browser adapter Metro selects.
vi.mock('@/components/atmosphere/glyph/GlyphSurface.native', async () =>
    await vi.importActual('@/components/atmosphere/glyph/GlyphSurface.web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
it.each([
    { width: 1440, canPaint: true, input: 'built' },
    { width: 390, canPaint: true, input: 'unbuilt' },
    { width: 390, canPaint: true, input: 'Escape' },
    { width: 390, canPaint: false, input: 'Still' },
])('first Welcome layout accepts $input input (renderer ready: $canPaint)', async ({ width, canPaint, input }) => {
    const segments = ['(app)', 'index'];
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('CSS', { escape: (id: string) => id });
    replacePersistentUiStateForTest(onboardingHistoryState, {});
    replacePersistentUiStateForTest(onboardingAuthHistoryState, {});
    setReducedMotionPreferenceOverride(false);
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
        .mockImplementation(function (this: HTMLElement) {
            if (this.dataset.testid === 'welcome-scan-existing-home') return new DOMRect(40, 660, 290, 50);
            if (this.dataset.testid === 'welcome-create-personal-home') return new DOMRect(40, 220, 290, 50);
            return new DOMRect(0, 0, width, 844);
        });
    const clock = vi.spyOn(performance, 'now');
    let commitLayout: () => void = () => { throw new Error('The destination has not mounted'); };
    let readBuildReady = () => false;
    function Destination() {
        const layout = useFirstOpenContentLayout('workflow');
        const stage = useStepMotionStage();
        commitLayout = () => { layout?.({ nativeEvent: { layout: frame } } as Parameters<NonNullable<typeof layout>>[0]); };
        readBuildReady = () => stage?.isBuildReady() ?? false;
        return <UnauthenticatedSplitShell stepId="welcome" isWelcomeStep>
            <WelcomeDecisionPanel
                authEntryOptions={{ serverAvailability: 'ready', authEntryUnavailable: false, serverUrlForCopy: '', homePairingAvailable: true,
                    showAuthActions: true, retryServerCheck() {} }}
                canScanQr canCreatePersonalHome onCreatePersonalHome={onAction}
                onOpenRestore={onAction} onOpenSecretKeyLogin={() => {}} onChangeRelay={() => {}}
            />
        </UnauthenticatedSplitShell>;
    }
    const fontsLoaded = vi.spyOn(document.fonts, 'load');
    let releaseFonts: (() => void) | undefined;
    if (!canPaint) {
        const fonts = new Promise<FontFace[]>(resolve => { releaseFonts = () => resolve([]); });
        fontsLoaded.mockReturnValue(fonts);
    }
    let completeTranslations: () => void = () => {};
    const translations = new Promise<void>(resolve => { completeTranslations = resolve; });
    let onAuthResolved = (_accountRestored: boolean): void => {};
    let releaseOpening: ReturnType<ReturnType<typeof useFirstOpenBoot>['admitOpening']>;
    const fastBoot = input === 'built';
    let mountOpening = () => {};
    let readyApp = () => {};
    let boot: Promise<void> | undefined;
    function BootFixture() {
        const [mount, setMount] = React.useState(false);
        const [ready, setReady] = React.useState(false);
        const { opening, Host, admitOpening } = useFirstOpenBoot();
        onAuthResolved = accountRestored => { releaseOpening = admitOpening(resolveFirstOpen({ accountRestored, segments })); };
        mountOpening = () => setMount(true);
        readyApp = () => setReady(true);
        return mount && opening && Host ? <Host opening={opening}>{ready ? <Destination /> : null}</Host> : null;
    }
    try {
        await act(async () => root.render(
            <SafeAreaProvider initialMetrics={{ frame, insets: { top: 0, right: 0, bottom: 0, left: 0 } }}>
                <StepMotionStage><BootFixture /></StepMotionStage>
            </SafeAreaProvider>,
        ));
        const scene = () => box.querySelector('[data-testid="first-open.scene"]');
        const welcome = () => box.querySelector('[data-testid="welcome-decision-panel"]');
        const login = () => box.querySelector<HTMLElement>('[data-testid="welcome-scan-existing-home"]')!;
        await act(async () => {
            boot = runAppBootSequence({
                loadFonts: async () => {},
                sodiumReady: Promise.resolve(),
                resolveCredentials: async () => null,
                prepareWarmCache: async () => {},
                prepareSessionDrafts: async () => {},
                prepareTranslations: () => fastBoot ? Promise.resolve() : translations,
                restoreSync: null,
                onAuthResolved,
                onReady: () => {
                    // On the cold web path, boot settles while the lazy destination still loads.
                    if (!fastBoot) readyApp();
                },
            });
        });
        // The boot dependencies can still be pending and the React host has yet to mount.
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(fontsLoaded).toHaveBeenCalled();
        }, { timeout: 3000 });
        expect(welcome()).toBeNull();
        await act(async () => mountOpening());
        await act(async () => { await vi.dynamicImportSettled(); });
        if (canPaint) {
            await vi.waitFor(async () => {
                await act(async () => {});
                expect(scene()?.querySelector('canvas[data-glyph-linked=true][data-glyph-first-draw-ms]'), scene()?.outerHTML).toBeTruthy();
            });
        }
        await act(async () => {
            if (fastBoot) readyApp();
            completeTranslations();
            await boot;
        });
        expect(welcome()).toBeTruthy();
        expect(login()).toBeTruthy();
        expect(readOpeningSeenAt()).toBeNull();
        if (canPaint) expect(readBuildReady()).toBe(true);
        animate.mockClear();
        clock.mockReturnValue(1000);
        await act(async () => commitLayout());
        expect(readOpeningSeenAt()).toEqual(expect.any(Number));
        if (!canPaint) {
            expect(scene()).toBeNull();
            expect(animate).not.toHaveBeenCalled();
            await act(async () => login().click());
            expect(onAction).toHaveBeenCalledOnce();
            await act(async () => releaseFonts?.());
            expect(scene()).toBeNull();
            expect(animate).not.toHaveBeenCalled();
            return;
        }
        expect(scene()).toBeTruthy();
        const openingCanvas = scene()?.querySelector('canvas[data-glyph-linked=true]');
        const visibleCanvases = Array.from(box.querySelectorAll<HTMLCanvasElement>('canvas[data-glyph-linked=true][data-glyph-first-draw-ms]'))
            .filter(canvas => canvas.style.visibility === 'visible');
        // The build gives the destination's real leaves compositor keyframes.
        expect(animate).toHaveBeenCalled();
        expect(login().closest('[inert]')).toBeNull();
        clock.mockReturnValue(1000 + openingClimbSeconds * 1000 + 680);
        if (input === 'Escape') {
            await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })); });
            expect(document.activeElement).toBe(box.querySelector('[role="heading"],h1,h2'));
            expect(scene()).toBeNull();
            return;
        }
        const control = input === 'built' ? login() : box.querySelector<HTMLElement>('[data-testid="welcome-create-personal-home"]')!;
        expect(control).toBeTruthy();
        await act(async () => {
            control.dispatchEvent(Object.assign(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }), { pointerId: 1 }));
            control.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
        });
        if (input === 'built') {
            expect(onAction).toHaveBeenCalledOnce();
            expect(scene()).toBeTruthy();
        } else {
            expect(onAction).not.toHaveBeenCalled();
            expect(scene()).toBeNull();
        }
        expect(visibleCanvases).toEqual([openingCanvas]);
        expect(resolveFirstOpen({ accountRestored: false, segments })).toBe('none');
    } finally {
        await act(async () => {
            releaseFonts?.();
            completeTranslations();
            await boot;
            releaseOpening?.();
            root.unmount();
        });
        fontsLoaded.mockRestore();
        clock.mockRestore();
        box.remove();
        bounds.mockRestore();
        if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
        else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
        setReducedMotionPreferenceOverride(null);
        restoreGraphics();
        vi.unstubAllGlobals();
    }
});

it('holds the scene over a phone Welcome until the Welcome planet has painted under it', async () => {
    const segments = ['(app)', 'index'];
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('CSS', { escape: (id: string) => id });
    replacePersistentUiStateForTest(onboardingHistoryState, {});
    replacePersistentUiStateForTest(onboardingAuthHistoryState, {});
    setReducedMotionPreferenceOverride(false);
    const frame = { x: 0, y: 0, width: 390, height: 844 };
    // JSDOM has no layout engine: every View reports the phone frame, as React Native Web measures it.
    vi.stubGlobal('ResizeObserver', class {
        constructor(private readonly report: (entries: Array<{ target: Element }>) => void) {}
        observe(target: Element) { setTimeout(() => this.report([{ target }]), 0); }
        unobserve() {}
        disconnect() {}
    });
    const offsetWidth = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(frame.width);
    const offsetHeight = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(frame.height);
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, frame.width, frame.height));
    const restoreGraphics = installFirstOpenWebGraphics(frame.width, frame.height);
    const effects: Array<{ cancel: ReturnType<typeof vi.fn> }> = [];
    const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: () => {
        const effect = { onfinish: null, cancel: vi.fn() };
        effects.push(effect);
        return effect;
    } });
    const fontsLoaded = vi.spyOn(document.fonts, 'load');
    const clock = vi.spyOn(performance, 'now');
    // The browser's frame clock reports the same time as the page clock.
    vi.stubGlobal('requestAnimationFrame', (draw: FrameRequestCallback) => setTimeout(() => draw(performance.now()), 16));
    vi.stubGlobal('cancelAnimationFrame', (frame: number) => clearTimeout(frame));
    const box = document.createElement('div');
    document.body.append(box);
    const root = createRoot(box);
    let releaseOpening: (() => void) | undefined;
    let releaseWelcomeFonts: (() => void) | undefined;
    let showDestination = () => {};
    function Destination() {
        return <UnauthenticatedSplitShell stepId="welcome" isWelcomeStep>
            <WelcomeDecisionPanel
                authEntryOptions={{ serverAvailability: 'ready', authEntryUnavailable: false, serverUrlForCopy: '', homePairingAvailable: true,
                    showAuthActions: true, retryServerCheck() {} }}
                canScanQr canCreatePersonalHome onCreatePersonalHome={() => {}}
                onOpenRestore={() => {}} onOpenSecretKeyLogin={() => {}} onChangeRelay={() => {}}
            />
        </UnauthenticatedSplitShell>;
    }
    function BootFixture() {
        const [ready, setReady] = React.useState(false);
        const { opening, Host, admitOpening } = useFirstOpenBoot();
        React.useEffect(() => {
            releaseOpening = admitOpening(resolveFirstOpen({ accountRestored: false, segments }));
        }, [admitOpening]);
        showDestination = () => setReady(true);
        return opening && Host ? <Host opening={opening}>{ready ? <Destination /> : null}</Host> : null;
    }
    const scene = () => box.querySelector('[data-testid="first-open.scene"]');
    const welcomePlanet = () => box.querySelector<HTMLElement>('[data-testid="welcome-planet"]');
    try {
        await act(async () => root.render(
            <SafeAreaProvider initialMetrics={{ frame, insets: { top: 0, right: 0, bottom: 0, left: 0 } }}>
                <StepMotionStage><BootFixture /></StepMotionStage>
            </SafeAreaProvider>,
        ));
        await act(async () => { await vi.dynamicImportSettled(); });
        await vi.waitFor(async () => {
            await act(async () => {});
            expect(scene()?.querySelector('canvas[data-glyph-linked=true][data-glyph-first-draw-ms]')).toBeTruthy();
        });
        // The Welcome's planet cannot paint until its glyph atlas has its font.
        fontsLoaded.mockReturnValue(new Promise<FontFace[]>(resolve => { releaseWelcomeFonts = () => resolve([]); }));
        clock.mockReturnValue(1000);
        await act(async () => showDestination());
        await vi.waitFor(async () => {
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
            expect(readOpeningSeenAt()).toEqual(expect.any(Number));
            expect(welcomePlanet()).toBeTruthy();
        });
        expect(scene()).toBeTruthy();
        expect(getComputedStyle(welcomePlanet()!).opacity).toBe('0');
        // The opening and its build run to their end; the build releases its keyframes as it settles.
        const handOffs = () => performance.getEntriesByName('first_open:destination-handoff').length;
        const handOffsBefore = handOffs();
        const built = () => effects.some(effect => effect.cancel.mock.calls.length > 0);
        expect(effects.length).toBeGreaterThan(0);
        expect(built()).toBe(false);
        clock.mockReturnValue(1000 + 4000);
        await vi.waitFor(async () => {
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
            expect(built()).toBe(true);
        });
        expect(scene()).toBeTruthy();
        expect(handOffs()).toBe(handOffsBefore);

        await act(async () => { releaseWelcomeFonts?.(); });
        await vi.waitFor(async () => {
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
            expect(scene()).toBeNull();
        });
        const planet = welcomePlanet()!;
        expect(getComputedStyle(planet).opacity).not.toBe('0');
        expect(planet.querySelector('canvas[data-glyph-first-draw-ms]')).toBeTruthy();
    } finally {
        await act(async () => {
            releaseWelcomeFonts?.();
            releaseOpening?.();
            root.unmount();
        });
        fontsLoaded.mockRestore();
        clock.mockRestore();
        box.remove();
        bounds.mockRestore();
        offsetWidth.mockRestore();
        offsetHeight.mockRestore();
        if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
        else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
        setReducedMotionPreferenceOverride(null);
        restoreGraphics();
        vi.unstubAllGlobals();
    }
});
