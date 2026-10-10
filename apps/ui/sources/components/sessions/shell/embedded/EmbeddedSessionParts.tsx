import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
import {
    createSessionPartClaims,
    useSessionPartClaim,
    type SessionPartClaims,
    type SessionPartKind,
} from '@happier-dev/plugin-ui/advanced';

import {
    ComposerKeyboardProvider,
    useComposerKeyboardLayout,
} from '@/components/sessions/keyboardAvoidance';
import { SessionViewLayout } from '@/components/sessions/shell/view/SessionViewLayout';
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
 * The host's standard arrangement — transcript, then composer — used by `SessionChat` and by the
 * embed route. It is the full Session view's own layout, so keyboard handling, content width and
 * the transcript's scroll ownership are exactly the incumbent's.
 */
export function EmbeddedSessionStandardLayout(props: Readonly<{ testID?: string }>) {
    const parts = useEmbeddedSessionParts();
    const owns = useEmbeddedSessionPartClaim(STANDARD_PARTS);
    const deviceType = useDeviceType();
    if (!parts || !owns) return null;
    return (
        <View testID={props.testID ?? 'embedded-session-standard-layout'} style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            <SessionViewLayout
                content={parts.transcript}
                input={parts.composer}
                placeholder={parts.placeholder}
                shouldShowCliWarning={false}
                onDismissCliWarning={noop}
                isLandscape={false}
                deviceType={deviceType}
                onBackPress={noop}
                chatBottomSpacing={parts.chatBottomSpacing}
            />
        </View>
    );
}

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
