import * as React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { SessionCockpitBottomChromeHeightContext, useSessionCockpitBottomChromeHeight } from './SessionCockpitChromeRegistry';
import { PaneHeader } from '@/components/appShell/panes/PaneHeader';
import { PaneHeaderSlotProvider, PaneHeaderSlotScope, usePublishedPaneHeaderContent } from '@/components/appShell/panes/paneHeaderSlot';
import { PaneHeaderScrollKey } from '@/components/appShell/panes/paneHeaderScroll';
import { PaneHeaderActions } from '@/components/appShell/panes/PaneHeaderActions';
import { SidePaneBodyProvider } from '@/components/ui/lists/listPresentation';

export const SessionCockpitFullscreenSurface = React.memo((props: Readonly<{
    screenTestID: string;
    safeAreaPadding?: boolean;
    /**
     * The surface's large title, with the live line and next step its body publishes through the
     * pane header slot (the same content the desktop sidebar's header shows for that tab).
     */
    header?: Readonly<{ slotKey: string; title: string }> | null;
    children: React.ReactNode;
}>) => {
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const safeArea = useSafeAreaInsets();
    const bottomChromeHeight = useSessionCockpitBottomChromeHeight();
    const safeAreaPaddingEnabled = props.safeAreaPadding !== false;

    // Cockpit fullscreen surfaces (files/git/terminal/details) sit under the
    // floating overlay bar, so reserve its height at the screen level — this keeps
    // fixed footers/buttons above the bar (scroll content alone self-pads, but
    // fixed elements don't). The reserved area is part of the session screen, so it
    // slides away on dismiss. Then zero the height for descendants so nested scroll
    // content doesn't reserve it a second time. `bottomChromeHeight` is 0 when the
    // bar is hidden, collapsing the reservation.
    const content = props.header ? (
        <PaneHeaderSlotProvider>
            <SessionCockpitSurfaceHeader slotKey={props.header.slotKey} title={props.header.title} testID={`${props.screenTestID}:header`} />
            <PaneHeaderSlotScope slotKey={props.header.slotKey}>
                <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>{props.children}</View>
            </PaneHeaderSlotScope>
        </PaneHeaderSlotProvider>
    ) : props.children;
    const body = safeAreaPaddingEnabled ? content : (
        <SessionCockpitBottomChromeHeightContext.Provider value={0}>
            {content}
        </SessionCockpitBottomChromeHeightContext.Provider>
    );

    return (
        <View
            testID={props.screenTestID}
            style={{
                flex: 1,
                minHeight: 0,
                minWidth: 0,
                backgroundColor: materialColor(theme.colors.surface.base, 'transparent'),
                paddingTop: safeAreaPaddingEnabled ? safeArea.top : 0,
                paddingBottom: safeAreaPaddingEnabled ? safeArea.bottom : bottomChromeHeight,
            }}
        >
            {/* A side pane presented as the phone's screen: its body keeps the pane's text edge, as beside the transcript. */}
            <SidePaneBodyProvider>{body}</SidePaneBodyProvider>
        </View>
    );
});

function SessionCockpitSurfaceHeader(props: Readonly<{ slotKey: string; title: string; testID: string }>) {
    const published = usePublishedPaneHeaderContent(props.slotKey);
    if (published?.immersive) return null;
    return (
        <PaneHeaderScrollKey scrollKey={props.slotKey}>
        <PaneHeader
            size="large"
            testID={props.testID}
            title={props.title}
            line={published?.line ?? null}
            actions={<PaneHeaderActions published={published} title={props.title} testID={props.testID} />}
        />
        </PaneHeaderScrollKey>
    );
}
