import * as React from 'react';
import { Image, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS, Popover } from '@/components/ui/popover';
import { GlassLivePictureBackdropContext } from '@/components/ui/glass/livePictureBackdrop';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { setDesktopGlassPanelShape } from '@/utils/platform/desktopGlassMaterial';
import type { MultiTextInputHandle } from '@/components/ui/forms/MultiTextInput';
import type { ComposerEditorReference } from '@/components/ui/forms/composerEditor/composerEditorTypes';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { AnnotatorCanvas } from '@/components/ui/media/annotation/AnnotatorCanvas';
import { AnnotatorCaptionSlot, AnnotatorPalette, AnnotatorPaperCapsule } from '@/components/ui/media/annotation/AnnotatorPalette';
import { AnnotatorPictureFrame } from '@/components/ui/media/annotation/AnnotatorPictureFrame';
import type { ImageAnnotator } from '@/components/ui/media/annotation/annotatorStore';
import { WordCrossFade } from '@/components/ui/motion/WordCrossFade';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useDesktopWindowDragMouseProps } from '@/components/navigation/desktopWindowChrome/DesktopWindowDragRegion';
import { resolveAgentInputPanelEdgeStyle } from '@/components/sessions/agentInput/components/agentInputChromeStyles';
import { SessionChooser, type SessionChooserPageReader } from '@/components/sessions/selection/SessionChooser';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { resolveThemeSurfaceBorderStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import { surfaceUsesRim } from '@/components/ui/surfaces/surfaceEdgeTreatment';
import { resolveThemeRaisedEdge } from '@/components/ui/surfaces/themeRaisedEdge';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { ESCAPE_LAYER_PRIORITIES, EscapeLayerProvider, useEscapeLayer } from '@/keyboard/escape';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { t } from '@/text';

import { RecentCaptureGrid } from '../recent/RecentCaptureGrid';
import type { RecentCaptureConsumer } from '../recent/useRecentCaptures';
import { CaptureDeliveryPill, CAPTURE_PILL_HEIGHT, capturePillLeavesOnItsOwn, type CapturePillState } from './CaptureDeliveryPill';
import { CaptureWindowMoreMenu, type CaptureWindowMoreActions } from './CaptureWindowMoreMenu';
import { CaptureWindowNote, CaptureWindowTargetLine, type CaptureWindowTarget, type CaptureWindowUnreachable } from './CaptureWindowNote';
import {
    playDeliveryMoment,
    playDiscardFold,
    playOpenCentred,
    playOpenFromArea,
    playPillExit,
    playPillReopen,
    playWindowExit,
    releasePaper,
} from './captureWindowMotion';
import { resolveCapturePillFrame, type CaptureRect, type CaptureWindowFrame } from './resolveCaptureWindowFrame';

const PILL_WIDTH = 460;
/** Lab `rc` REC: three thumbnails across, the same grid the composer's picker draws. */
const RECENT_WIDTH = 520;
const DISCARD_PILL_WIDTH = 280;
/** Layout reports whole pixels; a fraction short would ellipsize the Session title with room to spare. */
const RAIL_ROUNDING_SLACK = 2;

export type CaptureWindowMeasure = Readonly<{ chromeTop: number; chromeBottom: number; floorWidth: number }>;
export type CaptureDelivery = 'send' | 'addToDraft';
export type CaptureWindowTextSurface = Readonly<{
    noteRef: React.RefObject<View | null>;
    paperRef: React.RefObject<View | null>;
    /** The room under the toolbar: the View sheet covers the picture, never the tools. */
    stageRef: React.RefObject<View | null>;
}>;
export type CaptureWindowChooser = Readonly<{
    readPage: SessionChooserPageReader;
    selected: SessionAddress | null;
    onSelect: (address: SessionAddress) => void;
    /** Whether this capture can start a Session of its own. */
    canStartSession: boolean;
    onNewSession?: () => void;
    newSessionContext: string | null;
}>;
export type CaptureDeliveryOutcome =
    | Readonly<{ ok: true; pill: CapturePillState }>
    | Readonly<{ ok: false; cause: string; phase?: 'preparation' | 'delivery' }>;
export type CaptureWindowCaption = Readonly<{
    icon: IconName;
    /** The fact that leads, a step stronger than the rest. */
    lead: string | null;
    facts: readonly string[];
}>;
/** The note's time chips, for a video: the field stays the composer's own. */
export type CaptureWindowNoteChips = Readonly<{
    references: readonly ComposerEditorReference[];
    onReferencesChange: (references: readonly ComposerEditorReference[]) => void;
    onReferencePress: (ref: string) => void;
    /** Where the caret lands after a chip went in. */
    caret: Readonly<{ at: number }> | null;
}>;
type Phase = 'opening' | 'open' | 'delivering' | 'pill' | 'closing' | 'gone';

const dom = (view: unknown) => view as HTMLElement;
const pendingPill = (delivery: CaptureDelivery, session: string, newSession: boolean): CapturePillState =>
    newSession ? { kind: 'starting' } : { kind: delivery === 'send' ? 'sending' : 'adding', session };

/**
 * The Capture window (lab `cw` S/L, `st`; MIS §2, §6): the picture sized to the capture, the annotator
 * flat on the window's paper, and the note that sends it. The picture and the paper are one composition
 * in the window's coordinates; the host supplies the frame and every operation, so this screen loads no
 * Sync and decides no delivery.
 */
export function CaptureWindowScreen(props: Readonly<{
    signal?: AbortSignal;
    /** Null until the chrome is measured: the first pass lays out hidden. */
    frame: CaptureWindowFrame | null;
    /** The captured area in this container's coordinates; absent, the window opens centred. */
    area: CaptureRect | null;
    workArea: CaptureRect;
    screenInset: number;
    onMeasure: (measure: CaptureWindowMeasure) => void;
    annotator: ImageAnnotator;
    pictureUri?: string;
    /** Stands in for the still picture: the video's player, under the same marks. */
    renderPicture?: () => React.ReactNode;
    /** Marks draw on a paused frame only; while a video plays the canvas steps aside. */
    canvasHidden?: boolean;
    /** Under the picture, above the caption: the video's timeline. */
    belowPicture?: React.ReactNode;
    /** The line above the note that says what is sent. */
    notice?: React.ReactNode;
    noteChips?: CaptureWindowNoteChips;
    /** The pill's word after a reversible discard. */
    discardedTitle?: string;
    caption: CaptureWindowCaption;
    target: CaptureWindowTarget | null;
    /** Main-owned draft summary; the Send tooltip explains that this text goes too (D6). */
    sendIncludesDraftText?: boolean;
    /** Absent, the chip names the target and doesn't open. */
    chooser?: CaptureWindowChooser;
    unreachable: CaptureWindowUnreachable | null;
    /** The window-text chip; its View sheet stands on the note's panel, inside the window's paper. */
    renderWindowText?: (surface: CaptureWindowTextSurface) => React.ReactNode;
    note: string;
    onNoteChange: (note: string) => void;
    onDeliver: (delivery: CaptureDelivery) => Promise<CaptureDeliveryOutcome>;
    /** A settled failure's Retry: it resubmits; nothing is added again (D6). */
    onRetry: (delivery: CaptureDelivery) => Promise<CaptureDeliveryOutcome>;
    /** The flattened picture for the pill. */
    thumbnailUri: string | null;
    hasWork: boolean;
    onDiscard: () => void;
    onUndoDiscard: () => void;
    /** Commit a discard after Undo ends; a failure keeps this presentation and its Retry. */
    onBeforeClose?: () => Promise<Readonly<{ ok: false; cause: string }> | void>;
    /** The pill left or the window closed: the host hides the native window. */
    onClosed: () => void;
    onOpenSession?: () => void;
    onOpenStart?: () => void;
    onCopy?: () => Promise<void | boolean> | void | boolean;
    onShowInFolder?: () => void;
    more: CaptureWindowMoreActions;
    /** Opens a kept capture in this window, from the ⋯ menu's list. */
    onOpenRecent?: RecentCaptureConsumer;
    /**
     * The native frame follows the motion (D3). `glassRadius` is the resting card's radius when the card
     * fills that frame; the app's glass is clipped to it. Null while the card moves within the frame.
     */
    onSurfaceRect?: (rect: CaptureRect, glassRadius: number | null) => void;
}>) {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const { frame, area } = props;
    const rootRef = React.useRef<View>(null);
    const paperRef = React.useRef<View>(null);
    const contentRef = React.useRef<View>(null);
    const topRef = React.useRef<View>(null);
    const bottomRef = React.useRef<View>(null);
    const pictureRef = React.useRef<View>(null);
    const chipRef = React.useRef<View>(null);
    const chipMarkRef = React.useRef<View>(null);
    const pillRef = React.useRef<View>(null);
    const noteRef = React.useRef<MultiTextInputHandle>(null);
    const notePanelRef = React.useRef<View>(null);
    const stageRef = React.useRef<View>(null);
    const [choosing, setChoosing] = React.useState(false);
    const [choosingRecent, setChoosingRecent] = React.useState(false);
    const [phase, setPhase] = React.useState<Phase>('opening');
    const [pill, setPill] = React.useState<CapturePillState | null>(null);
    const [copied, setCopied] = React.useState(false);
    const [holding, setHolding] = React.useState(false);
    const lastDelivery = React.useRef<CaptureDelivery>('send');
    const opened = React.useRef(false);
    const sizes = React.useRef({ topHeight: 0, bottomHeight: 0, topWidth: 0, railWidth: 0 });
    const radius = theme.borderRadius.xxl;

    const report = () => {
        const { topHeight, bottomHeight, topWidth, railWidth } = sizes.current;
        // Every row must have reported: the first frame fixes the widths for good.
        if (topHeight === 0 || bottomHeight === 0 || topWidth === 0 || railWidth === 0) return;
        props.onMeasure({
            chromeTop: topHeight,
            chromeBottom: bottomHeight,
            floorWidth: Math.ceil(Math.max(topWidth, railWidth)),
        });
    };
    const onTopLayout = (event: LayoutChangeEvent) => {
        sizes.current.topHeight = event.nativeEvent.layout.height;
        report();
    };
    // Widths are the rows' own, read while they lay out unconstrained; inside the window they only follow it.
    const onToolbarLayout = (event: LayoutChangeEvent) => {
        if (frame !== null) return;
        sizes.current.topWidth = event.nativeEvent.layout.width + theme.space.s12 * 2;
        report();
    };
    const onBottomLayout = (event: LayoutChangeEvent) => {
        sizes.current.bottomHeight = event.nativeEvent.layout.height;
        report();
    };
    const onRailLayout = (event: LayoutChangeEvent) => {
        if (frame !== null) return;
        // The rail stands in the note's panel (padding and edge), which stands in the foot's gutter.
        const edge = resolveAgentInputPanelEdgeStyle(theme).borderWidth;
        sizes.current.railWidth = Math.ceil(event.nativeEvent.layout.width) + RAIL_ROUNDING_SLACK + (theme.space.s8 + theme.space.s16 + edge) * 2;
        report();
    };

    const resolvePill = (width: number) => (frame ? resolveCapturePillFrame({
        window: frame.window,
        pill: { width, height: CAPTURE_PILL_HEIGHT },
        workArea: props.workArea,
        screenInset: props.screenInset,
    }) : null);
    const deliveryRect = resolvePill(PILL_WIDTH);
    const discardRect = resolvePill(DISCARD_PILL_WIDTH);
    const [pillRectState, setPillRect] = React.useState<CaptureRect | null>(null);
    const pillRect = pillRectState ?? deliveryRect;

    const chrome = () => [topRef.current, bottomRef.current].map(dom);
    const elements = () => ({ paper: dom(paperRef.current), content: dom(contentRef.current) });

    React.useLayoutEffect(() => {
        if (!frame || opened.current) return;
        opened.current = true;
        noteRef.current?.focus();
        props.onOpenStart?.();
        // The note has focus from the first frame, so keys typed during the motion land (MIS §2.3).
        const run = area && rootRef.current
            ? (() => {
                const container = dom(rootRef.current).getBoundingClientRect();
                return playOpenFromArea({ ...elements(), picture: dom(pictureRef.current), chrome: chrome() }, {
                    area,
                    areaInPage: { ...area, x: area.x + container.left, y: area.y + container.top },
                    window: frame.window,
                    radius,
                    reducedMotion,
                });
            })()
            : playOpenCentred(dom(paperRef.current).parentElement!, reducedMotion);
        void run.then(() => {
            if (props.signal?.aborted) return;
            setPhase(current => current === 'opening' ? 'open' : current);
            props.onSurfaceRect?.(frame.window, radius);
        });
        // The window opens once per capture; a new capture mounts a new screen.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [frame]);

    // Each resting state stands in the layout; the fills of the motion that reached it let go.
    React.useLayoutEffect(() => {
        if ((phase === 'open' || phase === 'pill') && paperRef.current && contentRef.current) releasePaper(elements());
        // `elements` reads refs.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [phase]);

    const settle = async (outcome: Promise<CaptureDeliveryOutcome>, target: Pick<CaptureWindowTarget, 'title'>, delivery: CaptureDelivery) => {
        const settled = await outcome;
        if (props.signal?.aborted) return;
        setPill(settled.ok ? settled.pill : { kind: 'failed', session: target.title, cause: settled.cause,
            operation: delivery, phase: settled.phase ?? 'delivery' });
    };

    const deliver = (delivery: CaptureDelivery) => {
        const target = props.target ?? { title: '' };
        if (phase !== 'open' || !frame || !pillRect || !props.target || props.target.disabledReason
            || (delivery === 'send' && (props.target.kind === 'newSession' || props.unreachable !== null))) return;
        lastDelivery.current = delivery;
        setPillRect(null);
        setPhase('delivering');
        setPill(pendingPill(delivery, target.title, props.target.kind === 'newSession'));
        void settle(props.onDeliver(delivery), target, delivery);
        void playDeliveryMoment({
            ...elements(),
            picture: dom(pictureRef.current),
            chipMark: dom(chipMarkRef.current),
            chip: dom(chipRef.current),
            chrome: chrome(),
            pill: dom(pillRef.current),
        }, {
            window: frame.window, pillRect, radius, pillRadius: CAPTURE_PILL_HEIGHT / 2,
            ringColor: theme.colors.border.focus, reducedMotion,
        }).then(() => {
            if (props.signal?.aborted) return;
            setPhase('pill');
            props.onSurfaceRect?.(pillRect, CAPTURE_PILL_HEIGHT / 2);
        });
    };

    const close = React.useCallback(async (exit: 'window' | 'pill') => {
        if (props.signal?.aborted) return;
        setPhase('closing');
        const failure = await props.onBeforeClose?.();
        if (props.signal?.aborted) return;
        if (failure) {
            setPill({ kind: 'failed', operation: 'discard', session: '', cause: failure.cause });
            setPillRect(deliveryRect);
            if (exit === 'window' && frame && deliveryRect) {
                await playDiscardFold({ ...elements(), picture: dom(pictureRef.current), chrome: chrome(), pill: dom(pillRef.current) }, {
                    window: frame.window, pillRect: deliveryRect, radius, pillRadius: CAPTURE_PILL_HEIGHT / 2, reducedMotion,
                });
                if (props.signal?.aborted) return;
            }
            if (deliveryRect) props.onSurfaceRect?.(deliveryRect, CAPTURE_PILL_HEIGHT / 2);
            setPhase('pill');
            return;
        }
        await (exit === 'window' ? playWindowExit(dom(paperRef.current).parentElement!, reducedMotion)
            : playPillExit(dom(paperRef.current), reducedMotion));
        if (props.signal?.aborted) return;
        setPhase('gone');
        props.onClosed();
    }, [props.onBeforeClose, props.onClosed, props.onSurfaceRect, props.signal, frame, deliveryRect, radius, reducedMotion]);

    const reopen = () => {
        if (!frame || !pillRect) return;
        setPhase('delivering');
        props.onSurfaceRect?.(frame.window, null);
        void playPillReopen({ ...elements(), picture: dom(pictureRef.current), chrome: chrome(), pill: dom(pillRef.current) }, {
            window: frame.window, pillRect, radius, pillRadius: CAPTURE_PILL_HEIGHT / 2, reducedMotion,
        }).then(() => {
            if (props.signal?.aborted) return;
            setPill(null);
            setPillRect(null);
            setPhase('open');
            props.onSurfaceRect?.(frame.window, radius);
        });
    };

    const discard = () => {
        if (phase !== 'open' && phase !== 'opening') return;
        if (!props.hasWork) {
            props.onDiscard();
            void close('window');
            return;
        }
        if (!frame || !discardRect) return;
        props.onDiscard();
        setPhase('delivering');
        setPill(props.discardedTitle ? { kind: 'discarded', title: props.discardedTitle } : { kind: 'discarded' });
        setPillRect(discardRect);
        void playDiscardFold({ ...elements(), picture: dom(pictureRef.current), chrome: chrome(), pill: dom(pillRef.current) }, {
            window: frame.window, pillRect: discardRect, radius, pillRadius: CAPTURE_PILL_HEIGHT / 2, reducedMotion,
        }).then(() => {
            if (props.signal?.aborted) return;
            setPhase('pill');
            props.onSurfaceRect?.(discardRect, CAPTURE_PILL_HEIGHT / 2);
        });
    };

    const retry = () => {
        if (pill?.kind === 'failed' && pill.operation === 'discard') {
            void close('pill');
            return;
        }
        const target = props.target ?? { title: '' };
        setPill(pendingPill(lastDelivery.current, target.title, props.target?.kind === 'newSession'));
        void settle(props.onRetry(lastDelivery.current), target, lastDelivery.current);
    };

    const undoDiscard = () => {
        props.onUndoDiscard();
        reopen();
    };

    const copy = async () => {
        const copied = await props.onCopy?.();
        if (!props.signal?.aborted && copied !== false) setCopied(true);
    };

    // The window's two sends take the composer's own bindings, so a rebinding follows them here (MIS §2).
    useKeyboardShortcutHandlers({
        'composer.sendImmediate': () => {
            if (props.unreachable === null) deliver('send');
        },
        'composer.sendInterrupt': () => deliver('addToDraft'),
        ...(props.chooser && (phase === 'opening' || phase === 'open') ? { 'screenCapture.chooseSession': () => setChoosing(true) } : {}),
        ...(frame !== null && (phase === 'opening' || phase === 'open') && props.onCopy
            ? { 'screenCapture.copy': () => { void copy(); } }
            : {}),
    });

    // The annotator's own layers (a popover, the selection, crop) answer Esc first: they sit in this scope.
    const escapeScope = useEscapeLayer({
        priority: ESCAPE_LAYER_PRIORITIES.overlay,
        enabled: !choosing && !choosingRecent && (phase === 'open' || phase === 'opening' || phase === 'pill'),
        onEscape: () => {
            if (phase === 'pill') {
                if (pill?.kind !== 'failed' || pill.operation !== 'discard') void close('pill');
            }
            else discard();
            return true;
        },
    });

    // The pill holds while it reads; a failure never leaves on its own, and a resting pointer holds it.
    const settledPill = phase === 'pill' && pill !== null && capturePillLeavesOnItsOwn(pill);
    React.useEffect(() => {
        if (!settledPill || holding) return;
        const timer = setTimeout(() => {
            void close('pill');
        }, motionTokens.undoHoldMs);
        return () => clearTimeout(timer);
    }, [close, holding, reducedMotion, settledPill]);

    React.useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), motionTokens.undoHoldMs);
        return () => clearTimeout(timer);
    }, [copied]);

    // The app's glass stands behind the card only while it rests filling the window; each resting
    // frame brings it back with its radius (`onSurfaceRect`).
    const resting = phase === 'open' || phase === 'pill';
    React.useEffect(() => {
        if (!resting) void setDesktopGlassPanelShape(null);
    }, [resting]);

    const chooseSession = props.chooser ? () => setChoosing(true) : undefined;
    const chooseKey = useKeyboardShortcutLabel('screenCapture.chooseSession');
    const dragProps = useDesktopWindowDragMouseProps();
    const measuring = frame === null;
    const window = frame?.window;
    const folded = (phase === 'pill' || (phase === 'closing' && pill !== null)) && pillRect !== null;
    const paperRect = folded ? pillRect : window;
    return (
        <EscapeLayerProvider layer={escapeScope}>
        <GlassLivePictureBackdropContext.Provider value>
        <View ref={rootRef} style={styles.root} pointerEvents="box-none">
            <View
                ref={paperRef}
                style={[
                    styles.paper,
                    measuring ? styles.hidden : { left: paperRect!.x, top: paperRect!.y, width: paperRect!.width, height: paperRect!.height },
                    { borderRadius: folded ? CAPTURE_PILL_HEIGHT / 2 : radius },
                ]}
                onPointerEnter={() => setHolding(true)}
                onPointerLeave={() => setHolding(false)}
            >
                {/* The window's own material over the desktop, as the main window's: glass where the app's
                    glass is on and the desktop shows through, its opaque surface otherwise. */}
                <GlassSurface surfaceGroup="content" finishRole={null} style={styles.paperMaterial} children={null} />
            </View>
            <View
                ref={contentRef}
                role="dialog"
                aria-label={t('screenCapture.window.title')}
                style={[
                    styles.content,
                    measuring ? styles.hidden : { left: window!.x, top: window!.y, width: window!.width, height: window!.height },
                    folded ? styles.foldedContent : null,
                ]}
                aria-hidden={folded}
                testID="capture-window"
            >
                <View ref={stageRef} pointerEvents="none" style={[styles.stageBounds, { top: sizes.current.topHeight }]} />
                <View ref={topRef} onLayout={onTopLayout} style={styles.top} {...dragProps}>
                    <View style={styles.toolbar} onLayout={onToolbarLayout}>
                        <AnnotatorPaperCapsule>
                            <IconButton
                                variant="plain"
                                iconName="x"
                                accessibilityLabel={t('screenCapture.window.discard')}
                                tooltip={t('screenCapture.window.discard')}
                                tooltipPlacement="bottom"
                                onPress={discard}
                                testID="capture-window-discard"
                            />
                        </AnnotatorPaperCapsule>
                        <View style={styles.palette}>
                            <AnnotatorPalette annotator={props.annotator} layout="bar" surface="paper" />
                        </View>
                        <AnnotatorPaperCapsule>
                            <IconButton
                                variant="plain"
                                icon={(
                                    <WordCrossFade wordKey={copied ? 'done' : 'copy'}>
                                        <Icon name={copied ? 'check' : 'copy'} size={18} color={theme.colors.text.primary} />
                                    </WordCrossFade>
                                )}
                                accessibilityLabel={t('screenCapture.window.copy')}
                                tooltip={t('screenCapture.window.copy')}
                                tooltipPlacement="bottom"
                                onPress={() => void copy()}
                                testID="capture-window-copy"
                            />
                            {props.onShowInFolder ? (
                                <IconButton
                                    variant="plain"
                                    iconName="folder"
                                    accessibilityLabel={t('screenCapture.window.showInFolder')}
                                    tooltip={t('screenCapture.window.showInFolder')}
                                    tooltipPlacement="bottom"
                                    onPress={props.onShowInFolder}
                                    testID="capture-window-show-in-folder"
                                />
                            ) : null}
                            <CaptureWindowMoreMenu {...props.more} {...(props.onOpenRecent ? { onAttachRecent: () => setChoosingRecent(true) } : {})} />
                        </AnnotatorPaperCapsule>
                    </View>
                </View>
                {frame ? (
                    <View style={[styles.slot, phase === 'delivering' ? styles.slotOutline : null, { width: frame.picture.width, height: frame.picture.height, marginLeft: frame.picture.x }]}>
                        <View ref={pictureRef} collapsable={false} style={styles.picture} testID="capture-window-picture">
                            <AnnotatorPictureFrame annotator={props.annotator} size={frame.picture} style={StyleSheet.absoluteFill}>
                                {props.renderPicture ? props.renderPicture() : <Image source={{ uri: props.pictureUri }} style={styles.image} resizeMode="stretch" />}
                                {props.canvasHidden ? null : <AnnotatorCanvas annotator={props.annotator} />}
                            </AnnotatorPictureFrame>
                        </View>
                    </View>
                ) : null}
                <View ref={bottomRef} onLayout={onBottomLayout} style={styles.bottom}>
                    {props.belowPicture ? <View style={styles.belowPicture}>{props.belowPicture}</View> : null}
                    <AnnotatorCaptionSlot annotator={props.annotator} surface="paper">
                        <View style={styles.caption} {...dragProps} testID="capture-window-caption">
                            <Icon name={props.caption.icon} size={13} color={theme.colors.text.tertiary} />
                            {props.caption.lead ? <Text variant="meta" emphasis="medium" style={styles.captionLead} numberOfLines={1}>{props.caption.lead}</Text> : null}
                            {props.caption.facts.map((fact, index) => (
                                <React.Fragment key={fact}>
                                    {index > 0 || props.caption.lead ? <Text variant="meta" style={styles.captionSep} aria-hidden>·</Text> : null}
                                    <Text variant="meta" style={styles.captionFact} numberOfLines={1}>{fact}</Text>
                                </React.Fragment>
                            ))}
                        </View>
                    </AnnotatorCaptionSlot>
                    <View style={styles.foot}>
                        {props.notice}
                        {props.unreachable ? <CaptureWindowTargetLine cause={{ kind: 'unreachable', unreachable: props.unreachable }} onChooseSession={chooseSession} />
                            : props.target?.kind === 'newSession' ? <CaptureWindowTargetLine cause={{ kind: 'refused', reason: t('transcript.selection.sendTo.newSessionSubtitle') }} onChooseSession={chooseSession} />
                            : props.target?.disabledReason ? <CaptureWindowTargetLine cause={{ kind: 'refused', reason: props.target.disabledReason }} onChooseSession={chooseSession} />
                            : null}
                        <CaptureWindowNote
                            note={props.note}
                            onNoteChange={props.onNoteChange}
                            chips={props.noteChips}
                            target={props.target}
                            sendIncludesDraftText={props.sendIncludesDraftText}
                            onChooseSession={chooseSession}
                            choosing={choosing}
                            unreachable={props.unreachable}
                            windowText={props.renderWindowText?.({ noteRef: notePanelRef, paperRef, stageRef })}
                            busy={phase !== 'open'}
                            onSend={() => deliver('send')}
                            onAddToDraft={() => deliver('addToDraft')}
                            chipRef={chipRef}
                            chipMarkRef={chipMarkRef}
                            inputRef={noteRef}
                            inputHandleRef={noteRef}
                            panelRef={notePanelRef}
                            onRailLayout={onRailLayout}
                        />
                    </View>
                </View>
            </View>
            <Popover
                open={choosingRecent}
                anchorRef={topRef}
                boundaryRef={stageRef}
                placement="bottom"
                maxWidthCap={RECENT_WIDTH}
                portal={{ ...MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS, anchorAlign: 'end' }}
                accessibilityLabel={t('screenCapture.window.attachRecent')}
                containerStyle={styles.recent}
                onRequestClose={() => setChoosingRecent(false)}
            >
                {({ maxHeight }) => (
                    <FloatingOverlay maxHeight={maxHeight} surfaceChrome="theme" scrollEnabled={false}>
                        <View style={styles.recentInset}>
                            <RecentCaptureGrid
                                maxHeight={maxHeight - theme.space.s6 * 2}
                                onChoose={async (entry) => { await props.onOpenRecent?.(entry); if (!props.signal?.aborted) setChoosingRecent(false); }}
                            />
                        </View>
                    </FloatingOverlay>
                )}
            </Popover>
            {props.chooser ? (
                <SessionChooser
                    open={choosing && (phase === 'opening' || phase === 'open')}
                    anchorRef={chipRef}
                    boundaryRef={paperRef}
                    readPage={props.chooser.readPage}
                    selected={props.chooser.selected}
                    title={t('screenCapture.chooser.title')}
                    enterHint={t('screenCapture.chooser.sendHere')}
                    searchKey={chooseKey}
                    newSessionContext={props.chooser.newSessionContext}
                    onSelect={(address) => {
                        setChoosing(false);
                        props.chooser?.onSelect(address);
                    }}
                    onNewSession={props.chooser.canStartSession ? () => {
                        setChoosing(false);
                        props.chooser?.onNewSession?.();
                    } : undefined}
                    onClose={() => setChoosing(false)}
                />
            ) : null}
            <View
                ref={pillRef}
                pointerEvents={pill === null || phase === 'delivering' || phase === 'closing' ? 'none' : 'auto'}
                style={[
                    styles.pill,
                    pillRect ? { left: pillRect.x, top: pillRect.y, width: pillRect.width, height: pillRect.height } : styles.hidden,
                    pill === null ? styles.invisible : null,
                ]}
                onPointerEnter={() => setHolding(true)}
                onPointerLeave={() => setHolding(false)}
            >
                {pill ? (
                    <CaptureDeliveryPill
                        state={pill}
                        thumbnailUri={props.thumbnailUri}
                        onOpen={props.onOpenSession}
                        onRetry={retry}
                        onEdit={pill.kind === 'failed' && pill.operation === 'discard' ? undoDiscard : reopen}
                        onUndo={undoDiscard}
                    />
                ) : null}
            </View>
        </View>
        </GlassLivePictureBackdropContext.Provider>
        </EscapeLayerProvider>
    );
}

const styles = StyleSheet.create((theme) => ({
    root: {
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
    },
    hidden: {
        position: 'absolute',
        left: 0,
        top: 0,
        width: 'max-content',
        visibility: 'hidden',
    } as never,
    invisible: {
        opacity: 0,
    },
    paper: {
        position: 'absolute',
        // The material fills the card and follows its corners through every morph.
        overflow: 'hidden',
        ...resolveThemeSurfaceBorderStyle({
            borderColor: theme.colors.border.modal,
            edge: resolveThemeRaisedEdge(theme, 'modal'),
            rim: surfaceUsesRim('floating', theme.dark),
        }),
        boxShadow: theme.colors.glass.castShadow,
    } as never,
    paperMaterial: {
        ...StyleSheet.absoluteFillObject,
        borderRadius: 'inherit',
    } as never,
    content: {
        position: 'absolute',
    },
    recent: {
        paddingHorizontal: 0,
    },
    // The grid's tiles and selection ring keep the same inset from the card edge as on the composer's card.
    recentInset: {
        padding: theme.space.s6,
    },
    stageBounds: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
    },
    foldedContent: {
        visibility: 'hidden',
    } as never,
    top: {
        paddingHorizontal: theme.space.s12,
        paddingTop: theme.space.s12,
        paddingBottom: theme.space.s16,
    },
    toolbar: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space.s8,
    },
    palette: {
        flexShrink: 0,
    },
    slot: {
        borderRadius: theme.borderRadius.md,
    },
    // The picture's place keeps a faint outline as it leaves, so nothing reflows (MIS §6).
    slotOutline: {
        boxShadow: `0 0 0 1px ${theme.colors.border.surface}`,
    } as never,
    picture: {
        ...StyleSheet.absoluteFillObject,
        borderRadius: theme.borderRadius.md,
        boxShadow: `0 0 0 1px ${theme.colors.border.strong}`,
    } as never,
    image: {
        width: '100%',
        height: '100%',
        borderRadius: theme.borderRadius.md,
    },
    bottom: {
        paddingTop: theme.space.s10,
    },
    belowPicture: {
        paddingHorizontal: theme.space.s24,
        paddingTop: theme.space.s8,
    },
    caption: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.space.s6,
        paddingHorizontal: theme.space.s24,
    },
    captionLead: {
        color: theme.colors.text.secondary,
    },
    captionFact: {
        ...Typography.tabular(),
        color: theme.colors.text.tertiary,
    },
    captionSep: {
        color: theme.colors.text.tertiary,
    },
    // One inset around the note card: its sides, its foot and the room above it under the caption.
    foot: {
        padding: theme.space.s16,
    },
    pill: {
        position: 'absolute',
    },
}));
