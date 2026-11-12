import * as React from 'react';

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
    /** Host-stamped, non-authoritative loaded-runtime evidence for diagnostics/QA. */
    loadedRuntimeIdentity?: Readonly<{
        pluginId: string;
        occurrenceId: string;
        artifactDigest: string;
        machineId?: string | null;
        serverId?: string | null;
    }>;
}>;

function blockOfflineInteraction(event: React.SyntheticEvent): void {
    event.preventDefault();
    event.stopPropagation();
}

export function PluginSurfaceInteractionBoundary(
    props: PluginSurfaceInteractionBoundaryProps,
): React.ReactElement {
    const containerRef = React.useRef<HTMLDivElement>(null);
    const focusReturnRef = React.useRef<HTMLElement | null>(null);
    // Availability remains the sole owner of offline/recovery semantics.
    // Presentation eligibility only makes an otherwise available retained or
    // covered snapshot inert; it must not create another focus-return owner.
    const offlineNotice = useOfflineSurfaceNotice(props.enabled, props.snapshotTitle, props.hasContent);
    const companion = React.useContext(PluginSurfaceCompanionContext);
    const pageIdentity = React.useContext(PluginSurfacePageHeaderContext);
    const machineRecovery = React.useContext(PluginSurfaceMachineRecoveryContext);
    // A body with nothing cached claims the offline notice as its one line; the boundary then draws none. It is offered
    // whenever the boundary would draw that line: offline, or its Machine unreachable while the surface is still enabled.
    const offlineClaim = useClaimableOfflineNotice({
        offline: (!props.enabled || Boolean(machineRecovery)) && !offlineNotice.nothingLoaded && !companion,
        ...(machineRecovery?.retry ? { retry: machineRecovery.retry } : {}),
    });
    const interactionEnabled = props.enabled && props.focusEligible !== false;
    const wasEnabledRef = React.useRef(props.enabled);
    const wasInteractionEnabledRef = React.useRef(interactionEnabled);

    React.useLayoutEffect(() => {
        const container = containerRef.current;
        if (!container || typeof document === 'undefined') {
            return;
        }

        const wasEnabled = wasEnabledRef.current;
        const wasInteractionEnabled = wasInteractionEnabledRef.current;
        wasEnabledRef.current = props.enabled;
        wasInteractionEnabledRef.current = interactionEnabled;

        if (wasInteractionEnabled && !interactionEnabled) {
            const activeElement = document.activeElement;
            if (activeElement instanceof HTMLElement && container.contains(activeElement)) {
                // Availability owns recovery focus. Presentation eligibility
                // only removes an inactive retained snapshot from focus now.
                focusReturnRef.current = wasEnabled && !props.enabled ? activeElement : null;
                activeElement.blur();
            } else {
                focusReturnRef.current = null;
            }
            return;
        }

        if (wasEnabled || !props.enabled) return;
        const focusReturnTarget = focusReturnRef.current;
        focusReturnRef.current = null;
        if (!interactionEnabled || !focusReturnTarget?.isConnected || !container.contains(focusReturnTarget)) {
            return;
        }
        try {
            focusReturnTarget.focus({ preventScroll: true });
        } catch {
            focusReturnTarget.focus();
        }
    }, [interactionEnabled, props.enabled]);

    const blockedCaptureProps = interactionEnabled
        ? {}
        : {
            onClickCapture: blockOfflineInteraction,
            onKeyDownCapture: blockOfflineInteraction,
            onKeyUpCapture: blockOfflineInteraction,
            onPointerDownCapture: blockOfflineInteraction,
            onPointerUpCapture: blockOfflineInteraction,
            onFocusCapture: blockOfflineInteraction,
        };

    return (
        <>
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
            <div
                ref={containerRef}
                data-testid={`plugin-surface-interaction-boundary:${props.surfaceId}`}
                data-plugin-interaction-state={props.enabled ? 'enabled' : 'offline-snapshot'}
                data-plugin-id={props.loadedRuntimeIdentity?.pluginId}
                data-plugin-occurrence-id={props.loadedRuntimeIdentity?.occurrenceId}
                data-plugin-artifact-digest={props.loadedRuntimeIdentity?.artifactDigest}
                data-plugin-machine-id={props.loadedRuntimeIdentity?.machineId ?? undefined}
                data-plugin-server-id={props.loadedRuntimeIdentity?.serverId ?? undefined}
                style={{ display: 'contents' }}
            >
                <div
                    data-testid={`plugin-surface-snapshot:${props.surfaceId}`}
                    inert={!interactionEnabled}
                    aria-hidden={!interactionEnabled}
                    style={{
                        display: 'contents',
                        pointerEvents: interactionEnabled ? 'auto' : 'none',
                    }}
                    {...blockedCaptureProps}
                >
                    {offlineNotice.nothingLoaded ? null : (
                        <PluginSurfaceInteractionAvailabilityContext.Provider value={props.enabled}>
                            <PluginSurfacePageHeaderContext.Provider value={null}>
                                {offlineClaim.provide(props.children)}
                            </PluginSurfacePageHeaderContext.Provider>
                        </PluginSurfaceInteractionAvailabilityContext.Provider>
                    )}
                </div>
            </div>
            {offlineNotice.nothingLoaded && !companion ? pageIdentity?.header : null}
            {offlineNotice.nothingLoaded && companion ? null : offlineNotice.nothingLoaded ? (
                <SurfaceStateCard
                    testID={`plugin-surface-offline-state:${props.surfaceId}`}
                    kind={offlineNotice.kind}
                    size="line"
                    replacesContent
                    title={offlineNotice.title}
                    reason={offlineNotice.reason}
                    action={offlineNotice.kind === 'unavailable' ? machineRecovery?.retry : undefined}
                    secondaryAction={offlineNotice.kind === 'unavailable' ? machineRecovery?.chooseMachine : undefined}
                />
            ) : !props.enabled && !machineRecovery && !offlineClaim.claimed ? (
                <div
                    data-testid={`plugin-surface-offline-summary:${props.surfaceId}`}
                    role="status"
                    aria-live="polite"
                    aria-label={offlineNotice.accessibilityLabel}
                >
                    <SurfaceFreshnessLine
                        testID={`plugin-surface-offline-summary:${props.surfaceId}-freshness`}
                        reason={offlineNotice.reason}
                    />
                </div>
            ) : null}
        </>
    );
}
