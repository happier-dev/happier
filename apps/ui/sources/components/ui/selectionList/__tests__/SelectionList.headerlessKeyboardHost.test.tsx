import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type { SelectionListProps, SelectionListStep } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

/**
 * FR3-4 — Headerless SelectionList (inputless list presentations such as
 * session-mode picker, transcript-storage picker, recipient picker, etc.)
 * omits the `SelectionListSearchHeader` entirely. Before FR3-4 the header was
 * the only mount point for `onKeyPress={handleKeyPress}`, so Arrow / Enter /
 * Escape / Shift+Tab silently stopped working for those chips.
 *
 * The fix mounts a focusable keyboard host on the SelectionList container
 * itself when the header is omitted. On web the container View exposes an
 * `onKeyDown` (or `onKeyPress`-compatible) handler that delegates to the
 * orchestrator's `createSelectionListKeyPressHandler` so the shared keyboard
 * contract (ArrowUp/Down, Enter, Escape, Shift+Tab) works uniformly across
 * both header-present and headerless surfaces.
 */
function makeListOnlyStep(overrides: Partial<SelectionListStep> = {}): SelectionListStep {
    return {
        id: 'root',
        title: 'Storage',
        // No inputPlaceholder — the search header is omitted.
        sections: [
            {
                kind: 'static',
                id: 's',
                options: [
                    { id: 'persisted', label: 'Synced' },
                    { id: 'direct', label: 'Direct' },
                    { id: 'never', label: 'Off' },
                ],
            },
        ],
        ...overrides,
    };
}

function defaultProps(overrides: Partial<SelectionListProps> = {}): SelectionListProps {
    return {
        rootStep: makeListOnlyStep(),
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        keyboardHintsEnabled: false,
        disableTransitions: true,
        testID: 'sl',
        ...overrides,
    };
}

describe('SelectionList headerless keyboard host (FR3-4)', () => {
    it('exposes a keyboard handler on the container root when the search header is omitted', async () => {
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps()} />);
        // Sanity: confirm header is NOT mounted (per RV-1 routing-2 gate).
        expect(screen.findByTestId('sl:header')).toBeNull();
        // The headerless keyboard host MUST expose `onKeyDown` (web) on the
        // container so Arrow / Enter / Escape / Shift+Tab work uniformly.
        const container = screen.findByTestId('sl');
        expect(container).not.toBeNull();
        const props = (container as unknown as { props: Record<string, unknown> }).props;
        expect(typeof props.onKeyDown === 'function' || typeof props.onKeyPress === 'function').toBe(true);
    });

    it('handles ArrowDown via the headerless keyboard host', async () => {
        const { act } = await import('react-test-renderer');
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps()} />);
        const container = screen.findByTestId('sl');
        expect(container).not.toBeNull();
        const props = (container as unknown as { props: Record<string, unknown> }).props;
        const handler = (props.onKeyDown ?? props.onKeyPress) as ((evt: unknown) => void) | undefined;
        expect(typeof handler).toBe('function');
        // ArrowDown should be consumed (preventDefault called) by the
        // SelectionList keyboard dispatcher.
        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();
        await act(async () => {
            handler!({
                key: 'ArrowDown',
                preventDefault,
                stopPropagation,
            });
        });
        expect(preventDefault).toHaveBeenCalled();
    });

    it('routes Escape to onRequestClose via the headerless keyboard host', async () => {
        const { act } = await import('react-test-renderer');
        const { SelectionList } = await import('../SelectionList');
        const onRequestClose = vi.fn();
        const screen = await renderScreen(
            <SelectionList {...defaultProps({ onRequestClose })} />,
        );
        const container = screen.findByTestId('sl');
        const props = (container as unknown as { props: Record<string, unknown> }).props;
        const handler = (props.onKeyDown ?? props.onKeyPress) as ((evt: unknown) => void) | undefined;
        await act(async () => {
            handler!({
                key: 'Escape',
                preventDefault: () => {},
                stopPropagation: () => {},
            });
        });
        expect(onRequestClose).toHaveBeenCalledTimes(1);
    });

    it('routes Enter to onSelect on the focused option via the headerless keyboard host', async () => {
        const { act } = await import('react-test-renderer');
        const { SelectionList } = await import('../SelectionList');
        const onSelect = vi.fn();
        const screen = await renderScreen(
            <SelectionList {...defaultProps({ onSelect })} />,
        );
        const container = screen.findByTestId('sl');
        const props = (container as unknown as { props: Record<string, unknown> }).props;
        const handler = (props.onKeyDown ?? props.onKeyPress) as ((evt: unknown) => void) | undefined;
        // First option is focused by default (`focusedIndex=0`). Enter should
        // activate it.
        await act(async () => {
            handler!({
                key: 'Enter',
                preventDefault: () => {},
                stopPropagation: () => {},
            });
        });
        expect(onSelect).toHaveBeenCalledWith(
            'persisted',
            expect.objectContaining({ id: 'persisted' }),
        );
    });

    it('does NOT expose a redundant container key handler when the search header is mounted', async () => {
        // When the header is mounted, the input row owns the keyboard event
        // surface. The container key handler must NOT be added too, otherwise
        // events would fire twice when bubbling up from the input.
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList
                {...defaultProps({
                    rootStep: makeListOnlyStep({ inputPlaceholder: 'Search' }),
                })}
            />,
        );
        expect(screen.findByTestId('sl:header')).not.toBeNull();
        const container = screen.findByTestId('sl');
        const props = (container as unknown as { props: Record<string, unknown> }).props;
        expect(props.onKeyDown).toBeUndefined();
    });
});
