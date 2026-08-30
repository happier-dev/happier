import * as React from 'react';

import type { ActionListItem } from '@/components/ui/lists/ActionListSection';
import type { SelectionListHeightBehavior, SelectionListStep } from '@/components/ui/selectionList';

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

export type AgentInputComposerAttachmentBadge = Readonly<{
    key: string;
    label: string;
    testID?: string;
    accessibilityLabel?: string;
    icon?: (tint: string) => React.ReactNode;
    onPress?: () => void;
    onRemove?: () => void;
    removeAccessibilityLabel?: string;
}>;

/**
 * `danger` is distinct from `warning` on purpose: warning means a person is being asked for
 * something, danger means something already went wrong. The agent-activity badge shows both in one
 * row ("1 needs you · 1 failed" vs "1 agent failed") and they must not read the same.
 */
export type AgentInputStatusBadgeTone = 'neutral' | 'active' | 'paused' | 'warning' | 'danger' | 'complete';
export type AgentInputStatusBadgeEmphasis = 'quiet' | 'prominent';

export type AgentInputStatusBadge = Readonly<{
    key: string;
    label: string;
    testID?: string;
    accessibilityLabel?: string;
    accessibilityHint?: string;
    /**
     * Set by badges that toggle a companion surface (e.g. a composer banner) so assistive tech can
     * announce the collapsed/expanded state without the label having to spell out the action.
     */
    accessibilityState?: Readonly<{ expanded: boolean }>;
    tone?: AgentInputStatusBadgeTone;
    emphasis?: AgentInputStatusBadgeEmphasis;
    icon?: (tint: string) => React.ReactNode;
    onPress?: () => void;
    renderPopover?: (ctx: Readonly<{
        open: boolean;
        anchorRef: React.RefObject<any>;
        onRequestClose: () => void;
    }>) => React.ReactNode;
}>;

/**
 * Shared fields for every `collapsedOptionsPopover` descriptor. The branch-specific
 * fields (`presentation`, `options`, `rootStep`) live on the discriminated union
 * `AgentInputCollapsedOptionsPopover` below so that mixed `{ options, rootStep }`
 * shapes are rejected at compile time.
 */
type AgentInputCollapsedOptionsPopoverBase = Readonly<{
    title: string;
    label?: string | null;
    icon?: (tint: string) => React.ReactNode;
    selectedOptionId?: string | null;
    onSelect: (id: string) => void;
    applyLabel?: string;
    railWidth?: number;
    railMaxWidth?: number | `${number}%`;
    maxHeightCap?: number;
    maxWidthCap?: number;
    heightBehavior?: SelectionListHeightBehavior;
}>;

/**
 * Discriminated union describing the popover that opens when an extra action
 * chip is invoked from the collapsed action menu.
 *
 * - `'picker'` (default when `presentation` is omitted) — renders the chip-picker
 *   rail+detail panel (`AgentInputChipPickerPopover`). Requires `options` and
 *   forbids `rootStep`.
 * - `'list'` — renders the SelectionList-driven popover
 *   (`AgentInputSelectionListPopover`). Requires `rootStep` and forbids
 *   `options`.
 *
 * Encoding this invariant in the type system guarantees that the routing site
 * never observes a mixed `{ options, rootStep }` descriptor at runtime.
 */
export type AgentInputCollapsedOptionsPopover =
    | (AgentInputCollapsedOptionsPopoverBase & Readonly<{
        presentation?: 'picker';
        options: ReadonlyArray<AgentInputChipPickerOption>;
        rootStep?: undefined;
    }>)
    | (AgentInputCollapsedOptionsPopoverBase & Readonly<{
        presentation: 'list';
        rootStep: SelectionListStep;
        options?: undefined;
    }>);

export function hasAgentInputCollapsedOptionsPopoverContent(
    popover: AgentInputCollapsedOptionsPopover,
): boolean {
    if (popover.presentation === 'list') {
        return popover.rootStep !== undefined;
    }

    return Array.isArray(popover.options) && popover.options.length > 0;
}

export type AgentInputExtraActionChip = Readonly<{
    key: string;
    /**
     * Data revision for render/popover closures captured by this descriptor.
     * Presentation owners may retain a descriptor while this key is unchanged,
     * but must replace it when the key changes.
     */
    stabilityKey?: string | number | boolean | null;
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
    collapsedOptionsPopover?: AgentInputCollapsedOptionsPopover;
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
        reserveKeyboardInset?: AgentInputContentPopoverConfig['reserveKeyboardInset'];
    }>;
    composerAttachmentBadge?: AgentInputComposerAttachmentBadge;
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
