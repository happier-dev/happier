import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from '../agentInputTestHelpers';
import type { SelectionListStep } from '@/components/ui/selectionList';
import type { AgentInputExtraActionChip } from '../agentInputContracts';
import { buildOverlayLayerFixture } from './__tests__/buildOverlayLayerFixture';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Capture = {
    selectionListProps: Record<string, unknown> | null;
    descriptorOnSelectCalls: Array<string>;
    overlayCloseCalls: number;
    perOptionOnSelectCalls: Array<string>;
};

const capture: Capture = {
    selectionListProps: null,
    descriptorOnSelectCalls: [],
    overlayCloseCalls: 0,
    perOptionOnSelectCalls: [],
};

function resetCapture(): void {
    capture.selectionListProps = null;
    capture.descriptorOnSelectCalls = [];
    capture.overlayCloseCalls = 0;
    capture.perOptionOnSelectCalls = [];
}

installAgentInputCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'web' },
        });
    },
});

vi.mock('@/components/ui/popover', () => ({
    Popover: (props: Record<string, unknown> & { open?: boolean; children?: React.ReactNode | ((args: { maxHeight: number }) => React.ReactNode) }) => {
        const child = typeof props.children === 'function'
            ? props.children({ maxHeight: 312 })
            : props.children ?? null;
        return React.createElement('Popover', props, props.open ? child : null);
    },
    PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('./AgentInputSelectionListPopover', () => ({
    AgentInputSelectionListPopover: (props: Record<string, unknown>) => {
        capture.selectionListProps = props;
        return React.createElement('AgentInputSelectionListPopover', props, null);
    },
}));

vi.mock('./AgentInputChipPickerPopover', () => ({
    AgentInputChipPickerPopover: (props: Record<string, unknown>) => {
        return React.createElement('AgentInputChipPickerPopover', props, null);
    },
}));

vi.mock('./AgentInputChipPickerLayout', () => ({
    shouldShowAgentInputChipPickerRail: () => true,
}));

vi.mock('./AgentInputContentPopover', () => ({
    AgentInputContentPopover: () => null,
}));

vi.mock('./AgentInputActionMenuPopoverContent', () => ({
    AgentInputActionMenuPopoverContent: () => null,
}));

vi.mock('./PermissionModePicker', () => ({
    PermissionModePicker: () => null,
}));

vi.mock('@/sync/domains/permissions/permissionModeOptions', () => ({
    getPermissionModeTitleForAgentType: () => 'Permissions',
}));

const baseRootStep: SelectionListStep = {
    id: 'root',
    title: 'Root',
    sections: [
        {
            kind: 'static',
            id: 'main',
            options: [
                { id: 'one', label: 'One' },
                { id: 'two', label: 'Two' },
            ],
        },
    ],
};

const baseOverlayProps = buildOverlayLayerFixture({
    onActiveExtraCollapsedPopoverChipClose: () => {
        capture.overlayCloseCalls += 1;
    },
});

function buildChipWithListPresentation(rootStep: SelectionListStep): AgentInputExtraActionChip {
    return {
        key: 'feature-x',
        controlId: 'recipient',
        collapsedOptionsPopover: {
            presentation: 'list',
            title: 'feature.x.title',
            label: 'X',
            rootStep,
            selectedOptionId: 'one',
            onSelect: (id) => {
                capture.descriptorOnSelectCalls.push(id);
            },
        },
        render: () => null,
    };
}

/**
 * R16c — Major 7: the `presentation: 'list'` branch in
 * `AgentInputOverlayLayer` previously invoked TWO close paths inside its
 * `onSelect` wrapper:
 *   1. `popover.onSelect(selectedId)` (descriptor-level no-op for the
 *      checkout chip; could also drive caller-owned close logic).
 *   2. `props.onActiveExtraCollapsedPopoverChipClose()` (the unified overlay-
 *      controller close).
 *
 * Per-row `SelectionListOption.onSelect` callbacks ALSO close their own
 * legacy state (e.g. `setCheckoutPickerOpen(false)`), so a triple-close was
 * possible after rapid interactions. Worse, the double wrapper-call meant
 * the descriptor-level `onSelect` could observe a state-versus-overlay race.
 *
 * Fix: for the `'list'` branch the wrapper invokes ONLY the overlay-
 * controller close. The descriptor-level `onSelect` is not called by the
 * wrapper because each `SelectionListOption.onSelect` already runs inside
 * the SelectionList — that is the canonical action source for list-mode
 * chips (per the chip authoring contract; see
 * useNewSessionCheckoutActionChip.tsx where the descriptor-level onSelect
 * is documented as a no-op).
 *
 * The `presentation: 'picker'` branch keeps its existing behaviour (the
 * picker has no per-option callbacks; its descriptor-level onSelect IS the
 * action source).
 */
/**
 * FR4-W1-CHIP: the wrapper `AgentInputSelectionListPopover` is the SINGLE
 * close-after-select owner. The action-menu `presentation: 'list'` branch
 * must pass a no-op `onSelect` to the wrapper and let the wrapper defer
 * `onRequestClose` (which IS `onActiveExtraCollapsedPopoverChipClose`). The
 * branch must NOT separately call `deferAgentInputPopoverClose(...)` — doing
 * so schedules a duplicate close.
 */
describe("AgentInputOverlayLayer presentation:'list' sole-close-ownership (FR4-W1-CHIP)", () => {
    it("wrapper-level onSelect does NOT call any close path (the wrapper owns close via onRequestClose)", async () => {
        resetCapture();
        vi.useFakeTimers();
        try {
            const { AgentInputOverlayLayer } = await import('./AgentInputOverlayLayer');
            const chip = buildChipWithListPresentation(baseRootStep);
            await renderScreen(
                <AgentInputOverlayLayer
                    {...baseOverlayProps}
                    activeExtraCollapsedPopoverChip={chip}
                />,
            );

            expect(capture.selectionListProps).not.toBeNull();
            const wrapperOnSelect = capture.selectionListProps?.onSelect as (id: string) => void;
            const wrapperOnRequestClose = capture.selectionListProps?.onRequestClose as () => void;
            expect(typeof wrapperOnSelect).toBe('function');
            expect(typeof wrapperOnRequestClose).toBe('function');

            wrapperOnSelect('one');

            // Critical: invoking the wrapper-level onSelect must NOT trigger
            // any deferred close — the wrapper owns the close path through
            // its internal defer + onRequestClose.
            vi.runAllTimers();
            expect(capture.overlayCloseCalls).toBe(0);

            // onRequestClose IS `onActiveExtraCollapsedPopoverChipClose` and is
            // the single close path called by the wrapper after defer.
            wrapperOnRequestClose();
            expect(capture.overlayCloseCalls).toBe(1);

            // No descriptor-level onSelect either.
            expect(capture.descriptorOnSelectCalls).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("AgentInputOverlayLayer presentation:'list' close routing (R16c Major 7 + FR4-W1-CHIP)", () => {
    it("the wrapper's onRequestClose is the SOLE close path (and does NOT also call the descriptor-level onSelect)", async () => {
        // FR4-W1-CHIP: the wrapper `AgentInputSelectionListPopover` owns the
        // close-after-select path. The action-menu list branch passes a no-op
        // `onSelect`; the close goes through `onRequestClose` (which IS
        // `onActiveExtraCollapsedPopoverChipClose`). Because the production
        // wrapper defers `onRequestClose` on web, the mocked wrapper here
        // exposes both callbacks directly for verification.
        resetCapture();
        const { AgentInputOverlayLayer } = await import('./AgentInputOverlayLayer');
        const chip = buildChipWithListPresentation(baseRootStep);
        await renderScreen(
            <AgentInputOverlayLayer
                {...baseOverlayProps}
                activeExtraCollapsedPopoverChip={chip}
            />,
        );
        expect(capture.selectionListProps).not.toBeNull();
        const wrapperOnSelect = capture.selectionListProps?.onSelect as (id: string) => void;
        const wrapperOnRequestClose = capture.selectionListProps?.onRequestClose as () => void;
        expect(typeof wrapperOnSelect).toBe('function');
        expect(typeof wrapperOnRequestClose).toBe('function');

        // Wrapper-level onSelect is a no-op (no close path of any kind).
        wrapperOnSelect('one');
        expect(capture.overlayCloseCalls).toBe(0);
        expect(capture.descriptorOnSelectCalls).toEqual([]);

        // onRequestClose IS the single close path.
        wrapperOnRequestClose();
        expect(capture.overlayCloseCalls).toBe(1);
        expect(capture.descriptorOnSelectCalls).toEqual([]);
    });

    it("does not desync after rapid repeated wrapper-onSelect invocations (no extra close paths schedule)", async () => {
        resetCapture();
        const { AgentInputOverlayLayer } = await import('./AgentInputOverlayLayer');
        const chip = buildChipWithListPresentation(baseRootStep);
        await renderScreen(
            <AgentInputOverlayLayer
                {...baseOverlayProps}
                activeExtraCollapsedPopoverChip={chip}
            />,
        );
        const wrapperOnSelect = capture.selectionListProps?.onSelect as (id: string) => void;
        const wrapperOnRequestClose = capture.selectionListProps?.onRequestClose as () => void;
        // Multiple wrapper-onSelect invocations do NOT schedule any close path.
        wrapperOnSelect('one');
        wrapperOnSelect('two');
        wrapperOnSelect('one');
        expect(capture.overlayCloseCalls).toBe(0);

        // Close happens via onRequestClose, called by the wrapper's deferred
        // path in production. In this mocked harness, each explicit
        // onRequestClose call is one close.
        wrapperOnRequestClose();
        wrapperOnRequestClose();
        wrapperOnRequestClose();
        expect(capture.overlayCloseCalls).toBe(3);
        expect(capture.descriptorOnSelectCalls).toEqual([]);
    });

    /**
     * RV-1 (F1): the close-only contract above is correct ONLY because per-row
     * `SelectionListOption.onSelect` callbacks dispatch the action. This test
     * mounts a list-mode chip whose root-step options each carry their own
     * `onSelect`, then verifies the per-option callback is the real action
     * source. Mirrors the SelectionList row-activation contract used in
     * production (`activateSelectionListRow`: option.onSelect first, then
     * orchestrator onSelect — see `SelectionListRowActivation.ts`).
     */
    it('per-option SelectionListOption.onSelect carries the action; wrapper-onSelect is a no-op', async () => {
        resetCapture();
        const { AgentInputOverlayLayer } = await import('./AgentInputOverlayLayer');

        const rootStepWithRowCallbacks: SelectionListStep = {
            id: 'root',
            title: 'Root',
            sections: [
                {
                    kind: 'static',
                    id: 'main',
                    options: [
                        { id: 'one', label: 'One', onSelect: () => capture.perOptionOnSelectCalls.push('one') },
                        { id: 'two', label: 'Two', onSelect: () => capture.perOptionOnSelectCalls.push('two') },
                    ],
                },
            ],
        };
        const chip = buildChipWithListPresentation(rootStepWithRowCallbacks);

        await renderScreen(
            <AgentInputOverlayLayer
                {...baseOverlayProps}
                activeExtraCollapsedPopoverChip={chip}
            />,
        );

        const passedRootStep = capture.selectionListProps?.rootStep as SelectionListStep;
        const section = passedRootStep.sections[0];
        if (section.kind !== 'static') throw new Error('expected static section');
        const optionTwo = section.options.find((option) => option.id === 'two');
        optionTwo?.onSelect?.();

        // Per-option onSelect dispatched the action synchronously.
        expect(capture.perOptionOnSelectCalls).toEqual(['two']);

        // wrapper-onSelect is a no-op; it does NOT close.
        const wrapperOnSelect = capture.selectionListProps?.onSelect as (id: string) => void;
        wrapperOnSelect('two');
        expect(capture.overlayCloseCalls).toBe(0);

        // onRequestClose IS the canonical close path.
        const wrapperOnRequestClose = capture.selectionListProps?.onRequestClose as () => void;
        wrapperOnRequestClose();
        expect(capture.overlayCloseCalls).toBe(1);
        expect(capture.descriptorOnSelectCalls).toEqual([]);
    });
});
