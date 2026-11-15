import * as React from 'react';
import { ScrollView, View, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
import {
    createSessionPartClaims,
    useSessionPartClaim,
    type SessionPartClaims,
    type SessionPartKind,
} from '@happier-dev/plugin-ui/advanced';

import { ComposerKeyboardProvider } from '@/components/sessions/keyboardAvoidance/ComposerKeyboardContext';
import { useComposerKeyboardLayout } from '@/components/sessions/keyboardAvoidance/useComposerKeyboardLayout';
import { SessionViewLayout } from '@/components/sessions/shell/view/SessionViewLayout';
import { TRANSCRIPT_TOP_GUTTER_PX } from '@/components/sessions/transcript/_constants';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useDeviceType } from '@/utils/platform/responsive';
import { EmbeddedSessionPartSlotPublication } from './EmbeddedSessionPartSlots';

/**
 * What the embedded Session controller publishes: the elements `SessionView` created for this
 * Session, rendered wherever the author's slots sit. There is one composition whatever the
 * arrangement; a slot never binds the Session itself.
 */
export type EmbeddedSessionPartsState = 'ready' | 'loading' | 'unavailable' | 'blocked';

export type EmbeddedSessionPartsValue = Readonly<{
    /** The transcript layer (or the state that stands in for it: loading, unavailable, blocked). */
    transcript: React.ReactNode;
    /** Shown over the transcript layer while the Session has no timeline to render yet. */
    placeholder: React.ReactNode;
    /** `null` for a read-only presentation, or while the Session is not loaded. */
    composer: React.ReactNode | null;
    state: EmbeddedSessionPartsState;
    chatBottomSpacing: 'default' | 'none';
}>;

const EmbeddedSessionPartClaimsContext = React.createContext<SessionPartClaims | null>(null);
const EmbeddedSessionPartsContext = React.createContext<EmbeddedSessionPartsValue | null>(null);

/** Each controller owns its arrangement, even when an author nests it within another controller. */
export function EmbeddedSessionControllerClaimsScope(props: Readonly<{ children: React.ReactNode }>) {
    const [claims] = React.useState(createSessionPartClaims);
    return (
        <EmbeddedSessionPartClaimsContext.Provider value={claims}>
            {props.children}
        </EmbeddedSessionPartClaimsContext.Provider>
    );
}

/** A state/new-chat publication keeps its controller's claims across loading and ready states. */
export function EmbeddedSessionPartClaimsScope(props: Readonly<{ children: React.ReactNode }>) {
    const enclosing = React.useContext(EmbeddedSessionPartClaimsContext);
    return enclosing ? props.children : (
        <EmbeddedSessionControllerClaimsScope>{props.children}</EmbeddedSessionControllerClaimsScope>
    );
}

/** Published by `SessionView`'s embedded arm around the arrangement it renders. */
export function EmbeddedSessionPartsProvider(props: Readonly<{
    value: EmbeddedSessionPartsValue;
    children: React.ReactNode;
}>) {
    return (
        <EmbeddedSessionPartSlotPublication value={props.value}>
            <EmbeddedSessionArrangementPartsProvider value={props.value}>
                {props.children}
            </EmbeddedSessionArrangementPartsProvider>
        </EmbeddedSessionPartSlotPublication>
    );
}

/** The stable arrangement consumes slots, not the producer's contextual elements. */
export function EmbeddedSessionArrangementPartsProvider(props: Readonly<{ value: EmbeddedSessionPartsValue; children: React.ReactNode }>) {
    return <EmbeddedSessionPartsContext.Provider value={props.value}>{props.children}</EmbeddedSessionPartsContext.Provider>;
}

export function useEmbeddedSessionParts(): EmbeddedSessionPartsValue | null {
    return React.useContext(EmbeddedSessionPartsContext);
}

function useEmbeddedSessionPartClaim(parts: readonly SessionPartKind[]): boolean {
    const claims = React.useContext(EmbeddedSessionPartClaimsContext);
    return useSessionPartClaim(claims, parts);
}

/**
 * An embedded transcript scrolls under whatever the mount draws above it (a toolbar, a header), and
 * it rests at its newest turn, so the first visible row is usually cut mid-line. The region's top
 * edge therefore fades into the surface over the transcript's own top gutter: at rest the fade sits
 * inside the gutter, and a scrolled transcript meets the edge softly instead of being clipped.
 */
function EmbeddedSessionTranscriptTopEdge() {
    const { theme } = useUnistyles();
    return <ScrollEdgeFades color={theme.colors.surface.base} size={TRANSCRIPT_TOP_GUTTER_PX} edges={TOP_EDGE} />;
}
const TOP_EDGE = Object.freeze({ top: true });

/** The live transcript with its prompts; fills the remaining height of its bounded flex column. */
export function EmbeddedSessionTranscriptPart(props: Readonly<{ testID?: string }>) {
    const parts = useEmbeddedSessionParts();
    const owns = useEmbeddedSessionPartClaim(TRANSCRIPT_PART);
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    if (!parts || !owns) return null;
    return (
        <View
            testID={props.testID ?? 'embedded-session-transcript'}
            style={{
                flex: 1,
                minHeight: 0,
                minWidth: 0,
                position: 'relative',
                overflow: 'hidden',
                backgroundColor: materialColor(theme.colors.surface.base, 'transparent'),
            }}
        >
            {parts.transcript ? (
                <View style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, minWidth: 0 }}>
                    {parts.transcript}
                </View>
            ) : null}
            {parts.transcript ? <EmbeddedSessionTranscriptTopEdge /> : null}
            {parts.placeholder ? (
                <View
                    style={{
                        position: 'absolute',
                        top: 0,
                        right: 0,
                        bottom: 0,
                        left: 0,
                        alignItems: 'center',
                        justifyContent: 'center',
                    }}
                >
                    {parts.placeholder}
                </View>
            ) : null}
        </View>
    );
}

/**
 * The Session's composer at its natural height. It carries the keyboard and bottom safe-area lift
 * the full view applies, so on native it must be the bottom element of a region that reaches the
 * screen bottom. It renders nothing for a read-only presentation.
 */
export function EmbeddedSessionComposerPart(props: Readonly<{ testID?: string }>) {
    const parts = useEmbeddedSessionParts();
    const owns = useEmbeddedSessionPartClaim(COMPOSER_PART);
    if (!parts || !owns || parts.composer == null) return null;
    return (
        <EmbeddedSessionComposerFrame testID={props.testID ?? 'embedded-session-composer'}>
            {parts.composer}
        </EmbeddedSessionComposerFrame>
    );
}

function EmbeddedSessionComposerFrame(props: Readonly<{ testID: string; children: React.ReactNode }>) {
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const safeArea = useChromeSafeAreaInsets();
    const layout = useComposerKeyboardLayout({ safeAreaBottom: safeArea.bottom });
    const liftStyle = useAnimatedStyle(() => ({ paddingBottom: layout.bottomInset.value }), [layout]);
    const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
        layout.setComposerMeasuredHeight(event.nativeEvent.layout.height);
    }, [layout]);
    return (
        <ComposerKeyboardProvider layout={layout}>
            <Animated.View
                testID={props.testID}
                onLayout={handleLayout}
                style={[{ minWidth: 0, backgroundColor: materialColor(theme.colors.surface.base, 'transparent') }, liftStyle]}
            >
                {props.children}
            </Animated.View>
        </ComposerKeyboardProvider>
    );
}

const TRANSCRIPT_PART: readonly SessionPartKind[] = ['transcript'];
const COMPOSER_PART: readonly SessionPartKind[] = ['composer'];
const STANDARD_PARTS: readonly SessionPartKind[] = ['transcript', 'composer'];
const noop = () => {};

/**
 * The arrangement's one rule for a host with little room: the conversation never gets less height than the
 * composer you type into. A host that cannot hold both (a linked Session under a tall detail header in a short
 * window, 2026-11-13) used to give the composer every pixel and leave the transcript 0px tall, so a loaded
 * Session read empty. There the arrangement keeps that minimum and scrolls as one column, conversation first;
 * any host with enough room is filled exactly as before. Returns the arranged height, or `null` to fill the room.
 */
export function resolveEmbeddedSessionArrangedHeight(input: Readonly<{
    roomHeight: number | null;
    composerHeight: number | null;
}>): number | null {
    const { roomHeight, composerHeight } = input;
    if (roomHeight === null || composerHeight === null || !(composerHeight > 0)) return null;
    const minimum = Math.ceil(composerHeight * 2);
    return roomHeight >= minimum ? null : minimum;
}

function readLayoutHeight(event: LayoutChangeEvent): number | null {
    const height = event.nativeEvent.layout.height;
    return Number.isFinite(height) && height > 0 ? Math.round(height) : null;
}

/**
 * The host's standard arrangement — transcript, then composer — used by `SessionChat` and by the
 * embed route. It is the full Session view's own layout, so keyboard handling, content width and
 * the transcript's scroll ownership are exactly the incumbent's; only a host too short for both
 * scrolls the arrangement ({@link resolveEmbeddedSessionArrangedHeight}), anchored at its end.
 */
export function EmbeddedSessionStandardLayout(props: Readonly<{ testID?: string }>) {
    const parts = useEmbeddedSessionParts();
    const owns = useEmbeddedSessionPartClaim(STANDARD_PARTS);
    const deviceType = useDeviceType();
    const [roomHeight, setRoomHeight] = React.useState<number | null>(null);
    const [composerHeight, setComposerHeight] = React.useState<number | null>(null);
    const handleRoomLayout = React.useCallback((event: LayoutChangeEvent) => {
        const next = readLayoutHeight(event);
        setRoomHeight((current) => (current === next ? current : next));
    }, []);
    const handleComposerLayout = React.useCallback((event: LayoutChangeEvent) => {
        const next = readLayoutHeight(event);
        setComposerHeight((current) => (current === next ? current : next));
    }, []);
    // A scrolling arrangement opens at its end, as a chat does: the composer, and a prompt waiting in it
    // (Approve / Deny), are what a reader acts on, so they start in view rather than below the fold.
    const arrangementRef = React.useRef<ScrollView>(null);
    const anchorAtEnd = React.useCallback(() => {
        arrangementRef.current?.scrollToEnd({ animated: false });
    }, []);
    const composer = parts?.composer ?? null;
    const input = React.useMemo(() => (
        composer == null ? null : <View onLayout={handleComposerLayout} style={COMPOSER_MEASURE_STYLE}>{composer}</View>
    ), [composer, handleComposerLayout]);
    if (!parts || !owns) return null;
    const arrangedHeight = resolveEmbeddedSessionArrangedHeight({
        roomHeight,
        composerHeight: composer == null ? null : composerHeight,
    });
    return (
        <View
            testID={props.testID ?? 'embedded-session-standard-layout'}
            onLayout={handleRoomLayout}
            style={{ flex: 1, minHeight: 0, minWidth: 0 }}
        >
            {/* One tree whatever the room, so a resize never remounts the transcript. */}
            <ScrollView
                ref={arrangementRef}
                testID="embedded-session-arrangement"
                style={ARRANGEMENT_SCROLL_STYLE}
                contentContainerStyle={arrangedHeight === null ? ARRANGEMENT_FILL_STYLE : { height: arrangedHeight }}
                scrollEnabled={arrangedHeight !== null}
                onContentSizeChange={arrangedHeight === null ? undefined : anchorAtEnd}
                showsVerticalScrollIndicator={arrangedHeight !== null}
                alwaysBounceVertical={false}
                keyboardShouldPersistTaps="handled"
            >
                <SessionViewLayout
                    content={parts.transcript}
                    input={input}
                    placeholder={parts.placeholder}
                    shouldShowCliWarning={false}
                    onDismissCliWarning={noop}
                    isLandscape={false}
                    deviceType={deviceType}
                    onBackPress={noop}
                    chatBottomSpacing={parts.chatBottomSpacing}
                />
            </ScrollView>
            <EmbeddedSessionTranscriptTopEdge />
        </View>
    );
}
const COMPOSER_MEASURE_STYLE = Object.freeze({ minWidth: 0 });
const ARRANGEMENT_SCROLL_STYLE = Object.freeze({ flex: 1, minHeight: 0, minWidth: 0 });
const ARRANGEMENT_FILL_STYLE = Object.freeze({ flexGrow: 1, minHeight: 0, minWidth: 0 });

/**
 * Publishes a state that stands in for a loaded Session (loading, unavailable, blocked) as the
 * transcript part, with no composer, into the host's arrangement. The arrangement stays mounted and
 * the state fills the transcript slot, exactly as a loaded Session would.
 */
export function EmbeddedSessionStatePublication(props: Readonly<{
    state: Exclude<EmbeddedSessionPartsState, 'ready'>;
    transcript: React.ReactNode;
    arrangement?: React.ReactNode;
}>) {
    const value = React.useMemo<EmbeddedSessionPartsValue>(() => ({
        transcript: props.transcript,
        placeholder: null,
        composer: null,
        state: props.state,
        chatBottomSpacing: 'none',
    }), [props.state, props.transcript]);
    return (
        <EmbeddedSessionPartClaimsScope>
            <EmbeddedSessionPartsProvider value={value}>
                {props.arrangement ?? <EmbeddedSessionStandardLayout />}
            </EmbeddedSessionPartsProvider>
        </EmbeddedSessionPartClaimsScope>
    );
}
