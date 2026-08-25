import { Image } from 'expo-image';
import * as React from 'react';
import {
    AccessibilityInfo,
    findNodeHandle,
    Platform,
    Pressable,
    ScrollView,
    View,
    type LayoutChangeEvent,
    type NativeScrollEvent,
    type NativeSyntheticEvent,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { hapticsLight } from '@/components/ui/theme/haptics';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { LazyMountOnScreen } from '@/components/ui/performance/LazyMountOnScreen';
import { Text } from '@/components/ui/text/Text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import {
    AttachmentImagePreviewModal,
    type AttachmentImagePreviewModalImage,
} from '@/components/sessions/attachments/preview/AttachmentImagePreviewModal';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { useModalPortalTarget } from '@/modal/portal/ModalPortalTarget';
import { t } from '@/text';

import type {
    AgentInputAttachmentsRowItem,
    AgentInputAttachmentUploadProgress,
} from '../agentInputContracts';

type ComposerAttachmentImagePreviewItem = Extract<AttachmentImagePreviewModalImage, Readonly<{ kind: 'direct' }>>;

type AttachmentVerticalViewport = Readonly<{
    offset: number;
    height: number;
}>;

type AttachmentSurfaceLayout = Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
    sizing: 'compact' | 'content';
}>;

type CompactRailViewport = Readonly<{
    horizontalOffset: number;
    top: number | null;
    width: number;
}>;

function normalizeLayoutCoordinate(value: number): number {
    return Number.isFinite(value) ? value : 0;
}

function normalizeLayoutLength(value: number): number {
    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function intervalsIntersect(
    start: number,
    length: number,
    viewportStart: number,
    viewportLength: number,
): boolean {
    if (length <= 0 || viewportLength <= 0) return false;
    return start < viewportStart + viewportLength && viewportStart < start + length;
}

function isBadgeAttachmentRowItem(item: AgentInputAttachmentsRowItem): item is Extract<AgentInputAttachmentsRowItem, Readonly<{ kind: 'badge' }>> {
    return item.kind === 'badge';
}

function isMediaAttachmentRowItem(item: AgentInputAttachmentsRowItem): item is Extract<AgentInputAttachmentsRowItem, Readonly<{ kind: 'media' }>> {
    return item.kind === 'media';
}

function isCompactAttachmentRowItem(item: AgentInputAttachmentsRowItem): boolean {
    return item.kind !== 'surface' || item.sizing === 'compact';
}

function resolveAttachmentImagePreviewItems(items: readonly AgentInputAttachmentsRowItem[]): ComposerAttachmentImagePreviewItem[] {
    const previews: ComposerAttachmentImagePreviewItem[] = [];
    for (const attachment of items) {
        if (!isMediaAttachmentRowItem(attachment)) continue;
        const imagePreviewUri =
            attachment.preview?.kind === 'image' && typeof attachment.preview.uri === 'string' && attachment.preview.uri.trim().length > 0
                ? attachment.preview.uri
                : null;
        if (!imagePreviewUri) continue;
        previews.push({
            kind: 'direct',
            uri: imagePreviewUri,
            title: attachment.label,
        });
    }
    return previews;
}

function resolveUploadProgressPercent(progress?: AgentInputAttachmentUploadProgress): number | null {
    if (!progress) return null;
    if (!Number.isFinite(progress.totalBytes) || progress.totalBytes <= 0) return null;
    if (!Number.isFinite(progress.uploadedBytes) || progress.uploadedBytes < 0) return null;
    const percent = Math.round((progress.uploadedBytes / progress.totalBytes) * 100);
    return Math.max(0, Math.min(100, percent));
}

const ATTACHMENT_REMOVE_ICON_SIZE = 16;
const ATTACHMENT_IMAGE_PREVIEW_SIZE = 52;

type FocusableAttachmentTarget = Readonly<{
    focus?: (options?: Readonly<{ preventScroll?: boolean }>) => void;
}>;

type PendingAttachmentFocus = Readonly<{
    removedKey: string;
    neighborKeys: readonly string[];
}>;

function focusAttachmentTarget(target: unknown): boolean {
    if (!target || (typeof target !== 'object' && typeof target !== 'function')) return false;
    const focus = (target as FocusableAttachmentTarget).focus;
    if (typeof focus !== 'function') return false;

    if (Platform.OS === 'web') {
        try {
            focus.call(target, { preventScroll: true });
        } catch {
            try {
                focus.call(target);
            } catch {
                return false;
            }
        }
        return true;
    }

    try {
        focus.call(target);
    } catch {
        return false;
    }
    try {
        const node = findNodeHandle(target as React.ComponentRef<typeof Pressable>);
        if (typeof node === 'number') {
            AccessibilityInfo.setAccessibilityFocus(node);
        }
    } catch {
        // Physical focus already succeeded; accessibility focus is best-effort
        // for non-native test doubles and platform handles that cannot resolve.
    }
    return true;
}

const stylesheet = StyleSheet.create((theme) => ({
    attachmentsRow: {
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: 4,
    },
    attachmentChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    attachmentChipPreviewButton: {
        alignItems: 'center',
        alignSelf: 'stretch',
        flexDirection: 'row',
        flexShrink: 1,
        gap: 6,
        justifyContent: 'center',
    },
    attachmentChipText: {
        color: theme.colors.text.primary,
        fontSize: 12,
        maxWidth: 180,
        ...Typography.default(),
    },
    attachmentChipMeta: {
        color: theme.colors.text.secondary,
        fontSize: 11,
        ...Typography.default('semiBold'),
    },
    attachmentChipError: {
        color: theme.colors.state.danger.foreground,
        flexShrink: 1,
        fontSize: 11,
        maxWidth: 180,
        ...Typography.default('semiBold'),
    },
    attachmentErrorFeedback: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 4,
    },
    attachmentImageTile: {
        alignItems: 'center',
        flexDirection: 'row',
    },
    attachmentImageSurface: {
        width: ATTACHMENT_IMAGE_PREVIEW_SIZE,
        height: ATTACHMENT_IMAGE_PREVIEW_SIZE,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        overflow: 'hidden',
    },
    attachmentImage: {},
    attachmentImageOverlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: theme.colors.overlay.scrim,
    },
    attachmentImageOverlayText: {
        color: theme.colors.overlay.foreground,
        fontSize: 11,
        ...Typography.default('semiBold'),
    },
    attachmentImageErrorOverlay: {
        backgroundColor: theme.colors.state.danger.background,
    },
    attachmentImageRemoveButton: {
        position: 'relative',
    },
    rowContent: {
        gap: 8,
    },
    contentSurfaceBand: {
        gap: 8,
        paddingTop: 8,
    },
    compactSurface: {
        alignSelf: 'stretch',
    },
    contentSurface: {
        alignSelf: 'stretch',
    },
    surfaceItem: {
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        overflow: 'hidden',
    },
    surfaceHeader: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: 6,
        paddingHorizontal: 10,
    },
    surfacePreviewButton: {
        alignItems: 'center',
        alignSelf: 'stretch',
        flex: 1,
        flexDirection: 'row',
        gap: 6,
    },
    surfaceRemoveButton: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    surfaceLabel: {
        color: theme.colors.text.secondary,
        flex: 1,
        fontSize: 12,
        ...Typography.default(),
    },
}));

/**
 * One attachment owns its own anchor and open state, while the row continues
 * to own placement and removal. This reuses caller-provided incumbent popover
 * composition without retaining a cross-row preview cache or overlay owner.
 */
function AttachmentRowPreviewTrigger(props: Readonly<{
    item: AgentInputAttachmentsRowItem;
    fallbackOnPress?: () => void;
    children: (input: Readonly<{
        anchorRef?: React.RefObject<any>;
        onPress?: () => void;
        onRemove?: () => void;
    }>) => React.ReactNode;
}>): React.ReactNode {
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<any>(null);
    const renderPreviewPopover = props.item.renderPreviewPopover;
    const openedWithPreviewRendererRef = React.useRef<typeof renderPreviewPopover>(undefined);
    const hasPressAction = renderPreviewPopover !== undefined
        || props.item.onPress !== undefined
        || props.fallbackOnPress !== undefined;

    const closePreview = React.useCallback(() => {
        openedWithPreviewRendererRef.current = undefined;
        setOpen(false);
    }, []);

    React.useEffect(() => {
        if (openedWithPreviewRendererRef.current !== renderPreviewPopover) {
            closePreview();
        }
    }, [closePreview, renderPreviewPopover]);

    const onRemove = React.useCallback(() => {
        closePreview();
        props.item.onRemove?.();
    }, [closePreview, props.item.onRemove]);

    const onPress = React.useCallback(() => {
        hapticsLight();
        if (renderPreviewPopover !== undefined) {
            openedWithPreviewRendererRef.current = renderPreviewPopover;
            setOpen(true);
            return;
        }
        if (props.item.onPress !== undefined) {
            props.item.onPress({ focusReturnRef: anchorRef });
            return;
        }
        props.fallbackOnPress?.();
    }, [props.fallbackOnPress, props.item, renderPreviewPopover]);
    const hasCurrentPreviewRenderer = open
        && renderPreviewPopover !== undefined
        && openedWithPreviewRendererRef.current === renderPreviewPopover;

    return (
        <>
            {props.children({
                ...(hasPressAction ? { anchorRef } : {}),
                ...(hasPressAction ? { onPress } : {}),
                ...(props.item.onRemove === undefined ? {} : { onRemove }),
            })}
            {hasCurrentPreviewRenderer && renderPreviewPopover?.({
                open: true,
                anchorRef,
                onRequestClose: closePreview,
            })}
        </>
    );
}

export const AgentInputAttachmentsRow = React.memo(function AgentInputAttachmentsRow(props: Readonly<{
    items: readonly AgentInputAttachmentsRowItem[];
    /**
     * Native `AgentInput` owns the sole vertical attachment viewport. The row
     * consumes only its measured facts; standalone/web rows retain their
     * incumbent eager body rendering.
     */
    verticalViewport?: AttachmentVerticalViewport;
    /**
     * The native viewport owner measures this row's origin once so its scroll
     * coordinates can be translated before they reach the row-local bodies.
     */
    onLayout?: (event: LayoutChangeEvent) => void;
    /** Reuses AgentInput's mounted input focus method when no attachment remains. */
    onRequestComposerFocus?: () => void;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const modalPortalTarget = useModalPortalTarget();
    const [surfaceLayouts, setSurfaceLayouts] = React.useState<Readonly<Record<string, AttachmentSurfaceLayout>>>({});
    const [contentSurfaceBandTop, setContentSurfaceBandTop] = React.useState<number | null>(null);
    const [compactRailViewport, setCompactRailViewport] = React.useState<CompactRailViewport>({
        horizontalOffset: 0,
        top: null,
        width: 0,
    });
    const attachmentFocusTargetsRef = React.useRef(new Map<string, unknown>());
    const pendingAttachmentFocusRef = React.useRef<PendingAttachmentFocus | null>(null);
    const attachmentActionTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    const attachmentActionFrameStyle = React.useMemo(() => ({
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        minHeight: attachmentActionTargetSize,
        minWidth: attachmentActionTargetSize,
    }), [attachmentActionTargetSize]);
    const attachmentImageTileStyle = React.useMemo(() => ({
        width: ATTACHMENT_IMAGE_PREVIEW_SIZE + attachmentActionTargetSize,
        height: Math.max(ATTACHMENT_IMAGE_PREVIEW_SIZE, attachmentActionTargetSize),
    }), [attachmentActionTargetSize]);
    const attachmentImagePreviewStyle = React.useMemo(() => ({
        minHeight: attachmentActionTargetSize,
        minWidth: attachmentActionTargetSize,
    }), [attachmentActionTargetSize]);
    const attachmentFocusRef = React.useCallback((
        key: string,
        anchorRef?: React.RefObject<any>,
    ) => (target: unknown | null): void => {
        if (anchorRef) {
            (anchorRef as React.MutableRefObject<unknown | null>).current = target;
        }
        if (target === null) {
            attachmentFocusTargetsRef.current.delete(key);
            return;
        }
        attachmentFocusTargetsRef.current.set(key, target);
    }, []);
    const requestAttachmentRemoval = React.useCallback((
        item: AgentInputAttachmentsRowItem,
        onRemove: (() => void) | undefined,
    ): void => {
        if (!onRemove) return;
        const index = props.items.findIndex((candidate) => candidate.key === item.key);
        const neighborKeys = index < 0
            ? []
            : [props.items[index + 1]?.key, props.items[index - 1]?.key].filter(
                (key): key is string => typeof key === 'string',
            );
        pendingAttachmentFocusRef.current = { removedKey: item.key, neighborKeys };
        hapticsLight();
        onRemove();
    }, [props.items]);

    React.useLayoutEffect(() => {
        const pending = pendingAttachmentFocusRef.current;
        if (!pending || props.items.some((item) => item.key === pending.removedKey)) return;
        pendingAttachmentFocusRef.current = null;
        for (const key of pending.neighborKeys) {
            if (!props.items.some((item) => item.key === key)) continue;
            if (focusAttachmentTarget(attachmentFocusTargetsRef.current.get(key))) return;
        }
        props.onRequestComposerFocus?.();
    }, [props.items, props.onRequestComposerFocus]);
    const compactItems = React.useMemo(
        () => props.items.filter(isCompactAttachmentRowItem),
        [props.items],
    );
    const contentSurfaceItems = React.useMemo(
        () => props.items.filter((item): item is Extract<AgentInputAttachmentsRowItem, Readonly<{ kind: 'surface'; sizing: 'content' }>> => (
            item.kind === 'surface' && item.sizing === 'content'
        )),
        [props.items],
    );
    const attachmentImagePreviewItems = React.useMemo(
        () => resolveAttachmentImagePreviewItems(compactItems),
        [compactItems],
    );
    const surfaceLayoutKeys = React.useMemo(
        () => new Set(props.items.flatMap((item) => (
            item.kind === 'surface' ? [`${item.key}:${item.sizing}`] : []
        ))),
        [props.items],
    );

    React.useEffect(() => {
        setSurfaceLayouts((currentLayouts) => {
            const nextLayouts = Object.fromEntries(
                Object.entries(currentLayouts).filter(([key, layout]) => surfaceLayoutKeys.has(`${key}:${layout.sizing}`)),
            ) as Readonly<Record<string, AttachmentSurfaceLayout>>;
            return Object.keys(nextLayouts).length === Object.keys(currentLayouts).length
                ? currentLayouts
                : nextLayouts;
        });
    }, [surfaceLayoutKeys]);

    const updateSurfaceLayout = React.useCallback((
        item: Extract<AgentInputAttachmentsRowItem, Readonly<{ kind: 'surface' }>>,
        event: LayoutChangeEvent,
    ) => {
        const layout = event.nativeEvent.layout;
        const nextLayout: AttachmentSurfaceLayout = {
            x: normalizeLayoutCoordinate(layout.x),
            y: normalizeLayoutCoordinate(layout.y),
            width: normalizeLayoutLength(layout.width),
            height: normalizeLayoutLength(layout.height),
            sizing: item.sizing,
        };
        setSurfaceLayouts((currentLayouts) => {
            const currentLayout = currentLayouts[item.key];
            if (
                currentLayout?.x === nextLayout.x
                && currentLayout.y === nextLayout.y
                && currentLayout.width === nextLayout.width
                && currentLayout.height === nextLayout.height
                && currentLayout.sizing === nextLayout.sizing
            ) {
                return currentLayouts;
            }
            return { ...currentLayouts, [item.key]: nextLayout };
        });
    }, []);

    const onContentSurfaceBandLayout = React.useCallback((event: LayoutChangeEvent) => {
        const nextTop = normalizeLayoutCoordinate(event.nativeEvent.layout.y);
        setContentSurfaceBandTop((currentTop) => currentTop === nextTop ? currentTop : nextTop);
    }, []);

    const onCompactRailLayout = React.useCallback((event: LayoutChangeEvent) => {
        const layout = event.nativeEvent.layout;
        const nextTop = normalizeLayoutCoordinate(layout.y);
        const nextWidth = normalizeLayoutLength(layout.width);
        setCompactRailViewport((currentViewport) => (
            currentViewport.top === nextTop && currentViewport.width === nextWidth
                ? currentViewport
                : { ...currentViewport, top: nextTop, width: nextWidth }
        ));
    }, []);

    const onCompactRailScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const nextHorizontalOffset = normalizeLayoutCoordinate(event.nativeEvent.contentOffset.x);
        setCompactRailViewport((currentViewport) => (
            currentViewport.horizontalOffset === nextHorizontalOffset
                ? currentViewport
                : { ...currentViewport, horizontalOffset: nextHorizontalOffset }
        ));
    }, []);

    const shouldMountSurfaceBody = React.useCallback((
        item: Extract<AgentInputAttachmentsRowItem, Readonly<{ kind: 'surface' }>>,
    ): boolean => {
        if (!props.verticalViewport) return true;

        const verticalOffset = normalizeLayoutCoordinate(props.verticalViewport.offset);
        const verticalHeight = normalizeLayoutLength(props.verticalViewport.height);
        const surfaceLayout = surfaceLayouts[item.key];
        const surfaceContainerTop = item.sizing === 'compact'
            ? compactRailViewport.top
            : contentSurfaceBandTop;
        if (!surfaceLayout || surfaceLayout.sizing !== item.sizing || surfaceContainerTop === null) {
            return false;
        }
        if (!intervalsIntersect(
            surfaceContainerTop + surfaceLayout.y,
            surfaceLayout.height,
            verticalOffset,
            verticalHeight,
        )) {
            return false;
        }
        if (item.sizing !== 'compact') return true;
        return intervalsIntersect(
            surfaceLayout.x,
            surfaceLayout.width,
            compactRailViewport.horizontalOffset,
            compactRailViewport.width,
        );
    }, [compactRailViewport, contentSurfaceBandTop, props.verticalViewport, surfaceLayouts]);

    const resolveAttachmentError = (item: AgentInputAttachmentsRowItem): string | null => {
        if (item.status === 'error') return item.error?.trim() || t('common.error');
        if (item.availability === 'unavailable') return t('common.unavailable');
        if (item.availability === 'invalid') return t('errors.invalidFormat');
        return null;
    };
    const resolveAttachmentAccessibilityLabel = (item: AgentInputAttachmentsRowItem): string => {
        const error = resolveAttachmentError(item);
        const label = item.accessibilityLabel ?? item.label;
        return error ? `${label}: ${error}` : label;
    };
    const renderAttachmentErrorFeedback = (item: AgentInputAttachmentsRowItem) => {
        const error = resolveAttachmentError(item);
        if (!error) return null;
        return (
            <View
                accessibilityLabel={error}
                accessibilityRole="alert"
                style={styles.attachmentErrorFeedback}
                testID={`agent-input-attachment-error:${item.key}`}
            >
                <Icon name="warning-circle" size={14} color={theme.colors.state.danger.foreground} />
                <Text numberOfLines={1} style={styles.attachmentChipError}>{error}</Text>
            </View>
        );
    };

    if (props.items.length === 0) {
        return null;
    }

    const renderSurface = (item: Extract<AgentInputAttachmentsRowItem, Readonly<{ kind: 'surface' }>>) => {
        const removeTestID = item.removeTestID ?? (item.testID ? `${item.testID}-remove` : undefined);
        return (
            <AttachmentRowPreviewTrigger
                key={item.key}
                item={item}
            >
                {({ anchorRef, onPress, onRemove }) => (
                    <View
                        style={[
                            styles.surfaceItem,
                            item.sizing === 'compact' ? styles.compactSurface : styles.contentSurface,
                        ]}
                        testID={item.testID}
                        onLayout={(event) => {
                            updateSurfaceLayout(item, event);
                        }}
                    >
                        <View style={styles.surfaceHeader}>
                            {onPress ? (
                                <Pressable
                                    ref={attachmentFocusRef(item.key, anchorRef)}
                                    accessibilityHint={t('common.open')}
                                    accessibilityLabel={resolveAttachmentAccessibilityLabel(item)}
                                    accessibilityRole="button"
                                    onPress={onPress}
                                    style={[styles.surfacePreviewButton, attachmentActionFrameStyle]}
                                    testID={item.testID ? `${item.testID}-preview` : undefined}
                                >
                                    <Icon name="eye" size={16} color={theme.colors.text.secondary} />
                                    <Text numberOfLines={1} style={styles.surfaceLabel}>{item.label}</Text>
                                </Pressable>
                            ) : (
                                <Text numberOfLines={1} style={styles.surfaceLabel}>{item.label}</Text>
                            )}
                            {item.onRemove ? (
                                <Pressable
                                    ref={onPress ? undefined : attachmentFocusRef(item.key)}
                                    accessibilityLabel={item.removeAccessibilityLabel ?? t('common.remove')}
                                    accessibilityRole="button"
                                    onPress={() => requestAttachmentRemoval(item, onRemove)}
                                    style={[styles.surfaceRemoveButton, attachmentActionFrameStyle]}
                                    testID={removeTestID}
                                >
                                    <Icon name="x" size={ATTACHMENT_REMOVE_ICON_SIZE} color={theme.colors.text.secondary} />
                                </Pressable>
                            ) : null}
                        </View>
                        {renderAttachmentErrorFeedback(item)}
                        {props.verticalViewport ? (
                            shouldMountSurfaceBody(item) ? item.renderedContent : null
                        ) : (
                            <LazyMountOnScreen>
                                {item.renderedContent}
                            </LazyMountOnScreen>
                        )}
                    </View>
                )}
            </AttachmentRowPreviewTrigger>
        );
    };

    const renderCompactItem = (item: AgentInputAttachmentsRowItem) => {
        if (isBadgeAttachmentRowItem(item)) {
            const badge = item;
            const icon = badge.icon?.(theme.colors.text.secondary) ?? (
                <Icon name="file" size={14} color={theme.colors.text.secondary} />
            );
            const previewContent = (
                <>
                    {icon}
                    <Text
                        numberOfLines={1}
                        style={styles.attachmentChipText}
                    >
                        {badge.label}
                    </Text>
                    {renderAttachmentErrorFeedback(badge)}
                </>
            );
            const renderRemoveButton = (
                onRemove: (() => void) | undefined,
                focusFallback: boolean,
            ) => badge.onRemove ? (
                <Pressable
                    ref={focusFallback ? attachmentFocusRef(badge.key) : undefined}
                    accessibilityLabel={badge.removeAccessibilityLabel ?? t('common.remove')}
                    accessibilityRole="button"
                    onPress={() => requestAttachmentRemoval(badge, onRemove)}
                    style={attachmentActionFrameStyle}
                    testID={badge.removeTestID ?? (badge.testID ? `${badge.testID}-remove` : undefined)}
                >
                    <Icon name="x" size={ATTACHMENT_REMOVE_ICON_SIZE} color={theme.colors.text.secondary} />
                </Pressable>
            ) : null;

            if (badge.onPress || badge.renderPreviewPopover) {
                return (
                    <AttachmentRowPreviewTrigger
                        key={badge.key}
                        item={badge}
                    >
                        {({ anchorRef, onPress, onRemove }) => (
                            <View style={[styles.attachmentChip, attachmentActionFrameStyle]} testID={badge.testID}>
                                <Pressable
                                    ref={attachmentFocusRef(badge.key, anchorRef)}
                                    accessibilityLabel={resolveAttachmentAccessibilityLabel(badge)}
                                    accessibilityRole="button"
                                    onPress={onPress}
                                    style={[styles.attachmentChipPreviewButton, attachmentActionFrameStyle]}
                                    testID={badge.testID ? `${badge.testID}-preview` : undefined}
                                >
                                    {previewContent}
                                </Pressable>
                                {renderRemoveButton(onRemove, false)}
                            </View>
                        )}
                    </AttachmentRowPreviewTrigger>
                );
            }

            return (
                <View key={badge.key} style={[styles.attachmentChip, attachmentActionFrameStyle]} testID={badge.testID}>
                    {previewContent}
                    {renderRemoveButton(badge.onRemove, true)}
                </View>
            );
        }

        if (item.kind === 'surface') {
            return renderSurface(item);
        }

        const att = item;
        const attachmentError = resolveAttachmentError(att);
        const percent = att.status === 'uploading' ? resolveUploadProgressPercent(att.uploadProgress) : null;
        if (att.renderedPreview !== undefined) {
            return (
                <AttachmentRowPreviewTrigger
                    key={att.key}
                    item={att}
                >
                    {({ anchorRef, onPress, onRemove }) => (
                        <View style={[styles.attachmentImageTile, attachmentImageTileStyle]}>
                            {onPress ? (
                                <Pressable
                                    ref={attachmentFocusRef(att.key, anchorRef)}
                                    accessibilityLabel={resolveAttachmentAccessibilityLabel(att)}
                                    accessibilityRole="button"
                                    onPress={onPress}
                                    style={[styles.attachmentImageSurface, attachmentImagePreviewStyle]}
                                    testID={`agent-input-attachment-media:${att.key}`}
                                >
                                    {att.renderedPreview}
                                </Pressable>
                            ) : (
                                <View
                                    accessibilityLabel={resolveAttachmentAccessibilityLabel(att)}
                                    accessibilityRole="image"
                                    style={[styles.attachmentImageSurface, attachmentImagePreviewStyle]}
                                    testID={`agent-input-attachment-media:${att.key}`}
                                >
                                    {att.renderedPreview}
                                </View>
                            )}
                            {att.status === 'uploading' && percent != null ? (
                                <View style={styles.attachmentImageOverlay}>
                                    <Text style={styles.attachmentImageOverlayText}>{percent}%</Text>
                                </View>
                            ) : null}
                            {attachmentError ? (
                                <View
                                    accessibilityLabel={attachmentError}
                                    accessibilityRole="alert"
                                    style={[styles.attachmentImageOverlay, styles.attachmentImageErrorOverlay]}
                                    testID={`agent-input-attachment-error:${att.key}`}
                                >
                                    <Icon name="warning-circle" size={20} color={theme.colors.overlay.foreground} />
                                </View>
                            ) : null}
                            {att.onRemove ? (
                                <Pressable
                                    ref={onPress ? undefined : attachmentFocusRef(att.key)}
                                    testID={att.removeTestID ?? `agent-input-attachment-remove:${att.key}`}
                                    accessibilityLabel={att.removeAccessibilityLabel ?? t('common.remove')}
                                    accessibilityRole="button"
                                    onPress={() => requestAttachmentRemoval(att, onRemove)}
                                    style={[styles.attachmentImageRemoveButton, attachmentActionFrameStyle]}
                                >
                                    <Icon name="x-circle" size={ATTACHMENT_REMOVE_ICON_SIZE} color={theme.colors.text.secondary} />
                                </Pressable>
                            ) : null}
                        </View>
                    )}
                </AttachmentRowPreviewTrigger>
            );
        }
        const imagePreviewUri =
            att.preview?.kind === 'image' && typeof att.preview.uri === 'string' && att.preview.uri.trim().length > 0
                ? att.preview.uri
                : null;
        const imagePreviewIndex = attachmentImagePreviewItems.findIndex((item) => item.uri === imagePreviewUri && item.title === att.label);

        if (imagePreviewUri) {
            return (
                <AttachmentRowPreviewTrigger
                    key={att.key}
                    item={att}
                    fallbackOnPress={() => {
                        Modal.show({
                            component: AttachmentImagePreviewModal,
                            webPortalTarget: modalPortalTarget ?? null,
                            props: {
                                images: attachmentImagePreviewItems,
                                initialIndex: imagePreviewIndex >= 0 ? imagePreviewIndex : 0,
                            },
                        });
                    }}
                >
                    {({ anchorRef, onPress, onRemove }) => (
                        <View style={[styles.attachmentImageTile, attachmentImageTileStyle]}>
                            <Pressable
                                ref={attachmentFocusRef(att.key, anchorRef)}
                                accessibilityLabel={resolveAttachmentAccessibilityLabel(att)}
                                accessibilityRole="button"
                                onPress={onPress}
                                style={[styles.attachmentImageSurface, attachmentImagePreviewStyle]}
                                testID={`agent-input-attachment-image:${att.key}`}
                            >
                                <Image
                                    source={{ uri: imagePreviewUri }}
                                    style={[{ width: '100%', height: '100%' }, styles.attachmentImage]}
                                    contentFit="cover"
                                />
                                {att.status === 'uploading' && percent != null ? (
                                    <View style={styles.attachmentImageOverlay}>
                                        <Text style={styles.attachmentImageOverlayText}>{percent}%</Text>
                                    </View>
                                ) : null}
                                {attachmentError ? (
                                    <View
                                        accessibilityLabel={attachmentError}
                                        accessibilityRole="alert"
                                        style={[styles.attachmentImageOverlay, styles.attachmentImageErrorOverlay]}
                                        testID={`agent-input-attachment-error:${att.key}`}
                                    >
                                        <Icon name="warning-circle" size={20} color={theme.colors.overlay.foreground} />
                                    </View>
                                ) : null}
                            </Pressable>
                            {att.onRemove ? (
                                <Pressable
                                    testID={att.removeTestID ?? `agent-input-attachment-remove:${att.key}`}
                                    accessibilityLabel={att.removeAccessibilityLabel ?? t('common.remove')}
                                    accessibilityRole="button"
                                    onPress={() => requestAttachmentRemoval(att, onRemove)}
                                    style={[styles.attachmentImageRemoveButton, attachmentActionFrameStyle]}
                                >
                                    <Icon name="x-circle" size={ATTACHMENT_REMOVE_ICON_SIZE} color={theme.colors.text.secondary} />
                                </Pressable>
                            ) : null}
                        </View>
                    )}
                </AttachmentRowPreviewTrigger>
            );
        }

        const fallbackContent = (
            <>
                <Icon name="file" size={14} color={theme.colors.text.secondary} />
                <Text
                    numberOfLines={1}
                    style={styles.attachmentChipText}
                >
                    {att.label}
                </Text>
                {att.status === 'uploading' ? (
                    percent != null ? (
                        <Text style={styles.attachmentChipMeta}>{percent}%</Text>
                    ) : (
                        <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                    )
                ) : null}
                {renderAttachmentErrorFeedback(att)}
            </>
        );
        const renderFallbackRemoveButton = (
            onRemove: (() => void) | undefined,
            focusFallback: boolean,
        ) => att.onRemove ? (
            <Pressable
                ref={focusFallback ? attachmentFocusRef(att.key) : undefined}
                testID={att.removeTestID ?? `agent-input-attachment-remove:${att.key}`}
                accessibilityLabel={att.removeAccessibilityLabel ?? t('common.remove')}
                accessibilityRole="button"
                onPress={() => requestAttachmentRemoval(att, onRemove)}
                style={attachmentActionFrameStyle}
            >
                <Icon name="x-circle" size={ATTACHMENT_REMOVE_ICON_SIZE} color={theme.colors.text.secondary} />
            </Pressable>
        ) : null;

        if (att.onPress || att.renderPreviewPopover) {
            return (
                <AttachmentRowPreviewTrigger
                    key={att.key}
                    item={att}
                >
                    {({ anchorRef, onPress, onRemove }) => (
                        <View style={[styles.attachmentChip, attachmentActionFrameStyle]} testID={att.testID}>
                            <Pressable
                                ref={attachmentFocusRef(att.key, anchorRef)}
                                accessibilityLabel={resolveAttachmentAccessibilityLabel(att)}
                                accessibilityRole="button"
                                onPress={onPress}
                                style={[styles.attachmentChipPreviewButton, attachmentActionFrameStyle]}
                                testID={att.testID ? `${att.testID}-preview` : undefined}
                            >
                                {fallbackContent}
                            </Pressable>
                            {renderFallbackRemoveButton(onRemove, false)}
                        </View>
                    )}
                </AttachmentRowPreviewTrigger>
            );
        }

        return (
            <View key={att.key} style={[styles.attachmentChip, attachmentActionFrameStyle]} testID={att.testID}>
                {fallbackContent}
                {renderFallbackRemoveButton(att.onRemove, true)}
            </View>
        );
    };

    return (
        <View style={styles.attachmentsRow} onLayout={props.onLayout}>
            {compactItems.length > 0 ? (
                <ScrollView
                    horizontal
                    testID="agent-input-attachment-compact-viewport"
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.rowContent}
                    onLayout={onCompactRailLayout}
                    onScroll={onCompactRailScroll}
                    scrollEventThrottle={16}
                >
                    {compactItems.map(renderCompactItem)}
                </ScrollView>
            ) : null}
            {contentSurfaceItems.length > 0 ? (
                <View
                    testID="agent-input-attachment-content-surface-band"
                    style={styles.contentSurfaceBand}
                    onLayout={onContentSurfaceBandLayout}
                >
                    {contentSurfaceItems.map(renderSurface)}
                </View>
            ) : null}
        </View>
    );
});
