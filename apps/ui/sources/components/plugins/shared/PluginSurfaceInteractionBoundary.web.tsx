import * as React from 'react';

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
            <div
                ref={containerRef}
                data-testid={`plugin-surface-interaction-boundary:${props.surfaceId}`}
                data-plugin-interaction-state={props.enabled ? 'enabled' : 'offline-snapshot'}
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
                    {props.children}
                </div>
            </div>
            {!props.enabled ? (
                <span
                    data-testid={`plugin-surface-offline-summary:${props.surfaceId}`}
                    role="status"
                    aria-live="polite"
                    style={visuallyHiddenStyle}
                >
                    {t('pluginSurfaces.offlineSnapshot.accessibilityLabel', {
                        title: props.snapshotTitle,
                    })}
                </span>
            ) : null}
        </>
    );
}

const visuallyHiddenStyle: React.CSSProperties = {
    position: 'absolute',
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap',
    border: 0,
};
