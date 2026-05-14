import * as React from 'react';
import type { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from '../agentInputTestHelpers';
import type { SelectionListStep } from '@/components/ui/selectionList';
import type { AgentInputExtraActionChip } from '../agentInputContracts';
import { buildOverlayLayerFixture } from './__tests__/buildOverlayLayerFixture';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type CapturedRoutingProps = Record<string, unknown> & {
    open?: boolean;
    anchorRef?: unknown;
    rootStep?: SelectionListStep;
    selectedOptionId?: string | null;
};

type State = {
    selectionList: CapturedRoutingProps | null;
    chipPicker: CapturedRoutingProps | null;
    autocompleteSelectionPopover: CapturedRoutingProps | null;
    autocomplete: CapturedRoutingProps | null;
    contentPopovers: CapturedRoutingProps[];
};

const state: State = {
    selectionList: null,
    chipPicker: null,
    autocompleteSelectionPopover: null,
    autocomplete: null,
    contentPopovers: [],
};

// Read accessor that defeats TS's control-flow narrowing of state slots back
// to `null` after the in-test reset assignment (TS can't see the async vi.mock
// factory writes that happen during render).
function snap(): State {
    return state as State;
}

function resetCaptures(): void {
    state.selectionList = null;
    state.chipPicker = null;
    state.autocompleteSelectionPopover = null;
    state.autocomplete = null;
    state.contentPopovers = [];
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
    AgentInputSelectionListPopover: (props: CapturedRoutingProps) => {
        state.selectionList = props;
        return React.createElement('AgentInputSelectionListPopover', props, null);
    },
}));

vi.mock('../selection/AgentInputSelectionPopover', () => ({
    AgentInputSelectionPopover: (props: CapturedRoutingProps & {
        children?: React.ReactNode | ((args: { maxHeight: number }) => React.ReactNode);
    }) => {
        state.autocompleteSelectionPopover = props;
        const child = typeof props.children === 'function'
            ? props.children({ maxHeight: 240 })
            : props.children ?? null;
        return React.createElement('AgentInputSelectionPopover', props, props.open ? child : null);
    },
}));

vi.mock('./AgentInputChipPickerPopover', () => ({
    AgentInputChipPickerPopover: (props: CapturedRoutingProps) => {
        state.chipPicker = props;
        return React.createElement('AgentInputChipPickerPopover', props, null);
    },
}));

vi.mock('./AgentInputChipPickerLayout', () => ({
    shouldShowAgentInputChipPickerRail: () => true,
}));

vi.mock('./AgentInputAutocomplete', () => ({
    AgentInputAutocomplete: (props: CapturedRoutingProps) => {
        state.autocomplete = props;
        return React.createElement('AgentInputAutocomplete', props, null);
    },
}));

vi.mock('./AgentInputContentPopover', () => ({
    AgentInputContentPopover: (props: CapturedRoutingProps) => {
        state.contentPopovers.push(props);
        return React.createElement('AgentInputContentPopover', props, null);
    },
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
            onSelect: () => {},
        },
        render: () => null,
    };
}

function buildChipWithPickerPresentation(): AgentInputExtraActionChip {
    return {
        key: 'feature-z',
        controlId: 'delivery',
        collapsedOptionsPopover: {
            presentation: 'picker',
            title: 'feature.z.title',
            label: 'Z',
            options: [
                { id: 'a', label: 'A' },
                { id: 'b', label: 'B' },
            ],
            selectedOptionId: 'a',
            onSelect: () => {},
        },
        render: () => null,
    };
}

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

const baseOverlayProps = buildOverlayLayerFixture();

describe('AgentInputOverlayLayer presentation routing', () => {
    it('routes autocomplete suggestions through the shared selection popover shell', async () => {
        resetCaptures();

        const { AgentInputOverlayLayer } = await import('./AgentInputOverlayLayer');
        const overlayAnchorRef = { current: null } as React.RefObject<View | null>;

        await renderScreen(
            <AgentInputOverlayLayer
                {...baseOverlayProps}
                overlayAnchorRef={overlayAnchorRef}
                suggestions={[{ key: 'goal', text: '/goal', component: () => React.createElement('View'), rowHeight: 52 }]}
                autocompleteSelectedIndex={0}
                maxWidthCap={640}
            />,
        );

        expect(snap().autocompleteSelectionPopover).not.toBeNull();
        expect(snap().autocompleteSelectionPopover?.open).toBe(true);
        expect(snap().autocompleteSelectionPopover?.anchorRef).toBe(overlayAnchorRef);
        expect(snap().autocompleteSelectionPopover?.maxHeightCap).toBe(240);
        expect(snap().autocompleteSelectionPopover?.maxWidthCap).toBe(640);
        expect(snap().autocomplete?.items).toEqual([
            expect.objectContaining({
                id: 'goal',
                minHeight: 52,
            }),
        ]);
    });

    it('forwards machine content-popover scroll ownership props to the shared content popover', async () => {
        resetCaptures();

        const { AgentInputOverlayLayer } = await import('./AgentInputOverlayLayer');
        const renderContent = () => null;

        await renderScreen(
            <AgentInputOverlayLayer
                {...baseOverlayProps}
                showMachinePopover
                machinePopover={{
                    renderContent,
                    maxHeightCap: 560,
                    maxWidthCap: 560,
                    scrollEnabled: false,
                    edgeFades: { top: true, bottom: true, size: 28 },
                    edgeIndicators: true,
                    initialVisibility: { top: true, bottom: true },
                }}
            />,
        );

        expect(snap().contentPopovers).toHaveLength(1);
        expect(snap().contentPopovers[0]).toEqual(expect.objectContaining({
            content: renderContent,
            maxHeightCap: 560,
            maxWidthCap: 560,
            scrollEnabled: false,
            edgeFades: { top: true, bottom: true, size: 28 },
            edgeIndicators: true,
            initialVisibility: { top: true, bottom: true },
        }));
    });

    it("routes presentation: 'list' through AgentInputSelectionListPopover and forwards the rootStep + selectedOptionId + anchor", async () => {
        resetCaptures();

        const { AgentInputOverlayLayer } = await import('./AgentInputOverlayLayer');

        const chip = buildChipWithListPresentation(baseRootStep);

        await renderScreen(
            <AgentInputOverlayLayer
                {...baseOverlayProps}
                activeExtraCollapsedPopoverChip={chip}
            />,
        );

        expect(snap().selectionList).not.toBeNull();
        expect(snap().selectionList?.open).toBe(true);
        expect(snap().selectionList?.rootStep).toBe(baseRootStep);
        expect(snap().selectionList?.selectedOptionId).toBe('one');
        // The 'list' presentation must NOT mount the legacy chip-picker.
        expect(snap().chipPicker).toBeNull();
    });

    it("routes presentation: 'picker' (default) through AgentInputChipPickerPopover", async () => {
        resetCaptures();

        const { AgentInputOverlayLayer } = await import('./AgentInputOverlayLayer');

        const chip = buildChipWithPickerPresentation();

        await renderScreen(
            <AgentInputOverlayLayer
                {...baseOverlayProps}
                activeExtraCollapsedPopoverChip={chip}
            />,
        );

        expect(snap().chipPicker).not.toBeNull();
        expect(snap().chipPicker?.open).toBe(true);
        expect(snap().selectionList).toBeNull();
    });

    it("dev-warns and renders null when a 'list' descriptor is missing rootStep (R16d Fix 4 — runtime defense against type erasure)", async () => {
        resetCaptures();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const prevDev = (globalThis as any).__DEV__;
        (globalThis as any).__DEV__ = true;
        try {
            const { AgentInputOverlayLayer } = await import('./AgentInputOverlayLayer');
            // Force-cast a structurally invalid descriptor through `any` to
            // bypass R5's compile-time discriminated union (simulating dynamic
            // plugin / settings construction via type erasure).
            const invalidChip = {
                key: 'invalid-list',
                controlId: 'recipient',
                collapsedOptionsPopover: {
                    presentation: 'list',
                    title: 't',
                    onSelect: () => {},
                    // rootStep intentionally missing
                } as any,
                render: () => null,
            } as unknown as AgentInputExtraActionChip;

            await renderScreen(
                <AgentInputOverlayLayer
                    {...baseOverlayProps}
                    activeExtraCollapsedPopoverChip={invalidChip}
                />,
            );

            expect(snap().selectionList).toBeNull();
            expect(snap().chipPicker).toBeNull();
            expect(warnSpy).toHaveBeenCalled();
            const message = String(warnSpy.mock.calls[0]?.[0] ?? '');
            expect(message).toMatch(/list/i);
            expect(message).toMatch(/rootStep/i);
        } finally {
            (globalThis as any).__DEV__ = prevDev;
            warnSpy.mockRestore();
        }
    });

    it("dev-warns and renders null when a 'picker' descriptor is missing options (R16d Fix 4 — runtime defense against type erasure)", async () => {
        resetCaptures();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const prevDev = (globalThis as any).__DEV__;
        (globalThis as any).__DEV__ = true;
        try {
            const { AgentInputOverlayLayer } = await import('./AgentInputOverlayLayer');
            const invalidChip = {
                key: 'invalid-picker',
                controlId: 'recipient',
                collapsedOptionsPopover: {
                    presentation: 'picker',
                    title: 't',
                    onSelect: () => {},
                    // options intentionally missing
                } as any,
                render: () => null,
            } as unknown as AgentInputExtraActionChip;

            await renderScreen(
                <AgentInputOverlayLayer
                    {...baseOverlayProps}
                    activeExtraCollapsedPopoverChip={invalidChip}
                />,
            );

            expect(snap().selectionList).toBeNull();
            expect(snap().chipPicker).toBeNull();
            expect(warnSpy).toHaveBeenCalled();
            const message = String(warnSpy.mock.calls[0]?.[0] ?? '');
            expect(message).toMatch(/picker/i);
            expect(message).toMatch(/options/i);
        } finally {
            (globalThis as any).__DEV__ = prevDev;
            warnSpy.mockRestore();
        }
    });

    it("collapsedOptionsPopover rejects mixed { options, rootStep } shapes at the type level (one-of invariant)", () => {
        // The discriminated union must forbid declaring both `options` and `rootStep`
        // on the same descriptor. This guarantees the routing site never sees a
        // mixed shape at runtime.
        //
        // 1. 'list' with options must be rejected (options must be `undefined`).
        const mixedListChip = {
            key: 'mixed-list',
            controlId: 'recipient',
            collapsedOptionsPopover: {
                presentation: 'list',
                title: 't',
                // @ts-expect-error — 'list' presentation requires `options?: undefined`.
                options: [{ id: 'a', label: 'A' }],
                rootStep: baseRootStep,
                onSelect: () => {},
            },
            render: () => null,
        } satisfies AgentInputExtraActionChip;

        // 2. 'picker' (default) with rootStep must be rejected.
        const mixedPickerChip = {
            key: 'mixed-picker',
            controlId: 'recipient',
            collapsedOptionsPopover: {
                presentation: 'picker',
                title: 't',
                options: [{ id: 'a', label: 'A' }],
                // @ts-expect-error — 'picker' presentation requires `rootStep?: undefined`.
                rootStep: baseRootStep,
                onSelect: () => {},
            },
            render: () => null,
        } satisfies AgentInputExtraActionChip;

        // 3. 'list' missing rootStep must be rejected (rootStep is required).
        const listMissingRootStepChip = {
            key: 'list-no-root-step',
            controlId: 'recipient',
            // @ts-expect-error — 'list' presentation requires `rootStep`.
            collapsedOptionsPopover: {
                presentation: 'list',
                title: 't',
                onSelect: () => {},
            },
            render: () => null,
        } satisfies AgentInputExtraActionChip;

        // 4. 'picker' missing options must be rejected (options is required).
        const pickerMissingOptionsChip = {
            key: 'picker-no-options',
            controlId: 'recipient',
            // @ts-expect-error — 'picker' presentation requires `options`.
            collapsedOptionsPopover: {
                presentation: 'picker',
                title: 't',
                onSelect: () => {},
            },
            render: () => null,
        } satisfies AgentInputExtraActionChip;

        // 5. Default (no presentation) without options must be rejected.
        const defaultMissingOptionsChip = {
            key: 'default-no-options',
            controlId: 'recipient',
            // @ts-expect-error — default 'picker' presentation requires `options`.
            collapsedOptionsPopover: {
                title: 't',
                onSelect: () => {},
            },
            render: () => null,
        } satisfies AgentInputExtraActionChip;

        // 6. Valid 'list' shape compiles.
        const validListChip = {
            key: 'valid-list',
            controlId: 'recipient',
            collapsedOptionsPopover: {
                presentation: 'list' as const,
                title: 't',
                rootStep: baseRootStep,
                onSelect: () => {},
            },
            render: () => null,
        } satisfies AgentInputExtraActionChip;

        // 7. Valid 'picker' shape compiles.
        const validPickerChip = {
            key: 'valid-picker',
            controlId: 'recipient',
            collapsedOptionsPopover: {
                presentation: 'picker' as const,
                title: 't',
                options: [{ id: 'a', label: 'A' }],
                onSelect: () => {},
            },
            render: () => null,
        } satisfies AgentInputExtraActionChip;

        // 8. Valid default (omitted presentation) compiles.
        const validDefaultChip = {
            key: 'valid-default',
            controlId: 'recipient',
            collapsedOptionsPopover: {
                title: 't',
                options: [{ id: 'a', label: 'A' }],
                onSelect: () => {},
            },
            render: () => null,
        } satisfies AgentInputExtraActionChip;

        // Reference the symbols so they are not flagged as unused.
        expect(mixedListChip.key).toBe('mixed-list');
        expect(mixedPickerChip.key).toBe('mixed-picker');
        expect(listMissingRootStepChip.key).toBe('list-no-root-step');
        expect(pickerMissingOptionsChip.key).toBe('picker-no-options');
        expect(defaultMissingOptionsChip.key).toBe('default-no-options');
        expect(validListChip.key).toBe('valid-list');
        expect(validPickerChip.key).toBe('valid-picker');
        expect(validDefaultChip.key).toBe('valid-default');
    });
});
