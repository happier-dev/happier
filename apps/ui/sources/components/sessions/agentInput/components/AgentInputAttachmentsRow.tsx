import { Image } from 'expo-image';
import * as React from 'react';
import {
    AccessibilityInfo,
    findNodeHandle,
    Platform,
    ScrollView,
    View,
    type LayoutChangeEvent,
    type NativeScrollEvent,
    type NativeSyntheticEvent,
} from 'react-native';
import Reanimated, { FadeIn } from 'react-native-reanimated';

import { motionTokens } from '@/components/ui/motion/motionTokens';
import { WordCrossFade } from '@/components/ui/motion/WordCrossFade';
import { Tooltip } from '@/components/ui/overlays/Tooltip';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { hapticsLight } from '@/components/ui/theme/haptics';
import { LazyMountOnScreen } from '@/components/ui/performance/LazyMountOnScreen';
import { Text } from '@/components/ui/text/Text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { useMediaStage } from '@/components/ui/media/stage/useMediaStage';
import { HappierImageCheckerboard, HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { useImageBacking } from '@/components/ui/media/imageBacking';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type {
    AgentInputAttachmentsRowItem,
    AgentInputAttachmentUploadProgress,
} from '../agentInputContracts';
import { readAgentInputImageNumbers } from '../agentInputContracts';
import { ImageNumberBadge } from '@/components/ui/referenceChip/ImageNumberBadge';
import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE, useHappierTouchPrimaryPointer } from '@happier-dev/plugin-ui/environment';

/** A draft image the composer already holds as a direct URI (the draft owns and revokes it). */
type ComposerAttachmentImagePreviewItem = Readonly<{ key: string; uri: string; title: string; mimeType?: string; edit?: import('@/components/ui/media/stage/mediaStageItems').StagePictureEdit }>;

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
            key: attachment.key,
            uri: imagePreviewUri,
            title: attachment.label,
            mimeType: attachment.preview?.mimeType,
            edit: attachment.stageEdit,
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

/** A preview that only opens a popover has no press of its own. */
const NO_PRESS = (): void => {};
const ATTACHMENT_REMOVE_ICON_SIZE = 16;
const ATTACHMENT_CORNER_REMOVE_SIZE = 20;
const ATTACHMENT_CORNER_REMOVE_OVERHANG = 6;
const ATTACHMENT_CORNER_REMOVE_ICON_SIZE = 11;
/** A chip's remove icon sits between the label (6 px gap) and the chip's 10 px edge padding. */
const ATTACHMENT_CHIP_REMOVE_HIT_REACH = { left: 3, right: 10 } as const;

/**
 * A tray picture and its remove control: the lab's (TA) small ink disc on the picture's corner. With a
 * fine pointer it shows while the picture is hovered or the control has keyboard focus; under a finger
 * it is always shown (there is no hover). The disc is the whole drawn control: a finger reaches 44
 * through the shared hit area, outward only, so it never overlaps the picture's own press target.
 */
/** What sits behind a tray picture: the same paper or transparency board as the Media stage and image wells. */
function TrayPictureBacking(props: Readonly<{ alphaCapable: boolean; checkerboardTestID: string }>) {
    const { theme } = useUnistyles();
    const backing = useImageBacking('image', props.alphaCapable);
    return (
        <>
            {backing.paper ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: backing.paper }]} /> : null}
            {backing.checkerboard ? <HappierImageCheckerboard color={theme.colors.text.primary} testID={props.checkerboardTestID} /> : null}
        </>
    );
}

function resolveTrayPictureAlphaCapable(item: Extract<AgentInputAttachmentsRowItem, Readonly<{ kind: 'media' }>>): boolean {
    return item.alphaCapable ?? resolveFileViewerKind({ path: item.label, mimeType: item.preview?.mimeType }).alphaCapable;
}

/**
 * The disc already sits 14 px over the picture; its hit area reaches outward as far as the rail's
 * overhang allows and only 2 px back over the picture, which is just enough for the 24 px floor.
 */
const ATTACHMENT_CORNER_REMOVE_HIT_REACH = { left: 2, bottom: 2 } as const;

function TrayPictureTile(props: Readonly<{
    children: React.ReactNode;
    onRemove: (() => void) | undefined;
    removeTestID: string | undefined;
    removeAccessibilityLabel: string;
    removeRef?: (target: unknown | null) => void;
    /** The picture carries marks: the pen badge reopens them (lab `ia · I3`). */
    onEditMarks?: () => void;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const touch = useHappierTouchPrimaryPointer(Platform.OS);
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);
    return (
        <View
            style={styles.attachmentImageTileFrame}
            onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => setHovered(false)}
        >
            {props.children}
            {props.onEditMarks ? (
                <Reanimated.View entering={FadeIn.duration(motionTokens.guardMoment.wordCrossFadeMs)} style={styles.attachmentImagePenFrame}>
                    <Tooltip label={t('files.annotate.editMarks')} testID="agent-input-attachment-edit-marks" focusable={false}>
                        <HappierPressable
                            testID="agent-input-attachment-pen"
                            accessibilityLabel={t('files.annotate.editMarks')}
                            accessibilityRole="button"
                            onPress={props.onEditMarks}
                            hitTarget={HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE}
                            hitReach={ATTACHMENT_CORNER_REMOVE_HIT_REACH}
                        >
                            <View style={styles.attachmentImagePenDisc}>
                                <Icon name="pencil-simple" size={ATTACHMENT_CORNER_REMOVE_ICON_SIZE} color={styles.attachmentImageRemoveIcon.color} />
                            </View>
                        </HappierPressable>
                    </Tooltip>
                </Reanimated.View>
            ) : null}
            {props.onRemove ? (
                <HappierPressable
                    controlRef={props.removeRef}
                    testID={props.removeTestID}
                    accessibilityLabel={props.removeAccessibilityLabel}
                    accessibilityRole="button"
                    onPress={props.onRemove}
                    onFocusChange={setFocused}
                    hitTarget={HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE}
                    hitReach={ATTACHMENT_CORNER_REMOVE_HIT_REACH}
                    style={[
                        styles.attachmentImageRemoveFrame,
                        { opacity: touch || hovered || focused ? 1 : 0 },
                    ]}
                >
                    <View style={styles.attachmentImageRemoveDisc}>
                        <Icon name="x" size={ATTACHMENT_CORNER_REMOVE_ICON_SIZE} color={styles.attachmentImageRemoveIcon.color} />
                    </View>
                </HappierPressable>
            ) : null}
        </View>
    );
}
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
        const node = findNodeHandle(target as Parameters<typeof findNodeHandle>[0]);
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
        paddingHorizontal: theme.space.s12,
        paddingTop: theme.space.s8,
        paddingBottom: theme.space.s4,
    },
    attachmentChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        paddingHorizontal: theme.space.s10,
        paddingVertical: theme.space.s6,
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
        gap: theme.space.s6,
        justifyContent: 'center',
    },
    attachmentChipText: {
        color: theme.colors.text.primary,
        ...Typography.variant('meta'),
        maxWidth: 180,
    },
    attachmentChipDetail: {
        color: theme.colors.text.secondary,
        ...Typography.variant('meta'),
        ...Typography.tabular(),
    },
    attachmentChipMeta: {
        color: theme.colors.text.secondary,
        ...Typography.variant('micro', 'semiBold'),
    },
    attachmentChipError: {
        color: theme.colors.state.danger.foreground,
        flexShrink: 1,
        ...Typography.variant('micro', 'semiBold'),
        maxWidth: 180,
    },
    attachmentErrorFeedback: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: theme.space.s4,
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
        ...Typography.variant('micro', 'semiBold'),
    },
    attachmentImageErrorOverlay: {
        backgroundColor: theme.colors.state.danger.background,
    },
    attachmentImageTileFrame: {
        position: 'relative',
        width: ATTACHMENT_IMAGE_PREVIEW_SIZE,
        height: ATTACHMENT_IMAGE_PREVIEW_SIZE,
    },
    attachmentImageRemoveFrame: {
        position: 'absolute',
        top: -ATTACHMENT_CORNER_REMOVE_OVERHANG,
        right: -ATTACHMENT_CORNER_REMOVE_OVERHANG,
        width: ATTACHMENT_CORNER_REMOVE_SIZE,
        height: ATTACHMENT_CORNER_REMOVE_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
    },
    // Lab TA: a small ink disc on the picture's corner, ringed in the composer's paper so it reads
    // over any picture.
    attachmentImageRemoveDisc: {
        width: ATTACHMENT_CORNER_REMOVE_SIZE,
        height: ATTACHMENT_CORNER_REMOVE_SIZE,
        borderRadius: ATTACHMENT_CORNER_REMOVE_SIZE / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.text.primary,
        borderWidth: 2,
        borderColor: theme.colors.surface.base,
    },
    attachmentImageRemoveIcon: {
        color: theme.colors.surface.base,
    },
    // Lab I3: the pen sits on the corner opposite the number, on the same ink disc as remove.
    attachmentImageFill: {
        width: '100%',
        height: '100%',
    },
    attachmentImagePenFrame: {
        position: 'absolute',
        right: theme.space.s2,
        bottom: theme.space.s2,
    },
    attachmentImagePenDisc: {
        width: ATTACHMENT_CORNER_REMOVE_SIZE,
        height: ATTACHMENT_CORNER_REMOVE_SIZE,
        borderRadius: ATTACHMENT_CORNER_REMOVE_SIZE / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.text.primary,
        borderWidth: 2,
        borderColor: theme.colors.surface.base,
    },
    // The rail's scroll frame clips; it reaches up and right into the row's padding by the corner
    // control's overhang, so the control is not cut while the tray keeps its height.
    compactRail: {
        marginTop: -ATTACHMENT_CORNER_REMOVE_OVERHANG,
        marginRight: -ATTACHMENT_CORNER_REMOVE_OVERHANG,
    },
    rowContent: {
        gap: theme.space.s8,
        paddingTop: ATTACHMENT_CORNER_REMOVE_OVERHANG,
        paddingRight: ATTACHMENT_CORNER_REMOVE_OVERHANG,
    },
    contentSurfaceBand: {
        gap: theme.space.s8,
        paddingTop: theme.space.s8,
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
    },
    // The card body clips its content to the card's lower corners; the header above it never clips, so its
    // preview and remove controls reach past the card edge (DESIGN.md → touch targets are hit areas).
    surfaceBody: {
        borderBottomLeftRadius: 11,
        borderBottomRightRadius: 11,
        overflow: 'hidden',
    },
    surfaceHeader: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: theme.space.s6,
        paddingHorizontal: theme.space.s10,
    },
    surfacePreviewButton: {
        alignItems: 'center',
        alignSelf: 'stretch',
        flex: 1,
        flexDirection: 'row',
        gap: theme.space.s6,
    },
    surfaceRemoveButton: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    surfaceLabel: {
        color: theme.colors.text.secondary,
        flex: 1,
        ...Typography.variant('meta'),
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
    const stage = useMediaStage();
    // Touch neighbours split the 6 px chip gap. A fine pointer's neighbour has no extension;
    // the remove icon's 24 px target reaches 4 px into that gap without moving its drawn box.
    const chipRemoveHitReach = useHappierTouchPrimaryPointer(Platform.OS) ? ATTACHMENT_CHIP_REMOVE_HIT_REACH : undefined;
    const [surfaceLayouts, setSurfaceLayouts] = React.useState<Readonly<Record<string, AttachmentSurfaceLayout>>>({});
    const [contentSurfaceBandTop, setContentSurfaceBandTop] = React.useState<number | null>(null);
    const [compactRailViewport, setCompactRailViewport] = React.useState<CompactRailViewport>({
        horizontalOffset: 0,
        top: null,
        width: 0,
    });
    const attachmentFocusTargetsRef = React.useRef(new Map<string, unknown>());
    const pendingAttachmentFocusRef = React.useRef<PendingAttachmentFocus | null>(null);
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
    // Lab TA: each picture carries its "Image #N" number on its corner, the same number its chip reads.
    const imageNumbers = React.useMemo(() => readAgentInputImageNumbers(props.items), [props.items]);
    const renderImageNumber = (item: Extract<AgentInputAttachmentsRowItem, Readonly<{ kind: 'media' }>>) => {
        const number = item.attachmentId === undefined ? undefined : imageNumbers.get(item.attachmentId);
        return number === undefined ? null : <ImageNumberBadge number={number} testID={`agent-input-attachment-number:${item.key}`} />;
    };
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
        if (item.availability === 'invalid') return t('errors.invalidFormat');
        return null;
    };
    // An item that cannot be read right now (its source is offline, signed out) keeps its last-known name: the
    // reason is in its accessible name and tooltip, not a red alarm on the chip.
    const resolveAttachmentNote = (item: AgentInputAttachmentsRowItem): string | null => (
        // Only a known reason is said: the chip shows no unavailable state of its own (D4).
        item.availability === 'unavailable' ? item.availabilityReason?.trim() || null : null
    );
    const resolveAttachmentAccessibilityLabel = (item: AgentInputAttachmentsRowItem): string => {
        const error = resolveAttachmentError(item) ?? resolveAttachmentNote(item);
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

    /** One picture's upload state over the tile: progress (or a spinner until the size is known), its number, a failure. */
    const renderPictureState = (att: Extract<AgentInputAttachmentsRowItem, Readonly<{ kind: 'media' }>>, attachmentError: string | null, percent: number | null) => (
        <>
            {att.status === 'uploading' ? (
                <View style={styles.attachmentImageOverlay} testID={`agent-input-attachment-uploading:${att.key}`}>
                    {percent != null
                        ? <Text style={styles.attachmentImageOverlayText}>{percent}%</Text>
                        : <ActivitySpinner size="small" color={theme.colors.overlay.foreground} />}
                </View>
            ) : null}
            {renderImageNumber(att)}
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
        </>
    );

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
                                <HappierPressable
                                    controlRef={attachmentFocusRef(item.key, anchorRef)}
                                    accessibilityHint={t('common.open')}
                                    accessibilityLabel={resolveAttachmentAccessibilityLabel(item)}
                                    accessibilityRole="button"
                                    onPress={onPress}
                                    style={styles.surfacePreviewButton}
                                    testID={item.testID ? `${item.testID}-preview` : undefined}
                                >
                                    <Icon name="eye" size={16} color={theme.colors.text.secondary} />
                                    <Text numberOfLines={1} style={styles.surfaceLabel}>{item.label}</Text>
                                </HappierPressable>
                            ) : (
                                <Text numberOfLines={1} style={styles.surfaceLabel}>{item.label}</Text>
                            )}
                            {item.onRemove ? (
                                <HappierPressable
                                    controlRef={onPress ? undefined : attachmentFocusRef(item.key)}
                                    accessibilityLabel={item.removeAccessibilityLabel ?? t('common.remove')}
                                    accessibilityRole="button"
                                    onPress={() => requestAttachmentRemoval(item, onRemove)}
                                    hitTarget={HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE}
                                    hitReach={chipRemoveHitReach}
                                    style={styles.surfaceRemoveButton}
                                    testID={removeTestID}
                                >
                                    <Icon name="x" size={ATTACHMENT_REMOVE_ICON_SIZE} color={theme.colors.text.secondary} />
                                </HappierPressable>
                            ) : null}
                        </View>
                        <View style={styles.surfaceBody}>
                            {renderAttachmentErrorFeedback(item)}
                            {props.verticalViewport ? (
                                shouldMountSurfaceBody(item) ? item.renderedContent : null
                            ) : (
                                <LazyMountOnScreen>
                                    {item.renderedContent}
                                </LazyMountOnScreen>
                            )}
                        </View>
                    </View>
                )}
            </AttachmentRowPreviewTrigger>
        );
    };

    const renderCompactItem = (item: AgentInputAttachmentsRowItem) => {
        if (isBadgeAttachmentRowItem(item)) {
            const badge = item;
            const icon = badge.icon?.(theme.colors.text.secondary) ?? (
                <Icon name={badge.attachmentType === 'folder' ? 'folder' : 'file'} size={14} color={theme.colors.text.secondary} />
            );
            const note = resolveAttachmentNote(badge);
            const labelText = (
                <Text
                    numberOfLines={1}
                    style={styles.attachmentChipText}
                >
                    {badge.label}
                </Text>
            );
            const previewContent = (
                <>
                    {icon}
                    {note ? <Tooltip label={note} accessibilityLabel={resolveAttachmentAccessibilityLabel(badge)} testID={`agent-input-attachment-note:${badge.key}`} focusable={false}>{labelText}</Tooltip> : labelText}
                    {badge.detail ? (
                        <Text numberOfLines={1} style={styles.attachmentChipDetail}>{badge.detail}</Text>
                    ) : null}
                    {renderAttachmentErrorFeedback(badge)}
                </>
            );
            const renderRemoveButton = (
                onRemove: (() => void) | undefined,
                focusFallback: boolean,
            ) => badge.onRemove ? (
                <HappierPressable
                    controlRef={focusFallback ? attachmentFocusRef(badge.key) : undefined}
                    accessibilityLabel={badge.removeAccessibilityLabel ?? t('common.remove')}
                    accessibilityRole="button"
                    onPress={() => requestAttachmentRemoval(badge, onRemove)}
                    hitTarget={HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE}
                    hitReach={chipRemoveHitReach}
                    testID={badge.removeTestID ?? (badge.testID ? `${badge.testID}-remove` : undefined)}
                >
                    <Icon name="x" size={ATTACHMENT_REMOVE_ICON_SIZE} color={theme.colors.text.secondary} />
                </HappierPressable>
            ) : null;

            if (badge.onPress || badge.renderPreviewPopover) {
                return (
                    <AttachmentRowPreviewTrigger
                        key={badge.key}
                        item={badge}
                    >
                        {({ anchorRef, onPress, onRemove }) => (
                            <View style={styles.attachmentChip} testID={badge.testID}>
                                <HappierPressable
                                    controlRef={attachmentFocusRef(badge.key, anchorRef)}
                                    accessibilityLabel={resolveAttachmentAccessibilityLabel(badge)}
                                    accessibilityRole="button"
                                    onPress={onPress ?? NO_PRESS}
                                    style={styles.attachmentChipPreviewButton}
                                    testID={badge.testID ? `${badge.testID}-preview` : undefined}
                                >
                                    {previewContent}
                                </HappierPressable>
                                {renderRemoveButton(onRemove, false)}
                            </View>
                        )}
                    </AttachmentRowPreviewTrigger>
                );
            }

            return (
                <View key={badge.key} style={styles.attachmentChip} testID={badge.testID}>
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
                        <TrayPictureTile
                            removeTestID={att.onRemove ? att.removeTestID ?? `agent-input-attachment-remove:${att.key}` : undefined}
                            removeAccessibilityLabel={att.removeAccessibilityLabel ?? t('common.remove')}
                            removeRef={onPress ? undefined : attachmentFocusRef(att.key)}
                            onRemove={att.onRemove ? () => requestAttachmentRemoval(att, onRemove) : undefined}
                        >
                            {onPress ? (
                                <HappierPressable
                                    controlRef={attachmentFocusRef(att.key, anchorRef)}
                                    accessibilityLabel={resolveAttachmentAccessibilityLabel(att)}
                                    accessibilityRole="button"
                                    onPress={onPress ?? NO_PRESS}
                                    style={styles.attachmentImageSurface}
                                    testID={`agent-input-attachment-media:${att.key}`}
                                >
                                    {att.media === 'image' ? <TrayPictureBacking alphaCapable={resolveTrayPictureAlphaCapable(att)} checkerboardTestID={`agent-input-attachment-checkerboard:${att.key}`} /> : null}
                                    {att.renderedPreview}
                                </HappierPressable>
                            ) : (
                                <View
                                    accessibilityLabel={resolveAttachmentAccessibilityLabel(att)}
                                    accessibilityRole="image"
                                    style={styles.attachmentImageSurface}
                                    testID={`agent-input-attachment-media:${att.key}`}
                                >
                                    {att.media === 'image' ? <TrayPictureBacking alphaCapable={resolveTrayPictureAlphaCapable(att)} checkerboardTestID={`agent-input-attachment-checkerboard:${att.key}`} /> : null}
                                    {att.renderedPreview}
                                </View>
                            )}
                            {renderPictureState(att, attachmentError, percent)}
                        </TrayPictureTile>
                    )}
                </AttachmentRowPreviewTrigger>
            );
        }
        const imagePreviewUri =
            att.preview?.kind === 'image' && typeof att.preview.uri === 'string' && att.preview.uri.trim().length > 0
                ? att.preview.uri
                : null;
        const imagePreviewIndex = attachmentImagePreviewItems.findIndex((item) => item.uri === imagePreviewUri && item.title === att.label);

        const openImageStage = (annotate: boolean) => {
            const openIndex = imagePreviewIndex >= 0 ? imagePreviewIndex : 0;
            stage.open(attachmentImagePreviewItems.map((item, index) => ({
                kind: 'image' as const,
                title: item.title,
                alphaCapable: resolveFileViewerKind({ path: item.title, mimeType: item.mimeType }).alphaCapable,
                edit: item.edit,
                ...(annotate && index === openIndex ? { annotate: true } : {}),
                source: { enabled: true, mimeType: item.mimeType, source: { kind: 'uri' as const, uri: item.uri } },
                originRef: { current: (attachmentFocusTargetsRef.current.get(item.key) ?? null) as View | null },
            })), openIndex);
        };

        if (imagePreviewUri) {
            return (
                <AttachmentRowPreviewTrigger
                    key={att.key}
                    item={att}
                    fallbackOnPress={() => openImageStage(false)}
                >
                    {({ anchorRef, onPress, onRemove }) => (
                        <TrayPictureTile
                            removeTestID={att.onRemove ? att.removeTestID ?? `agent-input-attachment-remove:${att.key}` : undefined}
                            removeAccessibilityLabel={att.removeAccessibilityLabel ?? t('common.remove')}
                            onRemove={att.onRemove ? () => requestAttachmentRemoval(att, onRemove) : undefined}
                            {...(att.hasImageMarks ? { onEditMarks: () => openImageStage(true) } : {})}
                        >
                            <HappierPressable
                                controlRef={attachmentFocusRef(att.key, anchorRef)}
                                accessibilityLabel={resolveAttachmentAccessibilityLabel(att)}
                                accessibilityRole="button"
                                onPress={onPress ?? NO_PRESS}
                                style={styles.attachmentImageSurface}
                                testID={`agent-input-attachment-image:${att.key}`}
                            >
                                <TrayPictureBacking alphaCapable={resolveTrayPictureAlphaCapable(att)} checkerboardTestID={`agent-input-attachment-checkerboard:${att.key}`} />
                                {/* Done swaps the picture in place with one short fade (MIS §8.2). */}
                                <WordCrossFade wordKey={imagePreviewUri} style={styles.attachmentImageFill}>
                                    <Image
                                        source={{ uri: imagePreviewUri }}
                                        style={[{ width: '100%', height: '100%' }, styles.attachmentImage]}
                                        contentFit="cover"
                                    />
                                </WordCrossFade>
                                {renderPictureState(att, attachmentError, percent)}
                            </HappierPressable>
                        </TrayPictureTile>
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
            <HappierPressable
                controlRef={focusFallback ? attachmentFocusRef(att.key) : undefined}
                testID={att.removeTestID ?? `agent-input-attachment-remove:${att.key}`}
                accessibilityLabel={att.removeAccessibilityLabel ?? t('common.remove')}
                accessibilityRole="button"
                onPress={() => requestAttachmentRemoval(att, onRemove)}
                hitTarget={HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE}
                hitReach={chipRemoveHitReach}
            >
                <Icon name="x-circle" size={ATTACHMENT_REMOVE_ICON_SIZE} color={theme.colors.text.secondary} />
            </HappierPressable>
        ) : null;

        if (att.onPress || att.renderPreviewPopover) {
            return (
                <AttachmentRowPreviewTrigger
                    key={att.key}
                    item={att}
                >
                    {({ anchorRef, onPress, onRemove }) => (
                        <View style={styles.attachmentChip} testID={att.testID}>
                            <HappierPressable
                                controlRef={attachmentFocusRef(att.key, anchorRef)}
                                accessibilityLabel={resolveAttachmentAccessibilityLabel(att)}
                                accessibilityRole="button"
                                onPress={onPress ?? NO_PRESS}
                                style={styles.attachmentChipPreviewButton}
                                testID={att.testID ? `${att.testID}-preview` : undefined}
                            >
                                {fallbackContent}
                            </HappierPressable>
                            {renderFallbackRemoveButton(onRemove, false)}
                        </View>
                    )}
                </AttachmentRowPreviewTrigger>
            );
        }

        return (
            <View key={att.key} style={styles.attachmentChip} testID={att.testID}>
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
                    style={styles.compactRail}
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
