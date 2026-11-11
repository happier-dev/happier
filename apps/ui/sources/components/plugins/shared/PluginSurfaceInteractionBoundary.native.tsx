import * as React from 'react';
import { AccessibilityInfo, StyleSheet, TextInput, View } from 'react-native';

import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import {
    PluginSurfaceCompanionContext,
    PluginSurfaceInteractionAvailabilityContext,
    PluginSurfaceMachineRecoveryContext,
    PluginSurfacePageHeaderContext,
    useClaimableOfflineNotice,
    useOfflineSurfaceNotice,
} from './pluginSurfaceInteractionAvailability';

type PluginSurfaceInteractionBoundaryProps = Readonly<{
    children: React.ReactNode;
    /**
     * Layout/route-owned presentation fact. This is intentionally separate
     * from availability: an inactive retained surface is inert, not offline.
     */
    focusEligible?: boolean;
    enabled: boolean;
    /** The renderer already holds readable content, independently of effect availability. */
    hasContent?: boolean;
    snapshotTitle: string;
    surfaceId: string;
    loadedRuntimeIdentity?: Readonly<{
        pluginId: string;
        occurrenceId: string;
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
    const offlineNotice = useOfflineSurfaceNotice(props.enabled, props.snapshotTitle, props.hasContent);
    const companion = React.useContext(PluginSurfaceCompanionContext);
    const pageIdentity = React.useContext(PluginSurfacePageHeaderContext);
    const machineRecovery = React.useContext(PluginSurfaceMachineRecoveryContext);
    // A body with nothing cached claims the offline notice as its one line; the boundary then draws none.
    const offlineClaim = useClaimableOfflineNotice({
        offline: !props.enabled && !offlineNotice.nothingLoaded && !companion,
        ...(machineRecovery?.retry ? { retry: machineRecovery.retry } : {}),
    });
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
            {!offlineNotice.nothingLoaded && machineRecovery && !companion && !offlineClaim.claimed ? (
                <SurfaceStateCard
                    testID={`plugin-surface-machine-unavailable:${props.surfaceId}`}
                    kind="unavailable" size="line"
                    title={offlineNotice.title}
                    reason={offlineNotice.reason}
                    action={machineRecovery.retry}
                    secondaryAction={machineRecovery.chooseMachine}
                />
            ) : null}
            <View
                testID={`plugin-surface-snapshot:${props.surfaceId}`}
                pointerEvents={interactionEnabled ? 'auto' : 'none'}
                accessibilityElementsHidden={!interactionEnabled}
                importantForAccessibility={interactionEnabled ? 'auto' : 'no-hide-descendants'}
                style={offlineNotice.nothingLoaded ? undefined : styles.snapshot}
                {...focusCaptureProps}
            >
                {offlineNotice.nothingLoaded ? null : (
                    <PluginSurfaceInteractionAvailabilityContext.Provider value={props.enabled}>
                        <PluginSurfacePageHeaderContext.Provider value={null}>
                            {offlineClaim.provide(props.children)}
                        </PluginSurfacePageHeaderContext.Provider>
                    </PluginSurfaceInteractionAvailabilityContext.Provider>
                )}
            </View>
            {offlineNotice.nothingLoaded && !companion ? (
                <>
                    {pageIdentity?.header}
                    <SurfaceStateCard
                        testID={`plugin-surface-offline-state:${props.surfaceId}`}
                        kind={offlineNotice.kind}
                        replacesContent
                        title={offlineNotice.title}
                        reason={offlineNotice.reason}
                        action={offlineNotice.kind === 'unavailable' ? machineRecovery?.retry : undefined}
                        secondaryAction={offlineNotice.kind === 'unavailable' ? machineRecovery?.chooseMachine : undefined}
                    />
                </>
            ) : null}
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
            {!props.enabled && !offlineNotice.nothingLoaded && !machineRecovery && !offlineClaim.claimed ? (
                <View
                    testID={`plugin-surface-offline-summary:${props.surfaceId}`}
                    accessible
                    accessibilityRole="summary"
                    accessibilityLiveRegion="polite"
                    accessibilityLabel={offlineNotice.accessibilityLabel}
                >
                    <SurfaceFreshnessLine
                        testID={`plugin-surface-offline-summary:${props.surfaceId}-freshness`}
                        reason={offlineNotice.reason}
                    />
                </View>
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
        identity.occurrenceId,
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
});
