import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const scrollToOffset = vi.fn();
const scrollToIndex = vi.fn();

vi.mock('@legendapp/list/react-native', () => ({
    LegendList: React.forwardRef(function LegendListStub(_props: Record<string, unknown>, ref: React.Ref<unknown>) {
        React.useImperativeHandle(ref, () => ({ scrollToIndex, scrollToOffset }), []);
        return null;
    }),
}));

const { LegendListCompat } = await import('./LegendListCompat');

/**
 * The compat ref is load-bearing, not decoration.
 *
 * `useSessionListScrollRetention` restores the reader's position by calling `scrollToOffset` through
 * this ref after a session is closed. If the handle stops forwarding, that call becomes a silent
 * no-op: no error, no failing type, just a list that quietly comes back at the top. That is exactly
 * what happened once during this work — an unrelated cleanup deleted the `useImperativeHandle` and
 * nothing failed until it was caught on a device run.
 */
describe('LegendListCompat imperative handle', () => {
    let mounted: ReactTestRenderer | null = null;

    afterEach(() => {
        if (mounted) {
            const current = mounted;
            act(() => current.unmount());
            mounted = null;
        }
        scrollToOffset.mockClear();
        scrollToIndex.mockClear();
    });

    const renderWithRef = () => {
        const ref = React.createRef<{
            scrollToIndex: (params: { index: number }) => void;
            scrollToOffset: (params: { offset: number; animated?: boolean }) => void;
        } | null>();
        act(() => {
            mounted = create(
                <LegendListCompat
                    data={[{ id: 'a' }]}
                    keyExtractor={(item: { id: string }) => item.id}
                    ref={ref as never}
                    renderItem={() => null}
                />,
            );
        });
        return ref;
    };

    it('forwards scrollToOffset to the engine', () => {
        const ref = renderWithRef();

        ref.current?.scrollToOffset({ offset: 1044, animated: false });

        expect(scrollToOffset).toHaveBeenCalledWith({ offset: 1044, animated: false });
    });

    it('forwards scrollToIndex to the engine', () => {
        const ref = renderWithRef();

        ref.current?.scrollToIndex({ index: 12 });

        expect(scrollToIndex).toHaveBeenCalledWith({ index: 12 });
    });
});
