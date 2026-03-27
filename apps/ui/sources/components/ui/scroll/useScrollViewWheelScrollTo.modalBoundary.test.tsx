import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installModalComponentCommonModuleMocks } from '@/modal/components/modalComponentTestHelpers';

installModalComponentCommonModuleMocks();

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type WheelScrollHandlers = Readonly<{
    onScroll: (event: any) => void;
    onWheel: (event: any) => void;
}>;

describe('useScrollViewWheelScrollTo (modal boundary)', () => {
    it('does not translate wheel deltas when rendered outside a modal boundary by default', async () => {
        const { useScrollViewWheelScrollTo } = await import('./useScrollViewWheelScrollTo');

        const scrollTo = vi.fn();
        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();

        function Capture(props: { handlers: WheelScrollHandlers }) {
            return React.createElement('Capture', props);
        }

        function Harness() {
            const scrollRef = React.useRef<{ scrollTo: typeof scrollTo } | null>({ scrollTo });
            const handlers = useScrollViewWheelScrollTo(scrollRef);
            return <Capture handlers={handlers} />;
        }

        const screen = await renderScreen(<Harness />);
        const resolvedHandlers = screen.findByType('Capture' as any).props.handlers as WheelScrollHandlers;

        resolvedHandlers.onScroll({ nativeEvent: { contentOffset: { y: 40 } } });
        resolvedHandlers.onWheel({ deltaY: 80, cancelable: true, preventDefault, stopPropagation });

        expect(preventDefault).not.toHaveBeenCalled();
        expect(stopPropagation).not.toHaveBeenCalled();
        expect(scrollTo).not.toHaveBeenCalled();
    });

    it('translates wheel deltas when rendered inside BaseModal', async () => {
        const { ModalBoundaryProvider } = await import('@/modal/context/ModalBoundaryContext');
        const { useScrollViewWheelScrollTo } = await import('./useScrollViewWheelScrollTo');

        const scrollTo = vi.fn();
        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();

        function Capture(props: { handlers: WheelScrollHandlers }) {
            return React.createElement('Capture', props);
        }

        function Harness() {
            const scrollRef = React.useRef<{ scrollTo: typeof scrollTo } | null>({ scrollTo });
            const handlers = useScrollViewWheelScrollTo(scrollRef);
            return <Capture handlers={handlers} />;
        }

        const screen = await renderScreen(
            <ModalBoundaryProvider>
                <Harness />
            </ModalBoundaryProvider>,
        );
        const resolvedHandlers = screen.findByType('Capture' as any).props.handlers as WheelScrollHandlers;

        resolvedHandlers.onScroll({ nativeEvent: { contentOffset: { y: 40 } } });
        resolvedHandlers.onWheel({ deltaY: 80, cancelable: true, preventDefault, stopPropagation });

        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(stopPropagation).toHaveBeenCalledTimes(1);
        expect(scrollTo).toHaveBeenCalledWith({ y: 120, animated: false });
    });
});
