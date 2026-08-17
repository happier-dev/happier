/**
 * @vitest-environment jsdom
 */
import ReactDefault, * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDemoStageUnmountGate } from './useDemoStageUnmountGate';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function DemoStageUnmountProbe(props: Readonly<{
    onUnmountRequested: (completion: Promise<void>) => void;
}>): React.ReactElement {
    const gate = useDemoStageUnmountGate();

    React.useLayoutEffect(() => {
        gate.setDemoSeeded(true);
    }, [gate.setDemoSeeded]);

    return (
        <div>
            {gate.demoSeeded ? <div data-testid="demo-stage" /> : null}
            <button
                data-testid="skip-to-setup"
                onClick={() => {
                    props.onUnmountRequested(gate.unmountDemoStage());
                }}
            />
        </div>
    );
}

describe('useDemoStageUnmountGate (web)', () => {
    afterEach(() => {
        document.body.replaceChildren();
    });

    it('settles the converged dream-to-setup handler as part of the stage-removal commit', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        const onUnmountRequested = vi.fn<(completion: Promise<void>) => void>();
        const originalUseEffect = ReactDefault.useEffect;
        let suppressPassiveEffects = false;
        const useEffectSpy = vi.spyOn(ReactDefault, 'useEffect').mockImplementation((effect, dependencies) => (
            originalUseEffect(suppressPassiveEffects ? () => undefined : effect, dependencies)
        ));

        try {
            await act(async () => {
                root.render(<DemoStageUnmountProbe onUnmountRequested={onUnmountRequested} />);
            });
            expect(container.querySelector('[data-testid="demo-stage"]')).not.toBeNull();

            const button = container.querySelector<HTMLButtonElement>('[data-testid="skip-to-setup"]');
            expect(button).not.toBeNull();
            const actEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
            try {
                // Deliberately exercise a browser event outside `act`: wrapping the
                // click would flush passive effects and mask the production stall.
                globalThis.IS_REACT_ACT_ENVIRONMENT = false;
                // The loaded browser reproduced a passive-effect stall. Hold that
                // scheduler lane here: commit-phase acknowledgement must still
                // settle the real handler returned by the production hook.
                suppressPassiveEffects = true;
                button!.click();
                await Promise.resolve();
            } finally {
                globalThis.IS_REACT_ACT_ENVIRONMENT = actEnvironment;
            }

            expect(container.querySelector('[data-testid="demo-stage"]')).toBeNull();
            expect(onUnmountRequested).toHaveBeenCalledTimes(1);
            const completion = onUnmountRequested.mock.calls[0]?.[0];
            expect(completion).toBeInstanceOf(Promise);
            const stillPending = Symbol('still-pending');
            await expect(Promise.race([
                completion,
                Promise.resolve(stillPending),
            ])).resolves.toBeUndefined();
        } finally {
            useEffectSpy.mockRestore();
            await act(async () => {
                root.unmount();
            });
        }
    });
});
