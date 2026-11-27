import * as React from 'react';
import { Platform, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { reanimatedMotionTokens as motionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { StoryDeckA11yAnnouncements } from '@/components/ui/storyDeck/StoryDeckA11yAnnouncements';
import { StoryDeckKeyboardShortcuts } from '@/components/ui/storyDeck/StoryDeckKeyboardShortcuts';
import {
    DRAG_DISMISS_FRACTION as DRAG_RELEASE_FRACTION,
    DRAG_VELOCITY_THRESHOLD,
} from '@/components/ui/storyDeck/StorySheetFrame';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

/**
 * A short stack of cards, one decision each: Keep or Let go.
 *
 * Generic on purpose: the cloud leaving batch (plan 04) and local history (plan 08) both feed it
 * items and decide what Keep and Let go do. The stack owns only the walk: which card is on top, the
 * motion, the keyboard and swipe input, and a card coming back when its Keep is refused.
 *
 * Decisions commit at once; the departing card is a separate, purely visual layer, so a new step
 * never waits for an animation and only one card is ever moving. It mounts the top card and the next
 * two; only the top two get a preview.
 */

export type KeepStackItem = Readonly<{
    id: string;
    title: string;
    subtitle?: string | null;
    meta?: string | null;
}>;

export type KeepStackKeepResult =
    | Readonly<{ ok: true }>
    | Readonly<{
        ok: false;
        message: string;
        action?: Readonly<{ label: string; onPress: () => void }>;
    }>;

export type KeepStackOutcome = Readonly<{
    kept: readonly KeepStackItem[];
    letGo: readonly KeepStackItem[];
}>;

export type KeepStackProps = Readonly<{
    items: readonly KeepStackItem[];
    onKeep: (item: KeepStackItem) => Promise<KeepStackKeepResult>;
    /** The cloud batch records this choice locally. Other sources can settle it asynchronously. */
    onLetGo?: (item: KeepStackItem) => Promise<KeepStackKeepResult> | void;
    /** Every card handled and every write settled. */
    onComplete: (outcome: KeepStackOutcome) => void;
    onDismiss?: () => void;
    renderPreview?: (item: KeepStackItem) => React.ReactNode;
    keepHint?: string;
    letGoHint?: string;
    testID?: string;
}>;

type Decision = 'kept' | 'letGo';
type Refusal = Extract<KeepStackKeepResult, { ok: false }> & Readonly<{ itemId: string }>;
type Departing = Readonly<{ item: KeepStackItem; decision: Decision; fromX: number; seq: number }>;

const VISIBLE_CARDS = 3;
const PREVIEW_CARDS = 2;
const KEEP_TILT_DEG = 6;
const LET_GO_SINK_PX = 24;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        gap: 16,
    },
    stack: {
        minHeight: 196,
    },
    card: {
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        borderRadius: 16,
        padding: 16,
        gap: 10,
        backgroundColor: theme.colors.surface.base,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    topCard: {
        position: 'relative',
    },
    cardHeader: {
        gap: 2,
    },
    title: {
        ...Typography.rowTitle(),
        color: theme.colors.text.primary,
    },
    subtitle: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    meta: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    refusal: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
    },
    refusalText: {
        ...Typography.rowMeta(),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
    actions: {
        flexDirection: 'row',
        gap: 12,
    },
    action: {
        flex: 1,
    },
    hint: {
        ...Typography.rowMeta(),
        color: theme.colors.text.tertiary,
        textAlign: 'center',
    },
}));

function KeepStackCardBody(props: Readonly<{
    item: KeepStackItem;
    preview: React.ReactNode;
    refusal: Refusal | null;
}>) {
    const styles = stylesheet;
    return (
        <>
            <View style={styles.cardHeader}>
                <Text style={styles.title} numberOfLines={1}>{props.item.title}</Text>
                {props.item.subtitle ? (
                    <Text style={styles.subtitle} numberOfLines={1}>{props.item.subtitle}</Text>
                ) : null}
            </View>
            {props.preview}
            {props.item.meta ? <Text style={styles.meta}>{props.item.meta}</Text> : null}
            {props.refusal ? (
                <View style={styles.refusal} testID="keep-stack-refusal">
                    <Text style={styles.refusalText}>{props.refusal.message}</Text>
                    {props.refusal.action ? (
                        <RoundButton
                            size="small"
                            display="inverted"
                            title={props.refusal.action.label}
                            onPress={props.refusal.action.onPress}
                            testID="keep-stack-refusal-action"
                        />
                    ) : null}
                </View>
            ) : null}
        </>
    );
}

/** The top card: follows the finger on the UI thread and hands a committed swipe to the stack. */
function TopCard(props: Readonly<{
    item: KeepStackItem;
    preview: React.ReactNode;
    refusal: Refusal | null;
    reducedMotion: boolean;
    onSwipe: (decision: Decision, fromX: number) => void;
}>) {
    const styles = stylesheet;
    const translateX = useSharedValue(0);
    const width = useSharedValue(1);
    const arrive = useSharedValue(props.reducedMotion ? 1 : 0.96);
    const { onSwipe } = props;

    React.useEffect(() => {
        arrive.value = withTiming(1, { duration: motionTokens.durationMs.base, easing: motionTokens.easing.standard });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
        width.value = Math.max(1, event.nativeEvent.layout.width);
    }, [width]);

    const pan = React.useMemo(() => Gesture.Pan()
        .activeOffsetX([-10, 10])
        .failOffsetY([-12, 12])
        .onUpdate((event) => {
            'worklet';
            translateX.value = event.translationX;
        })
        .onEnd((event) => {
            'worklet';
            const fast = Math.abs(event.velocityX) > DRAG_VELOCITY_THRESHOLD;
            const far = Math.abs(event.translationX) > width.value * DRAG_RELEASE_FRACTION;
            if (fast || far) {
                const towardKeep = fast ? event.velocityX > 0 : event.translationX > 0;
                runOnJS(onSwipe)(towardKeep ? 'kept' : 'letGo', event.translationX);
                return;
            }
            translateX.value = withTiming(0, { duration: motionTokens.durationMs.base, easing: motionTokens.easing.standard });
        }), [onSwipe, translateX, width]);

    const reducedMotion = props.reducedMotion;
    const animatedStyle = useAnimatedStyle(() => {
        const progress = translateX.value / width.value;
        return {
            transform: [
                { translateX: translateX.value },
                { rotate: `${reducedMotion ? 0 : progress * KEEP_TILT_DEG}deg` },
                { scale: arrive.value },
            ],
        };
    });

    return (
        <GestureDetector gesture={pan}>
            <Animated.View
                testID={`keep-stack-card-${props.item.id}`}
                onLayout={handleLayout}
                style={[styles.card, styles.topCard, animatedStyle]}
            >
                <KeepStackCardBody item={props.item} preview={props.preview} refusal={props.refusal} />
            </Animated.View>
        </GestureDetector>
    );
}

/** The card that was just decided, moving away. Purely visual; replaced by the next step at once. */
function DepartingCard(props: Readonly<{ departing: Departing; preview: React.ReactNode; reducedMotion: boolean }>) {
    const styles = stylesheet;
    const { decision, fromX } = props.departing;
    const translateX = useSharedValue(fromX);
    const translateY = useSharedValue(0);
    const opacity = useSharedValue(1);

    React.useEffect(() => {
        const timing = { duration: motionTokens.durationMs.slow, easing: motionTokens.easing.standard };
        opacity.value = withTiming(0, props.reducedMotion ? { duration: motionTokens.durationMs.fast } : timing);
        if (props.reducedMotion) return;
        if (decision === 'kept') {
            translateX.value = withTiming(Math.max(fromX, 0) + 320, timing);
        } else {
            translateX.value = withTiming(Math.min(fromX, 0) - 96, timing);
            translateY.value = withTiming(LET_GO_SINK_PX, timing);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const reducedMotion = props.reducedMotion;
    const animatedStyle = useAnimatedStyle(() => ({
        opacity: opacity.value,
        transform: [
            { translateX: translateX.value },
            { translateY: translateY.value },
            { rotate: `${reducedMotion || decision !== 'kept' ? 0 : KEEP_TILT_DEG}deg` },
        ],
    }));

    return (
        <Animated.View pointerEvents="none" style={[styles.card, animatedStyle]}>
            <KeepStackCardBody item={props.departing.item} preview={props.preview} refusal={null} />
        </Animated.View>
    );
}

export function KeepStack(props: KeepStackProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const reducedMotion = useReducedMotionPreference();
    const [decisions, setDecisions] = React.useState<ReadonlyMap<string, Decision>>(() => new Map());
    const [pendingDecisions, setPendingDecisions] = React.useState<ReadonlySet<string>>(() => new Set());
    const [refusal, setRefusal] = React.useState<Refusal | null>(null);
    const [departing, setDeparting] = React.useState<Departing | null>(null);
    const departingSeqRef = React.useRef(0);
    const completedRef = React.useRef(false);
    const { items, onKeep, onLetGo, onComplete, renderPreview } = props;

    const remaining = React.useMemo(() => items.filter((item) => !decisions.has(item.id)), [decisions, items]);
    const top = remaining[0] ?? null;
    const visible = remaining.slice(0, VISIBLE_CARDS);

    // Preview elements are built once per card id while it is among the top two, so a re-render of
    // the stack (a refusal, a settled Keep) does not rebuild them.
    const previewCacheRef = React.useRef(new Map<string, React.ReactNode>());
    const previewFor = React.useCallback((item: KeepStackItem): React.ReactNode => {
        if (!renderPreview) return null;
        const cache = previewCacheRef.current;
        if (!cache.has(item.id)) cache.set(item.id, renderPreview(item));
        return cache.get(item.id) ?? null;
    }, [renderPreview]);

    const decide = React.useCallback((decision: Decision, fromX = 0) => {
        if (!top) return;
        const item = top;
        departingSeqRef.current += 1;
        setDeparting({ item, decision, fromX, seq: departingSeqRef.current });
        setDecisions((current) => new Map(current).set(item.id, decision));
        setRefusal((current) => (current?.itemId === item.id ? null : current));
        const pending = decision === 'kept' ? onKeep(item) : onLetGo?.(item);
        if (!pending) return;
        setPendingDecisions((current) => new Set(current).add(item.id));
        void pending.then(
            (result) => result,
            (error: unknown): KeepStackKeepResult => ({
                ok: false,
                message: error instanceof Error && error.message ? error.message : t('errors.unknownError'),
            }),
        ).then((result) => {
            setPendingDecisions((current) => {
                const next = new Set(current);
                next.delete(item.id);
                return next;
            });
            if (result.ok) return;
            // A refused decision brings the card back as the first remaining card.
            setDecisions((current) => {
                const next = new Map(current);
                next.delete(item.id);
                return next;
            });
            setRefusal({ ...result, itemId: item.id });
        });
    }, [onKeep, onLetGo, top]);

    const keep = React.useCallback(() => decide('kept'), [decide]);
    const letGo = React.useCallback(() => decide('letGo'), [decide]);

    React.useEffect(() => {
        if (completedRef.current || items.length === 0) return;
        if (remaining.length > 0 || pendingDecisions.size > 0) return;
        completedRef.current = true;
        onComplete({
            kept: items.filter((item) => decisions.get(item.id) === 'kept'),
            letGo: items.filter((item) => decisions.get(item.id) === 'letGo'),
        });
    }, [decisions, items, onComplete, pendingDecisions.size, remaining.length]);

    const behind = visible.slice(1).reverse();
    return (
        <View style={styles.container} testID={props.testID}>
            <StoryDeckKeyboardShortcuts onAdvance={keep} onBack={letGo} onDismiss={props.onDismiss} />
            {top ? (
                <StoryDeckA11yAnnouncements
                    currentIndex={items.length - remaining.length}
                    totalCount={items.length}
                    currentTitleKey={top.title}
                />
            ) : null}
            <View style={styles.stack}>
                {behind.map((item) => {
                    const depth = visible.indexOf(item);
                    return (
                        <View
                            key={item.id}
                            testID={`keep-stack-card-${item.id}`}
                            pointerEvents="none"
                            importantForAccessibility="no-hide-descendants"
                            accessibilityElementsHidden
                            style={[
                                styles.card,
                                {
                                    opacity: depth === 1 ? 0.7 : 0.4,
                                    transform: [{ translateY: depth * 8 }, { scale: 1 - depth * 0.04 }],
                                },
                            ]}
                        >
                            <KeepStackCardBody
                                item={item}
                                preview={depth < PREVIEW_CARDS ? previewFor(item) : null}
                                refusal={null}
                            />
                        </View>
                    );
                })}
                {top ? (
                    <TopCard
                        key={top.id}
                        item={top}
                        preview={previewFor(top)}
                        refusal={refusal?.itemId === top.id ? refusal : null}
                        reducedMotion={reducedMotion}
                        onSwipe={decide}
                    />
                ) : null}
                {departing ? (
                    <DepartingCard
                        key={departing.seq}
                        departing={departing}
                        preview={previewCacheRef.current.get(departing.item.id) ?? null}
                        reducedMotion={reducedMotion}
                    />
                ) : null}
            </View>
            <View style={styles.actions}>
                <View style={styles.action}>
                    <RoundButton
                        testID="keep-stack-let-go"
                        size="normal"
                        display="outline"
                        title={t('keepOrLetGo.letGo')}
                        accessibilityHint={props.letGoHint}
                        onPress={letGo}
                        disabled={!top}
                    />
                </View>
                <View style={styles.action}>
                    <RoundButton
                        testID="keep-stack-keep"
                        size="normal"
                        display="contrast"
                        title={t('keepOrLetGo.keep')}
                        leading={<Icon name="push-pin" size={16} color={theme.colors.surface.base} />}
                        accessibilityHint={props.keepHint}
                        onPress={keep}
                        disabled={!top}
                    />
                </View>
            </View>
            {Platform.OS !== 'web' ? <Text style={styles.hint}>{t('keepOrLetGo.swipeHint')}</Text> : null}
        </View>
    );
}
