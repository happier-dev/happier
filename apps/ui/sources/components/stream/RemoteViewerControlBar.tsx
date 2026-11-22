import * as React from 'react';
import { Platform, type LayoutChangeEvent } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useHappierTouchPrimaryPointer } from '@happier-dev/plugin-ui/environment';
import {
    RemoteViewerControlBar as SharedRemoteViewerControlBar,
    type RemoteViewerControlBarHost,
    type RemoteViewerControlBarProps,
} from '@happier-dev/plugin-ui/presentation';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { GlassLivePictureBackdropContext } from '@/components/ui/glass/livePictureBackdrop';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { CORE_CAPSULE_HOST } from '@/components/ui/status/capsuleHost';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';
import { t } from '@/text';

// Cold Browser imports can reach this binding before capsuleHost finishes loading.
// Keep the host stable and resolve its canonical leaves when the bar renders.
const HOST: RemoteViewerControlBarHost = {
    get Surface() { return CORE_CAPSULE_HOST.Surface; },
    get Button() { return CORE_CAPSULE_HOST.Button; },
    IconButton,
    SegmentedTabBar,
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
    return <GlassLivePictureBackdropContext.Provider value><SharedRemoteViewerControlBar {...props} host={HOST}
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
        }} /></GlassLivePictureBackdropContext.Provider>;
}
