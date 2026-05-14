import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit';

import type { AgentInputExtraActionChip } from '../agentInputContracts';
import { useAgentInputSelectionOverlayController } from './useAgentInputSelectionOverlayController';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useAgentInputSelectionOverlayController', () => {
    it('toggles the active selection overlay and switches anchors when another overlay opens', async () => {
        const hook = await renderHook(() => useAgentInputSelectionOverlayController({
            shouldRenderSessionModeChip: true,
            canChangePermission: true,
            hasMachinePopover: true,
            hasPathPopover: true,
            hasResumePopover: true,
            hasProfilePopover: true,
            hasEnvVarsPopover: true,
            hasAgentPickerOptions: true,
            extraActionChips: [],
        }));

        expect(hook.getCurrent().activeSelectionOverlay).toBeNull();

        await act(async () => {
            hook.getCurrent().toggleSelectionOverlay('agent', 'chip');
        });

        expect(hook.getCurrent().activeSelectionOverlay).toEqual({
            id: 'agent',
            anchor: 'chip',
        });
        expect(hook.getCurrent().isSelectionOverlayOpen('agent')).toBe(true);

        await act(async () => {
            hook.getCurrent().toggleSelectionOverlay('agent', 'chip');
        });

        expect(hook.getCurrent().activeSelectionOverlay).toBeNull();

        await act(async () => {
            hook.getCurrent().openSelectionOverlay('profile', 'actionMenu');
        });

        expect(hook.getCurrent().activeSelectionOverlay).toEqual({
            id: 'profile',
            anchor: 'actionMenu',
        });

        await act(async () => {
            hook.getCurrent().openSelectionOverlay('envVars', 'chip');
        });

        expect(hook.getCurrent().activeSelectionOverlay).toEqual({
            id: 'envVars',
            anchor: 'chip',
        });

        await act(async () => {
            hook.getCurrent().openSelectionOverlay('machine', 'chip');
        });

        expect(hook.getCurrent().activeSelectionOverlay).toEqual({
            id: 'machine',
            anchor: 'chip',
        });

        await act(async () => {
            hook.getCurrent().openSelectionOverlay('path', 'chip');
        });

        expect(hook.getCurrent().activeSelectionOverlay).toEqual({
            id: 'path',
            anchor: 'chip',
        });

        await hook.unmount();
    });

    it('tracks collapsed extra chips and clears them when the chip disappears', async () => {
        const extraActionChips = [{
            key: 'checkout',
            controlId: 'checkout',
            label: 'Checkout',
            icon: null,
            collapsedOptionsPopover: {
                title: 'Checkout',
                options: [{ id: 'main', label: 'main' }],
                onSelect: () => undefined,
            },
        }] as any;

        const hook = await renderHook(
            ({ nextExtraActionChips }: { nextExtraActionChips: typeof extraActionChips }) =>
                useAgentInputSelectionOverlayController({
                    shouldRenderSessionModeChip: true,
                    canChangePermission: true,
                    hasMachinePopover: false,
                    hasPathPopover: false,
                    hasResumePopover: false,
                    hasProfilePopover: true,
                    hasEnvVarsPopover: true,
                    hasAgentPickerOptions: true,
                    extraActionChips: nextExtraActionChips,
                }),
            {
                initialProps: { nextExtraActionChips: extraActionChips },
            },
        );

        await act(async () => {
            hook.getCurrent().openSelectionOverlay('collapsedExtra', 'actionMenu', 'checkout');
        });

        expect(hook.getCurrent().activeSelectionOverlay).toEqual({
            id: 'collapsedExtra',
            anchor: 'actionMenu',
            chipKey: 'checkout',
        });
        expect(hook.getCurrent().activeExtraCollapsedPopoverChip?.key).toBe('checkout');

        await act(async () => {
            hook.getCurrent().openSelectionOverlay('agent', 'chip');
        });

        expect(hook.getCurrent().activeSelectionOverlay).toEqual({
            id: 'agent',
            anchor: 'chip',
        });
        expect(hook.getCurrent().activeExtraCollapsedPopoverChip).toBeNull();

        await act(async () => {
            hook.getCurrent().openSelectionOverlay('collapsedExtra', 'actionMenu', 'checkout');
        });

        await hook.rerender({ nextExtraActionChips: [] as any });

        expect(hook.getCurrent().activeSelectionOverlay).toBeNull();
        expect(hook.getCurrent().activeExtraCollapsedPopoverChip).toBeNull();

        await hook.unmount();
    });

    it('treats collapsed extra content popovers as supported overlays', async () => {
        const extraActionChips = [{
            key: 'mcp',
            controlId: 'mcp',
            collapsedContentPopover: {
                title: 'MCP',
                renderContent: () => null,
            },
        }] as any;

        const hook = await renderHook(
            ({ nextExtraActionChips }: { nextExtraActionChips: typeof extraActionChips }) =>
                useAgentInputSelectionOverlayController({
                    shouldRenderSessionModeChip: true,
                    canChangePermission: true,
                    hasMachinePopover: false,
                    hasPathPopover: false,
                    hasResumePopover: false,
                    hasProfilePopover: true,
                    hasEnvVarsPopover: true,
                    hasAgentPickerOptions: true,
                    extraActionChips: nextExtraActionChips,
                }),
            {
                initialProps: { nextExtraActionChips: extraActionChips },
            },
        );

        await act(async () => {
            hook.getCurrent().openSelectionOverlay('collapsedExtra', 'actionMenu', 'mcp');
        });

        expect(hook.getCurrent().activeSelectionOverlay).toEqual({
            id: 'collapsedExtra',
            anchor: 'actionMenu',
            chipKey: 'mcp',
        });
        expect(hook.getCurrent().activeExtraCollapsedPopoverChip?.key).toBe('mcp');

        await hook.rerender({ nextExtraActionChips: [] as any });

        expect(hook.getCurrent().activeSelectionOverlay).toBeNull();
        expect(hook.getCurrent().activeExtraCollapsedPopoverChip).toBeNull();

        await hook.unmount();
    });

    it('rejects malformed picker collapsed extra popovers that only provide a list root step', async () => {
        // Boundary fixture: models a dynamic descriptor that bypassed the
        // discriminated union before reaching the overlay controller.
        const malformedPickerChip = {
            key: 'malformed-picker',
            controlId: 'recipient',
            collapsedOptionsPopover: {
                presentation: 'picker',
                title: 'Recipient',
                rootStep: {
                    id: 'recipient-root',
                    title: 'Recipient',
                    sections: [],
                },
                onSelect: () => undefined,
            },
            render: () => null,
        } as unknown as AgentInputExtraActionChip;

        const hook = await renderHook(() =>
            useAgentInputSelectionOverlayController({
                shouldRenderSessionModeChip: true,
                canChangePermission: true,
                hasMachinePopover: false,
                hasPathPopover: false,
                hasResumePopover: false,
                hasProfilePopover: true,
                hasEnvVarsPopover: true,
                hasAgentPickerOptions: true,
                extraActionChips: [malformedPickerChip],
            }),
        );

        await act(async () => {
            hook.getCurrent().openSelectionOverlay('collapsedExtra', 'actionMenu', 'malformed-picker');
        });

        expect(hook.getCurrent().activeSelectionOverlay).toBeNull();
        expect(hook.getCurrent().activeExtraCollapsedPopoverChip).toBeNull();

        await hook.unmount();
    });

    it('closes overlays when their backing capability disappears', async () => {
        const hook = await renderHook(
            ({
                shouldRenderSessionModeChip,
                hasAgentPickerOptions,
            }: {
                shouldRenderSessionModeChip: boolean;
                hasAgentPickerOptions: boolean;
            }) => useAgentInputSelectionOverlayController({
                shouldRenderSessionModeChip,
                canChangePermission: true,
                hasMachinePopover: false,
                hasPathPopover: false,
                hasResumePopover: false,
                hasProfilePopover: true,
                hasEnvVarsPopover: true,
                hasAgentPickerOptions,
                extraActionChips: [],
            }),
            {
                initialProps: {
                    shouldRenderSessionModeChip: true,
                    hasAgentPickerOptions: true,
                },
            },
        );

        await act(async () => {
            hook.getCurrent().openSelectionOverlay('sessionMode', 'chip');
        });
        expect(hook.getCurrent().isSelectionOverlayOpen('sessionMode')).toBe(true);

        await hook.rerender({
            shouldRenderSessionModeChip: false,
            hasAgentPickerOptions: true,
        });
        expect(hook.getCurrent().activeSelectionOverlay).toBeNull();

        await act(async () => {
            hook.getCurrent().openSelectionOverlay('agent', 'chip');
        });
        expect(hook.getCurrent().isSelectionOverlayOpen('agent')).toBe(true);

        await hook.rerender({
            shouldRenderSessionModeChip: false,
            hasAgentPickerOptions: false,
        });
        expect(hook.getCurrent().activeSelectionOverlay).toBeNull();

        await hook.unmount();
    });
});
