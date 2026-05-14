import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from '../agentInputTestHelpers';
import type { SelectionListStep } from '@/components/ui/selectionList';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type CapturedSelectionPopoverProps = Record<string, unknown> & {
    open?: boolean;
    anchorRef?: React.RefObject<any>;
    maxHeightCap?: number;
    maxWidthCap?: number;
    children?: (args: { maxHeight: number }) => React.ReactNode;
    onRequestClose?: () => void;
};

type CapturedSurfaceProps = Record<string, unknown> & {
    maxHeight?: number;
    scrollEnabled?: boolean;
    testID?: string;
    children?: React.ReactNode;
};

type CapturedSelectionListProps = Record<string, unknown> & {
    rootStep?: SelectionListStep;
    selectedOptionId?: string | null;
    onSelect?: (id: string) => void;
    onRequestClose?: () => void;
    maxHeight?: number;
    heightBehavior?: string;
    autoFocusInputOnWeb?: boolean;
};

type State = {
    selectionPopover: CapturedSelectionPopoverProps | null;
    surface: CapturedSurfaceProps | null;
    selectionList: CapturedSelectionListProps | null;
};

const state: State = {
    selectionPopover: null,
    surface: null,
    selectionList: null,
};

// Read accessor that defeats TS's control-flow narrowing of state slots back to
// `null` after the in-test reset assignment (TS can't see the async vi.mock
// factory writes that happen during render).
function snap(): State {
    return state as State;
}

installAgentInputCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'web' },
        });
    },
});

vi.mock('../selection/AgentInputSelectionPopover', () => ({
    AgentInputSelectionPopover: (props: CapturedSelectionPopoverProps) => {
        state.selectionPopover = props;
        const child = typeof props.children === 'function'
            ? props.children({ maxHeight: 312 })
            : null;
        return React.createElement('AgentInputSelectionPopover', props, child);
    },
}));

vi.mock('./AgentInputPopoverSurface', () => ({
    AgentInputPopoverSurface: (props: CapturedSurfaceProps) => {
        state.surface = props;
        return React.createElement('AgentInputPopoverSurface', props, props.children);
    },
}));

vi.mock('@/components/ui/selectionList', () => ({
    SelectionList: (props: CapturedSelectionListProps) => {
        state.selectionList = props;
        return React.createElement('SelectionList', props, null);
    },
}));

const sampleRootStep: SelectionListStep = {
    id: 'root',
    title: 'Root',
    sections: [
        {
            kind: 'static',
            id: 'main',
            options: [
                { id: 'a', label: 'A' },
                { id: 'b', label: 'B' },
            ],
        },
    ],
};

function resetCaptures(): void {
    state.selectionPopover = null;
    state.surface = null;
    state.selectionList = null;
}

describe('AgentInputSelectionListPopover', () => {
    it('mounts the SelectionList inside the shared selection popover shell with the surface scroll disabled', async () => {
        resetCaptures();

        const { AgentInputSelectionListPopover } = await import('./AgentInputSelectionListPopover');
        const anchorRef = { current: { nodeType: 'View' } } as React.RefObject<any>;
        const onRequestClose = vi.fn();
        const onSelect = vi.fn();

        await renderScreen(
            <AgentInputSelectionListPopover
                open
                anchorRef={anchorRef}
                rootStep={sampleRootStep}
                selectedOptionId="a"
                onSelect={onSelect}
                onRequestClose={onRequestClose}
            />,
        );

        // Selection popover shell received the forwarded props and default sizing.
        expect(snap().selectionPopover?.open).toBe(true);
        expect(snap().selectionPopover?.anchorRef).toBe(anchorRef);
        expect(snap().selectionPopover?.onRequestClose).toBe(onRequestClose);
        expect(snap().selectionPopover?.maxHeightCap).toBe(420);
        expect(snap().selectionPopover?.maxWidthCap).toBe(420);

        // Surface forwarded the popover maxHeight and disabled its own scroll because
        // SelectionList owns scroll internally.
        expect(snap().surface?.maxHeight).toBe(312);
        expect(snap().surface?.scrollEnabled).toBe(false);
        expect(snap().surface?.testID).toBe('agent-input-selection-list-popover');

        // SelectionList received the root step, selected option, callbacks, and maxHeight.
        expect(snap().selectionList?.rootStep).toBe(sampleRootStep);
        expect(snap().selectionList?.selectedOptionId).toBe('a');
        expect(snap().selectionList?.onRequestClose).toBe(onRequestClose);
        expect(snap().selectionList?.maxHeight).toBe(312);
        expect(snap().selectionList?.heightBehavior).toBeUndefined();
        expect(snap().selectionList?.autoFocusInputOnWeb).toBe(true);
        // The wrapper bridges SelectionList's (id, option) signature down to the popover's (id)
        // signature. Verify behaviorally by invoking the wrapped handler.
        snap().selectionList?.onSelect?.('b');
        expect(onSelect).toHaveBeenCalledWith('b');
    });

    /**
     * FR3-B (FR3-3): the wrapper's `onSelect` must NOT close the popover
     * synchronously on web. Closing via `onRequestClose` synchronously while a
     * portaled popover unmounts allows the click event to fall through to the
     * underlying chip anchor and immediately re-open the popover. The wrapper
     * routes `onRequestClose` through `deferAgentInputPopoverClose` so the
     * close runs on the next task after the click has fully resolved against
     * the option row.
     */
    it('defers onRequestClose on web after a row selection (avoids web click fall-through)', async () => {
        resetCaptures();
        vi.useFakeTimers();
        try {
            const { AgentInputSelectionListPopover } = await import('./AgentInputSelectionListPopover');
            const anchorRef = { current: { nodeType: 'View' } } as React.RefObject<any>;
            const onRequestClose = vi.fn();
            const onSelect = vi.fn();

            await renderScreen(
                <AgentInputSelectionListPopover
                    open
                    anchorRef={anchorRef}
                    rootStep={sampleRootStep}
                    onSelect={onSelect}
                    onRequestClose={onRequestClose}
                />,
            );

            const wrapperOnSelect = snap().selectionList?.onSelect;
            expect(typeof wrapperOnSelect).toBe('function');

            wrapperOnSelect?.('b');

            // The caller's onSelect runs synchronously so per-row mutations are
            // committed against the still-valid synthetic event...
            expect(onSelect).toHaveBeenCalledWith('b');
            // ...but the close is deferred (NOT yet called).
            expect(onRequestClose).not.toHaveBeenCalled();

            // After the next task, the deferred close fires exactly once.
            vi.runAllTimers();
            expect(onRequestClose).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('honors caller-provided sizing caps and testID overrides', async () => {
        resetCaptures();

        const { AgentInputSelectionListPopover } = await import('./AgentInputSelectionListPopover');
        const anchorRef = { current: { nodeType: 'View' } } as React.RefObject<any>;

        await renderScreen(
            <AgentInputSelectionListPopover
                open
                anchorRef={anchorRef}
                rootStep={sampleRootStep}
                onSelect={() => {}}
                onRequestClose={() => {}}
                maxHeightCap={620}
                maxWidthCap={620}
                testID="my-list-popover"
            />,
        );

        expect(snap().selectionPopover?.maxHeightCap).toBe(620);
        expect(snap().selectionPopover?.maxWidthCap).toBe(620);
        expect(snap().surface?.testID).toBe('my-list-popover');
    });

    it('can forward fixed height behavior to the SelectionList for dynamic typeahead popovers', async () => {
        resetCaptures();

        const { AgentInputSelectionListPopover } = await import('./AgentInputSelectionListPopover');
        const anchorRef = { current: { nodeType: 'View' } } as React.RefObject<any>;

        await renderScreen(
            <AgentInputSelectionListPopover
                open
                anchorRef={anchorRef}
                rootStep={sampleRootStep}
                onSelect={() => {}}
                onRequestClose={() => {}}
                maxHeightCap={620}
                heightBehavior="fixedToMaxHeight"
            />,
        );

        expect(snap().selectionList?.maxHeight).toBe(312);
        expect(snap().selectionList?.heightBehavior).toBe('fixedToMaxHeight');
    });
});
