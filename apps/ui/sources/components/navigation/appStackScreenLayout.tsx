import * as React from 'react';
import type { Stack } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';

import { ScreenSafeAreaFrame } from './safeArea/HorizontalSafeArea';
import { VoiceSurface } from '@/components/voice/surface/VoiceSurface';

export type AppStackScreenLayout = NonNullable<React.ComponentProps<typeof Stack>['screenLayout']>;
type AppStackScreenLayoutProps = Pick<Parameters<AppStackScreenLayout>[0], 'children' | 'options'>;

/** The `screenLayout` of every app stack: each screen owns its horizontal safe-area frame. */
export function renderAppStackScreen(props: AppStackScreenLayoutProps): React.ReactElement {
    return <ScreenSafeAreaFrame presentation={props.options.presentation}>{props.children}</ScreenSafeAreaFrame>;
}

/** Root routes own the global playback control, including screens presented as native modals. */
export function renderAppStackScreenWithVoiceSurface(props: AppStackScreenLayoutProps): React.ReactElement {
    return renderAppStackScreen({ ...props, children: <><FocusedGlobalVoiceSurface />{props.children}</> });
}

function FocusedGlobalVoiceSurface() {
    const focused = useIsFocused();
    return focused ? <VoiceSurface variant="global" /> : null;
}

/** Keeps the frame outermost when a stack adds its own per-screen layout (e.g. a loading gate). */
export function composeAppStackScreenLayout(inner: AppStackScreenLayout | undefined): AppStackScreenLayout {
    if (!inner) return renderAppStackScreen;
    return (props) => renderAppStackScreen({ ...props, children: inner(props) });
}
