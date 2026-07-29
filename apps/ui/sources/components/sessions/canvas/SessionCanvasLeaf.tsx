import * as React from 'react';
import { Platform, View } from 'react-native';

import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import type { SessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { SessionView } from '@/components/sessions/shell/SessionView';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import type { SessionRouteHydrationState } from '@/sync/domains/session/sessionRouteHydrationState';

type SessionCanvasLeafProps = Readonly<{
    sessionId: string;
    routeServerId?: string;
    jumpToSeq?: number | null;
    paneUrlState?: SessionPaneUrlState;
    initialAttachmentDrafts?: readonly AttachmentDraft[] | null;
    surfaceFocused?: boolean;
    surfaceVisible?: boolean;
    routeAnchor?: boolean;
    routeHydrationState?: SessionRouteHydrationState | null;
    onSurfaceInteract?: () => void;
}>;

export function SessionCanvasLeaf(props: SessionCanvasLeafProps) {
    const hydrationServerId = React.useMemo(() => {
        const normalized = String(props.routeServerId ?? '').trim();
        return normalized.length > 0 ? normalized : undefined;
    }, [props.routeServerId]);
    const ownRouteHydrationState = useHydrateSessionForRoute(
        props.sessionId,
        'SessionCanvasLeaf.ensureSessionVisible',
        hydrationServerId ? { serverId: hydrationServerId } : undefined,
    );
    const routeHydrationState = props.routeHydrationState ?? ownRouteHydrationState;
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
            <SessionView
                id={props.sessionId}
                routeServerId={props.routeServerId}
                routeHydrationState={routeHydrationState}
                jumpToSeq={props.jumpToSeq ?? null}
                paneUrlState={props.paneUrlState}
                initialAttachmentDrafts={props.initialAttachmentDrafts}
                surfaceFocusedOverride={props.surfaceFocused}
                surfaceVisibleOverride={props.surfaceVisible ?? true}
                routeAnchorOverride={Platform.OS === 'web' ? undefined : props.routeAnchor}
            />
        </View>
    );
}
