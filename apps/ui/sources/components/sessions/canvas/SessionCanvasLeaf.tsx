import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';

import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import type { SessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { SessionView } from '@/components/sessions/shell/SessionView';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';

type SessionCanvasLeafProps = Readonly<{
    sessionId: string;
    routeServerId?: string;
    jumpToSeq?: number | null;
    paneUrlState?: SessionPaneUrlState;
    initialAttachmentDrafts?: readonly AttachmentDraft[] | null;
    surfaceFocused?: boolean;
    surfaceVisible?: boolean;
    routeAnchor?: boolean;
    onSurfaceInteract?: () => void;
}>;

export function SessionCanvasLeaf(props: SessionCanvasLeafProps) {
    const hydrationServerId = React.useMemo(() => {
        const normalized = String(props.routeServerId ?? '').trim();
        return normalized.length > 0 ? normalized : undefined;
    }, [props.routeServerId]);
    const sessionHydrated = useHydrateSessionForRoute(
        props.sessionId,
        'SessionCanvasLeaf.ensureSessionVisible',
        hydrationServerId ? { serverId: hydrationServerId } : undefined,
    );
    const handleSurfaceInteract = React.useCallback(() => {
        props.onSurfaceInteract?.();
    }, [props.onSurfaceInteract]);

    return (
        <View
            testID={`session-canvas-surface-${props.sessionId}`}
            accessibilityState={props.surfaceFocused != null ? { selected: props.surfaceFocused } : undefined}
            aria-selected={props.surfaceFocused != null ? props.surfaceFocused : undefined}
            style={{ flex: 1, minWidth: 0, minHeight: 0 }}
            onPointerDownCapture={handleSurfaceInteract}
            onTouchStart={handleSurfaceInteract}
            onFocus={handleSurfaceInteract}
        >
            {sessionHydrated ? (
                <SessionView
                    id={props.sessionId}
                    routeServerId={props.routeServerId}
                    jumpToSeq={props.jumpToSeq ?? null}
                    paneUrlState={props.paneUrlState}
                    initialAttachmentDrafts={props.initialAttachmentDrafts}
                    surfaceFocusedOverride={props.surfaceFocused}
                    surfaceVisibleOverride={props.surfaceVisible ?? true}
                    routeAnchorOverride={props.routeAnchor}
                />
            ) : (
                <View
                    testID={`session-canvas-loading-${props.sessionId}`}
                    style={{
                        flex: 1,
                        minWidth: 0,
                        minHeight: 0,
                        alignItems: 'center',
                        justifyContent: 'center',
                    }}
                >
                    <ActivityIndicator />
                </View>
            )}
        </View>
    );
}
