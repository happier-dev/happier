import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

import { useAgentInputSelectionOverlayController } from '../selection/useAgentInputSelectionOverlayController';
import { useAgentInputActionMenuControls } from './useAgentInputActionMenuControls';
import type { AgentInputResolvedControlLines } from './agentInputControlTypes';

const resolved = (collapsed: readonly string[]): AgentInputResolvedControlLines => ({
    primary: [], secondary: [], collapsed, accessories: [], hidden: [], controls: [], effectivePlacements: {},
});

vi.mock('@/components/ui/theme/haptics', () => ({
    hapticsLight: vi.fn(),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});


describe('useAgentInputActionMenuControls', () => {
    it('builds no overflow items while closed and builds only effective overflow on open', async () => {
        let builds = 0;
        const chip = (id: string) => ({
            key: id, controlId: 'shortcuts' as const, placement: { id, title: id }, render: () => null,
            collapsedAction: () => {
                builds += 1;
                return { id, label: id, icon: null, onPress: () => {} };
            },
        });
        const chips = [chip('shortcuts:first'), chip('shortcuts:hidden'), chip('shortcuts:second')];
        const controlLines = resolved(['shortcuts:second', 'shortcuts:first']);
        const hook = await renderHook(({ open }: { open: boolean }) => useAgentInputActionMenuControls({
            resolvedControls: controlLines, showActionMenu: open, setShowActionMenu: vi.fn(),
            closeSelectionOverlay: vi.fn(), openSelectionOverlay: vi.fn(), resetSelectionOverlays: vi.fn(),
            inputRef: { current: null }, hasAgentPickerOptions: false, tint: '#fff', agentId: 'codex',
            profileLabel: null, profileIcon: 'user-circle', openCollapsedOptionsPopover: vi.fn(),
            extraActionChips: chips, hasProfile: false, hasEnvVars: false, hasAgent: false,
        }), { initialProps: { open: false } });
        expect(hook.getCurrent().hasActionMenuPopoverSections).toBe(true);
        expect(hook.getCurrent().actionMenuActions).toEqual([]);
        expect(builds).toBe(0);
        await hook.rerender({ open: true });
        expect(builds).toBe(2);
        expect(hook.getCurrent().actionMenuActions.map((item) => item.id)).toEqual(['shortcuts:second', 'shortcuts:first']);
        await hook.unmount();
    });

    it('opens the collapsed Agent picker when Agent options are available', async () => {
        const hook = await renderHook(() => {
            const controller = useAgentInputSelectionOverlayController({
                shouldRenderSessionModeChip: false,
                canChangePermission: false,
                hasMachinePopover: false,
                hasPathPopover: false,
                hasResumePopover: false,
                hasProfilePopover: false,
                hasEnvVarsPopover: false,
                hasAgentPickerOptions: true,
                extraActionChips: [],
            });
            return {
                ...controller,
                ...useAgentInputActionMenuControls({
                    resolvedControls: resolved(['engine']),
                    showActionMenu: true,
                    setShowActionMenu: vi.fn(),
                    closeSelectionOverlay: controller.closeSelectionOverlay,
                    openSelectionOverlay: controller.openSelectionOverlay,
                    resetSelectionOverlays: controller.resetSelectionOverlays,
                    inputRef: { current: { blur: vi.fn() } } as React.RefObject<{ blur?: () => void } | null>,
                    hasAgentPickerOptions: true,
                    tint: '#fff',
                    agentId: 'codex',
                    profileLabel: null,
                    profileIcon: 'user-circle',
                    openCollapsedOptionsPopover: () => {},
                    sessionModeLabel: null,
                    sessionModeChipInteraction: null,
                    hasProfile: false,
                    hasEnvVars: false,
                    hasAgent: true,
                }),
            };
        });

        await act(async () => {
            hook.getCurrent().actionMenuActions.find((action) => action.id === 'agent')?.onPress?.();
        });

        expect(hook.getCurrent().activeSelectionOverlay).toEqual({ id: 'agent', anchor: 'actionMenu' });
        await hook.unmount();
    });

    it('opens the shared path popover from the collapsed action menu path item', async () => {
        const onPathClick = vi.fn();

        const hook = await renderHook(() => {
            const controller = useAgentInputSelectionOverlayController({
                shouldRenderSessionModeChip: false,
                canChangePermission: false,
                hasMachinePopover: false,
                hasPathPopover: true,
                hasResumePopover: false,
                hasProfilePopover: false,
                hasEnvVarsPopover: false,
                hasAgentPickerOptions: false,
                extraActionChips: [],
            });

            const menu = useAgentInputActionMenuControls({
                resolvedControls: resolved(['path']),
                showActionMenu: true,
                setShowActionMenu: vi.fn(),
                closeSelectionOverlay: controller.closeSelectionOverlay,
                openSelectionOverlay: controller.openSelectionOverlay,
                resetSelectionOverlays: controller.resetSelectionOverlays,
                inputRef: { current: { blur: vi.fn() } } as React.RefObject<{ blur?: () => void } | null>,
                pathPopover: { renderContent: () => null },
                hasAgentPickerOptions: false,
                onPathClick,
                tint: '#fff',
                agentId: 'codex' as never,
                profileLabel: null,
                profileIcon: 'user-circle',
                currentPath: '/repo/current',
                openCollapsedOptionsPopover: () => {},
                sessionModeLabel: null,
                sessionModeChipInteraction: null,
                onMachineClick: undefined,
                onResumeClick: undefined,
                onFileViewerPress: undefined,
                hasProfile: false,
                hasEnvVars: false,
                hasAgent: false,
            });

            return {
                ...controller,
                ...menu,
            };
        });

        const pathAction = hook.getCurrent().actionMenuActions.find((action) => action.id === 'path');
        expect(pathAction).toBeTruthy();

        await act(async () => {
            pathAction?.onPress?.();
        });

        expect(onPathClick).not.toHaveBeenCalled();
        expect(hook.getCurrent().activeSelectionOverlay).toEqual({
            id: 'path',
            anchor: 'actionMenu',
        });

        await hook.unmount();
    });
});
