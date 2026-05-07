import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';

vi.mock('@/components/ui/theme/haptics', () => ({
    hapticsLight: vi.fn(),
}));

vi.mock('@/text', () => createTextModuleMock());

vi.mock('@/agents/catalog/catalog', () => ({
    getAgentCore: () => ({ displayNameKey: 'agents.codex' }),
    getAgentBehavior: (agentId: string) => ({
        sessionUsage: {
            supportsExactContextUsageBadge: agentId !== 'codex' && agentId !== 'gemini',
        },
    }),
}));

import { useAgentInputSelectionOverlayController } from '../selection/useAgentInputSelectionOverlayController';
import { useAgentInputCoreControlHandlers } from './useAgentInputCoreControlHandlers';

describe('useAgentInputCoreControlHandlers', () => {
    it('cycles the session mode chip when the interaction policy resolves to cycle', async () => {
        const onSessionModeChange = vi.fn();

        const hook = await renderHook(() => {
            const controller = useAgentInputSelectionOverlayController({
                shouldRenderSessionModeChip: true,
                canChangePermission: true,
                hasMachinePopover: false,
                hasPathPopover: false,
                hasResumePopover: false,
                hasProfilePopover: true,
                hasEnvVarsPopover: true,
                hasAgentPickerOptions: false,
                extraActionChips: [],
            });
            const handlers = useAgentInputCoreControlHandlers({
                agentType: 'codex' as never,
                hasAgentPickerOptions: false,
                sessionModeChipInteraction: {
                    kind: 'cycle',
                    selectableOptionIds: ['build', 'plan'],
                    nextOptionId: 'plan',
                },
                onSessionModeChange,
                setShowActionMenu: vi.fn(),
                closeSelectionOverlay: controller.closeSelectionOverlay,
                toggleSelectionOverlay: controller.toggleSelectionOverlay,
            });
            return {
                ...controller,
                ...handlers,
            };
        });

        await act(async () => {
            hook.getCurrent().handleModePress();
        });

        expect(onSessionModeChange).toHaveBeenCalledWith('plan');
        expect(hook.getCurrent().activeSelectionOverlay).toBeNull();

        await hook.unmount();
    });

    it('opens the session mode picker when the interaction policy resolves to picker', async () => {
        const hook = await renderHook(() => {
            const controller = useAgentInputSelectionOverlayController({
                shouldRenderSessionModeChip: true,
                canChangePermission: true,
                hasMachinePopover: false,
                hasPathPopover: false,
                hasResumePopover: false,
                hasProfilePopover: true,
                hasEnvVarsPopover: true,
                hasAgentPickerOptions: false,
                extraActionChips: [],
            });
            const handlers = useAgentInputCoreControlHandlers({
                agentType: 'codex' as never,
                hasAgentPickerOptions: false,
                sessionModeChipInteraction: {
                    kind: 'picker',
                    selectableOptionIds: ['default', 'build', 'plan', 'review'],
                },
                setShowActionMenu: vi.fn(),
                closeSelectionOverlay: controller.closeSelectionOverlay,
                toggleSelectionOverlay: controller.toggleSelectionOverlay,
            });
            return {
                ...controller,
                ...handlers,
            };
        });

        await act(async () => {
            hook.getCurrent().handleModePress();
        });
        expect(hook.getCurrent().activeSelectionOverlay).toEqual({
            id: 'sessionMode',
            anchor: 'chip',
        });

        await hook.unmount();
    });

    it('opens the machine popover instead of invoking the legacy click handler when one is configured', async () => {
        const onMachineClick = vi.fn();

        const hook = await renderHook(() => {
            const controller = useAgentInputSelectionOverlayController({
                shouldRenderSessionModeChip: true,
                canChangePermission: true,
                hasMachinePopover: true,
                hasPathPopover: false,
                hasResumePopover: false,
                hasProfilePopover: true,
                hasEnvVarsPopover: true,
                hasAgentPickerOptions: false,
                extraActionChips: [],
            });
            const handlers = useAgentInputCoreControlHandlers({
                agentType: 'codex' as never,
                hasAgentPickerOptions: false,
                machinePopover: {
                    renderContent: () => null,
                } as any,
                onMachineClick,
                setShowActionMenu: vi.fn(),
                closeSelectionOverlay: controller.closeSelectionOverlay,
                toggleSelectionOverlay: controller.toggleSelectionOverlay,
            });
            return {
                ...controller,
                ...handlers,
            };
        });

        await act(async () => {
            hook.getCurrent().handleMachinePress?.();
        });

        expect(onMachineClick).not.toHaveBeenCalled();
        expect(hook.getCurrent().activeSelectionOverlay).toEqual({
            id: 'machine',
            anchor: 'chip',
        });

        await hook.unmount();
    });

    it('routes resume through the shared content-popover handler without blurring the input first', async () => {
        const onResumeClick = vi.fn();

        const hook = await renderHook(() => {
            const controller = useAgentInputSelectionOverlayController({
                shouldRenderSessionModeChip: true,
                canChangePermission: true,
                hasMachinePopover: false,
                hasPathPopover: false,
                hasResumePopover: true,
                hasProfilePopover: true,
                hasEnvVarsPopover: true,
                hasAgentPickerOptions: false,
                extraActionChips: [],
            });
            const handlers = useAgentInputCoreControlHandlers({
                agentType: 'codex' as never,
                hasAgentPickerOptions: false,
                resumePopover: {
                    renderContent: () => null,
                } as any,
                onResumeClick,
                setShowActionMenu: vi.fn(),
                closeSelectionOverlay: controller.closeSelectionOverlay,
                toggleSelectionOverlay: controller.toggleSelectionOverlay,
            });
            return {
                ...controller,
                ...handlers,
            };
        });

        await act(async () => {
            hook.getCurrent().handleResumePress?.();
        });

        expect(onResumeClick).not.toHaveBeenCalled();
        expect(hook.getCurrent().activeSelectionOverlay).toEqual({
            id: 'resume',
            anchor: 'chip',
        });

        await hook.unmount();
    });

    it('toggles the agent picker instead of forcing it open', async () => {
        let showActionMenu = true;

        const hook = await renderHook(() => {
            const controller = useAgentInputSelectionOverlayController({
                shouldRenderSessionModeChip: true,
                canChangePermission: true,
                hasMachinePopover: false,
                hasPathPopover: false,
                hasResumePopover: false,
                hasProfilePopover: true,
                hasEnvVarsPopover: true,
                hasAgentPickerOptions: true,
                extraActionChips: [],
            });
            const handlers = useAgentInputCoreControlHandlers({
                agentType: 'codex' as never,
                hasAgentPickerOptions: true,
                setShowActionMenu: ((next) => {
                    showActionMenu = typeof next === 'function' ? next(showActionMenu) : next;
                }) as React.Dispatch<React.SetStateAction<boolean>>,
                closeSelectionOverlay: controller.closeSelectionOverlay,
                toggleSelectionOverlay: controller.toggleSelectionOverlay,
            });
            return {
                ...controller,
                ...handlers,
            };
        });

        await act(async () => {
            hook.getCurrent().openSelectionOverlay('permission', 'chip');
        });

        await act(async () => {
            hook.getCurrent().handleAgentPress();
        });
        expect(showActionMenu).toBe(false);
        expect(hook.getCurrent().activeSelectionOverlay).toEqual({
            id: 'agent',
            anchor: 'chip',
        });

        await act(async () => {
            hook.getCurrent().handleAgentPress();
        });
        expect(hook.getCurrent().activeSelectionOverlay).toBeNull();

        await hook.unmount();
    });
});
