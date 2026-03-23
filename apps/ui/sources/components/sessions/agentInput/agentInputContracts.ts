import * as React from 'react';

import type { ActionListItem } from '@/components/ui/lists/ActionListSection';

import type { AgentInputChipPickerOption } from './components/AgentInputChipPickerTypes';
import type { AgentInputContentPopoverConfig } from './components/AgentInputContentPopover';
import type { AgentInputControlId } from './controls/agentInputControlTypes';

export type AgentInputExtraActionChipRenderContext = Readonly<{
    chipStyle: (pressed: boolean) => any;
    showLabel: boolean;
    iconColor: string;
    textStyle: any;
    countTextStyle: any;
    chipAnchorRef?: React.RefObject<any>;
    /**
     * Full-width anchor for agent-input popovers (matches the overall composer width).
     * Useful for chip-triggered popovers (e.g. "Link file") that should size like the @ suggestions.
     */
    popoverAnchorRef: React.RefObject<any>;
    toggleCollapsedPopover?: (chipKey: string) => void;
}>;

export type AgentInputPopoverAnchor = 'chip' | 'actionMenu';

/**
 * Controls whether a chip's label is displayed in `auto` density mode.
 *
 * - `'always'` – label is always visible (selector chips like agent, machine, permission mode).
 * - `'auto-hide'` – label is hidden in auto mode because the icon is self-explanatory (attach, link file).
 */
export type ChipLabelPolicy = 'always' | 'auto-hide';

export type AgentInputExtraActionChip = Readonly<{
    key: string;
    controlId?: AgentInputControlId;
    /**
     * Determines whether the label should be shown in auto chip density mode.
     * Defaults to `'always'` when not specified.
     */
    labelPolicy?: ChipLabelPolicy;
    collapsedAction?: (ctx: Readonly<{
        tint: string;
        dismiss: () => void;
        blurInput: () => void;
    }>) => ActionListItem | ReadonlyArray<ActionListItem>;
    collapsedOptionsPopover?: Readonly<{
        title: string;
        label?: string | null;
        icon?: (tint: string) => React.ReactNode;
        options: ReadonlyArray<AgentInputChipPickerOption>;
        selectedOptionId?: string | null;
        onSelect: (id: string) => void;
        applyLabel?: string;
        railWidth?: number;
        railMaxWidth?: number | `${number}%`;
        maxHeightCap?: number;
        maxWidthCap?: number;
    }>;
    collapsedContentPopover?: Readonly<{
        title: string;
        label?: string | null;
        icon?: (tint: string) => React.ReactNode;
        renderContent: AgentInputContentPopoverConfig['renderContent'];
        boundaryRef?: React.RefObject<any> | null;
        maxHeightCap?: number;
        maxWidthCap?: number;
        scrollEnabled?: AgentInputContentPopoverConfig['scrollEnabled'];
        keyboardShouldPersistTaps?: AgentInputContentPopoverConfig['keyboardShouldPersistTaps'];
        edgeFades?: AgentInputContentPopoverConfig['edgeFades'];
        edgeIndicators?: AgentInputContentPopoverConfig['edgeIndicators'];
        initialVisibility?: AgentInputContentPopoverConfig['initialVisibility'];
    }>;
    render: (ctx: AgentInputExtraActionChipRenderContext) => React.ReactNode;
}>;

export type AgentInputAttachmentPreview =
    | Readonly<{ kind: 'image'; uri: string }>;

export type AgentInputAttachmentUploadProgress = Readonly<{
    uploadedBytes: number;
    totalBytes: number;
}>;

export type AgentInputAttachment = Readonly<{
    key: string;
    label: string;
    status?: 'pending' | 'uploading' | 'uploaded' | 'error';
    preview?: AgentInputAttachmentPreview;
    uploadProgress?: AgentInputAttachmentUploadProgress;
    error?: string;
    onRemove?: () => void;
}>;
