import {
    PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS,
    PUSH_NOTIFICATION_CATEGORY_IDS,
    buildReadyNotificationContent,
    summarizeToolInputForNotification,
    projectNotificationQuestion,
} from '@happier-dev/protocol';

import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import type { AgentRequestKind } from '@/utils/sessions/permissions/permissionPromptPolicy';

import type { ActivityLocalNotificationEvent } from './runtime/activityLocalNotificationBus';

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
    const summaryText = typeof session?.metadata?.summary?.text === 'string'
        ? session.metadata.summary.text.trim()
        : '';
    if (summaryText) return summaryText;

    return t('notifications.activity.defaultSessionTitle');
}

function summarizeReadyPreviewText(messages?: Message[]): string | null {
    const latestAssistantText = Array.isArray(messages)
        ? [...messages]
            .filter((message): message is Extract<Message, { kind: 'agent-text' }> => message?.kind === 'agent-text')
            .sort((left, right) => left.createdAt - right.createdAt)
            .at(-1)
            ?.text
        : null;
    const normalized = typeof latestAssistantText === 'string' ? latestAssistantText.trim() : '';
    return normalized || null;
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
    includeReadyMessageText?: boolean;
    includeRequestMessageText?: boolean;
}>): ActivityLocalNotificationContent {
    const title = resolveSessionNotificationTitle(params.session);
    const baseData = {
        sessionId: params.event.sessionId,
        serverUrl: params.serverUrl,
        ...(params.accountId ? { accountId: params.accountId } : {}),
    };

    if (params.event.kind === 'ready') {
        const readyContent = buildReadyNotificationContent({
            sessionTitle: title,
            defaultTitle: t('notifications.activity.defaultSessionTitle'),
            waitingForCommandLabel: title,
            fallbackBody: t('notifications.activity.readyFallbackBody'),
            includeMessageText: params.includeReadyMessageText,
            messageText: summarizeReadyPreviewText(params.event.messages),
        });

        return {
            title: readyContent.title,
            body: readyContent.body,
            data: baseData,
            expo: {
                channelId: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.defaultV1,
            },
        };
    }

    const question = params.event.requestKind === 'user_action' && params.event.occurrenceId && params.accountId
        && params.includeRequestMessageText !== false
        ? projectNotificationQuestion(params.event.toolName, params.event.toolArgs) : null;
    return {
        title,
        body: question?.body ?? summarizeAgentRequestBody(params.event.requestKind, params.event.toolName, params.event.toolArgs, params.includeRequestMessageText !== false),
        data: {
            ...baseData,
            requestId: params.event.requestId,
            ...(question ? { questionAnswerV1: question.descriptor } : {}),
            kind: params.event.requestKind,
            ...(typeof params.event.occurrenceId === 'string' ? { occurrenceId: params.event.occurrenceId } : {}),
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
