/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import type { GlyphSurfaceProps } from '@/components/atmosphere/glyph/glyphSurfaceTypes';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';

import { StepMotionLayer } from './StepMotionLayer';
import { runStepMove, StepMotionStage } from './StepMotionStage';
import { useStepFocal } from './useStepFocal';

vi.mock('react-native', async () => await vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
// jsdom has no WebGL context. The real stage and scene still prepare every DOM effect.
vi.mock('@/components/atmosphere/glyph/GlyphSurface', () => ({
    GlyphSurface: ({ onReady }: GlyphSurfaceProps) => {
        React.useEffect(() => { onReady?.('ready'); }, [onReady]);
        return null;
    },
}));

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

it('clears the outgoing Home copy on its own dissolve effect', async () => {
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
    function Journey() {
        const [home, setHome] = React.useState(false);
        return <StepMotionStage>{home ? (
            <StepMotionLayer key="home" layerKey="home" warmOnMount={false}><h1>Home</h1></StepMotionLayer>
        ) : (
            <StepMotionLayer key="workflow" layerKey="workflow"><button onClick={() => runStepMove({
                layer: 'workflow', kind: 'home', commit: () => setHome(true),
            })}>Create account</button></StepMotionLayer>
        )}</StepMotionStage>;
    }
    try {
        await act(async () => root.render(<Journey />));
        await act(async () => { await vi.dynamicImportSettled(); });
        await act(async () => container.querySelector('button')!.click());
        const copy = document.body.querySelector<HTMLElement>('[aria-hidden="true"][style*="position: fixed"]');
        expect(copy?.isConnected).toBe(true);
        expect(container.querySelector('button')).toBeNull();
        expect(frozenEffects).toHaveLength(1);
        const [dissolve] = frozenEffects;
        expect(dissolve.frames[0]?.opacity).toBe(1);
        expect(dissolve.frames.at(-1)?.opacity).toBe(0);
        expect(dissolve.duration).toBeLessThan(1_050);
        dissolve.animation.onfinish?.();
        expect(copy?.isConnected).toBe(false);
    } finally {
        await act(async () => root.unmount());
        container.remove();
        rect.mockRestore();
        Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: previousAnimate });
        setReducedMotionPreferenceOverride(null);
        vi.unstubAllGlobals();
    }
});
