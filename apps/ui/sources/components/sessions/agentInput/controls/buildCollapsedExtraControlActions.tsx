import * as React from 'react';

import type { ActionListItem } from '@/components/ui/lists/ActionListSection';
import type { FocusReturnRef } from '@/keyboard/focusReturn';

import {
    hasAgentInputCollapsedOptionsPopoverContent,
    type AgentInputExtraActionChip,
} from '../agentInputContracts';

export function buildCollapsedExtraControlActions(params: Readonly<{
    chips?: readonly AgentInputExtraActionChip[];
    tint: string;
    dismiss: () => void;
    blurInput: () => void;
    openCollapsedOptionsPopover: (chipKey: string) => void;
    resetCorePopovers?: () => void;
    /** The action menu's own anchor, so a chip that opens a native dialog can return focus to it. */
    focusReturnRef?: FocusReturnRef;
}>): Readonly<Record<string, ReadonlyArray<ActionListItem>>> {
    const extraControlActions: Record<string, ReadonlyArray<ActionListItem>> = {};

    for (const chip of params.chips ?? []) {
        const placementId = chip.placement?.id;
        if (!placementId) continue;

        let actions: ActionListItem | ReadonlyArray<ActionListItem> | null = null;
        if (typeof chip.collapsedAction === 'function') {
            actions = chip.collapsedAction({
                tint: params.tint,
                dismiss: params.dismiss,
                blurInput: params.blurInput,
                openCollapsedPopover: params.openCollapsedOptionsPopover,
                ...(params.focusReturnRef ? { focusReturnRef: params.focusReturnRef } : {}),
            });
        } else if (
            chip.collapsedOptionsPopover
            && hasAgentInputCollapsedOptionsPopoverContent(chip.collapsedOptionsPopover)
        ) {
            const isDisabled = (): boolean => chip.collapsedOptionsPopover!.disabled === true
                || chip.collapsedOptionsPopover!.isEnabled?.() === false;
            const disabled = isDisabled();
            actions = {
                id: chip.key,
                label: chip.collapsedOptionsPopover.label ?? chip.collapsedOptionsPopover.title,
                ...(chip.collapsedOptionsPopover.accessibilityLabel === undefined
                    ? {}
                    : { accessibilityLabel: chip.collapsedOptionsPopover.accessibilityLabel }),
                icon: chip.collapsedOptionsPopover.icon?.(params.tint) ?? null,
                ...(disabled ? { disabled: true } : {}),
                onPress: () => {
                    if (isDisabled()) return;
                    chip.onIntent?.();
                    params.dismiss();
                    params.resetCorePopovers?.();
                    params.openCollapsedOptionsPopover(chip.key);
                },
            };
        } else if (chip.collapsedContentPopover) {
            const isDisabled = (): boolean => chip.collapsedContentPopover!.disabled === true
                || chip.collapsedContentPopover!.isEnabled?.() === false;
            const disabled = isDisabled();
            actions = {
                id: chip.key,
                label: chip.collapsedContentPopover.label ?? chip.collapsedContentPopover.title,
                ...(chip.collapsedContentPopover.accessibilityLabel === undefined
                    ? {}
                    : { accessibilityLabel: chip.collapsedContentPopover.accessibilityLabel }),
                icon: chip.collapsedContentPopover.icon?.(params.tint) ?? null,
                ...(disabled ? { disabled: true } : {}),
                onPress: () => {
                    if (isDisabled()) return;
                    chip.onIntent?.();
                    params.dismiss();
                    params.resetCorePopovers?.();
                    params.openCollapsedOptionsPopover(chip.key);
                },
            };
        }

        if (!actions) continue;

        extraControlActions[placementId] = [
            ...(extraControlActions[placementId] ?? []),
            ...(Array.isArray(actions) ? actions : [actions]),
        ];
    }

    return extraControlActions;
}
