import * as React from 'react';
import { AccessibilityInfo, StyleSheet, TextInput, View } from 'react-native';

import { t } from '@/text';

type PluginSurfaceInteractionBoundaryProps = Readonly<{
    children: React.ReactNode;
    /**
     * Layout/route-owned presentation fact. This is intentionally separate
     * from availability: an inactive retained surface is inert, not offline.
     */
    focusEligible?: boolean;
    enabled: boolean;
    snapshotTitle: string;
    surfaceId: string;
    loadedRuntimeIdentity?: Readonly<{
        pluginId: string;
        generation: string;
        artifactDigest: string;
        machineId?: string | null;
        serverId?: string | null;
    }>;
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
    const interactionEnabled = props.enabled && props.focusEligible !== false;
    const wasEnabledRef = React.useRef(props.enabled);
    const wasInteractionEnabledRef = React.useRef(interactionEnabled);
    const handleFocusCapture = React.useCallback((event: unknown) => {
        if (!interactionEnabled) return;
        focusedTextInputRef.current = TextInput.State.currentlyFocusedInput();
        const target = (
            event as Readonly<{ nativeEvent?: Readonly<{ target?: unknown }> }>
        ).nativeEvent?.target;
        focusedAccessibilityTargetRef.current = typeof target === 'number' ? target : null;
    }, [interactionEnabled]);
    const handleBlurCapture = React.useCallback(() => {
        if (!interactionEnabled) return;
        focusedTextInputRef.current = null;
        focusedAccessibilityTargetRef.current = null;
    }, [interactionEnabled]);

    React.useLayoutEffect(() => {
        const wasEnabled = wasEnabledRef.current;
        const wasInteractionEnabled = wasInteractionEnabledRef.current;
        wasEnabledRef.current = props.enabled;
        wasInteractionEnabledRef.current = interactionEnabled;
        if (wasInteractionEnabled && !interactionEnabled) {
            const focusedTextInput = focusedTextInputRef.current;
            const focusedAccessibilityTarget = focusedAccessibilityTargetRef.current;
            // Availability owns the only focus-return path. A retained surface
            // made ineligible by presentation must blur immediately, but its
            // layout must never preserve a stale return target for itself.
            if (wasEnabled && !props.enabled) {
                focusReturnTextInputRef.current = focusedTextInput;
                focusReturnAccessibilityTargetRef.current = focusedAccessibilityTarget;
            } else {
                focusReturnTextInputRef.current = null;
                focusReturnAccessibilityTargetRef.current = null;
            }
            focusedTextInputRef.current = null;
            focusedAccessibilityTargetRef.current = null;
            if (focusedTextInput) {
                TextInput.State.blurTextInput(focusedTextInput);
            }
            return;
        }
        if (!wasEnabled && props.enabled) {
            const textInput = focusReturnTextInputRef.current;
            const accessibilityTarget = focusReturnAccessibilityTargetRef.current;
            focusReturnTextInputRef.current = null;
            focusReturnAccessibilityTargetRef.current = null;
            if (!interactionEnabled) return;
            if (textInput) {
                TextInput.State.focusTextInput(textInput);
            } else if (accessibilityTarget !== null) {
                AccessibilityInfo.setAccessibilityFocus(accessibilityTarget);
            }
        }
    }, [interactionEnabled, props.enabled]);

    const focusCaptureProps = {
        onFocusCapture: handleFocusCapture,
        onBlurCapture: handleBlurCapture,
    };
    const loadedRuntimeMarkerId = props.loadedRuntimeIdentity === undefined
        ? null
        : buildLoadedRuntimeMarkerTestId(props.surfaceId, props.loadedRuntimeIdentity);

    return (
        <View
            testID={`plugin-surface-interaction-boundary:${props.surfaceId}`}
            style={styles.root}
        >
            <View
                testID={`plugin-surface-snapshot:${props.surfaceId}`}
                pointerEvents={interactionEnabled ? 'auto' : 'none'}
                accessibilityElementsHidden={!interactionEnabled}
                importantForAccessibility={interactionEnabled ? 'auto' : 'no-hide-descendants'}
                style={styles.snapshot}
                {...focusCaptureProps}
            >
                {props.children}
            </View>
            {loadedRuntimeMarkerId ? (
                <View
                    testID={loadedRuntimeMarkerId}
                    accessible={false}
                    pointerEvents="none"
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    style={styles.loadedRuntimeMarker}
                />
            ) : null}
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

function buildLoadedRuntimeMarkerTestId(
    surfaceId: string,
    identity: NonNullable<PluginSurfaceInteractionBoundaryProps['loadedRuntimeIdentity']>,
): string {
    return [
        'plugin-surface-interaction-boundary',
        'surface-native-loaded-runtime',
        surfaceId,
        identity.pluginId,
        identity.generation,
        identity.artifactDigest,
        identity.machineId ?? 'no-machine',
        identity.serverId ?? 'no-server',
    ].map((part) => encodeURIComponent(part)).join(':');
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
    loadedRuntimeMarker: {
        position: 'absolute',
        width: 0,
        height: 0,
        opacity: 0,
    },
    accessibilitySummary: {
        position: 'absolute',
        width: 1,
        height: 1,
        overflow: 'hidden',
    },
});
