import { usePresentedAgentRequestSettlement } from './usePresentedAgentRequestSettlement';
import { useActivityAttentionSummarySource } from '@/activity/source/useActivityAttentionSource';
import * as React from 'react';

import { Platform } from 'react-native';

import { isPushNotificationBundledSoundId, resolveExpoNotificationSoundName, resolvePushNotificationAndroidChannelId } from '@happier-dev/protocol/push/pushNotificationActions';
import { isSessionAwarenessContentReadableV1 } from '@happier-dev/protocol/sessions/awareness/availability';
import { resolveActivityRequestEventIdentityV1, resolveActivitySequenceEventIdentityV1, resolveActivityTranscriptLocalIdEventIdentityV1, resolveActivityTurnEventIdentityV1 } from '@happier-dev/protocol/activity/eventIdentity';
import { resolveSessionPersonalEventEligibilityV1 } from '@happier-dev/protocol/sessions/personal/eventEligibility';
import { resolveEffectiveAccountFollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { resolveActivityAttentionDeliveryPlan } from '@/activity/delivery/resolveActivityAttentionDeliveryPlan';
import { useExactHomeAccountSettings } from '@/activity/delivery/useExactHomeAccountSettings';
import { readSessionRecordingVisibility } from '@/sync/store/sessionRecordingVisibility';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import { readAccountSessionDeliveryMutedScopes } from '@/sync/api/session/sessionFollowApi';
import { isFollowDeliveryMutedV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import type { ActivityAttentionDeliveryEventKind } from '@/activity/delivery/activityAttentionDeliveryPlanTypes';
import { localSettingsParse, type LocalSettings } from '@/sync/domains/settings/localSettings';
import { isHostWindowFocused } from '@/utils/runtime/readHostWindowFocus';
import { getFocusedDesktopAppWindowSurface } from '@/desktop/window/appWindowSurface';
import { storage, useLocalSetting } from '@/sync/domains/state/storage';
import { isSessionSurfaceVisible } from '@/sync/domains/session/sessionSurfaceVisibility';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { useDestinationRouter } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useOptionalAuth } from '@/auth/context/AuthContext';
import { navigateToSession } from '@/hooks/session/useNavigateToSession';
import {
    areServerProfileIdentifiersEquivalent,
    getActiveServerSnapshot,
    getServerProfileById,
} from '@/sync/domains/server/serverProfiles';
import { isSessionPersonallyTrackedForViewer } from '@/sync/domains/session/readState/sessionViewer';
import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import { deriveTranscriptInteractionFromSession } from '@/utils/sessions/deriveTranscriptInteraction';
import { findSessionListLookupSession } from '@/sync/domains/session/listing/sessionListLookupState';
import { buildSessionFromListRenderable } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { isDesktopHost, desktopHostKind } from '@/utils/platform/desktopHost';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { randomUUID } from '@/platform/randomUUID';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import {
    buildSessionContextFacts,
    projectSessionContextPresentation,
} from '@/sync/domains/session/presentation/sessionContextPresentation';

import { syncSessionChangedBackgroundWakeTaskRegistration } from '../backgroundWake/defineSessionChangedBackgroundWakeTask';
import {
    consumeOtherLegActivityAlertPresentation,
    noteActivityAlertPresented,
} from '../remoteAlerts/activityAlertPresentationNotes';
import { buildActivityLocalNotificationContent } from '../buildActivityLocalNotificationContent';
import { sendExpoLocalNotification } from '../channels/sendExpoLocalNotification';
import { sendTauriLocalNotification } from '../channels/sendTauriLocalNotification';
import {
    isWebLocalNotificationPermissionGranted,
    sendWebLocalNotification,
    subscribeWebLocalNotificationPermission,
} from '../channels/sendWebLocalNotification';
import { parseNotificationTap } from '../notificationRouting';
import { navigateWithNotificationAccount } from './navigateWithNotificationAccount';
import { GuardStopWarningDesktopBanners } from './GuardStopWarningDesktopBanners';
import { ManagedMachineDeletionNotificationRuntime } from './ManagedMachineDeletionNotificationRuntime';
import { observeGuardStopWarningNotifications } from '../guardStopWarningLifecycle';
import { loadExpoNotifications } from '@/utils/platform/loadExpoNotifications';
import { desktopGuardNotificationTransport } from '../channels/tauriNotificationPlugin';
import { AppState } from 'react-native';
import { isActivityLocalNotificationMutedForWake, subscribeActivityLocalNotifications, type ActivityLocalNotificationEvent } from './activityLocalNotificationBus';
import { isSessionFollowStalledOccurrenceCurrentV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceOccurrenceV1';
import { resolveActivityStalledEventIdentityV1 } from '@happier-dev/protocol/activity/eventIdentity';

function resolveLocalNotificationEventKind(event: ActivityLocalNotificationEvent): ActivityAttentionDeliveryEventKind {
    if (event.kind === 'ready') return 'ready';
    if (event.kind === 'session-update') return 'follow_update';
    return event.requestKind === 'permission' ? 'permission_request' : 'user_action_request';
}

function resolveLocalNotificationEventIdentity(event: ActivityLocalNotificationEvent): string | undefined {
    if (event.kind === 'session-update' && event.event === 'source_unavailable' && event.stalledOccurrence)
        return resolveActivityStalledEventIdentityV1(event.stalledOccurrence);
    if (event.kind === 'agent-request') return resolveActivityRequestEventIdentityV1(event.requestId, event.turnId);
    if (event.kind === 'session-update' && 'turnId' in event) return resolveActivityTurnEventIdentityV1(event.turnId);
    return 'committedSequence' in event && event.committedSequence
        ? resolveActivitySequenceEventIdentityV1(event.committedSequence)
        : event.kind === 'ready' && event.committedLocalId
            ? resolveActivityTranscriptLocalIdEventIdentityV1(event.committedLocalId)
            : undefined;
}

function resolveExpoLocalNotificationSound(
    event: ActivityLocalNotificationEvent,
    deliveryPlan: ReturnType<typeof resolveActivityAttentionDeliveryPlan>,
): Readonly<{ sound: string | null; channelId?: string }> {
    const kind = resolveLocalNotificationEventKind(event);
    const androidKind = kind === 'permission_request'
        ? 'permission'
        : kind === 'user_action_request'
            ? 'user_action'
            : 'ready';

    if (deliveryPlan.delivery === 'silent' || deliveryPlan.sound.kind === 'none') {
        return {
            sound: null,
            channelId: Platform.OS === 'android'
                ? resolvePushNotificationAndroidChannelId({ kind: androidKind, soundId: 'none' })
                : undefined,
        };
    }
    if (deliveryPlan.sound.kind === 'system_default') {
        return { sound: 'default' };
    }

    const soundId = deliveryPlan.sound.id ?? 'default';
    const sound = resolveExpoNotificationSoundName(soundId) ?? null;
    return {
        sound,
        channelId:
            Platform.OS === 'android' && isPushNotificationBundledSoundId(soundId)
                ? resolvePushNotificationAndroidChannelId({ kind: androidKind, soundId })
                : undefined,
    };
}

function isSessionActivelyViewedForLocalNotification(event: ActivityLocalNotificationEvent, accountId: string): boolean {
    if (isDesktopHost()) {
        const focused = getFocusedDesktopAppWindowSurface();
        if (focused) return focused.sessionId === event.address.sessionId && focused.accountId === accountId
            && areServerProfileIdentifiersEquivalent(focused.homeId, event.address.serverId);
    }
    if (!isSessionSurfaceVisible(event.address.sessionId, event.address.serverId)) {
        return false;
    }

    // A browser tab or desktop window can keep a Session open while the person works elsewhere.
    return Platform.OS !== 'web' || isHostWindowFocused();
}

/**
 * Document hosts (browser tabs and desktop windows) have no Expo foreground handler, so they
 * apply the in-app choice when the event is admitted. Native applies it from that handler.
 */
function resolveDocumentHostForegroundState(): 'foreground' | 'background' | undefined {
    if (Platform.OS !== 'web') return undefined;
    return isHostWindowFocused() ? 'foreground' : 'background';
}

/**
 * Every open tab receives the same event, and the browser replaces a notification with the same
 * tag, so tagging by the event's canonical identity shows one notification per event.
 */
function resolveWebNotificationTag(event: ActivityLocalNotificationEvent, identity: string | undefined, accountId: string): string | undefined {
    return identity ? `happier:${JSON.stringify([sessionAddressKey(event.address), accountId, event.event, identity])}` : undefined;
}

function useActivityLocalNotificationLocalSettings(): Partial<LocalSettings> {
    const attentionDeviceOverridesV1 = useLocalSetting('attentionDeviceOverridesV1');

    return React.useMemo(
        () => localSettingsParse({ attentionDeviceOverridesV1 }),
        [attentionDeviceOverridesV1],
    );
}

export function ActivityLocalNotificationRuntime(): React.ReactElement | null {
    // A browser has an OS delivery channel only once it grants notification permission.
    const webPermissionGranted = React.useSyncExternalStore(
        subscribeWebLocalNotificationPermission,
        isWebLocalNotificationPermissionGranted,
        () => false,
    );
    if (Platform.OS === 'web' && !isDesktopHost() && !webPermissionGranted) return null;
    return <SupportedActivityLocalNotificationRuntime />;
}

function SupportedActivityLocalNotificationRuntime(): React.ReactElement | null {
    // Own native capture observation while this presentation consumer is mounted.
    useSessionRecordingVisibility();
    const reconcilePresentedRequests = usePresentedAgentRequestSettlement();
    const localSettings = useActivityLocalNotificationLocalSettings();
    // Always mounted: it reads audiences and Home currentness, never transcripts (an alert reads its one
    // committed message from the store when it fires), so a streamed reply does not render it.
    const audienceSource = useActivityAttentionSummarySource();
    const reminderServerIds = React.useMemo(() => [...audienceSource.audienceScopes.keys()], [audienceSource.audienceScopes]);
    const resolveAccountSettings = useExactHomeAccountSettings(audienceSource.audienceScopes);
    // A clicked browser notification opens its Session through the shared Home switch.
    const router = useDestinationRouter();
    const refreshFromActiveServer = useOptionalAuth()?.refreshFromActiveServer;
    const openSessionRef = React.useRef((_data: unknown) => {});
    openSessionRef.current = (data) => {
        const parsed = parseNotificationTap({
            response: { actionIdentifier: 'default', notification: { request: { content: { data } } } },
            defaultActionIdentifier: 'default',
        });
        if (parsed?.command.kind !== 'openSession' || !parsed.accountId) return;
        const command = parsed.command;
        fireAndForget(navigateWithNotificationAccount({
            target: { serverId: command.serverId, serverUrl: command.serverUrl,
                route: command.route, accountId: parsed.accountId },
            refreshAuth: refreshFromActiveServer ?? null,
            // Browser notifications remain clickable after their delivering effect retires.
            isDisposed: () => false,
            navigate: () => {
                fireAndForget(navigateToSession(command.sessionId, { serverId: command.serverId ?? undefined },
                    { router, refreshFromActiveServer: refreshFromActiveServer ?? (async () => {}) }),
                { tag: 'ActivityLocalNotificationRuntime.openSession' });
            },
        }), { tag: 'ActivityLocalNotificationRuntime.admitSession' });
    };
    React.useEffect(() => {
        const nativeDesktop = isDesktopHost() && desktopHostKind() === 'tauri';
        if (Platform.OS === 'web' && !nativeDesktop) return;
        let disposed = false;
        let cleanup: (() => void) | undefined;
        fireAndForget((nativeDesktop ? Promise.resolve(desktopGuardNotificationTransport) : loadExpoNotifications()).then(notifications => {
            if (disposed) return;
            const watcher = observeGuardStopWarningNotifications(notifications, error => {
                fireAndForget(Promise.reject(error), { tag: 'ActivityLocalNotificationRuntime.guardReconcile' });
            });
            const subscription = AppState.addEventListener('change', state => { if (state === 'active') watcher.refresh(); });
            cleanup = () => { subscription.remove(); watcher.dispose(); };
        }), { tag: 'ActivityLocalNotificationRuntime.guardReconcile' });
        return () => { disposed = true; cleanup?.(); };
    }, []);

    // The closed-app `session_changed` wake exists for exactly this runtime: it
    // hydrates the woken Home so the Activity event below can be presented
    // while the app is in the background. Reconciling its task registration
    // here keeps the consumer and its transport together, and the task owner —
    // not this mount — decides which platforms can run it without touching
    // native task APIs on unsupported platforms.
    React.useEffect(() => {
        void syncSessionChangedBackgroundWakeTaskRegistration();
    }, []);

    React.useEffect(() => {
        const controller = new AbortController();
        const notify = async (event: ActivityLocalNotificationEvent) => {
            // Capture the reconciliation decision while its owning scope is
            // active, before the asynchronous Account mute read can outlive it.
            if (event.kind === 'ready' && event.source === 'reconciliation'
                && isActivityLocalNotificationMutedForWake(event.address)) return;
            const scope = audienceSource.audienceScopes?.get(event.address.serverId);
            if (!scope) return;
            const scopes = await readAccountSessionDeliveryMutedScopes(scope, controller.signal);
            if (controller.signal.aborted || scopes === null || isFollowDeliveryMutedV1(scopes, {
                senderSessionId: event.address.sessionId, source: { kind: 'session', sessionId: event.address.sessionId },
            })) return;
            if (!readSessionRecordingVisibility()(event.address)) return;
            const state = storage.getState();
            const directSession = state.sessions[event.address.sessionId];
            const directServerId = typeof directSession?.serverId === 'string' ? directSession.serverId.trim() : '';
            const directScopedSession = directServerId
                && areServerProfileIdentifiersEquivalent(directServerId, event.address.serverId)
                ? directSession
                : null;
            const scopedRow = findSessionListLookupSession(state, event.address, { activeServerId: getActiveServerSnapshot().serverId });
            const session = directScopedSession ?? (scopedRow
                ? buildSessionFromListRenderable(scopedRow.session, { serverId: event.address.serverId })
                : null);
            if (!session) return;
            const stalledOccurrence = event.kind === 'session-update' && event.event === 'source_unavailable'
                ? event.stalledOccurrence : undefined;
            if (stalledOccurrence && !isSessionFollowStalledOccurrenceCurrentV1(stalledOccurrence, session)) return;
            if (event.kind === 'session-update' && event.event === 'human_message'
                && event.sourceAccountId === audienceSource.audienceScopes?.get(event.address.serverId)?.accountId) return;
            const viewer = session.viewer;
            const tracked = isSessionPersonallyTrackedForViewer(session);
            // Pre-viewer Homes carry no Follow facts. Only their identified owner
            // retains the released default; unknown collaborators remain quiet.
            if (!viewer && !tracked) return;
            const isSessionOwner = viewer
                ? viewer.relevance.reasons.includes('owned_by_me')
                : tracked;
            const interaction = deriveTranscriptInteractionFromSession({
                access: session.access,
                active: session.active,
            });
            const followEvent = stalledOccurrence ? { kind: 'stalled' as const }
                : event.kind === 'session-update' && event.event === 'message' ? event.followEvent : undefined;
            const eligibility = resolveSessionPersonalEventEligibilityV1({
                event: event.event,
                isSessionOwner,
                tracked,
                // Session lookup is fed only by this authenticated viewer's authorized
                // sync projection; revoked rows disappear through the existing owner.
                accessible: true,
                accountSuspended: false,
                archived: session.archivedAt != null,
                responsible: viewer?.relevance.reasons.includes('responsible_for_me') === true,
                targeted: false,
                followFacts: viewer ? viewer.follow : { follows: false, notificationLevel: null },
                followEvent,
                capabilities: {
                    canSubmitAgentInput: interaction.canSendMessages,
                    canApprovePermissions: interaction.canApprovePermissions,
                },
            });
            if (!eligibility.eligible) return;
            const accountSettings = resolveAccountSettings(event.address.serverId);
            if (!accountSettings) return;
            const followPolicy = followEvent ? resolveEffectiveAccountFollowPolicyV1({
                facts: viewer?.follow ?? { follows: false, notificationLevel: null }, isSessionOwner,
            }) : null;
            const deliveryPlan = resolveActivityAttentionDeliveryPlan({
                accountSettings,
                localSettings,
                event: resolveLocalNotificationEventKind(event),
                channel: 'local_notification',
                sameSessionVisible: isSessionActivelyViewedForLocalNotification(event, scope.accountId),
                foregroundState: resolveDocumentHostForegroundState(),
                now: new Date(),
                ...(followEvent ? { follow: { event: followEvent, policies: followPolicy ? [followPolicy] : [] } } : {}),
            });
            if (deliveryPlan.delivery === 'suppress') {
                return;
            }

            const eventIdentity = resolveLocalNotificationEventIdentity(event);
            const accountId = scope.accountId;
            // Desktop has no Expo foreground presentation callback. Native
            // arrivals arbitrate there after current policy, not while scheduling.
            // Identityless state observations always continue through the
            // current eligibility and policy checks above.
            if (isDesktopHost() && eventIdentity && accountId && consumeOtherLegActivityAlertPresentation({
                address: event.address,
                accountId,
                event: event.event,
                identity: eventIdentity,
                committedLocalId: event.kind === 'ready' ? event.committedLocalId : undefined,
                source: 'local_notification',
            })) {
                return;
            }

            const serverProfile = getServerProfileById(event.address.serverId);
            const activeServer = getActiveServerSnapshot();
            const serverUrl = serverProfile?.serverUrl
                ?? (areServerProfileIdentifiersEquivalent(activeServer.serverId, event.address.serverId)
                    ? activeServer.serverUrl
                    : null);
            if (!serverUrl) return;
            const nowMs = Date.now();
            const awareness = projectUiSessionAwareness(session, nowMs);
            const mayShowPrivateContent = viewer?.attention.presentation !== 'status_only'
                && isSessionAwarenessContentReadableV1(awareness.encryption);
            // An alert may enrich itself only from the exact committed row
            // already opened for this Home. It never fetches/decrypts a preview
            // or borrows another Home's same-id Session transcript.
            const contentEvent = event.kind === 'session-update' && 'committedSequence' in event
                ? { ...event, messages: mayShowPrivateContent && directScopedSession
                    && event.committedSequence.sequenceDomain === 'session_transcript'
                    ? Object.values(state.sessionMessages[event.address.sessionId]?.messagesMap ?? {})
                        .filter((message) => message.seq === event.committedSequence.sequence)
                    : undefined }
                : event;
            const notification = buildActivityLocalNotificationContent({
                event: contentEvent,
                session: mayShowPrivateContent ? session : null,
                serverUrl,
                accountId,
                contextLine: projectSessionContextPresentation(buildSessionContextFacts({
                    address: event.address,
                    serverProfile,
                    // Same projection the private-content gate above already consulted, so the
                    // delivered context can never describe content this device could not open.
                    awareness,
                    viewer,
                    audience: audienceSource.audiencePresentationsBySessionKey?.get(sessionAddressKey(event.address)),
                    // Same Home-directory input Session rows use, so a delivered notification
                    // never prints an absolute workspace path.
                    homeDir: readSessionOwnerMetadataView(session)?.homeDir ?? null,
                    // Same exact-Home currentness the row and Activity show: an alert from a Home
                    // Happier can no longer reach says so instead of implying it is current.
                    homeObservation: audienceSource.sessionListHomeObservationByServerId?.[event.address.serverId] ?? null,
                    nowMs,
                })).contextLine,
                previewBehavior: mayShowPrivateContent ? deliveryPlan.previewBehavior : 'status_only',
            });

            if (isDesktopHost()) {
                const submission = sendTauriLocalNotification({
                    title: notification.title,
                    body: notification.body,
                    ...(desktopHostKind() === 'tauri' ? { interaction: {
                        identifier: resolveWebNotificationTag(event, eventIdentity, accountId) ?? randomUUID(),
                        data: notification.data,
                        actions: [],
                    } } : {}),
                }).then((accepted) => {
                    if (!accepted || !eventIdentity || !accountId) return;
                    noteActivityAlertPresented({
                        address: event.address,
                        accountId,
                        event: event.event,
                        identity: eventIdentity,
                        committedLocalId: event.kind === 'ready' ? event.committedLocalId : undefined,
                        source: 'local_notification',
                    });
                });
                fireAndForget(submission, { tag: 'ActivityLocalNotificationRuntime.sendTauriLocalNotification' });
                return;
            }

            if (Platform.OS === 'web') {
                // Plain browsers have no push leg on this device, so there is nothing to arbitrate.
                fireAndForget(sendWebLocalNotification({
                    title: notification.title,
                    body: notification.body,
                    tag: resolveWebNotificationTag(event, eventIdentity, accountId),
                    silent: deliveryPlan.delivery === 'silent',
                    onClick: () => openSessionRef.current(notification.data),
                }), { tag: 'ActivityLocalNotificationRuntime.sendWebLocalNotification' });
                return;
            }

            const resolvedSound = resolveExpoLocalNotificationSound(event, deliveryPlan);
            const expoNotificationParams: Parameters<typeof sendExpoLocalNotification>[0] = {
                title: notification.title,
                body: notification.body,
                data: notification.data,
                categoryIdentifier: notification.expo.categoryIdentifier,
                sound: resolvedSound.sound,
                channelId: resolvedSound.channelId ?? notification.expo.channelId,
            };
            // Scheduling acceptance does not mean a banner presented. Only the
            // Expo foreground handler may consume or write native presentation notes.
            const submission = sendExpoLocalNotification(expoNotificationParams).then(reconcilePresentedRequests);
            fireAndForget(submission, {
                tag: 'ActivityLocalNotificationRuntime.sendExpoLocalNotification',
            });
        };
        const unsubscribe = subscribeActivityLocalNotifications(event => {
            fireAndForget(notify(event), { tag: 'ActivityLocalNotificationRuntime.admitNotification' });
        });
        return () => { controller.abort(); unsubscribe(); };
    }, [
        localSettings,
        reconcilePresentedRequests,
        resolveAccountSettings,
        audienceSource.audienceScopes,
        audienceSource.audiencePresentationsBySessionKey,
        audienceSource.sessionListHomeObservationByServerId,
    ]);

    // Phones get the guard's stop warning as a push; a desktop host announces it locally.
    // Deletion reminders are scheduled native notifications, which a browser cannot hold.
    if (isDesktopHost()) return <GuardStopWarningDesktopBanners />;
    return Platform.OS === 'web' ? null : <ManagedMachineDeletionNotificationRuntime serverIds={reminderServerIds} />;
}
