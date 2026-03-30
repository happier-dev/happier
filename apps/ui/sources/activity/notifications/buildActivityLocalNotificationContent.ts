import {
    PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS,
    PUSH_NOTIFICATION_CATEGORY_IDS,
    buildReadyNotificationContent,
} from '@happier-dev/protocol';

import { formatPermissionRequestSummary } from '@/components/tools/normalization/policy/permissionSummary';
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

function summarizePermissionBody(toolName: string, toolArgs: unknown): string {
    const summary = formatPermissionRequestSummary({
        toolName,
        toolInput: toolArgs,
    }).replace(/^Permission required:\s*/i, '').trim();

    return summary || t('notifications.activity.permissionFallbackBody');
}

function extractFirstUserActionQuestion(toolName: string, toolArgs: unknown): string | null {
    if (toolName !== 'AskUserQuestion') return null;

    const questions = Array.isArray((toolArgs as { questions?: unknown })?.questions)
        ? (toolArgs as { questions: ReadonlyArray<{ question?: unknown }> }).questions
        : [];

    for (const question of questions) {
        const text = typeof question?.question === 'string' ? question.question.trim() : '';
        if (text) return text;
    }

    return null;
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
