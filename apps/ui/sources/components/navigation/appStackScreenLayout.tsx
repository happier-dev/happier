import * as React from 'react';
import type { Stack } from 'expo-router';

import { ScreenSafeAreaFrame } from './safeArea/HorizontalSafeArea';

export type AppStackScreenLayout = NonNullable<React.ComponentProps<typeof Stack>['screenLayout']>;
type AppStackScreenLayoutProps = Parameters<AppStackScreenLayout>[0];

/** The `screenLayout` of every app stack: each screen owns its horizontal safe-area frame. */
export function renderAppStackScreen(props: AppStackScreenLayoutProps): React.ReactElement {
    return <ScreenSafeAreaFrame presentation={props.options.presentation}>{props.children}</ScreenSafeAreaFrame>;
}

/** Keeps the frame outermost when a stack adds its own per-screen layout (e.g. a loading gate). */
export function composeAppStackScreenLayout(inner: AppStackScreenLayout | undefined): AppStackScreenLayout {
    if (!inner) return renderAppStackScreen;
    return (props) => renderAppStackScreen({ ...props, children: inner(props) });
}
