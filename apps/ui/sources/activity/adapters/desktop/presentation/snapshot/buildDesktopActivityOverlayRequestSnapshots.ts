import { buildAgentRequestSemanticSummary, classifyPermissionRequestRisk, formatPermissionRequestSummary } from '@happier-dev/protocol/activity/agentRequestSummary';
import { isSessionAwarenessContentReadableV1 } from '@happier-dev/protocol/sessions/awareness/availability';
import type { SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';
import type { ActivitySurfaceCandidatePrivacyModeResolver } from '@/activity/presentation/buildActivitySurfaceViewModel';
import { createActivitySurfaceSessionTarget } from '@/activity/actions/activitySurfaceTargets';
import { activityInstanceKey } from '@/sync/domains/session/sessionAddress';
import {
    listPendingPermissionRequestsFromSession,
    listPendingUserActionRequestsFromSession,
} from '@/sync/domains/session/pending/listPendingSessionRequests';

import type { DesktopActivityOverlayRequestSnapshot } from './desktopActivityOverlaySnapshotTypes';

function buildRequestActivityInstanceId(params: Readonly<{
    serverId: string | null;
    sessionId: string;
    kind: DesktopActivityOverlayRequestSnapshot['kind'];
    requestId: string;
}>): string {
    return activityInstanceKey(
        { serverId: params.serverId, sessionId: params.sessionId },
        JSON.stringify([params.kind, params.requestId]),
    );
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
    resolveCandidatePrivacyMode?: ActivitySurfaceCandidatePrivacyModeResolver;
}>): Readonly<{
    permissionRequests: readonly DesktopActivityOverlayRequestSnapshot[];
    userQuestions: readonly DesktopActivityOverlayRequestSnapshot[];
}> {
    const permissionRequests: DesktopActivityOverlayRequestSnapshot[] = [];
    const userQuestions: DesktopActivityOverlayRequestSnapshot[] = [];

    for (const candidate of params.candidates) {
        // A Home whose Account only permits runtime status withholds request content
        // here for the same reason the viewer's own status-only presentation does.
        if (params.resolveCandidatePrivacyMode?.(candidate) === 'status_only') continue;
        if (candidate.session.viewer?.attention.presentation === 'status_only'
            || !isSessionAwarenessContentReadableV1(candidate.awareness.encryption)) continue;
        const sessionId = candidate.sessionId;
        const serverId = candidate.address?.serverId
            ?? candidate.serverId
            ?? (typeof candidate.session.serverId === 'string' ? candidate.session.serverId.trim() || null : null);

        for (const request of listPendingPermissionRequestsFromSession(candidate.session)) {
            const semantic = buildAgentRequestSemanticSummary({
                kind: 'permission',
                toolName: request.tool,
                toolInput: request.arguments,
            });

            permissionRequests.push({
                kind: 'permission_request',
                activityInstanceId: buildRequestActivityInstanceId({
                    serverId,
                    sessionId,
                    kind: 'permission_request',
                    requestId: request.id,
                }),
                requestId: request.id,
                ...(request.turnId ? { turnId: request.turnId } : {}),
                sessionId,
                serverId,
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
                openActionIdentifier: createActivitySurfaceSessionTarget(sessionId, serverId),
                allowActionIdentifier: 'session.permission.respond',
                denyActionIdentifier: 'session.permission.respond',
                risk: classifyPermissionRequestRisk({
                    toolName: request.tool,
                    toolInput: request.arguments,
                }),
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
                activityInstanceId: buildRequestActivityInstanceId({
                    serverId,
                    sessionId,
                    kind: 'user_question',
                    requestId: request.id,
                }),
                requestId: request.id,
                sessionId,
                serverId,
                title: semantic.firstQuestionText ?? semantic.permissionTitle ?? semantic.normalizedToolLabel,
                summary: semantic.questionCount > 1
                    ? `${semantic.questionCount} questions`
                    : semantic.firstQuestionText,
                toolLabel: semantic.normalizedToolLabel,
                questionText: semantic.firstQuestionText,
                count: Math.max(semantic.questionCount, 1),
                openActionIdentifier: createActivitySurfaceSessionTarget(sessionId, serverId),
                directOptions: buildAskUserQuestionDirectOptions(request),
            });
        }
    }

    return {
        permissionRequests,
        userQuestions,
    };
}
