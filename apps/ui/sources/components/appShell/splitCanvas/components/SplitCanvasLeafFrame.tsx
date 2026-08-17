import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { t } from '@/text';
import { SplitCanvasFocusRing } from './SplitCanvasFocusRing';
import type { SplitCanvasLeafHostRef } from '../model/splitCanvasTypes';
import { Icon } from '@/components/ui/icons/Icon';

type WebSplitCanvasHostElement = EventTarget & SplitCanvasLeafHostRef & {
    addEventListener: (type: string, listener: EventListener) => void;
    removeEventListener: (type: string, listener: EventListener) => void;
};

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
                    borderRadius: props.quietChrome ? 0 : 12,
                    ...(props.quietChrome ? null : { backgroundColor: theme.colors.surface.base }),
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
                                padding: 4,
                                borderRadius: 999,
                                borderWidth: 1,
                                borderColor: theme.colors.border.default,
                                backgroundColor: theme.colors.surface.inset,
                            }}
                        >
                            <Pressable
                                testID={`split-canvas-leaf-maximize-${props.leafId}`}
                                accessibilityRole="button"
                                accessibilityLabel={props.isMaximized ? t('common.restore') : t('common.maximize')}
                                onPress={props.onToggleMaximize}
                                style={{
                                    width: 28,
                                    height: 28,
                                    borderRadius: 14,
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                }}
                            >
                                <Icon
                                    name={props.isMaximized ? 'arrows-in' : 'arrows-out'}
                                    size={16}
                                    color={theme.colors.text.secondary}
                                />
                            </Pressable>
                            <Pressable
                                testID={`split-canvas-leaf-close-${props.leafId}`}
                                accessibilityRole="button"
                                accessibilityLabel={t('common.close')}
                                onPress={props.onClose}
                                style={{
                                    width: 28,
                                    height: 28,
                                    borderRadius: 14,
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                }}
                            >
                                <Icon
                                    name="x"
                                    size={16}
                                    color={theme.colors.text.secondary}
                                />
                            </Pressable>
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
