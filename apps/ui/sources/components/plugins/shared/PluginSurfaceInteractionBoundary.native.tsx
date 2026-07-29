import * as React from 'react';
import { AccessibilityInfo, StyleSheet, TextInput, View } from 'react-native';

import { t } from '@/text';

type PluginSurfaceInteractionBoundaryProps = Readonly<{
    children: React.ReactNode;
    enabled: boolean;
    snapshotTitle: string;
    surfaceId: string;
}>;

export function PluginSurfaceInteractionBoundary(
    props: PluginSurfaceInteractionBoundaryProps,
): React.ReactElement {
    const focusedTextInputRef = React.useRef<
        ReturnType<typeof TextInput.State.currentlyFocusedInput> | null
    >(null);
    const focusedAccessibilityTargetRef = React.useRef<number | null>(null);
    const focusReturnTextInputRef = React.useRef<
        ReturnType<typeof TextInput.State.currentlyFocusedInput> | null
    >(null);
    const focusReturnAccessibilityTargetRef = React.useRef<number | null>(null);
    const wasEnabledRef = React.useRef(props.enabled);
    const handleFocusCapture = React.useCallback((event: unknown) => {
        if (!props.enabled) return;
        focusedTextInputRef.current = TextInput.State.currentlyFocusedInput();
        const target = (
            event as Readonly<{ nativeEvent?: Readonly<{ target?: unknown }> }>
        ).nativeEvent?.target;
        focusedAccessibilityTargetRef.current = typeof target === 'number' ? target : null;
    }, [props.enabled]);
    const handleBlurCapture = React.useCallback(() => {
        if (!props.enabled) return;
        focusedTextInputRef.current = null;
        focusedAccessibilityTargetRef.current = null;
    }, [props.enabled]);

    React.useLayoutEffect(() => {
        const wasEnabled = wasEnabledRef.current;
        wasEnabledRef.current = props.enabled;
        if (wasEnabled && !props.enabled) {
            focusReturnTextInputRef.current = focusedTextInputRef.current;
            focusReturnAccessibilityTargetRef.current = focusedAccessibilityTargetRef.current;
            if (focusReturnTextInputRef.current) {
                TextInput.State.blurTextInput(focusReturnTextInputRef.current);
            }
            return;
        }
        if (!wasEnabled && props.enabled) {
            const textInput = focusReturnTextInputRef.current;
            const accessibilityTarget = focusReturnAccessibilityTargetRef.current;
            focusReturnTextInputRef.current = null;
            focusReturnAccessibilityTargetRef.current = null;
            if (textInput) {
                TextInput.State.focusTextInput(textInput);
            } else if (accessibilityTarget !== null) {
                AccessibilityInfo.setAccessibilityFocus(accessibilityTarget);
            }
        }
    }, [props.enabled]);

    const focusCaptureProps = {
        onFocusCapture: handleFocusCapture,
        onBlurCapture: handleBlurCapture,
    };

    return (
        <View
            testID={`plugin-surface-interaction-boundary:${props.surfaceId}`}
            style={styles.root}
        >
            <View
                testID={`plugin-surface-snapshot:${props.surfaceId}`}
                pointerEvents={props.enabled ? 'auto' : 'none'}
                accessibilityElementsHidden={!props.enabled}
                importantForAccessibility={props.enabled ? 'auto' : 'no-hide-descendants'}
                style={styles.snapshot}
                {...focusCaptureProps}
            >
                {props.children}
            </View>
            {!props.enabled ? (
                <View
                    testID={`plugin-surface-offline-summary:${props.surfaceId}`}
                    accessible
                    accessibilityRole="summary"
                    accessibilityLiveRegion="polite"
                    accessibilityLabel={t('pluginSurfaces.offlineSnapshot.accessibilityLabel', {
                        title: props.snapshotTitle,
                    })}
                    style={styles.accessibilitySummary}
                />
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create({
    root: {
        flex: 1,
        minWidth: 0,
        minHeight: 0,
    },
    snapshot: {
        flex: 1,
        minWidth: 0,
        minHeight: 0,
    },
    accessibilitySummary: {
        position: 'absolute',
        width: 1,
        height: 1,
        overflow: 'hidden',
    },
});
