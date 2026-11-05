import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import {
    RemoteViewerControlBar as SharedRemoteViewerControlBar,
    type RemoteViewerControlBarHost,
    type RemoteViewerControlBarProps,
} from '@happier-dev/plugin-ui/presentation';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { CORE_CAPSULE_HOST } from '@/components/ui/status/capsuleHost';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';
import { t } from '@/text';

const HOST: RemoteViewerControlBarHost = {
    Surface: CORE_CAPSULE_HOST.Surface,
    Button: CORE_CAPSULE_HOST.Button,
    IconButton,
    SegmentedTabBar,
    KeyHint,
};

/** Bind the app's exact material, controls, type, spacing and translations. */
export function RemoteViewerControlBar(props: Pick<RemoteViewerControlBarProps, 'actions' | 'controls' | 'enabled' | 'testID'>) {
    const { theme } = useUnistyles();
    return <SharedRemoteViewerControlBar {...props} host={HOST}
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
        }} />;
}
