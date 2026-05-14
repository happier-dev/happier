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
            });
        } else if (
            chip.collapsedOptionsPopover
            && hasAgentInputCollapsedOptionsPopoverContent(chip.collapsedOptionsPopover)
        ) {
            actions = {
                id: chip.controlId,
                label: chip.collapsedOptionsPopover.label ?? chip.collapsedOptionsPopover.title,
                icon: chip.collapsedOptionsPopover.icon?.(params.tint) ?? null,
                onPress: () => {
                    params.dismiss();
                    params.resetCorePopovers?.();
                    params.openCollapsedOptionsPopover(chip.key);
                },
            };
        } else if (chip.collapsedContentPopover) {
            actions = {
                id: chip.controlId,
                label: chip.collapsedContentPopover.label ?? chip.collapsedContentPopover.title,
                icon: chip.collapsedContentPopover.icon?.(params.tint) ?? null,
                onPress: () => {
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
