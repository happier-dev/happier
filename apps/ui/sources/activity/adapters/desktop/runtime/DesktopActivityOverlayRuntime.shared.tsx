import * as React from 'react';
import { router } from 'expo-router';

import { parseActivityInteraction } from '@/activity/actions/parseActivityInteraction';
import { resolveActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import { buildDesktopActivityOverlayModel } from '@/activity/adapters/desktop/presentation/buildDesktopActivityOverlayModel';
import { buildDesktopActivityOverlaySnapshot } from '@/activity/adapters/desktop/presentation/buildDesktopActivityOverlaySnapshot';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import type { ActionId } from '@happier-dev/protocol';
import { useLocalSettings } from '@/sync/domains/state/storage';
import { isTauriDesktop } from '@/utils/platform/tauri';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
    listenDesktopActivityOverlayInteraction,
    setDesktopActivityOverlayExpanded,
    showDesktopMainWindow,
    syncDesktopActivityOverlay,
} from './desktopActivityOverlayBridge';
import { isDesktopActivityOverlayWindowContext } from './isDesktopActivityOverlayWindowContext';
import { resolveDesktopOverlayPolicy } from './resolveDesktopOverlayPolicy';
import { useDesktopActivityOverlaySource } from './useDesktopActivityOverlaySource';

type InteractionPayload = Readonly<{
    actionIdentifier: string;
    data?: Record<string, unknown>;
}>;

const DESKTOP_OVERLAY_DIRECT_ACTION_IDS = new Set([
    'session.permission.respond',
    'session.user_action.answer',
]);

function readExpandedFromInteraction(payload: InteractionPayload): boolean | null {
    const data = payload.data;
    if (!data || typeof data !== 'object') {
        return null;
    }
    return typeof data.expanded === 'boolean' ? data.expanded : null;
}

function readSessionIdFromInteraction(payload: InteractionPayload): string | null {
    const sessionId = payload.data?.sessionId;
    return typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId.trim() : null;
}

export function DesktopActivityOverlayRuntimeShared(): React.ReactElement | null {
    const source = useDesktopActivityOverlaySource();
    const localSettings = useLocalSettings();
    const [isExpanded, setIsExpanded] = React.useState(false);
    const actionExecutor = React.useMemo(() => createDefaultActionExecutor(), []);

    const isDesktop = isTauriDesktop();
    const isOverlayWindow = isDesktopActivityOverlayWindowContext();
    const desktopPolicy = React.useMemo(
        () => resolveDesktopOverlayPolicy((localSettings ?? {}) as Record<string, unknown>),
        [localSettings],
    );
    const activityPolicy = React.useMemo(
        () => resolveActivitySurfacePolicy((localSettings ?? {}) as Record<string, unknown>),
        [localSettings],
    );
    const snapshot = React.useMemo(
        () => buildDesktopActivityOverlaySnapshot({
            source,
            activityPolicy,
            desktopPolicy,
        }),
        [activityPolicy, desktopPolicy, source],
    );
    const model = React.useMemo(
        () => buildDesktopActivityOverlayModel({
            snapshot,
            policy: desktopPolicy,
            isExpanded,
        }),
        [desktopPolicy, isExpanded, snapshot],
    );

    React.useEffect(() => {
        if (!isDesktop || isOverlayWindow) {
            return;
        }

        fireAndForget(syncDesktopActivityOverlay({
            visible: model.visible,
            expanded: isExpanded,
            model,
            policy: desktopPolicy,
            window: model.window,
        }), {
            tag: 'DesktopActivityOverlayRuntime.syncDesktopActivityOverlay',
        });
    }, [desktopPolicy, isDesktop, isExpanded, isOverlayWindow, model]);

    React.useEffect(() => {
        if (!isDesktop || isOverlayWindow) {
            return;
        }
        if (!isExpanded || !model.visible) {
            return;
        }
        if (!desktopPolicy.autoHideEnabled) {
            return;
        }

        const timeoutId = setTimeout(() => {
            setIsExpanded(false);
            fireAndForget(setDesktopActivityOverlayExpanded(false), {
                tag: 'DesktopActivityOverlayRuntime.autoHideCollapse',
            });
        }, desktopPolicy.autoHideDelayMs);

        return () => {
            clearTimeout(timeoutId);
        };
    }, [
        desktopPolicy.autoHideDelayMs,
        desktopPolicy.autoHideEnabled,
        isDesktop,
        isExpanded,
        isOverlayWindow,
        model.visible,
    ]);

    React.useEffect(() => {
        if (!isDesktop || isOverlayWindow) {
            return () => {};
        }

        let disposed = false;
        let unlisten: (() => void) | null = null;
        void listenDesktopActivityOverlayInteraction((payload) => {
            if (disposed) {
                return;
            }

            const actionIdentifier = payload.actionIdentifier.trim();
            if (actionIdentifier === 'overlay-toggle-expanded') {
                setIsExpanded((previous) => {
                    const next = !previous;
                    fireAndForget(setDesktopActivityOverlayExpanded(next), {
                        tag: 'DesktopActivityOverlayRuntime.setExpanded.toggle',
                    });
                    return next;
                });
                return;
            }
            if (actionIdentifier === 'overlay-set-expanded') {
                const expanded = readExpandedFromInteraction(payload);
                if (expanded == null) return;
                setIsExpanded(expanded);
                fireAndForget(setDesktopActivityOverlayExpanded(expanded), {
                    tag: 'DesktopActivityOverlayRuntime.setExpanded.explicit',
                });
                return;
            }
            if (DESKTOP_OVERLAY_DIRECT_ACTION_IDS.has(actionIdentifier)) {
                const defaultSessionId = readSessionIdFromInteraction(payload) ?? snapshot.primary?.sessionId ?? null;
                fireAndForget(actionExecutor.execute(actionIdentifier as ActionId, payload.data ?? {}, {
                    surface: 'desktop_overlay',
                    defaultSessionId,
                }), {
                    tag: 'DesktopActivityOverlayRuntime.executeDirectAction',
                });
                return;
            }

            const parsed = parseActivityInteraction({
                actionIdentifier,
                defaultActionIdentifier: snapshot.defaultTarget,
                data: payload.data ?? {
                    primarySessionId: snapshot.primary?.sessionId ?? null,
                },
            });
            if (parsed?.permissionAction) {
                fireAndForget(actionExecutor.execute('session.permission.respond', {
                    sessionId: parsed.permissionAction.sessionId,
                    requestId: parsed.permissionAction.requestId,
                    decision: parsed.permissionAction.action,
                }, {
                    surface: 'desktop_overlay',
                    defaultSessionId: parsed.permissionAction.sessionId,
                }), {
                    tag: 'DesktopActivityOverlayRuntime.executePermissionAction',
                });
                return;
            }
            if (!parsed?.route) {
                return;
            }

            fireAndForget(showDesktopMainWindow(), {
                tag: 'DesktopActivityOverlayRuntime.showMainWindow.beforeRoute',
            });
            router.push(parsed.route);
            setIsExpanded(false);
            fireAndForget(setDesktopActivityOverlayExpanded(false), {
                tag: 'DesktopActivityOverlayRuntime.setExpanded.afterOpen',
            });
        }).then((dispose) => {
            if (disposed) {
                dispose();
                return;
            }
            unlisten = dispose;
        }).catch(() => {});

        return () => {
            disposed = true;
            unlisten?.();
        };
    }, [actionExecutor, isDesktop, isOverlayWindow, snapshot.defaultTarget, snapshot.primary?.sessionId]);

    return null;
}

export default DesktopActivityOverlayRuntimeShared;
