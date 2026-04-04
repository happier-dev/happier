import {
    PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS,
    PUSH_NOTIFICATION_CATEGORY_IDS,
    buildReadyNotificationContent,
    extractFirstUserActionQuestion,
    formatPermissionRequestSummary,
} from '@happier-dev/protocol';
import { buildActivityPreviewText } from '@/activity/attention/buildActivityPreviewText';
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

function summarizePermissionBody(toolName: string, toolArgs: unknown): string {
    const summary = formatPermissionRequestSummary({
        toolName,
        toolInput: toolArgs,
    }).replace(/^Permission required:\s*/i, '').trim();

    return summary || t('notifications.activity.permissionFallbackBody');
}

function summarizeAgentRequestBody(requestKind: AgentRequestKind, toolName: string, toolArgs: unknown): string {
    if (requestKind === 'permission') {
        return summarizePermissionBody(toolName, toolArgs);
    }

    return extractFirstUserActionQuestion(toolName, toolArgs) || t('notifications.activity.userActionFallbackBody');
}

export function buildActivityLocalNotificationContent(params: Readonly<{
    event: ActivityLocalNotificationEvent;
    session: Session | null | undefined;
    serverUrl: string;
    includeReadyMessageText?: boolean;
}>): ActivityLocalNotificationContent {
    const title = resolveSessionNotificationTitle(params.session);
    const baseData = {
        sessionId: params.event.sessionId,
        serverUrl: params.serverUrl,
    };

    if (params.event.kind === 'ready') {
        const readyContent = buildReadyNotificationContent({
            sessionTitle: title,
            defaultTitle: t('notifications.activity.defaultSessionTitle'),
            waitingForCommandLabel: title,
            fallbackBody: t('notifications.activity.readyFallbackBody'),
            includeMessageText: params.includeReadyMessageText,
            messageText: buildActivityPreviewText({ messages: params.event.messages }),
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

    return {
        title,
        body: summarizeAgentRequestBody(params.event.requestKind, params.event.toolName, params.event.toolArgs),
        data: {
            ...baseData,
            requestId: params.event.requestId,
        },
        expo: {
            channelId:
                params.event.requestKind === 'permission'
                    ? PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.permissionRequestsV1
                    : PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.userActionRequestsV1,
            categoryIdentifier:
                params.event.requestKind === 'permission'
                    ? PUSH_NOTIFICATION_CATEGORY_IDS.permissionRequestV1
                    : PUSH_NOTIFICATION_CATEGORY_IDS.userActionRequestV1,
        },
    };
}
