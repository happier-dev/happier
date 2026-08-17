import * as React from 'react';

import type {
    ComposerAttachmentDisplayV1,
    ComposerAttachmentPreviewV1,
    ComposerAttachmentViewV1,
    ComposerDecorationSetV1,
    ComposerInputLockSnapshotV1,
    PluginUiRendererChainBindingV1,
} from '@happier-dev/protocol';

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
 * Private bridge from an admitted extra chip to the incumbent overlay owner.
 * The callback is mounted only while that chip is the active collapsed
 * presentation; it owns no overlay state or renderer selection.
 */
export type AgentInputExtraActionChipCollapsedPopoverRenderContext = Readonly<{
    anchorRef: React.RefObject<any>;
    onRequestClose: () => void;
}>;

/**
 * Controls whether a chip's label is displayed in `auto` density mode.
 *
 * - `'always'` – label is always visible (selector chips like agent, machine, permission mode).
 * - `'auto-hide'` – label is hidden in auto mode because the icon is self-explanatory (attach, link file).
 */
export type ChipLabelPolicy = 'always' | 'auto-hide';

export type AgentInputAttachmentRowStatus = 'pending' | 'uploading' | 'uploaded' | 'error';

export type AgentInputAttachmentRowAvailability = 'ready' | 'unavailable' | 'invalid';

/**
 * An already-validated, scope-local decoration projection. AgentInput only
 * renders this presentation; the Composer target remains its lifecycle owner.
 */
export type AgentInputComposerDecoration = Readonly<{
    id: string;
    key: string;
    decorations: ComposerDecorationSetV1;
}>;

export type AgentInputComposerInputLock = ComposerInputLockSnapshotV1;

/**
 * Shared, UI-only facts for the one attachment-row projection. The row owns
 * chrome and removal; domain/transfer owners project their state into this
 * contract and remain responsible for mutations, bytes, and persistence.
 */
type AgentInputAttachmentRowItemBase = Readonly<{
    key: string;
    label: string;
    testID?: string;
    accessibilityLabel?: string;
    onPress?: () => void;
    /**
     * The row owns the trigger/anchor lifecycle while a caller can compose an
     * incumbent popover at that exact attachment. This stays presentation-only:
     * no renderer, attachment state, or mutation authority moves into the row.
     */
    renderPreviewPopover?: (ctx: Readonly<{
        open: boolean;
        anchorRef: React.RefObject<any>;
        onRequestClose: () => void;
    }>) => React.ReactNode;
    onRemove?: () => void;
    removeAccessibilityLabel?: string;
    /** Stable host test hook for domain adapters that predate the unified row. */
    removeTestID?: string;
    status?: AgentInputAttachmentRowStatus;
    uploadProgress?: AgentInputAttachmentUploadProgress;
    error?: string;
    availability?: AgentInputAttachmentRowAvailability;
}>;

/**
 * A compact host-rendered attachment fallback. Browser and Review own their
 * own domain state and handlers; plugin attachment fallback also lands here
 * whenever its current catalog/display renderer is unavailable.
 */
export type AgentInputAttachmentRowBadge = AgentInputAttachmentRowItemBase & Readonly<{
    kind: 'badge';
    icon?: (tint: string) => React.ReactNode;
}>;

/**
 * A host-resolved media preview. `preview` is already presentation-safe; the
 * row never reads, resolves, or infers a URI from opaque composer content.
 */
export type AgentInputAttachmentRowMedia = AgentInputAttachmentRowItemBase & Readonly<{
    kind: 'media';
    media: 'image' | 'video';
    /**
     * A host-owned thumbnail for opaque staged composer media. It deliberately
     * carries no filesystem path or URI through the attachment-row contract.
     */
    renderedPreview?: React.ReactNode;
    /** Incumbent transfer-domain image preview, retained for existing uploads. */
    preview?: AgentInputAttachmentPreview;
}>;

/**
 * A composer mount already rendered by the incumbent PluginSurfaceHost path.
 * This component only places the result, so it cannot become another loader,
 * renderer, Host-API, or currentness owner.
 */
export type AgentInputAttachmentRowSurface = AgentInputAttachmentRowItemBase & Readonly<{
    kind: 'surface';
    sizing: 'compact' | 'content';
    renderedContent: React.ReactNode;
}>;

export type AgentInputStatusBadgeTone = 'neutral' | 'active' | 'paused' | 'warning' | 'complete';
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

type AgentInputCollapsedOptionsPopoverBase = Readonly<{
    title: string;
    label?: string | null;
    /** Optional menu-row name when its visible fallback label is not descriptive enough. */
    accessibilityLabel?: string;
    icon?: (tint: string) => React.ReactNode;
    /** A host projection can retain the control chrome while it is unavailable. */
    disabled?: boolean;
    /** Rechecks mount/session currentness immediately before overflow opens. */
    isEnabled?: () => boolean;
    selectedOptionId?: string | null;
    onSelect: (id: string) => void;
    applyLabel?: string;
    railWidth?: number;
    railMaxWidth?: number | `${number}%`;
    maxHeightCap?: number;
    maxWidthCap?: number;
    heightBehavior?: SelectionListHeightBehavior;
}>;

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
        /** Opens this chip's existing collapsed-overlay slot. */
        openCollapsedPopover: (chipKey: string) => void;
    }>) => ActionListItem | ReadonlyArray<ActionListItem>;
    collapsedOptionsPopover?: AgentInputCollapsedOptionsPopover;
    collapsedContentPopover?: Readonly<{
        title: string;
        label?: string | null;
        /** Optional menu-row name when its visible fallback label is not descriptive enough. */
        accessibilityLabel?: string;
        icon?: (tint: string) => React.ReactNode;
        /** A host projection can retain the control chrome while it is unavailable. */
        disabled?: boolean;
        /** Rechecks mount/session currentness immediately before overflow opens. */
        isEnabled?: () => boolean;
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
    /**
     * Private dynamic counterpart to the static collapsed popover descriptors.
     * It reuses the incumbent overlay/anchor lifecycle without lifting state
     * into AgentInput or introducing a second overlay owner.
     */
    renderCollapsedPopover?: (
        ctx: AgentInputExtraActionChipCollapsedPopoverRenderContext,
    ) => React.ReactNode;
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

/** The one presentational input model for `AgentInputAttachmentsRow`. */
export type AgentInputAttachmentsRowItem =
    | AgentInputAttachmentRowBadge
    | AgentInputAttachmentRowMedia
    | AgentInputAttachmentRowSurface;

function createAgentInputAttachmentRowItemBase(
    attachment: AgentInputAttachment,
): Omit<AgentInputAttachmentRowBadge, 'kind' | 'icon'> {
    return {
        key: attachment.key,
        label: attachment.label,
        ...(attachment.status === undefined ? {} : { status: attachment.status }),
        ...(attachment.uploadProgress === undefined ? {} : { uploadProgress: attachment.uploadProgress }),
        ...(attachment.error === undefined ? {} : { error: attachment.error }),
        ...(attachment.onRemove === undefined ? {} : { onRemove: attachment.onRemove }),
        ...(attachment.onRemove === undefined ? {} : { removeTestID: `agent-input-attachment-remove:${attachment.key}` }),
    };
}

/**
 * Adapts the incumbent transfer-domain model into the one row model. This is
 * deliberately one-way: transfer state remains owned by its existing draft and
 * upload controllers, while the row only receives immutable render facts.
 */
export function projectAgentInputAttachmentRowItem(
    attachment: AgentInputAttachment,
): AgentInputAttachmentsRowItem {
    const base = createAgentInputAttachmentRowItemBase(attachment);
    if (attachment.preview?.kind === 'image' && attachment.preview.uri.trim().length > 0) {
        return {
            ...base,
            kind: 'media',
            media: 'image',
            preview: attachment.preview,
        };
    }
    return { ...base, kind: 'badge' };
}

/**
 * The only caller-side merge from existing domain adapters into the one row
 * input. `AgentInput` receives this completed projection rather than retaining
 * a second `attachments` prop or choosing a cross-domain order itself.
 */
export function projectAgentInputAttachmentRowItems(input: Readonly<{
    items?: readonly AgentInputAttachmentsRowItem[];
    transferAttachments?: readonly AgentInputAttachment[];
}>): readonly AgentInputAttachmentsRowItem[] {
    const items = input.items ?? [];
    const transferAttachments = input.transferAttachments ?? [];
    if (transferAttachments.length === 0) return items;
    return [
        ...items,
        ...transferAttachments.map(projectAgentInputAttachmentRowItem),
    ];
}

export type ComposerAttachmentCatalogRowDescriptor = Readonly<{
    /** The exact admitted attachment definition this static display belongs to. */
    identity: ComposerAttachmentViewV1['attachment'];
    /** The installed-generation fence consumed by the one composer mount binding. */
    immutableGenerationId: string;
    picker?: PluginUiRendererChainBindingV1;
    display?: ComposerAttachmentDisplayV1;
    preview?: ComposerAttachmentPreviewV1;
}>;

export type ComposerAttachmentRowSurfacePresentation = Readonly<{
    sizing: 'compact' | 'content';
    /** The existing renderer host has already produced this mount result. */
    renderedContent: React.ReactNode;
}>;

/**
 * Host presentation facts for one opaque staged-media attachment. The media
 * bytes, temporary preview source, and release lifecycle remain with the
 * incumbent SessionMedia/transfer owners.
 */
export type ComposerAttachmentRowMediaPresentation = Readonly<{
    media: 'image' | 'video';
    renderedPreview: React.ReactNode;
    onPress?: () => void;
}>;

function isSameComposerAttachmentDefinition(
    left: ComposerAttachmentViewV1['attachment'],
    right: ComposerAttachmentViewV1['attachment'],
): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

function createComposerAttachmentFallbackBadge(input: Readonly<{
    attachment: ComposerAttachmentViewV1;
    onPress?: () => void;
    renderPreviewPopover?: AgentInputAttachmentRowBadge['renderPreviewPopover'];
    onRemove?: () => void;
    testID?: string;
    accessibilityLabel?: string;
    removeAccessibilityLabel?: string;
}>): AgentInputAttachmentRowBadge {
    return {
        kind: 'badge',
        key: input.attachment.instanceId,
        label: input.attachment.presentation.label,
        availability: input.attachment.availability.status,
        ...(input.onPress === undefined ? {} : { onPress: input.onPress }),
        ...(input.renderPreviewPopover === undefined ? {} : { renderPreviewPopover: input.renderPreviewPopover }),
        ...(input.onRemove === undefined ? {} : { onRemove: input.onRemove }),
        ...(input.testID === undefined ? {} : { testID: input.testID }),
        ...(input.accessibilityLabel === undefined ? {} : { accessibilityLabel: input.accessibilityLabel }),
        ...(input.removeAccessibilityLabel === undefined ? {} : { removeAccessibilityLabel: input.removeAccessibilityLabel }),
    };
}

/**
 * Projects a current plugin attachment view only when its catalog display is
 * for that exact qualified definition. Draft records may carry only an opaque
 * staged-media handle; unavailable or unsupported presentation remains a
 * removable host badge.
 */
export function projectComposerAttachmentRowItem(input: Readonly<{
    attachment: ComposerAttachmentViewV1;
    catalog: ComposerAttachmentCatalogRowDescriptor | null;
    media?: ComposerAttachmentRowMediaPresentation;
    surface?: ComposerAttachmentRowSurfacePresentation;
    onPress?: () => void;
    renderPreviewPopover?: AgentInputAttachmentRowBadge['renderPreviewPopover'];
    onRemove?: () => void;
    testID?: string;
    accessibilityLabel?: string;
    removeAccessibilityLabel?: string;
}>): AgentInputAttachmentsRowItem {
    const exactCatalog = input.catalog !== null
        && isSameComposerAttachmentDefinition(input.attachment.attachment, input.catalog.identity)
        ? input.catalog
        : null;
    const display = exactCatalog?.display;
    const preview = exactCatalog?.preview;
    const media = display?.kind === 'media' && input.media?.media === display.media
        ? input.media
        : undefined;
    const hostPreviewOnPress = preview?.kind === 'host'
        && media !== undefined
        && preview.presentation === media.media
        ? media.onPress
        : undefined;
    const rowInteraction = preview?.kind === 'host'
        ? {
            ...(hostPreviewOnPress === undefined ? {} : { onPress: hostPreviewOnPress }),
        }
        : {
            ...(input.onPress === undefined ? {} : { onPress: input.onPress }),
            ...(input.renderPreviewPopover === undefined ? {} : { renderPreviewPopover: input.renderPreviewPopover }),
        };
    const fallback = () => createComposerAttachmentFallbackBadge({
        attachment: input.attachment,
        ...rowInteraction,
        ...(input.onRemove === undefined ? {} : { onRemove: input.onRemove }),
        ...(input.testID === undefined ? {} : { testID: input.testID }),
        ...(input.accessibilityLabel === undefined ? {} : { accessibilityLabel: input.accessibilityLabel }),
        ...(input.removeAccessibilityLabel === undefined ? {} : { removeAccessibilityLabel: input.removeAccessibilityLabel }),
    });
    if (input.attachment.availability.status !== 'ready') return fallback();

    if (media !== undefined) {
        return {
            kind: 'media',
            key: input.attachment.instanceId,
            label: input.attachment.presentation.label,
            media: media.media,
            renderedPreview: media.renderedPreview,
            availability: 'ready',
            ...rowInteraction,
            ...(input.onRemove === undefined ? {} : { onRemove: input.onRemove }),
            ...(input.testID === undefined ? {} : { testID: input.testID }),
            ...(input.accessibilityLabel === undefined ? {} : { accessibilityLabel: input.accessibilityLabel }),
            ...(input.removeAccessibilityLabel === undefined ? {} : { removeAccessibilityLabel: input.removeAccessibilityLabel }),
        };
    }

    if (display?.kind === 'surface' && input.surface?.sizing === display.sizing) {
        return {
            kind: 'surface',
            key: input.attachment.instanceId,
            label: input.attachment.presentation.label,
            sizing: display.sizing,
            renderedContent: input.surface.renderedContent,
            ...rowInteraction,
            ...(input.onRemove === undefined ? {} : { onRemove: input.onRemove }),
            ...(input.testID === undefined ? {} : { testID: input.testID }),
            ...(input.accessibilityLabel === undefined ? {} : { accessibilityLabel: input.accessibilityLabel }),
            ...(input.removeAccessibilityLabel === undefined ? {} : { removeAccessibilityLabel: input.removeAccessibilityLabel }),
        };
    }

    return fallback();
}

/**
 * Browser/Review action sources expose independent controls and optional
 * attachment-row presentation through this local UI-only model.
 */
export type AgentInputExtraActionPresentation = Readonly<{
    actionChip: AgentInputExtraActionChip;
    attachmentRowItem?: AgentInputAttachmentsRowItem;
}>;
