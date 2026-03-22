import * as React from 'react';
import { Platform, View } from 'react-native';
import { ModalPortalTargetProvider } from '@/modal/portal/ModalPortalTarget';
import { OverlayPortalHost, OverlayPortalProvider } from './OverlayPortal';
import { PopoverPortalTargetContextProvider } from './PopoverPortalTarget';

/**
 * Creates a screen-local portal host for native popovers/dropdowns.
 *
 * Why this exists:
 * - On iOS, screens presented as `containedModal` / sheet-like presentations can live in a
 *   different native coordinate space than the app root.
 * - If popovers portal to an app-root host, anchor measurements and overlay positioning can
 *   mismatch (menus appear vertically offset).
 *
 * By scoping an `OverlayPortalProvider` + `OverlayPortalHost` to the current screen subtree,
 * popovers render in the same coordinate space as their anchors.
 */
export function PopoverPortalTargetProvider(props: { children: React.ReactNode }) {
    if (Platform.OS === 'web') {
        const [webPortalTarget, setWebPortalTarget] = React.useState<HTMLElement | null>(null);

        return (
            <ModalPortalTargetProvider target={webPortalTarget}>
                <View style={{ flex: 1 }} pointerEvents="box-none">
                    {props.children}
                    <div
                        data-happy-popover-portal-host=""
                        ref={(node) => {
                            setWebPortalTarget((prev) => (prev === node ? prev : node));
                        }}
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: 0,
                            height: 0,
                            overflow: 'visible',
                            pointerEvents: 'none',
                        }}
                    />
                </View>
            </ModalPortalTargetProvider>
        );
    }

    const rootRef = React.useRef<any>(null);
    const [layout, setLayout] = React.useState(() => ({ width: 0, height: 0 }));
    const portalTarget = React.useMemo(() => ({ rootRef, layout }), [layout]);

    return (
        <PopoverPortalTargetContextProvider value={portalTarget}>
            <OverlayPortalProvider>
                <View
                    ref={rootRef}
                    style={{ flex: 1 }}
                    pointerEvents="box-none"
                    onLayout={(e) => {
                        const next = e?.nativeEvent?.layout;
                        if (!next) return;
                        setLayout((prev) => {
                            if (prev.width === next.width && prev.height === next.height) return prev;
                            return { width: next.width, height: next.height };
                        });
                    }}
                >
                    {props.children}
                    <OverlayPortalHost />
                </View>
            </OverlayPortalProvider>
        </PopoverPortalTargetContextProvider>
    );
}
