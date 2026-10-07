import { useActivityAttentionSource } from '@/activity/source/useActivityAttentionSource';
import * as React from 'react';

import { Platform } from 'react-native';

import { isPushNotificationBundledSoundId, resolveExpoNotificationSoundName, resolvePushNotificationAndroidChannelId } from '@happier-dev/protocol/push/pushNotificationActions';
import { isSessionAwarenessContentReadableV1 } from '@happier-dev/protocol/sessions/awareness/availability';
import { resolveActivityRequestEventIdentityV1, resolveActivitySequenceEventIdentityV1, resolveActivityTranscriptLocalIdEventIdentityV1, resolveActivityTurnEventIdentityV1 } from '@happier-dev/protocol/activity/eventIdentity';
import { resolveSessionPersonalEventEligibilityV1 } from '@happier-dev/protocol/sessions/personal/eventEligibility';
import { resolveActivityAttentionDeliveryPlan } from '@/activity/delivery/resolveActivityAttentionDeliveryPlan';
import { useExactHomeAccountSettings } from '@/activity/delivery/useExactHomeAccountSettings';
import type { ActivityAttentionDeliveryEventKind } from '@/activity/delivery/activityAttentionDeliveryPlanTypes';
import { localSettingsParse, type LocalSettings } from '@/sync/domains/settings/localSettings';
import { isDesktopMainWindowFocused } from '@/desktop/window/desktopMainWindowPresence';
import { storage, useLocalSetting } from '@/sync/domains/state/storage';
import { isSessionSurfaceVisible } from '@/sync/domains/session/sessionSurfaceVisibility';
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
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { fireAndForget } from '@/utils/system/fireAndForget';
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
import { isActivityLocalNotificationMutedForWake, subscribeActivityLocalNotifications, type ActivityLocalNotificationEvent } from './activityLocalNotificationBus';

function resolveLocalNotificationEventKind(event: ActivityLocalNotificationEvent): ActivityAttentionDeliveryEventKind {
    if (event.kind === 'ready') return 'ready';
    if (event.kind === 'session-update') return 'follow_update';
    return event.requestKind === 'permission' ? 'permission_request' : 'user_action_request';
}

function resolveLocalNotificationEventIdentity(event: ActivityLocalNotificationEvent): string | undefined {
    if (event.kind === 'agent-request') return resolveActivityRequestEventIdentityV1(event.requestId);
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

function isSessionActivelyViewedForLocalNotification(event: ActivityLocalNotificationEvent): boolean {
    if (!isSessionSurfaceVisible(event.address.sessionId, event.address.serverId)) {
        return false;
    }

    if (!isDesktopHost()) {
        return true;
    }

    return isDesktopMainWindowFocused();
}

function useActivityLocalNotificationLocalSettings(): Partial<LocalSettings> {
    const attentionDeviceOverridesV1 = useLocalSetting('attentionDeviceOverridesV1');

    return React.useMemo(
        () => localSettingsParse({ attentionDeviceOverridesV1 }),
        [attentionDeviceOverridesV1],
    );
}

export function ActivityLocalNotificationRuntime(): React.ReactElement | null {
    const localSettings = useActivityLocalNotificationLocalSettings();
    const audienceSource = useActivityAttentionSource();
    const resolveAccountSettings = useExactHomeAccountSettings(audienceSource.audienceScopes);

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
        return subscribeActivityLocalNotifications((event) => {
            if (event.kind === 'ready' && event.source === 'reconciliation'
                && isActivityLocalNotificationMutedForWake(event.address)) return;
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
                capabilities: {
                    canSubmitAgentInput: interaction.canSendMessages,
                    canApprovePermissions: interaction.canApprovePermissions,
                },
            });
            if (!eligibility.eligible) return;
            const accountSettings = resolveAccountSettings(event.address.serverId);
            if (!accountSettings) return;
            const deliveryPlan = resolveActivityAttentionDeliveryPlan({
                accountSettings,
                localSettings,
                event: resolveLocalNotificationEventKind(event),
                channel: 'local_notification',
                sameSessionVisible: isSessionActivelyViewedForLocalNotification(event),
                now: new Date(),
            });
            if (deliveryPlan.delivery === 'suppress') {
                return;
            }

            const eventIdentity = resolveLocalNotificationEventIdentity(event);
            const accountId = audienceSource.audienceScopes?.get(event.address.serverId)?.accountId;
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
                contextLine: projectSessionContextPresentation(buildSessionContextFacts({
                    address: event.address,
                    serverProfile,
                    // Same projection the private-content gate above already consulted, so the
                    // delivered context can never describe content this device could not open.
                    awareness,
                    viewer,
                    audienceContext: session.access?.audienceContext,
                    audienceScope: audienceSource.audienceScopes?.get(event.address.serverId),
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

            if (Platform.OS === 'web') return;

            const resolvedSound = resolveExpoLocalNotificationSound(event, deliveryPlan);
            const expoNotificationParams: Parameters<typeof sendExpoLocalNotification>[0] = {
                title: notification.title,
                body: notification.body,
                data: notification.data,
                categoryIdentifier: notification.expo.categoryIdentifier,
                sound: resolvedSound.sound,
                channelId: resolvedSound.channelId,
            };
            // Scheduling acceptance does not mean a banner presented. Only the
            // Expo foreground handler may consume or write native presentation notes.
            const submission = sendExpoLocalNotification(expoNotificationParams);
            fireAndForget(submission, {
                tag: 'ActivityLocalNotificationRuntime.sendExpoLocalNotification',
            });
        });
    }, [
        localSettings,
        resolveAccountSettings,
        audienceSource.audienceScopes,
        audienceSource.sessionListHomeObservationByServerId,
    ]);

    return null;
}
