import * as React from 'react';
import { Platform, View, type LayoutChangeEvent } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useHappierTouchPrimaryPointer } from '@happier-dev/plugin-ui/environment';
import {
    RemoteViewerControlBar as SharedRemoteViewerControlBar,
    type RemoteViewerControlBarHost,
    type RemoteViewerControlBarProps,
} from '@happier-dev/plugin-ui/presentation';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { GlassLivePictureBackdropContext } from '@/components/ui/glass/livePictureBackdrop';
import { SegmentedTabBar, type SegmentedTabBarProps } from '@/components/ui/navigation/SegmentedTabBar';
import { CORE_CAPSULE_HOST, useCoreCapsuleColors } from '@/components/ui/status/capsuleHost';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';
import { t } from '@/text';

/** Who has the picture and the one control that gives it back (the presence capsule's human state). */
export type RemoteViewerHandBack = Readonly<{ title: string; label: string; onPress: () => void }>;

type HandBackSlot = Readonly<{
    handBack: RemoteViewerHandBack | null;
    publish: (handBack: RemoteViewerHandBack | null) => void;
    /** The touch bar stands and carries the hand back, so the presence footer steps aside. */
    barHolds: boolean;
    setBarHolds: (holds: boolean) => void;
}>;
const HandBackSlotContext = React.createContext<HandBackSlot | null>(null);
const BarHandBackContext = React.createContext<RemoteViewerHandBack | null>(null);

/**
 * One remote viewer (its picture, its touch bar and its presence footer). While a finger controls the picture the
 * bar stands at the stage's foot; the presence capsule's "You have control · Hand back" then rides in the bar's own
 * surface instead of a second band under it. The footer publishes the offer, the bar takes it while it stands.
 */
export function RemoteViewerHandBackScope(props: Readonly<{ children: React.ReactNode }>) {
    const [handBack, publish] = React.useState<RemoteViewerHandBack | null>(null);
    const [barHolds, setBarHolds] = React.useState(false);
    const value = React.useMemo(() => ({ handBack, publish, barHolds, setBarHolds }), [barHolds, handBack]);
    return <HandBackSlotContext.Provider value={value}>{props.children}</HandBackSlotContext.Provider>;
}

/**
 * The presence footer's side: offers its hand back to a standing bar, and answers whether the bar holds it (the
 * footer then draws nothing). Without a scope or a standing bar the footer keeps its capsule.
 */
export function useRemoteViewerHandBackOffer(offer: RemoteViewerHandBack | null): boolean {
    const slot = React.useContext(HandBackSlotContext);
    const publish = slot?.publish;
    React.useLayoutEffect(() => {
        if (!publish) return undefined;
        publish(offer);
        return () => publish(null);
    }, [offer, publish]);
    return Boolean(slot?.barHolds && offer);
}

/** The bar's surface: the host's floating material, led by the hand back while the bar carries it. */
function RemoteViewerBarSurface(props: React.ComponentProps<RemoteViewerControlBarHost['Surface']>) {
    const handBack = React.useContext(BarHandBackContext);
    const { theme } = useUnistyles();
    const colors = useCoreCapsuleColors();
    const Surface = CORE_CAPSULE_HOST.Surface;
    const Text = CORE_CAPSULE_HOST.Text;
    const Button = CORE_CAPSULE_HOST.Button;
    return <Surface {...props}>
        {/* The surface is a capsule: the row keeps the bar's own inset clear of its rounded ends. */}
        {handBack ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: controlBarSpacing(theme).gap,
            paddingHorizontal: controlBarSpacing(theme).inset, paddingTop: controlBarSpacing(theme).gap }}
            testID={`${props.testID}-hand-back-row`}>
            <View style={{ flex: 1, minWidth: 0 }}><Text role="title" color={colors.text} numberOfLines={1}>{handBack.title}</Text></View>
            <Button emphasis="primary" title={handBack.label} onPress={handBack.onPress} testID={`${props.testID}-hand-back`} />
        </View> : null}
        {props.children}
    </Surface>;
}

function ViewerTabs<T extends string>(props: Pick<SegmentedTabBarProps<T>, 'tabs' | 'activeTabId' | 'onSelectTab' | 'testIDPrefix' | 'compact'>) {
    useCurrentUiContextLocalCommands(props.tabs.map(tab => ({
        key: tab.id,
        title: tab.label,
        invoke: () => props.onSelectTab(tab.id),
    })), { contextKey: props.testIDPrefix });
    return <SegmentedTabBar {...props} />;
}

function ViewerIconButton(props: React.ComponentProps<RemoteViewerControlBarHost['IconButton']>) {
    // The shared bar's keys and clipboard remain with their existing input Actions.
    // Only these two existing buttons change the local viewer presentation.
    useCurrentUiContextLocalCommands(!props.disabled && (props.iconName === 'keyboard' || props.iconName === 'arrows-in') ? [{
        key: 'press',
        title: props.accessibilityLabel,
        invoke: props.onPress,
    }] : [], { contextKey: props.testID });
    return <IconButton {...props} />;
}

// Cold Browser imports can reach this binding before capsuleHost finishes loading.
// Keep the host stable and resolve its canonical leaves when the bar renders.
const HOST: RemoteViewerControlBarHost = {
    Surface: RemoteViewerBarSurface,
    get Button() { return CORE_CAPSULE_HOST.Button; },
    IconButton: ViewerIconButton,
    SegmentedTabBar: ViewerTabs,
    KeyHint,
};

/**
 * Bind the app's exact material, controls, type, spacing and translations. The bar is a finger's stand-in
 * for a mouse and keyboard, so it stands over the picture only where the primary pointer is a finger; a
 * mouse and keyboard drive the picture directly (labs Q, H, LV have no bar). It stands there only while
 * this viewer controls the picture: a viewer who watches sees the page alone (lab Kp), and taking control
 * brings the bar. It always floats over the live picture, so it takes that picture's coat: a white page
 * never washes a dark bar out.
 */
type Size = Readonly<{ width: number; height: number }>;
type Theme = ReturnType<typeof useUnistyles>['theme'];

/** The bar's gap to the stage's foot and between its controls: one value for the bar and the room it takes. */
function controlBarSpacing(theme: Theme) {
    return { inset: theme.space.s12, gap: theme.space.s8 };
}

/**
 * The finger's control bar has its own row at the foot of the stage: the picture fits above it, with the bar's own
 * gap, so the bar never covers the page or screen and its labels never stand on remote pixels. The tallest bar seen
 * while it stands holds that room (closing a panel never slides the picture back under it); without the bar (a mouse,
 * or a viewer who only watches) the picture has the whole stage. One rule for every remote viewer.
 */
export function useRemoteViewerControlsRoom(viewport: Size | null, barShown: boolean): Readonly<{
    pictureArea: Size | null;
    onControlsLayout: (event: LayoutChangeEvent) => void;
}> {
    const { theme } = useUnistyles();
    const [room, setRoom] = React.useState(0);
    if (!barShown && room !== 0) setRoom(0);
    const stageHeight = viewport?.height ?? 0;
    // The bar's own height with its gap above and below: never derived from where the stage stood when the bar
    // was measured (taking control brings the presence capsule in under the stage, which shortens it).
    const inset = controlBarSpacing(theme).inset;
    const onControlsLayout = React.useCallback((event: LayoutChangeEvent) => {
        const next = event.nativeEvent.layout.height + 2 * inset;
        setRoom(current => next > current ? next : current);
    }, [inset]);
    const width = viewport?.width ?? 0;
    const pictureArea = React.useMemo(() => !viewport ? null
        : barShown && room > 0 && room < stageHeight ? { width, height: stageHeight - room } : viewport,
    [barShown, room, stageHeight, viewport, width]);
    return { pictureArea, onControlsLayout };
}

export function RemoteViewerControlBar(props: Pick<RemoteViewerControlBarProps, 'actions' | 'controls' | 'enabled' | 'testID' | 'onLayout'>) {
    const touch = useHappierTouchPrimaryPointer(Platform.OS);
    if (!touch || !props.enabled) return null;
    return <TouchRemoteViewerControlBar {...props} />;
}

function TouchRemoteViewerControlBar(props: Pick<RemoteViewerControlBarProps, 'actions' | 'controls' | 'enabled' | 'testID' | 'onLayout'>) {
    const { theme } = useUnistyles();
    const slot = React.useContext(HandBackSlotContext);
    const handBack = slot?.handBack ?? null;
    const setBarHolds = slot?.setBarHolds;
    // Before paint, so the footer's band and the bar's row never show the same control together.
    React.useLayoutEffect(() => {
        if (!setBarHolds || !handBack) return undefined;
        setBarHolds(true);
        return () => setBarHolds(false);
    }, [handBack, setBarHolds]);
    return <GlassLivePictureBackdropContext.Provider value><BarHandBackContext.Provider value={handBack}><SharedRemoteViewerControlBar {...props} host={HOST}
        spacing={controlBarSpacing(theme)} labels={{
            directMode: t('browserPresence.stream.directMode'),
            trackpadMode: t('browserPresence.stream.trackpadMode'),
            resetZoom: t('browserPresence.stream.resetZoom'),
            sendClipboard: t('browserPresence.remoteControls.sendClipboard'),
            receiveClipboard: t('browserPresence.remoteControls.receiveClipboard'),
            touch: t('browserPresence.remoteControls.touch'),
            modifiers: t('browserPresence.remoteControls.modifiers'),
            arrows: t('browserPresence.remoteControls.arrows'),
            clipboard: t('browserPresence.remoteControls.clipboard'),
            hideKeyboard: t('browserPresence.remoteControls.hideKeyboard'),
            showKeyboard: t('browserPresence.interaction.showKeyboard'),
        }} /></BarHandBackContext.Provider></GlassLivePictureBackdropContext.Provider>;
}
