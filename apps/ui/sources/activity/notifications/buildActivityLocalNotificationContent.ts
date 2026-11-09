import { projectNotificationQuestion } from '@happier-dev/protocol/push/notificationQuestionActions';
import { PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS, PUSH_NOTIFICATION_CATEGORY_IDS } from '@happier-dev/protocol/push/pushNotificationActions';
import { buildReadyNotificationContent } from '@happier-dev/protocol/push/readyNotificationContent';
import { prepareTranscriptMessageBody } from '@/components/sessions/transcript/messageDisplayText';
import { resolveActivityRemoteAlertEventForPersonalEventV2 } from '@happier-dev/protocol/push/activityRemoteAlert';
import { restrictAttentionPreviewBehavior } from '@happier-dev/protocol/account/settings/accountRemoteAlertPolicy';
import { buildAgentRequestSemanticSummary, summarizeToolInputForNotification, type AgentRequestKind } from '@happier-dev/protocol/activity/agentRequestSummary';
import { buildActivityPreviewText, normalizeActivityPreviewText } from '@/activity/attention/buildActivityPreviewText';
import type { Message } from "@happier-dev/session-core/messages";
import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionNameIfNamed } from '@/utils/sessions/sessionUtils';
import { t } from '@/text';
import type { ActivityLocalNotificationEvent } from './runtime/activityLocalNotificationBus';

/**
 * `AttentionPreviewBehavior` is not re-exported from the protocol barrel; derive it
 * from the exported restrictor that returns it rather than restating the union.
 */
type AttentionPreviewBehavior = ReturnType<typeof restrictAttentionPreviewBehavior>;

type ActivityLocalNotificationContent = Readonly<{
    title: string;
    body: string;
    data: Readonly<Record<string, unknown>>;
    expo: Readonly<{
        channelId: string;
        categoryIdentifier?: string;
    }>;
}>;

function resolveSessionNotificationTitle(session: Session | null | undefined): string {
    // The name every surface shows; only a Session nothing names falls back to the generic title.
    return (session ? readSessionNameIfNamed(session) : null) ?? t('notifications.activity.defaultSessionTitle');
}

function summarizeAgentRequestBody(requestKind: AgentRequestKind, toolName: string, toolArgs: unknown, includeMessageText: boolean): string {
    const details = includeMessageText ? summarizeToolInputForNotification(toolName, toolArgs, {
        command: t('notifications.activity.requestLabels.command'),
        file: t('notifications.activity.requestLabels.file'),
        selectOne: t('notifications.activity.requestLabels.selectOne'),
        selectMultiple: t('notifications.activity.requestLabels.selectMultiple'),
        customAnswer: t('notifications.activity.requestLabels.customAnswer'),
        localMessages: t('notifications.activity.requestLabels.localMessages'),
        remoteMessages: t('notifications.activity.requestLabels.remoteMessages'),
        answerAll: count => t('notifications.activity.requestLabels.answerAll', { count }),
    }) : null;
    return details || t(requestKind === 'permission'
        ? 'notifications.activity.permissionFallbackBody'
        : 'notifications.activity.userActionFallbackBody');
}

export function buildActivityLocalNotificationContent(params: Readonly<{
    event: ActivityLocalNotificationEvent;
    session: Session | null | undefined;
    serverUrl: string;
    accountId?: string;
    contextLine?: string | null;
    previewBehavior?: AttentionPreviewBehavior;
    includeReadyMessageText?: boolean;
    includeRequestMessageText?: boolean;
}>): ActivityLocalNotificationContent {
    const previewBehavior = params.previewBehavior;
    const includePrivateTitle = previewBehavior !== 'status_only';
    const baseTitle = includePrivateTitle
        ? resolveSessionNotificationTitle(params.session)
        : t('notifications.activity.defaultSessionTitle');
    const contextLine = typeof params.contextLine === 'string' ? params.contextLine.trim() : '';
    // Privacy gates the Session title and the message preview, never the shared context line: the
    // caller already resolved it through the canonical context projection, which reads only
    // structural facts this device is authorized for. A locked or status-only alert therefore still
    // names its exact Home, audience, freshness and content state (Lane 07.4 §8, L07-R42/L07-I37).
    const title = contextLine ? `${baseTitle} · ${contextLine}` : baseTitle;
    const baseData = {
        serverId: params.event.address.serverId,
        sessionId: params.event.address.sessionId,
        serverUrl: params.serverUrl,
        ...(params.accountId ? { accountId: params.accountId } : {}),
    };

    if (params.event.kind === 'ready') {
        const readyContent = buildReadyNotificationContent({
            sessionTitle: title,
            defaultTitle: t('notifications.activity.defaultSessionTitle'),
            waitingForCommandLabel: title,
            fallbackBody: t('notifications.activity.readyFallbackBody'),
            includeMessageText: previewBehavior === 'include_preview'
                ? params.includeReadyMessageText !== false
                : previewBehavior === undefined
                    ? params.includeReadyMessageText
                    : false,
            messageText: buildActivityPreviewText({ messages: params.event.messages }),
        });

        return {
            title: readyContent.title,
            body: readyContent.body,
            data: {
                ...baseData,
                ...(params.event.committedSequence?.sequenceDomain === 'session_transcript'
                    ? { activityEvent: resolveActivityRemoteAlertEventForPersonalEventV2('ready', {
                        domain: 'session_transcript',
                        seq: params.event.committedSequence.sequence,
                    }) }
                    : {}),
                ...(params.event.committedLocalId ? { activityEventLocalId: params.event.committedLocalId } : {}),
            },
            expo: {
                channelId: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.defaultV1,
            },
        };
    }

    if (params.event.kind === 'session-update') {
        const event = params.event;
        const sequence = 'committedSequence' in event ? event.committedSequence : undefined;
        const sourceEvent = resolveActivityRemoteAlertEventForPersonalEventV2(
            event.event,
            sequence?.sequenceDomain === 'session_transcript'
                ? { domain: 'session_transcript', seq: sequence.sequence }
                : sequence?.sequenceDomain === 'discussion'
                    ? { domain: 'discussion', discussionId: sequence.discussionId, seq: sequence.sequence }
                    : undefined,
            'turnId' in event ? event.turnId : undefined,
        );
        const activityEvent = sourceEvent?.type === 'source_unavailable' && event.event === 'source_unavailable' && event.stalledOccurrence
            ? { ...sourceEvent, stalledOccurrence: event.stalledOccurrence } : sourceEvent;
        const preview = previewBehavior === 'include_preview'
            ? event.event === 'human_message'
                ? event.messages?.filter((message) => message.kind === 'user-text')
                    .map((message) => normalizeActivityPreviewText(prepareTranscriptMessageBody(message).text ?? '')).filter(Boolean).join(' ')
                : buildActivityPreviewText({ messages: event.messages })
            : null;
        const fallback = event.event === 'failed' ? t('session.follow.notificationBody.failed')
            : event.event === 'cancelled' ? t('session.follow.notificationBody.cancelled')
                : event.event === 'source_unavailable' ? t('session.follow.notificationBody.sourceUnavailable')
                    : t('session.follow.notificationBody.message');
        return {
            title,
            body: preview || fallback,
            data: { ...baseData, activityEvent },
            expo: { channelId: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.defaultV1 },
        };
    }

    const includeRequestText = (previewBehavior === undefined || previewBehavior === 'include_preview')
        && params.includeRequestMessageText !== false;
    const question = params.event.requestKind === 'user_action' && params.event.turnId && params.accountId && includeRequestText
        ? projectNotificationQuestion(buildAgentRequestSemanticSummary({ kind: params.event.requestKind,
            toolName: params.event.toolName, toolInput: params.event.toolArgs })) : null;
    return {
        title,
        body: question?.body ?? summarizeAgentRequestBody(params.event.requestKind, params.event.toolName, params.event.toolArgs, includeRequestText),
        data: {
            ...baseData,
            kind: params.event.requestKind,
            requestId: params.event.requestId,
            ...(question ? { questionAnswerV1: question.descriptor } : {}),
            ...(params.event.turnId ? { turnId: params.event.turnId } : {}),
        },
        expo: {
            channelId:
                params.event.requestKind === 'permission'
                    ? PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.permissionRequestsV1
                    : PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.userActionRequestsV1,
            categoryIdentifier:
                params.event.requestKind === 'permission'
                    ? PUSH_NOTIFICATION_CATEGORY_IDS.permissionRequestV1
                    : question?.categoryId ?? PUSH_NOTIFICATION_CATEGORY_IDS.userActionRequestV1,
        },
    };
}
