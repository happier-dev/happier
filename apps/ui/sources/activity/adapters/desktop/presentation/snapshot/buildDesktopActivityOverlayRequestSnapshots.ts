import { t } from '@/text';
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

import { getDiffStats } from '@/components/ui/code/model/diff/calculateDiff';
import { resolveAgentIdForPermissionUi } from '@/agents/catalog/resolve';
import { resolveSessionPermissionBehavior } from '@/sync/ops/sessionPermissionAnswers';
import { resolveSessionPermissionChoices } from '@/sync/ops/sessionPermissionChoices';
import { deriveTranscriptInteractionFromSession } from '@/utils/sessions/deriveTranscriptInteraction';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

import type { DesktopActivityOverlayRequestSnapshot, DesktopActivityOverlayRequestSubject } from './desktopActivityOverlaySnapshotTypes';
import { listSessionListPresentationPermissionRequests, listSessionListPresentationUserActionRequests, readSessionListPresentationOwnerMetadata } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';

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

function readInputString(input: unknown, keys: readonly string[]): string | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    for (const key of keys) {
        const value = (input as Record<string, unknown>)[key];
        if (typeof value === 'string') return value;
    }
    return null;
}

/** The file or command a permission request acts on, from the shared request summary (never the raw tool name). */
function readPermissionRequestSubject(
    semantic: ReturnType<typeof buildAgentRequestSemanticSummary>,
    toolInput: unknown,
): DesktopActivityOverlayRequestSubject | null {
    const tool = semantic.normalizedToolLabel.toLowerCase();
    if (semantic.shellCommand && (tool === 'bash' || tool === 'execute' || tool === 'shell')) {
        return { kind: 'command', text: semantic.shellCommand, additions: null, deletions: null };
    }
    if (!semantic.filePath) return null;
    if (tool === 'read') return { kind: 'read', text: semantic.filePath, additions: null, deletions: null };
    if (tool === 'write') {
        const content = readInputString(toolInput, ['content', 'newText', 'new_string']);
        const stats = content === null ? null : getDiffStats('', content);
        return { kind: 'write', text: semantic.filePath, additions: stats?.additions ?? null, deletions: stats ? 0 : null };
    }
    if (tool !== 'edit' && tool !== 'multiedit') return null;
    const oldText = readInputString(toolInput, ['oldText', 'old_string']);
    const newText = readInputString(toolInput, ['newText', 'new_string']);
    const stats = oldText !== null && newText !== null ? getDiffStats(oldText, newText) : null;
    return { kind: 'edit', text: semantic.filePath, additions: stats?.additions ?? null, deletions: stats?.deletions ?? null };
}

export function buildDesktopActivityOverlayRequestSnapshots(params: Readonly<{
    candidates: readonly SessionActivityAttention[];
    resolveCandidatePrivacyMode?: ActivitySurfaceCandidatePrivacyModeResolver;
    audienceScopes?: ReadonlyMap<string, ServerAccountScope>;
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

        for (const request of candidate.presentationSource ? listSessionListPresentationPermissionRequests(candidate.presentationSource)
            : 'agentState' in candidate.session ? listPendingPermissionRequestsFromSession(candidate.session) : []) {
            const semantic = buildAgentRequestSemanticSummary({
                kind: 'permission',
                toolName: request.tool,
                toolInput: request.arguments,
            });
            const session = candidate.session;
            const metadata = candidate.presentationSource
                ? readSessionListPresentationOwnerMetadata(candidate.presentationSource)
                : readSessionOwnerMetadataView(session);
            const flavor = metadata && typeof metadata === 'object' && 'flavor' in metadata && typeof metadata.flavor === 'string' ? metadata.flavor : null;
            const permissionBehavior = resolveSessionPermissionBehavior({
                agentId: resolveAgentIdForPermissionUi({ metadata, flavor, toolName: request.tool }),
                metadata, accountScope: serverId ? params.audienceScopes?.get(serverId) ?? null : undefined,
            });
            const canApprove = deriveTranscriptInteractionFromSession({ access: session.access, active: session.active }).canApprovePermissions;

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
                permissionChoices: canApprove ? resolveSessionPermissionChoices({ toolName: request.tool, toolInput: request.arguments,
                    source: request.source, suggestions: request.permissionSuggestions, permissionBehavior,
                    mcpTool: request.mcpTool, canWriteCatalog: Boolean(serverId && params.audienceScopes?.has(serverId)) }) : [],
                risk: classifyPermissionRequestRisk({
                    toolName: request.tool,
                    toolInput: request.arguments,
                }),
                subject: readPermissionRequestSubject(semantic, request.arguments),
                directOptions: [],
            });
        }

        for (const request of candidate.presentationSource ? listSessionListPresentationUserActionRequests(candidate.presentationSource)
            : 'agentState' in candidate.session ? listPendingUserActionRequestsFromSession(candidate.session) : []) {
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
                    ? t('tools.askUserQuestion.multipleQuestions', { count: semantic.questionCount })
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
