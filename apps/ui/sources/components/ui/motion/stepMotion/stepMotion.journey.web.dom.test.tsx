/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { glyphFrame } from '@happier-dev/brand/glyph-scene';

import type { GlyphSurfaceProps } from '@/components/atmosphere/glyph/glyphSurfaceTypes';
import { HomePlanet } from '@/components/atmosphere/HomePlanet';
import { resolvePostAuthLanding } from '@/components/onboarding/state/resolvePostAuthLanding';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import { isShowcaseHomeLandingPending } from '@/onboarding/showcase/storage';

import { StepMotionLayer } from './StepMotionLayer';
import { playBuild, runStepMove, skipStepMotion, StepMotionStage } from './StepMotionStage';
import { stepMotionTiming } from './stepMotionTiming';
import { useStepFocal } from './useStepFocal';

const desktopEvents = vi.hoisted(() => new Map<string, () => void>());
let stageScene: GlyphSurfaceProps['scene'] = [];
let homePaint: GlyphSurfaceProps | undefined;
let stageMotion: GlyphSurfaceProps['motion'];

vi.mock('@/utils/platform/desktopHost', async (importOriginal) => {
    const { createDesktopHostModuleMock } = await import('@/dev/testkit/mocks/desktopHost');
    return createDesktopHostModuleMock({ importOriginal, overrides: {
        isDesktopHost: () => true,
        getDesktopHostWindowLabel: () => 'main',
        invokeDesktopHost: async <T,>() => true as T,
        listenDesktopHostEvent: async <T,>(event: string, receive: (payload: T) => void) => {
            desktopEvents.set(event, () => receive(null as T));
            return () => { desktopEvents.delete(event); };
        },
    } });
});
vi.mock('react-native', async () => await vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
// jsdom has no WebGL context. The real stage and scene still prepare every DOM effect.
vi.mock('@/components/atmosphere/glyph/GlyphSurface', () => ({
    GlyphSurface: (props: GlyphSurfaceProps) => {
        const { onReady, scene, motion, testID } = props;
        React.useEffect(() => { onReady?.('ready'); }, [onReady]);
        React.useEffect(() => {
            if (testID === 'home-planet') homePaint = props;
            else { stageScene = scene; stageMotion = motion; }
        }, [motion, props, scene, testID]);
        return null;
    },
}));

it('builds the actual Home planet in Full and settles to its existing Quiet pixels', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('CSS', { escape: (id: string) => id });
    setReducedMotionPreferenceOverride(false);
    const animate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: () => ({ onfinish: null, cancel() {} }) });
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600));
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const pixelsAt = (time: number) => {
        if (!homePaint || typeof homePaint.scene !== 'function') throw new Error('Home did not publish a glyph scene');
        const { width, height, scene } = homePaint;
        const body = glyphFrame({ view: { w: width, h: height }, theme: 'dark', dpr: 1, layers: scene(time) }, { time }).body;
        if (!body) throw new Error('Home did not sample its planet');
        let opacity = 0;
        for (let index = 3; index < body.rgba.length; index += 4) opacity = Math.max(opacity, body.rgba[index]);
        return opacity;
    };
    try {
        await act(async () => root.render(<StepMotionStage>
            <StepMotionLayer layerKey="home" stepKey="home">
                <HomePlanet pane={{ width: 800, height: 600 }} intensity="quiet" digits={false} theme="dark"
                    phone={false} hero={null} hidden={false} leave="fade" reducedMotion={false} />
            </StepMotionLayer>
        </StepMotionStage>));
        await act(async () => { await vi.dynamicImportSettled(); });
        const resting = pixelsAt(0);
        expect(homePaint?.motion).toBeNull();
        let result: Promise<'settled' | 'skipped'> | undefined;
        await act(async () => { result = playBuild({ layer: 'home', choreography: 'home' }); });
        expect(pixelsAt(0)).toBeGreaterThan(resting);
        expect(homePaint?.motion).toBeNull();
        clock.mockReturnValue(1000 + stepMotionTiming.homeS * 1000);
        await act(async () => {
            if (stageMotion?.kind !== 'transition') throw new Error('Home build did not start');
            stageMotion.onSettled?.();
        });
        expect(await result).toBe('settled');
        expect(homePaint?.motion).toMatchObject({ epoch: 1000 + stepMotionTiming.homeS * 1000 });
        expect(pixelsAt(0)).toBeGreaterThan(resting);
        expect(pixelsAt(stepMotionTiming.homeSettleS)).toBe(resting);
        await act(async () => {
            if (homePaint?.motion?.kind !== 'field-calm') throw new Error('Home settle did not continue after the build');
            homePaint.motion.onSettled?.();
        });
        expect(homePaint?.motion).toBeNull();
    } finally {
        await act(async () => root.unmount());
        container.remove();
        clock.mockRestore();
        rect.mockRestore();
        if (animate) Object.defineProperty(HTMLElement.prototype, 'animate', animate);
        else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
        setReducedMotionPreferenceOverride(null);
        vi.unstubAllGlobals();
    }
});

function pointerDown(node: HTMLElement, id: number) {
    const event = new MouseEvent('pointerdown', { bubbles: true });
    Object.defineProperty(event, 'pointerId', { value: id });
    node.dispatchEvent(event);
}

function click(node: HTMLElement, id: number) {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
    Object.defineProperty(event, 'pointerId', { value: id });
    node.dispatchEvent(event);
}

it('commits the new step immediately, ignores the previous pointer release, and settles as the next press acts', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    // The browser supports CSS.escape, which jsdom does not implement. This journey uses simple IDs.
    vi.stubGlobal('CSS', { escape: (id: string) => id });
    const previousMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn(() => Object.assign(new EventTarget(), { matches: true, media: '(prefers-reduced-motion: reduce)' }));
    const previousAnimate = HTMLElement.prototype.animate;
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ onfinish: null, cancel }));
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const dispose = vi.fn();
    const destinationClick = vi.fn();
    const motionEnd = vi.fn();
    function Outgoing({ next }: Readonly<{ next: () => void }>) {
        React.useEffect(() => dispose, []);
        return <button data-testid="approve" onClick={next}><span data-testid="approve-label">Approve</span></button>;
    }
    function Journey() {
        const [step, setStep] = React.useState('approve');
        return <StepMotionStage>
            <button onClick={() => runStepMove({ layer: 'workflow', kind: 'back', commit: () => setStep('approve') })}>Back</button>
            <StepMotionLayer layerKey="workflow" stepKey={step}>
                {step === 'approve'
                    ? <Outgoing next={() => runStepMove({ layer: 'workflow', kind: 'step', commit: () => setStep('ready'), onSettled: motionEnd })} />
                    : <>
                        <h1 data-testid="ready-heading">Ready</h1>
                        <div data-testid="step-decoration" />
                        <button data-testid="next" onClick={destinationClick}>Continue</button>
                    </>}
            </StepMotionLayer>
        </StepMotionStage>;
    }
    const find = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
    try {
        await act(async () => root.render(<Journey />));
        await act(async () => {
            pointerDown(find('approve-label'), 1);
            // A second pointer was already down when this one activated Approve.
            pointerDown(find('approve-label'), 2);
            click(find('approve-label'), 1);
        });
        expect(dispose).toHaveBeenCalledOnce();
        expect(find('approve')).toBeNull();
        expect(document.activeElement).toBe(find('ready-heading'));
        expect(animate).toHaveBeenCalledWith([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
        expect(document.querySelector('[inert]')).toBeNull();
        click(find('next'), 2);
        expect(destinationClick).not.toHaveBeenCalled();
        expect(motionEnd).not.toHaveBeenCalled();

        // Chromium blurs the new focal target on the second mouse-down over the decoration.
        const repeat = new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 2 });
        if (find('step-decoration').dispatchEvent(repeat)) find('ready-heading').blur();
        expect(document.activeElement).toBe(find('ready-heading'));
        expect(find('next').dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true, cancelable: true, detail: 2,
        }))).toBe(true);

        pointerDown(find('next'), 3);
        click(find('next'), 3);
        expect(cancel).toHaveBeenCalledOnce();
        expect(destinationClick).toHaveBeenCalledOnce();
        expect(motionEnd).toHaveBeenCalledExactlyOnceWith('skipped');
        await act(async () => container.querySelector('button')!.click());
        expect(document.activeElement).toBe(find('approve'));
    } finally {
        await act(async () => root.unmount());
        container.remove();
        window.matchMedia = previousMatchMedia;
        Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: previousAnimate });
        vi.unstubAllGlobals();
    }
});

it.each(['back', 'blur'] as const)('keeps stage continuity when a late QR is followed by %s', async (interruption) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('CSS', { escape: (id: string) => id });
    setReducedMotionPreferenceOverride(false);
    const previousAnimate = HTMLElement.prototype.animate;
    Object.defineProperty(HTMLElement.prototype, 'animate', {
        configurable: true, value: () => ({ onfinish: null, cancel() {} }),
    });
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        if (this.dataset.testid === 'open-approval') return new DOMRect(30, 100, 120, 32);
        if (this.dataset.testid === 'approval-title') return new DOMRect(60, 130, 240, 42);
        if (this.dataset.testid === 'late-qr') return new DOMRect(80, 210, 228, 228);
        return new DOMRect(20, 40, 400, 520);
    });
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const settled = vi.fn();
    let showQr = () => {};
    function Approve() {
        const focal = useStepFocal();
        const [ready, setReady] = React.useState(false);
        showQr = () => setReady(true);
        return <><h1 data-testid="approval-title">Approve</h1>{ready && <div ref={focal} data-testid="late-qr" />}</>;
    }
    function Journey() {
        const [approve, setApprove] = React.useState(false);
        return <StepMotionStage>
            <button data-testid="back" onClick={() => runStepMove({ layer: 'workflow', kind: 'back', commit: () => setApprove(false) })}>Back</button>
            <StepMotionLayer layerKey="workflow" stepKey={approve ? 'approve' : 'welcome'} backTestID="back">
                {approve ? <Approve /> : <button data-testid="open-approval" onClick={() => runStepMove({
                    layer: 'workflow', kind: 'step', commit: () => setApprove(true), onSettled: settled,
                })}>Log in</button>}
            </StepMotionLayer>
        </StepMotionStage>;
    }
    const find = (testID: string) => container.querySelector<HTMLElement>(`[data-testid="${testID}"]`)!;
    const travellerAt = (elapsed: number) => typeof stageScene === 'function' ? stageScene(elapsed).find(layer => layer.kind === 'traveller') : undefined;
    try {
        await act(async () => root.render(<Journey />));
        await act(async () => { await vi.dynamicImportSettled(); });
        await act(async () => {
            pointerDown(find('open-approval'), 1);
            click(find('open-approval'), 1);
        });
        const forward = travellerAt(0.368);
        expect(forward).toBeDefined();
        await act(async () => showQr());
        expect(document.activeElement).toBe(find('late-qr'));
        clock.mockReturnValue(1368);
        if (interruption === 'back') {
            await act(async () => { find('back').click(); });
            const reverse = travellerAt(0);
            expect(reverse?.stepMorphProgress).toBeCloseTo(forward!.stepMorphProgress);
            expect(reverse?.particles.length).toBe(forward!.particles.length);
            expect(reverse?.particles.every((value, index) => value === forward!.particles[index])).toBe(true);
            expect(document.activeElement).toBe(find('open-approval'));
        } else {
            expect(document.visibilityState).toBe('visible');
            expect(desktopEvents.has('tauri://blur')).toBe(true);
            await act(async () => { desktopEvents.get('tauri://blur')?.(); });
            expect(document.querySelector('[aria-hidden="true"][style*="position: fixed"]')).toBeNull();
            expect(document.activeElement).toBe(find('late-qr'));
        }
        expect(settled).toHaveBeenCalledExactlyOnceWith('skipped');
    } finally {
        await act(async () => { desktopEvents.get('tauri://focus')?.(); root.unmount(); });
        container.remove();
        rect.mockRestore();
        clock.mockRestore();
        Object.defineProperty(HTMLElement.prototype, 'animate', { value: previousAnimate });
        setReducedMotionPreferenceOverride(null);
        vi.unstubAllGlobals();
    }
});

it.each([false, true])('hands focus to the arriving QR only if it stayed on the heading (user moved: %s)', async (userMoved) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    setReducedMotionPreferenceOverride(true);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let showQr = () => {};
    function Approve() {
        const focal = useStepFocal();
        const [ready, setReady] = React.useState(false);
        showQr = () => setReady(true);
        return <>
            <h1>Approve</h1>
            {ready && <div ref={focal} data-testid="approval-code" />}
            <button>Use a recovery key</button>
        </>;
    }
    function Journey() {
        const [approve, setApprove] = React.useState(false);
        return <StepMotionStage>
            <StepMotionLayer layerKey="workflow" stepKey={approve ? 'approve' : 'welcome'}>
                {approve ? <Approve /> : <button onClick={() => runStepMove({
                    layer: 'workflow', kind: 'step', commit: () => setApprove(true),
                })}>Log in</button>}
            </StepMotionLayer>
        </StepMotionStage>;
    }
    try {
        await act(async () => root.render(<Journey />));
        await act(async () => container.querySelector('button')!.click());
        expect(document.activeElement).toBe(container.querySelector('h1'));
        if (userMoved) container.querySelector('button')!.focus();
        await act(async () => showQr());
        expect(document.activeElement).toBe(container.querySelector(userMoved ? 'button' : '[data-testid="approval-code"]'));
    } finally {
        await act(async () => root.unmount());
        container.remove();
        setReducedMotionPreferenceOverride(null);
        vi.unstubAllGlobals();
    }
});

it('moves between retained standalone routes and restores the opener through the same stage', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('CSS', { escape: (id: string) => id });
    setReducedMotionPreferenceOverride(true);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    function Routes() {
        const [manual, setManual] = React.useState(false);
        return <StepMotionStage>
            <StepMotionLayer layerKey="workflow" active={!manual}>
                <button data-testid="restore-manual" onClick={() => runStepMove({
                    layer: 'workflow', kind: 'step', commit: () => setManual(true),
                })}>Use a recovery key</button>
            </StepMotionLayer>
            <StepMotionLayer layerKey="workflow" active={manual} backTestID="restore-manual-back">
                <h1>Recovery key</h1>
                <button data-testid="restore-manual-back" onClick={() => runStepMove({
                    layer: 'workflow', kind: 'back', commit: () => setManual(false),
                })}>Back</button>
            </StepMotionLayer>
        </StepMotionStage>;
    }
    try {
        await act(async () => root.render(<Routes />));
        const opener = container.querySelector<HTMLButtonElement>('[data-testid="restore-manual"]')!;
        await act(async () => { pointerDown(opener, 1); click(opener, 1); });
        expect(document.activeElement).toBe(container.querySelector('h1'));
        await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="restore-manual-back"]')!.click());
        expect(document.activeElement).toBe(opener);
    } finally {
        await act(async () => root.unmount());
        container.remove();
        setReducedMotionPreferenceOverride(null);
        vi.unstubAllGlobals();
    }
});

it('captures the approved step for one Home landing and holds the tour until the move settles', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    setReducedMotionPreferenceOverride(false);
    const previousAnimate = HTMLElement.prototype.animate;
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 40, 280, 420));
    const frozenEffects: Array<ReturnType<typeof collectEffect>> = [];
    function collectEffect(frames: Keyframe[], duration: number) {
        return { frames, duration, animation: { onfinish: null as (() => void) | null, cancel() {} } };
    }
    Object.defineProperty(HTMLElement.prototype, 'animate', {
        configurable: true,
        value(this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
            const effect = collectEffect(frames, Number(options.duration));
            if (this.style.position === 'fixed' && this.getAttribute('aria-hidden') === 'true') frozenEffects.push(effect);
            return effect.animation;
        },
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const copies: HTMLElement[] = [];
    const observer = new MutationObserver(records => {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node instanceof HTMLElement && node.inert && node.getAttribute('aria-hidden') === 'true') copies.push(node);
            }
        }
    });
    observer.observe(document.body, { childList: true });
    const applyHome = vi.fn();
    function Journey() {
        const [home, setHome] = React.useState(false);
        return <StepMotionStage>{home ? (
            <StepMotionLayer key="home" layerKey="home" warmOnMount={false}><h1>Home</h1></StepMotionLayer>
        ) : (
            <StepMotionLayer key="workflow" layerKey="workflow"><button onClick={() => {
                resolvePostAuthLanding({ replace: href => {
                    applyHome(href);
                    setHome(true);
                } });
            }}>Approved</button></StepMotionLayer>
        )}</StepMotionStage>;
    }
    try {
        await act(async () => root.render(<Journey />));
        await act(async () => { await vi.dynamicImportSettled(); });
        await act(async () => container.querySelector('button')!.click());
        const copy = document.body.querySelector<HTMLElement>('[aria-hidden="true"][style*="position: fixed"]');
        expect(copy?.isConnected).toBe(true);
        expect(copies).toEqual([copy]);
        expect(applyHome).toHaveBeenCalledExactlyOnceWith('/');
        expect(isShowcaseHomeLandingPending()).toBe(true);
        expect(container.querySelector('button')).toBeNull();
        expect(frozenEffects).toHaveLength(1);
        const [dissolve] = frozenEffects;
        expect(dissolve.frames[0]?.opacity).toBe(1);
        expect(dissolve.frames.at(-1)?.opacity).toBe(0);
        expect(dissolve.duration).toBeLessThan(1_050);
        dissolve.animation.onfinish?.();
        expect(copy?.isConnected).toBe(false);
        expect(isShowcaseHomeLandingPending()).toBe(true);
        await act(async () => skipStepMotion());
        expect(isShowcaseHomeLandingPending()).toBe(false);
    } finally {
        observer.disconnect();
        await act(async () => root.unmount());
        container.remove();
        rect.mockRestore();
        Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: previousAnimate });
        setReducedMotionPreferenceOverride(null);
        vi.unstubAllGlobals();
    }
});
