import * as React from 'react';

import type { ActionListItem } from '@/components/ui/lists/ActionListSection';

import {
    hasAgentInputCollapsedOptionsPopoverContent,
    type AgentInputExtraActionChip,
} from '../agentInputContracts';
import type { AgentInputControlId } from './agentInputControlTypes';

export function buildCollapsedExtraControlActions(params: Readonly<{
    chips?: readonly AgentInputExtraActionChip[];
    tint: string;
    dismiss: () => void;
    blurInput: () => void;
    openCollapsedOptionsPopover: (chipKey: string) => void;
    resetCorePopovers?: () => void;
}>): Partial<Record<AgentInputControlId, ReadonlyArray<ActionListItem>>> {
    const extraControlActions: Partial<Record<AgentInputControlId, ReadonlyArray<ActionListItem>>> = {};

    for (const chip of params.chips ?? []) {
        if (!chip.controlId) continue;

        let actions: ActionListItem | ReadonlyArray<ActionListItem> | null = null;
        if (typeof chip.collapsedAction === 'function') {
            actions = chip.collapsedAction({
                tint: params.tint,
                dismiss: params.dismiss,
                blurInput: params.blurInput,
                openCollapsedPopover: params.openCollapsedOptionsPopover,
            });
        } else if (
            chip.collapsedOptionsPopover
            && hasAgentInputCollapsedOptionsPopoverContent(chip.collapsedOptionsPopover)
        ) {
            const isDisabled = (): boolean => chip.collapsedOptionsPopover!.disabled === true
                || chip.collapsedOptionsPopover!.isEnabled?.() === false;
            const disabled = isDisabled();
            actions = {
                id: chip.controlId,
                label: chip.collapsedOptionsPopover.label ?? chip.collapsedOptionsPopover.title,
                ...(chip.collapsedOptionsPopover.accessibilityLabel === undefined
                    ? {}
                    : { accessibilityLabel: chip.collapsedOptionsPopover.accessibilityLabel }),
                icon: chip.collapsedOptionsPopover.icon?.(params.tint) ?? null,
                ...(disabled ? { disabled: true } : {}),
                onPress: () => {
                    if (isDisabled()) return;
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
                id: chip.controlId,
                label: chip.collapsedContentPopover.label ?? chip.collapsedContentPopover.title,
                ...(chip.collapsedContentPopover.accessibilityLabel === undefined
                    ? {}
                    : { accessibilityLabel: chip.collapsedContentPopover.accessibilityLabel }),
                icon: chip.collapsedContentPopover.icon?.(params.tint) ?? null,
                ...(disabled ? { disabled: true } : {}),
                onPress: () => {
                    if (isDisabled()) return;
                    params.dismiss();
                    params.resetCorePopovers?.();
                    params.openCollapsedOptionsPopover(chip.key);
                },
            };
        }

        if (!actions) continue;

        extraControlActions[chip.controlId] = [
            ...(extraControlActions[chip.controlId] ?? []),
            ...(Array.isArray(actions) ? actions : [actions]),
        ];
    }

    return extraControlActions;
}
