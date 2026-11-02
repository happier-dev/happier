import * as React from 'react';
import { ActivityIndicator, Image, Platform, ScrollView, View, type LayoutChangeEvent } from 'react-native';
import Animated, { FadeIn, ReduceMotion } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { isEmptyEdit, type ImageMarksDocumentV1 } from '@happier-dev/protocol';

import {
    resolveAgentInputPanelBackedEdgeStyle,
    resolveAgentInputPanelStyle,
} from '@/components/sessions/agentInput/components/agentInputChromeStyles';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { MultiTextInput, type MultiTextInputHandle, type OnKeyPressCallback } from '@/components/ui/forms/MultiTextInput';
import { Icon } from '@/components/ui/icons/Icon';
import { KeyboardCommandHint, useKeyboardCommandHintLabel } from '@/components/ui/keyboard/KeyHint';
import { AnnotatorCanvas } from '@/components/ui/media/annotation/AnnotatorCanvas';
import { AnnotatorCaptionSlot, AnnotatorHistoryButtons, AnnotatorPalette, AnnotatorPaperCapsule } from '@/components/ui/media/annotation/AnnotatorPalette';
import { AnnotatorPictureFrame } from '@/components/ui/media/annotation/AnnotatorPictureFrame';
import { useImageAnnotator, useImageAnnotatorState } from '@/components/ui/media/annotation';
import type { ElementPicker, ImageAnnotationSource, ImageAnnotator } from '@/components/ui/media/annotation';
import { motionTokens, resolveInPlaceMorphTiming } from '@/components/ui/motion/motionTokens';
import { playElementRectDeparture, playElementRectFlight, captureElementFlightRect } from '@/components/ui/motion/rectFlight';
import { WordCrossFade } from '@/components/ui/motion/WordCrossFade';
import { Text } from '@/components/ui/text/Text';
import type { HappierFocusable } from '@happier-dev/plugin-ui/presentation';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { resolveComposerSendShortcutAction } from '@/keyboard/composer';
import { ESCAPE_LAYER_PRIORITIES, EscapeLayerProvider, useEscapeLayer, type EscapeLayerScope } from '@/keyboard/escape';
import { shadowLevelStyle } from '@/shadowElevation';
import { useSettingsValues } from '@/sync/store/settingsReadHooks';
import { t } from '@/text';
import { createBrowserAnnotationElementPicker } from '@/sync/domains/browser/context/elementPickerAnnotationBridge';

import { createBrowserAnnotatorElementTool } from './browserAnnotatorElementTool';
import type { BrowserAnnotationController } from './useBrowserAnnotationController';

const ACTION_HEIGHT = 32;
const COMMENT_MAX_HEIGHT = 96;
const INSET_ANIMATION_ID = 'browser-annotator-inset';
const CARD_MIN_WIDTH = 320;

export type BrowserAnnotatorSession = Readonly<{
    source: ImageAnnotationSource;
    document: ImageMarksDocumentV1;
    comment: string;
    pageLabel: string;
    element?: ElementPicker;
    onDocumentChange: (document: ImageMarksDocumentV1) => void;
    onCommentChange: (comment: string) => Promise<Readonly<{ ok: boolean }>>;
    /** Flattens once and lands the picture, its badge and the comment in the composer (MIS §8b.5). */
    onAttach: () => Promise<Readonly<{ ok: boolean }>>;
    onCancel: () => void;
}>;

/** The controller's frozen draft as the annotator's session; null until the capture exists. */
export function useBrowserAnnotatorSession(annotation: BrowserAnnotationController): BrowserAnnotatorSession | null {
    const { draft, queryElementAtPoint, changeDocument, changeComment, recordElement, attachDraft, cancel } = annotation;
    const source = draft?.source ?? null;
    const element = React.useMemo(() => {
        if (!source || !queryElementAtPoint) return undefined;
        return createBrowserAnnotatorElementTool({
            source,
            createPicker: (onHover) => createBrowserAnnotationElementPicker({ query: queryElementAtPoint, scale: source.scale, onHover }),
            recordElement,
        });
    }, [queryElementAtPoint, recordElement, source]);
    return React.useMemo(() => (draft && source ? {
        source,
        document: draft.document,
        comment: draft.comment ?? '',
        pageLabel: draft.pageTitle || readPageOrigin(draft.pageUrl) || t('browserContext.composer.untitledPage'),
        ...(element ? { element } : {}),
        onDocumentChange: changeDocument,
        onCommentChange: changeComment,
        onAttach: attachDraft,
        onCancel: cancel,
    } : null), [attachDraft, cancel, changeComment, changeDocument, draft, element, source]);
}

function readPageOrigin(pageUrl: string | undefined): string | null {
    if (!pageUrl) return null;
    try {
        return new URL(pageUrl).origin;
    } catch {
        return null;
    }
}

/**
 * The annotator for one frozen page. It lives only while annotating, its keyboard commands with it, and
 * hands itself to the shell, whose chrome row and page region draw the same instance. An agent's edit
 * lands in the host's document and comes back here without becoming a gesture.
 */
export function BrowserAnnotatorMount(props: Readonly<{
    session: BrowserAnnotatorSession;
    onAnnotator: (annotator: ImageAnnotator | null) => void;
}>) {
    const { session, onAnnotator } = props;
    const annotator = useImageAnnotator({
        source: session.source,
        initial: session.document,
        tools: { ...(session.element ? { element: session.element } : {}) },
        onDocumentChange: session.onDocumentChange,
    });
    React.useEffect(() => {
        annotator.receiveDocument(session.document);
    }, [annotator, session.document]);
    React.useLayoutEffect(() => {
        // The page tool leads: Annotate page is mostly "this thing here" (lab `an · BR`).
        if (session.element) annotator.setTool('element');
        onAnnotator(annotator);
        return () => onAnnotator(null);
        // The tool is chosen once, on opening; afterwards it's the person's.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [annotator, onAnnotator]);
    return null;
}

/** The chrome row while annotating: × in Back's slot, the shared palette where the address was (MIS §8b.1). */
export function BrowserAnnotatorBar(props: Readonly<{
    annotator: ImageAnnotator;
    phone: boolean;
    onClose: () => void;
    attach: BrowserAnnotatorAttachControl;
    /** The stage control's Escape scope: the palette's popover answers Esc before Cancel. */
    escapeScope: EscapeLayerScope;
}>) {
    const close = (
        <AnnotatorPaperCapsule>
            <IconButton
                variant="plain"
                iconName="x"
                accessibilityLabel={t('browserContext.editor.cancel')}
                onPress={props.onClose}
                testID="browser-annotator-close"
            />
        </AnnotatorPaperCapsule>
    );
    if (props.phone) {
        return (
            <EscapeLayerProvider layer={props.escapeScope}>
                {close}
                <View style={styles.grow} />
                <AnnotatorPaperCapsule>
                    <AnnotatorHistoryButtons annotator={props.annotator} />
                    <BrowserAnnotatorAttachButton attach={props.attach} />
                </AnnotatorPaperCapsule>
            </EscapeLayerProvider>
        );
    }
    return (
        <EscapeLayerProvider layer={props.escapeScope}>
            {close}
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.paletteTrack}
                contentContainerStyle={styles.paletteContent}
            >
                <Animated.View entering={FadeIn.duration(motionTokens.guardMoment.wordCrossFadeMs).reduceMotion(ReduceMotion.System)}>
                    <AnnotatorPalette annotator={props.annotator} layout="bar" surface="paper" />
                </Animated.View>
            </ScrollView>
        </EscapeLayerProvider>
    );
}

/** The toggle's spinner: a quick capture never shows it (MIS §8b.2). */
export function BrowserAnnotatorPendingGlyph() {
    const { theme } = useUnistyles();
    return (
        <Animated.View entering={FadeIn.delay(motionTokens.durationMs.fast).duration(motionTokens.durationMs.fast).reduceMotion(ReduceMotion.Never)}>
            <ActivityIndicator size="small" color={theme.colors.text.secondary} />
        </Animated.View>
    );
}

export type BrowserAnnotatorAttachControl = Readonly<{ busy: boolean; onPress: () => void; showKey?: boolean }>;

function BrowserAnnotatorAttachButton(props: Readonly<{ attach: BrowserAnnotatorAttachControl }>) {
    const sendKey = useKeyboardCommandHintLabel('composer.sendImmediate');
    return (
        <RoundButton
            size="small"
            capsuleHeight={ACTION_HEIGHT}
            title={t('browserContext.editor.attach')}
            trailing={props.attach.showKey && sendKey ? <KeyboardCommandHint commandId="composer.sendImmediate" tone="onFill" /> : undefined}
            loading={props.attach.busy}
            onPress={props.attach.onPress}
            testID="browser-annotator-attach"
        />
    );
}

/** The live page settles into this still: the picture, whole, and under it what the person says about it. */
export function BrowserAnnotatorStage(props: Readonly<{
    annotator: ImageAnnotator;
    session: BrowserAnnotatorSession;
    phone: boolean;
    control: BrowserAnnotatorStageControl;
}>) {
    const { annotator, session, phone, control } = props;
    const { theme } = useUnistyles();
    const [area, setArea] = React.useState<Readonly<{ width: number; height: number }> | null>(null);
    const [cardHeight, setCardHeight] = React.useState(0);
    const picture = React.useMemo(() => {
        if (!area) return null;
        const scale = Math.min(area.width / annotator.source.width, area.height / annotator.source.height);
        return { width: Math.round(annotator.source.width * scale), height: Math.round(annotator.source.height * scale) };
    }, [annotator.source.height, annotator.source.width, area]);
    const onAreaLayout = React.useCallback((event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        setArea((current) => (current?.width === width && current.height === height ? current : { width, height }));
    }, []);
    const onCardLayout = React.useCallback((event: LayoutChangeEvent) => {
        const { height } = event.nativeEvent.layout;
        setCardHeight((current) => Math.max(current, height));
    }, []);
    const cardWidth = picture ? Math.max(picture.width, Math.min(area?.width ?? 0, CARD_MIN_WIDTH)) : undefined;
    useBrowserAnnotatorInset(control, picture);
    return (
        <EscapeLayerProvider layer={control.escapeScope}>
        <View ref={control.regionRef} collapsable={false} style={[styles.stage, phone ? styles.stagePhone : null]} testID="browser-annotator-stage">
            <View style={styles.pictureArea} onLayout={onAreaLayout}>
                {picture ? (
                    <View
                        ref={control.pictureRef}
                        collapsable={false}
                        style={[styles.picture, picture, { backgroundColor: theme.colors.surface.base }]}
                        testID="browser-annotator-picture"
                    >
                        <AnnotatorPictureFrame annotator={annotator} size={picture} style={picture}>
                            <Image source={{ uri: annotator.source.uri }} style={StyleSheet.absoluteFill} resizeMode="stretch" />
                            <AnnotatorCanvas annotator={annotator} />
                        </AnnotatorPictureFrame>
                    </View>
                ) : null}
            </View>
            <View ref={control.cardRef} collapsable={false} style={[styles.caption, { width: cardWidth, minHeight: cardHeight || undefined }]}>
                <AnnotatorCaptionSlot annotator={annotator} surface="paper">
                    <View onLayout={onCardLayout}>
                        <BrowserAnnotatorCommentCard annotator={annotator} session={session} phone={phone} control={control} />
                    </View>
                </AnnotatorCaptionSlot>
            </View>
            {phone ? <AnnotatorPalette annotator={annotator} layout="phone" surface="paper" /> : null}
        </View>
        </EscapeLayerProvider>
    );
}

function BrowserAnnotatorCommentCard(props: Readonly<{
    annotator: ImageAnnotator;
    session: BrowserAnnotatorSession;
    phone: boolean;
    control: BrowserAnnotatorStageControl;
}>) {
    const { annotator, session, phone, control } = props;
    const { theme } = useUnistyles();
    const inputRef = React.useRef<MultiTextInputHandle>(null);
    const keepRef = React.useRef<HappierFocusable | null>(null);
    const panel = React.useMemo(() => [
        resolveAgentInputPanelStyle(theme),
        resolveAgentInputPanelBackedEdgeStyle(theme),
    ], [theme]);
    const elements = useImageAnnotatorState(annotator, (state) => state.document.marks.reduce((count, mark) => (mark.kind === 'element' ? count + 1 : count), 0));
    const shortcuts = useSettingsValues([
        'keyboardShortcutsV2Enabled', 'keyboardSingleKeyShortcutsEnabled',
        'keyboardShortcutOverridesV1', 'keyboardShortcutDisabledCommandIdsV1',
    ]);
    // Focus lands in the comment on the first frame (MIS §8b.1).
    React.useLayoutEffect(() => {
        inputRef.current?.focus();
    }, []);
    // The field keeps its keys, so Attach resolves the way the composer's send does.
    const onKeyPress: OnKeyPressCallback = (event) => {
        const action = resolveComposerSendShortcutAction(event, {
            keyboardShortcutsV2Enabled: shortcuts.keyboardShortcutsV2Enabled === true,
            keyboardSingleKeyShortcutsEnabled: shortcuts.keyboardSingleKeyShortcutsEnabled === true,
            keyboardShortcutOverridesV1: shortcuts.keyboardShortcutOverridesV1 ?? {},
            keyboardShortcutDisabledCommandIdsV1: shortcuts.keyboardShortcutDisabledCommandIdsV1 ?? [],
            hasSendableInput: true,
            sendActionDisabled: control.attach.busy,
            platformOS: Platform.OS,
        });
        if (action === 'sendAlternate') control.attach.onPress();
        return action !== null;
    };
    // The discard question lands on the choice that loses nothing (MIS §8b.7), once the word swap shows it.
    const confirming = control.confirming;
    React.useEffect(() => {
        if (!confirming) return undefined;
        let frame = 0;
        const land = () => {
            const node = keepRef.current;
            node?.focus();
            if (Platform.OS === 'web' && document.activeElement !== (node as unknown as Element)) frame = requestAnimationFrame(land);
        };
        frame = requestAnimationFrame(land);
        return () => cancelAnimationFrame(frame);
    }, [confirming]);
    return (
        <View style={panel} testID="browser-annotator-comment">
            <MultiTextInput
                ref={inputRef}
                onKeyPress={onKeyPress}
                value={control.comment}
                onChangeText={control.onCommentChange}
                onBlur={control.onCommentBlur}
                placeholder={t('browserContext.editor.commentPlaceholder')}
                placeholderTextColor={theme.colors.text.secondary}
                textStyle={styles.input as never}
                maxHeight={COMMENT_MAX_HEIGHT}
                paddingTop={theme.space.s8}
                paddingBottom={theme.space.s4}
                paddingLeft={theme.space.s6}
                paddingRight={theme.space.s6}
                accessibilityLabel={t('browserContext.editor.commentPlaceholder')}
                testID="browser-annotator-comment-input"
            />
            {phone && !confirming ? null : <WordCrossFade wordKey={confirming ? 'discard' : 'attach'} style={styles.rail}>
                {confirming ? (
                    <>
                        <Text variant="body" emphasis="medium" style={styles.prompt}>{t('files.annotate.discardPrompt')}</Text>
                        <TextLinkButton
                            label={t('files.annotate.keepEditing')}
                            tone="strong"
                            controlRef={(node) => { keepRef.current = node; }}
                            onPress={control.onKeepEditing}
                            testID="browser-annotator-keep"
                        />
                        <RoundButton
                            size="small"
                            capsuleHeight={ACTION_HEIGHT}
                            display="destructive"
                            title={t('files.annotate.discard')}
                            onPress={control.onDiscard}
                            testID="browser-annotator-discard"
                        />
                    </>
                ) : (
                    <>
                        <View style={styles.page}>
                            <Icon name="globe" size={14} color={theme.colors.text.tertiary} />
                            <Text variant="meta" numberOfLines={1} style={styles.pageLabel}>
                                {elements > 0
                                    ? `${session.pageLabel}  ·  ${t('browserContext.editor.elementCount', { count: elements })}`
                                    : session.pageLabel}
                            </Text>
                        </View>
                        <BrowserAnnotatorAttachButton attach={{ ...control.attach, showKey: true }} />
                    </>
                )}
            </WordCrossFade>}
        </View>
    );
}

export type BrowserAnnotatorStageControl = Readonly<{
    regionRef: React.RefObject<View | null>;
    pictureRef: React.RefObject<View | null>;
    cardRef: React.RefObject<View | null>;
    comment: string;
    onCommentChange: (comment: string) => void;
    onCommentBlur: () => void;
    confirming: boolean;
    onKeepEditing: () => void;
    onDiscard: () => void;
    attach: BrowserAnnotatorAttachControl;
    close: () => void;
    /** Cancel's Escape layer; the bar and the stage provide it so their own layers answer first. */
    escapeScope: EscapeLayerScope;
}>;

/**
 * The moments around the still: settling in, leaving, the discard question and Attach. One owner, so × in
 * the chrome row, Esc and the card's own actions all take the same path.
 */
export function useBrowserAnnotatorStageControl(input: Readonly<{
    annotator: ImageAnnotator | null;
    session: BrowserAnnotatorSession | null;
}>): BrowserAnnotatorStageControl {
    const { annotator, session } = input;
    const reducedMotion = useReducedMotionPreference();
    const regionRef = React.useRef<View | null>(null);
    const pictureRef = React.useRef<View | null>(null);
    const cardRef = React.useRef<View | null>(null);
    const [comment, setComment] = React.useState(session?.comment ?? '');
    const [confirming, setConfirming] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const leaving = React.useRef(false);
    const sessionRef = React.useRef(session);
    sessionRef.current = session;
    const commentRef = React.useRef(comment);
    commentRef.current = comment;

    // An agent's comment lands in the field; the person's typing writes the draft on blur and at Attach,
    // so a keystroke costs no Action. A new annotator starts from its own draft.
    React.useEffect(() => {
        setComment(session?.comment ?? '');
    }, [annotator, session?.comment]);

    const hasChanges = React.useCallback(() => {
        const document = annotator?.store.getState().document;
        return Boolean((document && !isEmptyEdit(document)) || commentRef.current.trim().length > 0);
    }, [annotator]);

    const leave = React.useCallback(() => {
        if (leaving.current) return;
        leaving.current = true;
        const picture = pictureRef.current as unknown as HTMLElement | null;
        const region = regionRef.current as unknown as HTMLElement | null;
        const done = () => {
            leaving.current = false;
            setConfirming(false);
            sessionRef.current?.onCancel();
        };
        if (Platform.OS !== 'web' || reducedMotion || !picture || !region) return done();
        (cardRef.current as unknown as HTMLElement | null)?.animate?.({ opacity: [1, 0] }, { duration: motionTokens.overlay.panel.exitMs, fill: 'forwards' });
        const flight = playElementRectDeparture(picture, captureElementFlightRect(region), {
            animationId: INSET_ANIMATION_ID,
            durationMs: motionTokens.inPlaceMorph.frameMs,
            easingCss: motionTokens.easingCss.standard,
        });
        if (!flight) return done();
        flight.onfinish = done;
        flight.oncancel = done;
        return undefined;
    }, [reducedMotion]);

    const close = React.useCallback(() => {
        if (hasChanges()) setConfirming(true);
        else leave();
    }, [hasChanges, leave]);

    const escapeScope = useEscapeLayer({
        priority: ESCAPE_LAYER_PRIORITIES.modal,
        enabled: annotator !== null,
        allowEditableTarget: true,
        onEscape: () => {
            if (confirming) setConfirming(false);
            else close();
            return true;
        },
    });

    const attach = React.useCallback(() => {
        const current = sessionRef.current;
        if (!current || busy) return;
        setBusy(true);
        const picture = pictureRef.current as unknown as HTMLElement | null;
        const ghost = !reducedMotion && Platform.OS === 'web' && picture ? createAttachGhost(picture) : null;
        void (async () => {
            try {
                if (commentRef.current !== current.comment && !(await current.onCommentChange(commentRef.current)).ok) return;
                const { ok } = await current.onAttach();
                if (ok) ghost?.fly();
            } finally {
                ghost?.dispose();
                setBusy(false);
            }
        })();
    }, [busy, reducedMotion]);

    return {
        regionRef, pictureRef, cardRef, comment, onCommentChange: setComment, confirming,
        onCommentBlur: () => {
            const current = sessionRef.current;
            if (current && commentRef.current !== current.comment) void current.onCommentChange(commentRef.current);
        },
        onKeepEditing: () => setConfirming(false),
        onDiscard: leave,
        attach: { busy, onPress: attach },
        close,
        escapeScope,
    };
}

/**
 * Attach's flight (MIS §8b.5): the picture is copied before the commit takes it away, so the live page can
 * come back under the copy as it gathers and travels into the new tray thumbnail. Web only; a phone app
 * and reduced motion land in place.
 */
function createAttachGhost(picture: HTMLElement): Readonly<{ fly: () => void; dispose: () => void }> {
    const rect = captureElementFlightRect(picture);
    const copy = picture.cloneNode(true) as HTMLElement;
    let flying = false;
    return {
        fly() {
            const numbers = document.querySelectorAll<HTMLElement>('[data-testid^="agent-input-attachment-number"]');
            const target = numbers[numbers.length - 1]?.parentElement;
            if (!target) return;
            flying = true;
            const moment = motionTokens.successMoment;
            Object.assign(copy.style, {
                position: 'fixed', left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`,
                margin: '0', zIndex: '2147483000', pointerEvents: 'none',
            });
            document.body.appendChild(copy);
            const flight = playElementRectDeparture(copy, captureElementFlightRect(target), {
                animationId: INSET_ANIMATION_ID,
                durationMs: moment.gatherMs + moment.travelMs + moment.landMs,
                easingCss: motionTokens.easingCss.standard,
                fadeMs: moment.landMs,
            });
            if (flight) flight.onfinish = flight.oncancel = () => copy.remove();
            else copy.remove();
        },
        dispose() {
            if (!flying) copy.remove();
        },
    };
}

/**
 * Settle in (MIS §8b.1): the still starts exactly on the live view's rect, so the first frame shows no change,
 * and insets to its fitted picture; the comment rises under it after the content delay.
 */
function useBrowserAnnotatorInset(control: BrowserAnnotatorStageControl, picture: unknown) {
    const reducedMotion = useReducedMotionPreference();
    const settled = React.useRef(false);
    React.useLayoutEffect(() => {
        if (settled.current || !picture || Platform.OS !== 'web') return;
        const node = control.pictureRef.current as unknown as HTMLElement | null;
        const region = control.regionRef.current as unknown as HTMLElement | null;
        const card = control.cardRef.current as unknown as HTMLElement | null;
        if (!node || !region) return;
        settled.current = true;
        const timing = resolveInPlaceMorphTiming(reducedMotion);
        if (reducedMotion) {
            region.animate?.({ opacity: [0, 1] }, { duration: timing.coveredFadeMs });
            return;
        }
        playElementRectFlight(node, captureElementFlightRect(region), { animationId: INSET_ANIMATION_ID, durationMs: timing.frameMs });
        card?.animate?.(
            { opacity: [0, 1], transform: ['translateY(8px)', 'translateY(0)'] },
            { delay: timing.contentDelayMs, duration: motionTokens.overlay.panel.enterMs, easing: motionTokens.easingCss.standard, fill: 'backwards' },
        );
    }, [control.cardRef, control.pictureRef, control.regionRef, picture, reducedMotion]);
}

const styles = StyleSheet.create((theme) => ({
    grow: { flexGrow: 1 },
    paletteTrack: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
    paletteContent: { flexGrow: 1, justifyContent: 'center' },
    stage: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        gap: theme.space.s12,
        padding: theme.space.s16,
        backgroundColor: theme.colors.surface.base,
    },
    stagePhone: {
        paddingVertical: theme.space.s12,
        paddingHorizontal: theme.space.s16,
        gap: theme.space.s8,
    },
    pictureArea: {
        flex: 1,
        alignSelf: 'stretch',
        minHeight: 0,
        alignItems: 'center',
        justifyContent: 'center',
    },
    picture: {
        overflow: 'hidden',
        borderRadius: theme.borderRadius.lg,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        ...shadowLevelStyle(theme.colors.shadowLevels[2]),
    },
    caption: {
        justifyContent: 'center',
    },
    input: {
        ...Typography.variant('reading'),
        color: theme.colors.text.primary,
    },
    rail: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        minHeight: ACTION_HEIGHT,
    },
    page: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        paddingHorizontal: theme.space.s6,
    },
    pageLabel: {
        flexShrink: 1,
        color: theme.colors.text.tertiary,
    },
    prompt: {
        flex: 1,
        paddingHorizontal: theme.space.s6,
    },
}));
