import * as React from 'react';
import { Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DesktopMainContentDragSurface } from '@/components/navigation/desktopWindowChrome/DesktopMainContentDragSurface';
import { DesktopShellWindowControlsHost } from '@/components/navigation/shell/desktopChrome/DesktopShellWindowControlsHost';
import { useResolvedDesktopWindowControls } from '@/components/navigation/shell/desktopChrome/useResolvedDesktopWindowControls';
import { isTauriDesktop } from '@/utils/platform/tauri';

import { AppLockScreen } from './AppLockScreen';

function AppLockDesktopWindowControls() {
    const insets = useSafeAreaInsets();
    const controls = useResolvedDesktopWindowControls({ variant: 'expanded' });
    return (
        <View
            pointerEvents="box-none"
            style={{ position: 'absolute', top: insets.top + 12, left: insets.left + 16, zIndex: 10 }}
        >
            <DesktopShellWindowControlsHost>{controls}</DesktopShellWindowControlsHost>
        </View>
    );
}

/**
 * The lock screen as a window surface. On the desktop app the main window has no system title
 * bar, so the lock screen keeps the window draggable and keeps its minimise/maximise/close buttons.
 */
export function AppLockSurface(props: Readonly<{ onSignedOut: () => void }>) {
    const desktop = Platform.OS === 'web' && isTauriDesktop();
    return (
        <DesktopMainContentDragSurface enabled={desktop} leftOffsetPx={0} style={{ flex: 1 }}>
            <View style={{ flex: 1 }}>
                <AppLockScreen onSignedOut={props.onSignedOut} />
                {desktop ? <AppLockDesktopWindowControls /> : null}
            </View>
        </DesktopMainContentDragSurface>
    );
}
