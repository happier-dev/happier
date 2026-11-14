// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * react-native-web's `onLayout` owner (`useElementLayout`, patched in patches/react-native-web@0.21.2.patch)
 * shares one ResizeObserver. A window resize delivers every changed View in one observer callback.
 */
const observerCallbacks: ResizeObserverCallback[] = [];
const observed = new Set<Element>();

class TestResizeObserver implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) { observerCallbacks.push(callback); }
    disconnect(): void { observed.clear(); }
    observe(target: Element): void { observed.add(target); }
    unobserve(target: Element): void { observed.delete(target); }
}
vi.stubGlobal('ResizeObserver', TestResizeObserver);

const { View } = await import('react-native-web');

function deliverResize(targets: readonly Element[]): void {
    const entries = targets.map(target => ({ target }) as unknown as ResizeObserverEntry);
    for (const callback of observerCallbacks) callback(entries, {} as ResizeObserver);
}

describe('react-native-web onLayout on a resize', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        vi.useFakeTimers();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });
    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        vi.useRealTimers();
    });

    it('measures every View the resize changed in one deferred pass and commits their layouts together', () => {
        const VIEW_COUNT = 30;
        const layouts: number[] = [];
        let commits = 0;
        function Measured(props: Readonly<{ index: number; onWidth: (index: number) => void }>) {
            return <View testID={`measured-${props.index}`} onLayout={() => props.onWidth(props.index)} />;
        }
        function Screen() {
            const [measured, setMeasured] = React.useState(0);
            React.useLayoutEffect(() => { commits += 1; });
            const onWidth = React.useCallback((index: number) => { layouts.push(index); setMeasured(count => count + 1); }, []);
            return <View>{Array.from({ length: VIEW_COUNT }, (_, index) => <Measured key={index} index={index} onWidth={onWidth} />)}{measured < 0 ? null : null}</View>;
        }
        act(() => root.render(<Screen />));
        const targets = [...observed].filter(node => (node as HTMLElement).dataset.testid?.startsWith('measured-'));
        expect(targets).toHaveLength(VIEW_COUNT);
        act(() => { vi.runAllTimers(); });
        layouts.length = 0;
        const commitsBefore = commits;

        act(() => deliverResize(targets));
        // One measurement pass for the whole observer delivery, not one timer per View.
        expect(vi.getTimerCount()).toBe(1);
        act(() => { vi.runOnlyPendingTimers(); });
        expect(layouts).toHaveLength(VIEW_COUNT);
        expect(commits - commitsBefore).toBe(1);
    });
});
