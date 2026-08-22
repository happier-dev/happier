import * as React from 'react';
import { router } from 'expo-router';

import { createActivitySurfaceSessionRoute } from '@/activity/actions/activitySurfaceTargets';
import {
    resolveActivityInteractionCommand,
    type ActivityInteractionCommand,
    type ActivityInteractionIdentity,
    type ActivityInteractionTargetContext,
} from '@/activity/actions/resolveActivityInteractionCommand';
import { resolveActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import { buildDesktopActivityOverlayModel } from '@/activity/adapters/desktop/presentation/buildDesktopActivityOverlayModel';
import {
    buildDesktopActivityOverlaySnapshot,
    type DesktopActivityOverlaySnapshot,
} from '@/activity/adapters/desktop/presentation/buildDesktopActivityOverlaySnapshot';
import { buildStableActivityOverviewFingerprint } from '@/activity/source/buildActivityOverviewFromSource';
import { isUnsafeNotificationServerUrl } from '@/activity/notifications/notificationRouting';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import type { ActionId } from '@happier-dev/protocol';
import { useLocalSettings } from '@/sync/domains/state/storage';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
    emitDesktopActivityOverlayInteractionResult,
    listenDesktopActivityOverlayInteraction,
    setDesktopActivityOverlayExpanded,
    showDesktopMainWindow,
    syncDesktopActivityOverlay,
} from './desktopActivityOverlayBridge';
import { readDesktopActivityOverlayQaSyncOverride } from './desktopActivityOverlayQaSyncOverride';
import { isDesktopActivityOverlayWindowContext } from './isDesktopActivityOverlayWindowContext';
import { resolveDesktopOverlayPolicy } from './resolveDesktopOverlayPolicy';
import { buildDesktopActivityOverlayOverviewFromSource } from '../presentation/snapshot/buildDesktopActivityOverlayOverviewFromSource';
import { useDesktopActivityOverlaySource } from './useDesktopActivityOverlaySource';

type InteractionPayload = Readonly<{
    requestId?: string;
    actionIdentifier: string;
    data?: Record<string, unknown>;
}>;

const DESKTOP_OVERLAY_DIRECT_ACTION_IDS = new Set([
    'session.message.send',
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

function readLockedFromInteraction(payload: InteractionPayload): boolean | null {
    const data = payload.data;
    if (!data || typeof data !== 'object') {
        return null;
    }
    return typeof data.locked === 'boolean' ? data.locked : null;
}

function readEngagedFromInteraction(payload: InteractionPayload): boolean | null {
    const data = payload.data;
    if (!data || typeof data !== 'object') {
        return null;
    }
    return typeof data.engaged === 'boolean' ? data.engaged : null;
}

function readSessionIdFromInteraction(payload: InteractionPayload): string | null {
    const sessionId = payload.data?.sessionId;
    return typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId.trim() : null;
}

function readRequestIdFromInteraction(payload: InteractionPayload): string | null {
    return typeof payload.requestId === 'string' && payload.requestId.trim().length > 0
        ? payload.requestId.trim()
        : null;
}

function readResultString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error || 'action_failed');
}

function emitDirectActionInteractionResult(
    requestId: string | null,
    result: Readonly<{
        ok: boolean;
        errorCode?: unknown;
        error?: unknown;
    }>,
) {
    if (!requestId) {
        return;
    }
    const ok = result.ok === true;
    fireAndForget(emitDesktopActivityOverlayInteractionResult({
        requestId,
        ok,
        ...(ok ? {} : {
            errorCode: readResultString(result.errorCode) ?? 'action_failed',
            error: readResultString(result.error) ?? 'action_failed',
        }),
    }), {
        tag: ok
            ? 'DesktopActivityOverlayRuntime.emitDirectActionInteractionResult.success'
            : 'DesktopActivityOverlayRuntime.emitDirectActionInteractionResult.failure',
    });
}

function emitDirectActionInteractionError(requestId: string | null, error: unknown) {
    if (!requestId) {
        return;
    }
    fireAndForget(emitDesktopActivityOverlayInteractionResult({
        requestId,
        ok: false,
        errorCode: 'action_failed',
        error: readErrorMessage(error),
    }), {
        tag: 'DesktopActivityOverlayRuntime.emitDirectActionInteractionResult.error',
    });
}

function readServerUrlFromInteraction(payload: InteractionPayload): string | null {
    const serverUrl = payload.data?.serverUrl;
    return typeof serverUrl === 'string' && serverUrl.trim().length > 0 ? serverUrl.trim() : null;
}

function readServerIdFromInteraction(payload: InteractionPayload): string | null {
    const serverId = payload.data?.serverId;
    return typeof serverId === 'string' && serverId.trim().length > 0 ? serverId.trim() : null;
}

function addKnownServerIdForSession(
    serverIds: Set<string>,
    sessionId: string,
    candidateSessionId: string,
    candidateServerId: string | null,
) {
    if (candidateSessionId !== sessionId || !candidateServerId) {
        return;
    }
    serverIds.add(candidateServerId);
}

function addKnownInteractionIdentity(
    identities: ActivityInteractionIdentity[],
    candidateSessionId: string,
    candidateServerId: string | null,
) {
    if (!candidateServerId) {
        return;
    }
    identities.push({
        sessionId: candidateSessionId,
        serverId: candidateServerId,
    });
}

function collectKnownServerIdsForSession(
    snapshot: DesktopActivityOverlaySnapshot,
    sessionId: string,
): ReadonlySet<string> {
    const serverIds = new Set<string>();
    for (const session of snapshot.sessions) {
        addKnownServerIdForSession(serverIds, sessionId, session.sessionId, session.serverId);
    }
    for (const request of snapshot.permissionRequests) {
        addKnownServerIdForSession(serverIds, sessionId, request.sessionId, request.serverId);
    }
    for (const request of snapshot.userQuestions) {
        addKnownServerIdForSession(serverIds, sessionId, request.sessionId, request.serverId);
    }
    for (const completionState of snapshot.completionStates) {
        addKnownServerIdForSession(serverIds, sessionId, completionState.sessionId, completionState.serverId);
    }
    return serverIds;
}

function resolveKnownServerIdForSession(
    snapshot: DesktopActivityOverlaySnapshot,
    sessionId: string,
): string | null {
    const serverIds = [...collectKnownServerIdsForSession(snapshot, sessionId)];
    return serverIds.length === 1 ? serverIds[0]! : null;
}

function resolveActionContextServerId(serverId: string | null | undefined): string | null {
    const normalized = typeof serverId === 'string' ? serverId.trim() : '';
    if (!normalized || normalized === 'local') {
        return null;
    }
    return normalized;
}

function collectKnownInteractionIdentities(
    snapshot: DesktopActivityOverlaySnapshot,
): readonly ActivityInteractionIdentity[] {
    const identities: ActivityInteractionIdentity[] = [];
    for (const session of snapshot.sessions) {
        addKnownInteractionIdentity(identities, session.sessionId, session.serverId);
    }
    for (const request of snapshot.permissionRequests) {
        addKnownInteractionIdentity(identities, request.sessionId, request.serverId);
    }
    for (const request of snapshot.userQuestions) {
        addKnownInteractionIdentity(identities, request.sessionId, request.serverId);
    }
    for (const completionState of snapshot.completionStates) {
        addKnownInteractionIdentity(identities, completionState.sessionId, completionState.serverId);
    }
    return identities;
}

function hasVerifiedDirectActionScope(
    snapshot: DesktopActivityOverlaySnapshot,
    sessionId: string | null,
    serverId: string | null,
): boolean {
    if (!sessionId || !serverId) {
        return false;
    }
    return collectKnownServerIdsForSession(snapshot, sessionId).has(serverId);
}

function resolveDirectActionFallbackRoute(
    payload: InteractionPayload,
    snapshot: DesktopActivityOverlaySnapshot,
    fallbackSessionId: string | null,
): string {
    const sessionId = readSessionIdFromInteraction(payload) ?? fallbackSessionId;
    if (!sessionId) {
        return '/inbox';
    }
    const serverId = readServerIdFromInteraction(payload) ?? resolveKnownServerIdForSession(snapshot, sessionId);
    return createActivitySurfaceSessionRoute(sessionId, serverId);
}

function buildDirectActionTargetContext(payload: InteractionPayload): ActivityInteractionTargetContext {
    return {
        serverId: readServerIdFromInteraction(payload),
        sessionId: readSessionIdFromInteraction(payload),
        serverUrl: readServerUrlFromInteraction(payload),
    };
}

function buildCanonicalDirectActionPayload(data: Record<string, unknown> | undefined): Record<string, unknown> {
    const { serverId: _serverId, serverUrl: _serverUrl, ...payload } = data ?? {};
    return payload;
}

function buildVerifiedDesktopDirectActionCommand(params: Readonly<{
    actionIdentifier: string;
    payload: InteractionPayload;
    snapshot: DesktopActivityOverlaySnapshot;
}>): ActivityInteractionCommand | null {
    if (!DESKTOP_OVERLAY_DIRECT_ACTION_IDS.has(params.actionIdentifier)) {
        return null;
    }

    const sessionId = readSessionIdFromInteraction(params.payload) ?? params.snapshot.primary?.sessionId ?? null;
    const serverId = readServerIdFromInteraction(params.payload);
    if (!hasVerifiedDirectActionScope(params.snapshot, sessionId, serverId) || !sessionId || !serverId) {
        return null;
    }

    return {
        kind: 'executeAction',
        actionId: params.actionIdentifier as ActionId,
        payload: buildCanonicalDirectActionPayload(params.payload.data),
        defaultSessionId: sessionId,
        target: buildDirectActionTargetContext(params.payload),
        identity: {
            sessionId,
            serverId,
        },
        surface: {
            name: 'desktop_overlay',
            interaction: params.actionIdentifier,
        },
    };
}

function hasBlockingAutoCollapseCard(model: ReturnType<typeof buildDesktopActivityOverlayModel>): boolean {
    return (model.expanded.cards ?? []).some((card) => (
        card.kind === 'permission_request' || card.kind === 'user_question'
    ));
}

function buildDesktopOverlaySyncFingerprint(params: Readonly<{
    sourceFingerprint: string;
    visible: boolean;
    expanded: boolean;
    snapshot: DesktopActivityOverlaySnapshot;
    policy: ReturnType<typeof resolveDesktopOverlayPolicy>;
    window: ReturnType<typeof buildDesktopActivityOverlayModel>['window'];
    qaSyncOverride: unknown;
}>): string {
    if (params.qaSyncOverride) {
        return JSON.stringify({
            qaSyncOverride: params.qaSyncOverride,
        });
    }

    const { generatedAt: _generatedAt, ...stableSnapshot } = params.snapshot;
    return JSON.stringify({
        source: params.sourceFingerprint,
        visible: params.visible,
        expanded: params.expanded,
        snapshot: stableSnapshot,
        policy: params.policy,
        window: params.window,
    });
}

function isRouteCommand(command: ActivityInteractionCommand): command is Extract<
    ActivityInteractionCommand,
    { kind: 'openSession' | 'openInbox' | 'focusComposer' | 'openSettings' }
> {
    return command.kind === 'openSession'
        || command.kind === 'openInbox'
        || command.kind === 'focusComposer'
        || command.kind === 'openSettings';
}

export function DesktopActivityOverlayRuntimeShared(): React.ReactElement | null {
    const source = useDesktopActivityOverlaySource();
    const localSettings = useLocalSettings();
    const [isExpanded, setIsExpanded] = React.useState(false);
    const [inputLocked, setInputLocked] = React.useState(false);
    const [surfaceEngaged, setSurfaceEngaged] = React.useState(false);
    const actionExecutor = React.useMemo(() => createDefaultActionExecutor(), []);
    const previousPrimaryRef = React.useRef<{
        sessionId: string | null;
        changedAtMs: number | null;
    }>({
        sessionId: null,
        changedAtMs: null,
    });
    const lastSyncFingerprintRef = React.useRef<string | null>(null);

    const isDesktop = isDesktopHost();
    const isOverlayWindow = isDesktopActivityOverlayWindowContext();
    const desktopPolicy = React.useMemo(
        () => resolveDesktopOverlayPolicy((localSettings ?? {}) as Record<string, unknown>),
        [localSettings],
    );
    const activityPolicy = React.useMemo(
        () => resolveActivitySurfacePolicy((localSettings ?? {}) as Record<string, unknown>),
        [localSettings],
    );
    const sourceOverview = React.useMemo(
        () => buildDesktopActivityOverlayOverviewFromSource({
            source,
            nowMs: Date.now(),
        }),
        [source],
    );
    const sourceOverviewFingerprint = React.useMemo(
        () => buildStableActivityOverviewFingerprint(sourceOverview),
        [sourceOverview],
    );
    const snapshot = React.useMemo(
        () => buildDesktopActivityOverlaySnapshot({
            source,
            sourceOverview,
            activityPolicy,
            desktopPolicy,
            previousPrimarySessionId: previousPrimaryRef.current.sessionId,
            previousPrimaryChangedAtMs: previousPrimaryRef.current.changedAtMs,
        }),
        [activityPolicy, desktopPolicy, source, sourceOverview],
    );
    const snapshotPrimarySessionId = snapshot.primary?.sessionId ?? null;
    if (snapshotPrimarySessionId !== previousPrimaryRef.current.sessionId) {
        previousPrimaryRef.current = {
            sessionId: snapshotPrimarySessionId,
            changedAtMs: snapshotPrimarySessionId ? snapshot.generatedAt : null,
        };
    }
    const snapshotRef = React.useRef(snapshot);
    snapshotRef.current = snapshot;
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

        const qaSyncOverride = readDesktopActivityOverlayQaSyncOverride();
        const payload = qaSyncOverride ?? {
            visible: model.visible,
            expanded: isExpanded,
            model,
            policy: desktopPolicy,
            window: model.window,
        };
        const nextSyncFingerprint = buildDesktopOverlaySyncFingerprint({
            sourceFingerprint: sourceOverviewFingerprint,
            visible: model.visible,
            expanded: isExpanded,
            snapshot,
            policy: desktopPolicy,
            window: model.window,
            qaSyncOverride,
        });
        if (lastSyncFingerprintRef.current === nextSyncFingerprint) {
            return;
        }
        lastSyncFingerprintRef.current = nextSyncFingerprint;

        fireAndForget(syncDesktopActivityOverlay(payload), {
            tag: 'DesktopActivityOverlayRuntime.syncDesktopActivityOverlay',
        });
    }, [
        desktopPolicy,
        isDesktop,
        isExpanded,
        isOverlayWindow,
        model,
        snapshot,
        sourceOverviewFingerprint,
    ]);

    React.useEffect(() => {
        if (!isDesktop || isOverlayWindow) {
            return;
        }
        if (!isExpanded || !model.visible) {
            return;
        }
        if (inputLocked) {
            return;
        }
        if (surfaceEngaged || hasBlockingAutoCollapseCard(model)) {
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
        inputLocked,
        isDesktop,
        isExpanded,
        isOverlayWindow,
        model.visible,
        model,
        surfaceEngaged,
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
            if (actionIdentifier === 'overlay-set-expanded') {
                const expanded = readExpandedFromInteraction(payload);
                if (expanded == null) return;
                setIsExpanded(expanded);
                if (!expanded) {
                    setInputLocked(false);
                    setSurfaceEngaged(false);
                }
                fireAndForget(setDesktopActivityOverlayExpanded(expanded), {
                    tag: 'DesktopActivityOverlayRuntime.setExpanded.explicit',
                });
                return;
            }
            if (actionIdentifier === 'overlay-input-locked') {
                const locked = readLockedFromInteraction(payload);
                if (locked == null) return;
                setInputLocked(locked);
                return;
            }
            if (actionIdentifier === 'overlay-surface-engaged') {
                const engaged = readEngagedFromInteraction(payload);
                if (engaged == null) return;
                setSurfaceEngaged(engaged);
                return;
            }
            const currentSnapshot = snapshotRef.current;
            const sharedCommand = resolveActivityInteractionCommand({
                actionIdentifier,
                defaultActionIdentifier: currentSnapshot.defaultTarget,
                data: payload.data ?? {
                    primarySessionId: currentSnapshot.primary?.sessionId ?? null,
                },
                knownIdentities: collectKnownInteractionIdentities(currentSnapshot),
                directActionsEnabled: false,
                surfaceName: 'desktop_overlay',
            });
            let command = sharedCommand;
            const directActionCommand = buildVerifiedDesktopDirectActionCommand({
                actionIdentifier,
                payload,
                snapshot: currentSnapshot,
            });
            if (directActionCommand) {
                command = directActionCommand;
            } else if (DESKTOP_OVERLAY_DIRECT_ACTION_IDS.has(actionIdentifier)) {
                const requestId = readRequestIdFromInteraction(payload);
                const serverUrl = readServerUrlFromInteraction(payload);
                emitDirectActionInteractionResult(requestId, {
                    ok: false,
                    errorCode: 'unsafe_server_scope',
                    error: 'unsafe_server_scope',
                });
                const fallbackSessionId = readSessionIdFromInteraction(payload) ?? currentSnapshot.primary?.sessionId ?? '';
                command = {
                    kind: 'openSession',
                    sessionId: fallbackSessionId,
                    serverId: resolveKnownServerIdForSession(currentSnapshot, fallbackSessionId),
                    serverUrl,
                    route: resolveDirectActionFallbackRoute(payload, currentSnapshot, currentSnapshot.primary?.sessionId ?? null),
                    identity: null,
                    fallbackReason: 'unsafe_target',
                };
            }
            if (command.kind === 'executeAction') {
                const requestId = readRequestIdFromInteraction(payload);
                fireAndForget((async () => {
                    try {
                        const serverId = resolveActionContextServerId(command.identity?.serverId ?? command.target.serverId);
                        const result = await actionExecutor.execute(command.actionId, command.payload, {
                            surface: 'ui',
                            defaultSessionId: command.defaultSessionId,
                            ...(serverId ? { serverId } : {}),
                        });
                        emitDirectActionInteractionResult(requestId, result);
                    } catch (error) {
                        emitDirectActionInteractionError(requestId, error);
                    }
                })(), {
                    tag: 'DesktopActivityOverlayRuntime.executeInteractionAction',
                });
                return;
            }
            if (command.kind === 'ignore') {
                return;
            }
            if (!isRouteCommand(command)) {
                return;
            }

            fireAndForget(showDesktopMainWindow(), {
                tag: 'DesktopActivityOverlayRuntime.showMainWindow.beforeRoute',
            });
            router.push(command.route);
            setIsExpanded(false);
            setInputLocked(false);
            setSurfaceEngaged(false);
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
    }, [actionExecutor, isDesktop, isOverlayWindow]);

    return null;
}

export default DesktopActivityOverlayRuntimeShared;
