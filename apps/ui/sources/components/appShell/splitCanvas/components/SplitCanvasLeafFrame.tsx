import * as React from 'react';
import { HAPPIER_ICON_BUTTON_SIZE, useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { t } from '@/text';
import { SplitCanvasFocusRing } from './SplitCanvasFocusRing';
import type { SplitCanvasLeafHostRef } from '../model/splitCanvasTypes';
import { IconButton } from '@/components/ui/buttons/IconButton';

type WebSplitCanvasHostElement = EventTarget & SplitCanvasLeafHostRef & {
    addEventListener: (type: string, listener: EventListener) => void;
    removeEventListener: (type: string, listener: EventListener) => void;
};

const CONTROLS_PILL_PADDING_PX = 4;

export const SplitCanvasLeafFrame = React.memo((props: Readonly<{
    leafId: string;
    accessibilityLabel?: string;
    isFocused: boolean;
    isMaximized: boolean;
    quietChrome?: boolean;
    showControls: boolean;
    showFocusRing: boolean;
    keyboardFocusVisible?: boolean;
    onLayout?: (event: any) => void;
    onHostRefChange?: (host: SplitCanvasLeafHostRef | null) => void;
    onFocus: () => void;
    onClose: () => void;
    onToggleMaximize: () => void;
    children: React.ReactNode;
}>) => {
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const attachedHostRef = React.useRef<WebSplitCanvasHostElement | null>(null);
    const detachHostListenersRef = React.useRef<(() => void) | null>(null);

    const detachHostListeners = React.useCallback(() => {
        detachHostListenersRef.current?.();
        detachHostListenersRef.current = null;
        if (attachedHostRef.current) {
            props.onHostRefChange?.(null);
        }
        attachedHostRef.current = null;
    }, [props.onHostRefChange]);

    const setHostRef = React.useCallback((node: unknown) => {
        if (Platform.OS !== 'web') {
            props.onHostRefChange?.(node as SplitCanvasLeafHostRef | null);
            return;
        }

        const hostElement = (node as (EventTarget & Partial<WebSplitCanvasHostElement>) | null) ?? null;
        if (hostElement === attachedHostRef.current) {
            return;
        }

        detachHostListeners();
        if (!hostElement || typeof hostElement.addEventListener !== 'function' || typeof hostElement.removeEventListener !== 'function') {
            return;
        }
        const nextHostElement = hostElement as WebSplitCanvasHostElement;

        const promoteFocus = () => {
            props.onFocus();
        };

        nextHostElement.addEventListener('pointerdown', promoteFocus);
        nextHostElement.addEventListener('focusin', promoteFocus);
        attachedHostRef.current = nextHostElement;
        props.onHostRefChange?.(nextHostElement);
        detachHostListenersRef.current = () => {
            nextHostElement.removeEventListener('pointerdown', promoteFocus);
            nextHostElement.removeEventListener('focusin', promoteFocus);
        };
    }, [detachHostListeners, props.onFocus, props.onHostRefChange]);

    React.useEffect(() => detachHostListeners, [detachHostListeners]);

    return (
        <View
            ref={setHostRef}
            testID={`split-canvas-leaf-frame-${props.leafId}`}
            accessibilityLabel={props.accessibilityLabel}
            style={{
                flex: 1,
                minWidth: 0,
                minHeight: 0,
            }}
        >
            <View
                testID={`split-canvas-leaf-interaction-surface-${props.leafId}`}
                onLayout={props.onLayout}
                onStartShouldSetResponderCapture={() => {
                    props.onFocus();
                    return false;
                }}
                style={{
                    flex: 1,
                    minWidth: 0,
                    minHeight: 0,
                    borderRadius: props.quietChrome ? 0 : theme.borderRadius.xl,
                    ...(props.quietChrome ? null : { backgroundColor: materialColor(theme.colors.surface.base, 'transparent') }),
                    overflow: 'hidden',
                }}
            >
                {props.showControls ? (
                    <View
                        pointerEvents="box-none"
                        style={{
                            position: 'absolute',
                            top: 10,
                            right: 10,
                            zIndex: 4,
                        }}
                    >
                        <View
                            style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                gap: 6,
                                padding: CONTROLS_PILL_PADDING_PX,
                                // A capsule around the shared icon buttons: half its own height.
                                borderRadius: (HAPPIER_ICON_BUTTON_SIZE + CONTROLS_PILL_PADDING_PX * 2) / 2,
                                borderWidth: 1,
                                borderColor: theme.colors.border.default,
                                backgroundColor: materialColor(theme.colors.surface.inset),
                            }}
                        >
                            <IconButton
                                testID={`split-canvas-leaf-maximize-${props.leafId}`}
                                variant="plain"
                                iconName={props.isMaximized ? 'arrows-in' : 'arrows-out'}
                                accessibilityLabel={props.isMaximized ? t('common.restore') : t('common.maximize')}
                                onPress={props.onToggleMaximize}
                            />
                            <IconButton
                                testID={`split-canvas-leaf-close-${props.leafId}`}
                                variant="plain"
                                iconName="x"
                                accessibilityLabel={t('common.close')}
                                onPress={props.onClose}
                            />
                        </View>
                    </View>
                ) : null}

                <View
                    style={{
                        flex: 1,
                        minWidth: 0,
                        minHeight: 0,
                    }}
                >
                    {props.children}
                </View>

                <SplitCanvasFocusRing
                    leafId={props.leafId}
                    visible={props.showFocusRing}
                    keyboardVisible={props.keyboardFocusVisible === true}
                />
            </View>
        </View>
    );
});
