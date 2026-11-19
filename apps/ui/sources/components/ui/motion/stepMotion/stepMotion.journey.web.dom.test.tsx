/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { StepMotionLayer } from './StepMotionLayer';
import { runStepMove, StepMotionStage } from './StepMotionStage';

vi.mock('react-native', async () => await vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
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
