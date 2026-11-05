import { buildSharedActivityProjection } from '@/activity/delivery/sharedActivityProjection';
import { createDesktopActivityOverlayActionHandler } from './desktopActivityOverlayActions';
import { DesktopActivityOverlayMcpPermission } from './DesktopActivityOverlayMcpPermission';
import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useConnectedServiceQuotaSummaries, type ConnectedServiceQuotaSummary } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries';
import { areSessionAddressesEqual, sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { router } from 'expo-router';
import { admitInternalRouteHref } from '@/utils/path/routeUtils';

import { createActivitySurfaceSessionRoute } from '@/activity/actions/activitySurfaceTargets';
import {
    resolveActivityInteractionCommand,
    type ActivityInteractionCommand,
    type ActivityInteractionIdentity,
    type ActivityInteractionTargetContext,
} from '@/activity/actions/resolveActivityInteractionCommand';
import { resolveActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import type { SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';
import {
    resolveActivitySurfaceDeliveryAdmission,
} from '@/activity/delivery/resolveActivitySurfaceDeliveryAdmission';
import { resolveStricterActivitySurfacePrivacyMode } from '@/activity/delivery/resolveActivityAttentionDeliveryPlan';
import { useExactHomeAccountSettings } from '@/activity/delivery/useExactHomeAccountSettings';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import { buildDesktopActivityOverlayModel } from '@/activity/adapters/desktop/presentation/buildDesktopActivityOverlayModel';
import {
    buildDesktopActivityOverlaySnapshot,
    type DesktopActivityOverlaySnapshot,
} from '@/activity/adapters/desktop/presentation/buildDesktopActivityOverlaySnapshot';
import {
    buildActivityOverviewFromCandidates,
} from '@/activity/attention/buildActivityOverviewSnapshot';
import { isUnsafeNotificationServerUrl } from '@/activity/notifications/notificationRouting';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { resolveServerIdForSessionIdFromLocalState } from '@/sync/domains/session/resolveSessionAddressFromLocalState';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { storage, useLocalSetting } from '@/sync/domains/state/storage';
import { isDesktopHost, useDesktopHostRoleAvailability } from '@/utils/platform/desktopHost';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { registerMountedDesktopOverlayPresentation } from '@/components/appShell/workspace/desktopOverlayPresentationRuntime';

import {
    emitDesktopActivityOverlayInteractionResult,
    showDesktopMainWindow,
    syncDesktopActivityOverlay,
    type DesktopActivityOverlaySyncPayload,
} from './desktopActivityOverlayBridge';
import { isCaptureWindowLabel, listenDesktopWindowAction } from '@/utils/platform/desktopWindowActionBridge';
import { dispatchDesktopCaptureWindowAction } from '@/utils/platform/desktopWindowActionDispatch';
import { reconcileDesktopActivityOverlayState } from './useDesktopActivityOverlayState';
import { isDesktopActivityOverlayWindowContext } from './isDesktopActivityOverlayWindowContext';
import { resolveDesktopOverlayPolicy } from './resolveDesktopOverlayPolicy';
import { buildDesktopActivityOverlayOverviewFromSource } from '../presentation/snapshot/buildDesktopActivityOverlayOverviewFromSource';
import { useDesktopActivityOverlaySource } from './useDesktopActivityOverlaySource';
import { useBotsHomeServerIds, useOrderedBots } from '@/components/sessions/bots/botsSummary';
import { useMachineDisplaysByServerId, useSessionOrganizationProjections } from '@/sync/store/hooks';
import { buildNotchBotFaces } from '../presentation/buildNotchBotFaces';
import type { NotchBotFaces, PinnedDesktopOverlayConversation } from '../presentation/notchBotTypes';
import { usePinnedDesktopOverlayConversation } from './usePinnedDesktopOverlayConversation';
import { registerDesktopActivityOverlayQaFixtureProducer } from './desktopActivityOverlayQaFixtureSelection';
import type { DesktopActivityOverlayQaModel } from './desktopActivityOverlayQaFixtures.mjs';

type InteractionPayload = Readonly<{
    requestId?: string;
    actionIdentifier: string;
    data?: Record<string, unknown>;
}>;

const DESKTOP_OVERLAY_DIRECT_ACTION_IDS = new Set([
    'session.open',
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
        result?: unknown;
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
        // The Action's typed output (e.g. `session.open`'s window outcome), so the island acts on what happened.
        ...(ok ? (result.result === undefined ? {} : { result: result.result }) : {
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
    for (const face of snapshot.bots.faces) {
        addKnownServerIdForSession(serverIds, sessionId, face.sessionId, face.serverId);
    }
    if (snapshot.conversation) addKnownServerIdForSession(serverIds, sessionId, snapshot.conversation.sessionId, snapshot.conversation.serverId);
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

function resolveActionContextServerId(serverId: string | null | undefined): string | null {
    const normalized = typeof serverId === 'string' ? serverId.trim() : '';
    return normalized || null;
}

function collectKnownInteractionIdentities(
    snapshot: DesktopActivityOverlaySnapshot,
): readonly ActivityInteractionIdentity[] {
    const identities: ActivityInteractionIdentity[] = [];
    for (const face of snapshot.bots.faces) addKnownInteractionIdentity(identities, face.sessionId, face.serverId);
    if (snapshot.conversation) addKnownInteractionIdentity(identities, snapshot.conversation.sessionId, snapshot.conversation.serverId);
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

function isRouteCommand(command: ActivityInteractionCommand): command is Extract<
    ActivityInteractionCommand,
    { kind: 'openSession' | 'openInbox' | 'focusComposer' | 'openSettings' }
> {
    return command.kind === 'openSession'
        || command.kind === 'openInbox'
        || command.kind === 'focusComposer'
        || command.kind === 'openSettings';
}

// This producer reads only the preferences used by its desktop policy and delivery admission.
// Other device preferences must not rebuild activity or publish native content.
const DESKTOP_OVERLAY_SETTING_KEYS = [
    'activitySurfacesEnabled', 'activitySurfaceTapTarget', 'activitySurfacePrivacyMode',
    'attentionDeviceOverridesV1', 'desktopOverlayEnabled', 'desktopOverlayVisibilityMode',
    'desktopOverlayAlwaysOnTop', 'desktopOverlayDisplayMode',
    'desktopOverlayDock', 'desktopOverlayIdle', 'desktopBotConversationPresentation',
] as const;

type ProducerContext = Readonly<{
    snapshot: DesktopActivityOverlaySnapshot;
    source: ReturnType<typeof useDesktopActivityOverlaySource>;
    admittedCandidates: readonly SessionActivityAttention[];
}>;

type ProducerProps = Readonly<{
    detailAddresses: readonly SessionAddress[] | null;
    contextRef: React.MutableRefObject<ProducerContext | null>;
    publishedRef: React.MutableRefObject<DesktopActivityOverlaySyncPayload | null>;
    pinnedTarget: SessionAddress | null;
    setPinnedTarget: React.Dispatch<React.SetStateAction<SessionAddress | null>>;
}>;

function DesktopActivityOverlayPinnedConversation({ target, hidden, reachable, onChange }: Readonly<{
    target: Pick<PinnedDesktopOverlayConversation, 'serverId' | 'accountId' | 'sessionId'>;
    hidden: boolean;
    reachable: boolean;
    onChange: (conversation: PinnedDesktopOverlayConversation) => void;
}>): null {
    const conversation = usePinnedDesktopOverlayConversation({ target, hidden, reachable });
    React.useEffect(() => { onChange(conversation); }, [conversation, onChange]);
    return null;
}

function DesktopActivityOverlayQuotaDemand({ onChange }: Readonly<{
    onChange: (summaries: readonly ConnectedServiceQuotaSummary[]) => void;
}>): null {
    const { summaries } = useConnectedServiceQuotaSummaries();
    React.useEffect(() => { onChange(summaries); }, [onChange, summaries]);
    return null;
}

function DesktopActivityOverlayProducer({ detailAddresses, contextRef, publishedRef, pinnedTarget, setPinnedTarget }: ProducerProps): React.ReactElement | null {
    const [qaModel, setQaModel] = React.useState<DesktopActivityOverlayQaModel | null>(null);
    React.useEffect(() => {
        if (__DEV__) return registerDesktopActivityOverlayQaFixtureProducer(setQaModel);
    }, []);
    const [pinnedConversation, setPinnedConversation] = React.useState<PinnedDesktopOverlayConversation | null>(null);
    const orderedBots = useOrderedBots();
    const botHomeIds = useBotsHomeServerIds();
    const organizations = useSessionOrganizationProjections(botHomeIds);
    const machineDisplaysByServerId = useMachineDisplaysByServerId(botHomeIds);
    const previousFaces = React.useRef<NotchBotFaces | undefined>(undefined);
    const detailDemanded = detailAddresses !== null;
    const [quotaSummaries, setQuotaSummaries] = React.useState<readonly ConnectedServiceQuotaSummary[]>([]);
    const source = useDesktopActivityOverlaySource({ detailDemanded, detailAddresses: detailAddresses ?? undefined, quotaSummaries });
    const isSessionVisible = useSessionRecordingVisibility();
    const resolveAccountSettings = useExactHomeAccountSettings(source.audienceScopes);
    const localSettings = storage(useShallow(state => Object.fromEntries(
        DESKTOP_OVERLAY_SETTING_KEYS.map(key => [key, (state.localSettings as Readonly<Record<string, unknown>>)[key]]),
    )), { localSettings: DESKTOP_OVERLAY_SETTING_KEYS });
    const previousPrimaryRef = React.useRef<{
        serverId: string | null;
        sessionId: string | null;
        changedAtMs: number | null;
    }>({
        serverId: null,
        sessionId: null,
        changedAtMs: null,
    });
    const desktopPolicy = React.useMemo(
        () => resolveDesktopOverlayPolicy((localSettings ?? {}) as Record<string, unknown>),
        [localSettings],
    );
    const activityPolicy = React.useMemo(
        () => resolveActivitySurfacePolicy((localSettings ?? {}) as Record<string, unknown>),
        [localSettings],
    );
    const unfilteredOverview = React.useMemo(
        () => buildDesktopActivityOverlayOverviewFromSource({
            source,
            nowMs: Date.now(),
        }),
        [source],
    );
    // The overlay is an Account-policy delivery channel like any other: each exact
    // Home decides whether its Sessions appear here and how much they may say. The
    // device visibility preference below remains an additional device-global gate.
    const deliveryAdmission = React.useMemo(() => resolveActivitySurfaceDeliveryAdmission({
        candidates: unfilteredOverview.candidates,
        surface: 'desktop_overlay',
        resolveAccountSettings,
        accountDeliveryMutesByServerId: source.accountDeliveryMutesByServerId,
        audienceScopes: source.audienceScopes,
        localSettings: (localSettings ?? {}) as Record<string, unknown>,
        now: new Date(),
    }), [localSettings, resolveAccountSettings, source.accountDeliveryMutesByServerId, source.audienceScopes, unfilteredOverview]);
    // Explicit conversation detail keeps its admission; ambient identities never reach the native projection.
    const ambientAdmission = React.useMemo(() => ({
        ...deliveryAdmission,
        candidates: deliveryAdmission.candidates.filter(candidate => isSessionVisible(candidate.address ?? candidate)),
    }), [deliveryAdmission, isSessionVisible]);
    const sourceOverview = React.useMemo(
        () => buildActivityOverviewFromCandidates(ambientAdmission.candidates),
        [ambientAdmission],
    );
    // The device-global overlay privacy preference and the exact Home's plan are two
    // gates; the overlay shows only what both allow.
    const resolveCandidatePrivacyMode = React.useCallback(
        (candidate: SessionActivityAttention) => {
            const homePrivacyMode = deliveryAdmission.privacyModeFor(candidate);
            return homePrivacyMode
                ? resolveStricterActivitySurfacePrivacyMode(homePrivacyMode, activityPolicy.privacyMode)
                : null;
        },
        [activityPolicy.privacyMode, deliveryAdmission],
    );
    const pinnedCandidate = pinnedTarget ? deliveryAdmission.candidates.find(candidate =>
        areSessionAddressesEqual(candidate.address, pinnedTarget)) : null;
    // Admission already used this exact Home/Account scope; carry it to M6 unchanged.
    const pinnedScope = pinnedCandidate?.address ? source.audienceScopes?.get(pinnedCandidate.address.serverId) : undefined;
    const pinnedHidden = pinnedCandidate ? resolveCandidatePrivacyMode(pinnedCandidate) === 'status_only' : false;
    // A child effect may still hold the previous slice during a retarget/privacy change.
    // Consume the already-decided privacy mode before any content crosses the bridge.
    const conversation = React.useMemo(() => pinnedCandidate && pinnedScope && pinnedConversation?.accountId === pinnedScope.accountId
        && areSessionAddressesEqual(pinnedConversation, pinnedCandidate.address)
        ? pinnedHidden && pinnedConversation ? { ...pinnedConversation, reply: { state: 'hidden' as const, text: null } }
            : pinnedConversation
        : null, [pinnedCandidate, pinnedScope, pinnedConversation, pinnedHidden]);
    React.useEffect(() => {
        if (pinnedTarget && !pinnedCandidate) setPinnedTarget(null);
    }, [pinnedCandidate, pinnedTarget, setPinnedTarget]);
    const bots = React.useMemo(() => buildNotchBotFaces({
        orderedBots, admission: ambientAdmission,
        railPinnedByServerId: Object.fromEntries(botHomeIds.map(serverId =>
            [serverId, organizations[serverId]?.railPinnedSessionIds ?? []])),
        mode: desktopPolicy.visibilityMode, activityPolicy, resolveCandidatePrivacyMode,
    }, previousFaces.current), [orderedBots, ambientAdmission, botHomeIds, organizations, desktopPolicy.visibilityMode, activityPolicy, resolveCandidatePrivacyMode]);
    previousFaces.current = bots;
    const sharedActivity = React.useMemo(() => buildSharedActivityProjection({
        admission: ambientAdmission, policy: activityPolicy, selectedFaces: bots.faces,
    }), [ambientAdmission, activityPolicy, bots]);
    const snapshot = React.useMemo(
        () => buildDesktopActivityOverlaySnapshot({
            source,
            sourceOverview,
            activityPolicy,
            desktopPolicy,
            resolveCandidatePrivacyMode,
            bots,
            conversation,
            machineDisplaysByServerId,
            previousPrimaryAddress: previousPrimaryRef.current.serverId && previousPrimaryRef.current.sessionId
                ? {
                    serverId: previousPrimaryRef.current.serverId,
                    sessionId: previousPrimaryRef.current.sessionId,
                }
                : null,
            previousPrimaryChangedAtMs: previousPrimaryRef.current.changedAtMs,
        }),
        [activityPolicy, desktopPolicy, resolveCandidatePrivacyMode, source, sourceOverview, bots, conversation, machineDisplaysByServerId],
    );
    const snapshotPrimarySessionId = snapshot.primary?.sessionId ?? null;
    const snapshotPrimaryServerId = snapshot.primary?.serverId ?? null;
    if (
        snapshotPrimarySessionId !== previousPrimaryRef.current.sessionId
        || snapshotPrimaryServerId !== previousPrimaryRef.current.serverId
    ) {
        previousPrimaryRef.current = {
            serverId: snapshotPrimaryServerId,
            sessionId: snapshotPrimarySessionId,
            changedAtMs: snapshotPrimarySessionId ? snapshot.generatedAt : null,
        };
    }
    contextRef.current = { snapshot, source, admittedCandidates: deliveryAdmission.candidates };
    const model = React.useMemo(
        () => qaModel ? { ...qaModel, generatedAt: snapshot.generatedAt } : buildDesktopActivityOverlayModel({
            snapshot,
            sharedActivity,
            policy: desktopPolicy,
        }),
        [desktopPolicy, snapshot, sharedActivity, qaModel],
    );

    React.useEffect(() => {
        const previous = publishedRef.current;
        const payload = reconcileDesktopActivityOverlayState(previous, {
            visible: model.visible,
            model,
            policy: desktopPolicy,
        });
        if (previous === payload) return;
        publishedRef.current = payload;
        fireAndForget(syncDesktopActivityOverlay(payload), {
            tag: 'DesktopActivityOverlayRuntime.syncDesktopActivityOverlay',
        });
    }, [desktopPolicy, model, publishedRef]);
    React.useEffect(() => () => {
        const previous = publishedRef.current;
        publishedRef.current = null;
        if (!previous) return;
        // The producer owns its final publication before subscriptions are released.
        fireAndForget(syncDesktopActivityOverlay({
            visible: false,
            model: { ...previous.model, visible: false },
            policy: { ...previous.policy, enabled: false },
        }), { tag: 'DesktopActivityOverlayRuntime.suspend' });
    }, [publishedRef]);
    return <>
        {snapshot.permissionRequests.flatMap(request => {
            const choice = request.permissionChoices?.find(choice => choice.catalog);
            const scope = request.serverId ? source.audienceScopes?.get(request.serverId) : undefined;
            return choice?.catalog && scope ? [<DesktopActivityOverlayMcpPermission key={request.activityInstanceId}
                sessionId={request.sessionId} requestId={request.requestId} turnId={request.turnId} scope={scope}
                choice={{ ...choice, catalog: choice.catalog }} />] : [];
        })}
        {pinnedCandidate?.address && pinnedScope ? <DesktopActivityOverlayPinnedConversation key={JSON.stringify([pinnedScope.accountId, sessionAddressKey(pinnedCandidate.address)])}
            target={{ ...pinnedCandidate.address, accountId: pinnedScope.accountId }} hidden={pinnedHidden} reachable={pinnedCandidate.awareness.runtime !== 'offline'}
            onChange={setPinnedConversation} /> : null}
        {detailDemanded ? <DesktopActivityOverlayQuotaDemand onChange={setQuotaSummaries} /> : null}
    </>;
}

export function DesktopActivityOverlayRuntimeShared(): React.ReactElement | null {
    const availability = useDesktopHostRoleAvailability('activity');
    const enabled = useLocalSetting('desktopOverlayEnabled');
    const isDesktop = isDesktopHost();
    const isOverlayWindow = isDesktopActivityOverlayWindowContext();
    const [detailAddresses, setDetailAddresses] = React.useState<readonly SessionAddress[] | null>(null);
    const [pinnedTarget, setPinnedTarget] = React.useState<SessionAddress | null>(null);
    const contextRef = React.useRef<ProducerContext | null>(null);
    const publishedRef = React.useRef<DesktopActivityOverlaySyncPayload | null>(null);
    const actionExecutor = React.useMemo(() => createDefaultActionExecutor(), []);
    const producing = availability?.kind === 'available' && enabled && !isOverlayWindow;

    React.useEffect(() => {
        if (producing) return;
        contextRef.current = null;
        setDetailAddresses(null);
        setPinnedTarget(null);
    }, [producing]);

    React.useEffect(() => {
        if (!producing) return;
        return registerMountedDesktopOverlayPresentation(async target => {
            const candidate = contextRef.current?.admittedCandidates.find(value => areSessionAddressesEqual(value.address, target));
            if (!candidate) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
            setDetailAddresses(null);
            setPinnedTarget(previous => areSessionAddressesEqual(previous, target) ? previous : target);
            let applied = false;
            try {
                const result = await actionExecutor.execute('desktop.notch.set', { state: 'pinned' }, { surface: 'ui', serverId: target.serverId });
                applied = result.ok;
                return result.ok ? { ok: true } : result;
            } finally {
                if (!applied) setPinnedTarget(current => areSessionAddressesEqual(current, target) ? null : current);
            }
        });
    }, [actionExecutor, producing]);

    React.useEffect(() => {
        if (!isDesktop || isOverlayWindow) {
            return () => {};
        }

        let disposed = false;
        let unlisten: (() => void) | null = null;
        const overlayActions = createDesktopActivityOverlayActionHandler(actionExecutor);
        void listenDesktopWindowAction((payload) => {
            if (disposed) {
                return;
            }

            if (isCaptureWindowLabel(payload.windowLabel)) {
                const executor = createDefaultActionExecutor({
                    screenCaptureWindowPress: true,
                    // The Capture UI sends this only after its existing Undo outcome.
                    screenCaptureDiscard: async captureRef => {
                        await (await import('@/desktop/capture/nativeCapture')).discardCapture(captureRef);
                    },
                    ...(payload.intent === 'retry' ? { screenCaptureSendDraftOnly: true } : {}),
                });
                fireAndForget(dispatchDesktopCaptureWindowAction(payload, executor), {
                    tag: 'DesktopWindowAction.capture',
                });
                return;
            }
            if (payload.windowLabel !== 'activity_overlay') return;

            if (overlayActions.handle(payload)) return;

            const actionIdentifier = payload.actionIdentifier.trim();
            if (actionIdentifier === 'overlay-set-expanded') {
                if (payload.data?.target === null) setPinnedTarget(null);
                const expanded = readExpandedFromInteraction(payload);
                if (expanded == null) return;
                if (expanded) {
                    const current = contextRef.current;
                    if (!current) return;
                    const serverId = readServerIdFromInteraction(payload);
                    const sessionId = readSessionIdFromInteraction(payload);
                    setDetailAddresses(serverId && sessionId ? [{ serverId, sessionId }]
                        : current.snapshot.sessions.flatMap(session => session.serverId
                            ? [{ serverId: session.serverId, sessionId: session.sessionId }] : []));
                } else {
                    setDetailAddresses(null);
                }
                return;
            }
            if (actionIdentifier === 'overlay-input-locked' || actionIdentifier === 'overlay-surface-engaged') return;
            const context = contextRef.current;
            if (!context) return;
            const currentSnapshot = context.snapshot;
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
                const currentSource = context.source;
                const fallbackServerId = resolveServerIdForSessionIdFromLocalState({
                    sessions: currentSource.sessionsById,
                    sessionListRowsByServerId: currentSource.sessionListRowsByServerId,
                    ordinarySessionListMembershipByServerId: currentSource.ordinarySessionListMembershipByServerId,
                    sessionListIndexByServerId: currentSource.sessionListIndexByServerId,
                }, fallbackSessionId);
                command = fallbackSessionId && fallbackServerId
                    ? {
                        kind: 'openSession',
                        sessionId: fallbackSessionId,
                        serverId: fallbackServerId,
                        serverUrl,
                        route: createActivitySurfaceSessionRoute(
                            fallbackSessionId,
                            fallbackServerId,
                        ),
                        identity: null,
                        fallbackReason: 'unsafe_target',
                    }
                    : sharedCommand;
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

            fireAndForget((async () => {
                const requestId = command.kind === 'openSession' ? readRequestIdFromInteraction(payload) : null;
                try {
                    await showDesktopMainWindow();
                    router.push(admitInternalRouteHref(command.route));
                    setDetailAddresses(null);
                    emitDirectActionInteractionResult(requestId, { ok: true });
                } catch (error) {
                    emitDirectActionInteractionError(requestId, error);
                }
            })(), {
                tag: 'DesktopActivityOverlayRuntime.showMainWindow.beforeRoute',
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
            overlayActions.dispose();
            unlisten?.();
        };
    }, [actionExecutor, isDesktop, isOverlayWindow]);

    return producing ? <DesktopActivityOverlayProducer detailAddresses={detailAddresses}
        contextRef={contextRef} publishedRef={publishedRef} pinnedTarget={pinnedTarget} setPinnedTarget={setPinnedTarget} /> : null;
}

export default DesktopActivityOverlayRuntimeShared;
