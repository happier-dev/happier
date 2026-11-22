import * as React from 'react';
import { Platform } from 'react-native';
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
export function RemoteViewerControlBar(props: Pick<RemoteViewerControlBarProps, 'actions' | 'controls' | 'enabled' | 'testID' | 'onLayout'>) {
    const touch = useHappierTouchPrimaryPointer(Platform.OS);
    if (!touch || !props.enabled) return null;
    return <TouchRemoteViewerControlBar {...props} />;
}

function TouchRemoteViewerControlBar(props: Pick<RemoteViewerControlBarProps, 'actions' | 'controls' | 'enabled' | 'testID' | 'onLayout'>) {
    const { theme } = useUnistyles();
    return <GlassLivePictureBackdropContext.Provider value><SharedRemoteViewerControlBar {...props} host={HOST}
        spacing={{ inset: theme.space.s12, gap: theme.space.s8 }} labels={{
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
