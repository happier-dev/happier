import { buildAgentRequestSemanticSummary, formatPermissionRequestSummary } from '@happier-dev/protocol';
import type { SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';
import {
    listPendingPermissionRequestsFromSession,
    listPendingUserActionRequestsFromSession,
} from '@/sync/domains/session/pending/listPendingSessionRequests';

import type { DesktopActivityOverlayRequestSnapshot } from './desktopActivityOverlaySnapshotTypes';

function createOpenActionIdentifier(sessionId: string): string {
    return `open-session:${sessionId}`;
}

function buildAskUserQuestionDirectOptions(request: {
    arguments?: unknown;
}): DesktopActivityOverlayRequestSnapshot['directOptions'] {
    const rawQuestions = Array.isArray((request.arguments as { questions?: unknown } | undefined)?.questions)
        ? ((request.arguments as { questions: ReadonlyArray<{
            question?: unknown;
            options?: unknown;
            multiSelect?: unknown;
        }> }).questions)
        : [];
    if (rawQuestions.length !== 1) {
        return [];
    }

    const firstQuestion = rawQuestions[0];
    const question = typeof firstQuestion?.question === 'string' ? firstQuestion.question.trim() : '';
    const options = Array.isArray(firstQuestion?.options)
        ? firstQuestion.options.map((option, index) => ({
            id: `option-${index}`,
            label: typeof (option as { label?: unknown }).label === 'string'
                ? String((option as { label?: unknown }).label).trim()
                : '',
            description: typeof (option as { description?: unknown }).description === 'string'
                ? String((option as { description?: unknown }).description).trim()
                : '',
        })).filter((option) => option.label.length > 0)
        : [];
    const multiSelect = firstQuestion?.multiSelect === true;
    if (!question || multiSelect || options.length === 0) {
        return [];
    }

    return options.map((option) => ({
        id: option.id,
        label: option.label,
        description: option.description || null,
        actionIdentifier: 'session.user_action.answer',
        answers: [
            {
                question,
                answer: option.label,
            },
        ],
    }));
}

export function buildDesktopActivityOverlayRequestSnapshots(params: Readonly<{
    candidates: readonly SessionActivityAttention[];
}>): Readonly<{
    permissionRequests: readonly DesktopActivityOverlayRequestSnapshot[];
    userQuestions: readonly DesktopActivityOverlayRequestSnapshot[];
}> {
    const permissionRequests: DesktopActivityOverlayRequestSnapshot[] = [];
    const userQuestions: DesktopActivityOverlayRequestSnapshot[] = [];

    for (const candidate of params.candidates) {
        const sessionId = candidate.sessionId;

        for (const request of listPendingPermissionRequestsFromSession(candidate.session)) {
            const semantic = buildAgentRequestSemanticSummary({
                kind: 'permission',
                toolName: request.tool,
                toolInput: request.arguments,
            });

            permissionRequests.push({
                kind: 'permission_request',
                requestId: request.id,
                sessionId,
                title: semantic.permissionTitle ?? formatPermissionRequestSummary({
                    toolName: request.tool,
                    toolInput: request.arguments,
                }),
                summary: formatPermissionRequestSummary({
                    toolName: request.tool,
                    toolInput: request.arguments,
                }),
                toolLabel: semantic.normalizedToolLabel,
                questionText: semantic.firstQuestionText,
                count: 1,
                openActionIdentifier: createOpenActionIdentifier(sessionId),
                allowActionIdentifier: 'session.permission.respond',
                denyActionIdentifier: 'session.permission.respond',
                directOptions: [],
            });
        }

        for (const request of listPendingUserActionRequestsFromSession(candidate.session)) {
            const semantic = buildAgentRequestSemanticSummary({
                kind: 'user_action',
                toolName: request.tool,
                toolInput: request.arguments,
            });

            userQuestions.push({
                kind: 'user_question',
                requestId: request.id,
                sessionId,
                title: semantic.firstQuestionText ?? semantic.permissionTitle ?? semantic.normalizedToolLabel,
                summary: semantic.questionCount > 1
                    ? `${semantic.questionCount} questions`
                    : semantic.firstQuestionText,
                toolLabel: semantic.normalizedToolLabel,
                questionText: semantic.firstQuestionText,
                count: Math.max(semantic.questionCount, 1),
                openActionIdentifier: createOpenActionIdentifier(sessionId),
                directOptions: buildAskUserQuestionDirectOptions(request),
            });
        }
    }

    return {
        permissionRequests,
        userQuestions,
    };
}
