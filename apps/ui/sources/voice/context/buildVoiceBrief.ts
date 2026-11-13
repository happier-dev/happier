import type { InboxModel } from '@/hooks/inbox/useInboxModel';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { normalizeSessionAddress, sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import { getVoiceContextFormatterPrefs } from './voiceContextPrefs';
import { formatVoiceApprovalGuidance, summarizeAgentRequestForVoiceHuman } from './contextFormatters';
import { redactVoicePathLikeString } from '@/voice/shared/redactVoicePathLikeData';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { resolveWorkflowRunDisplayName } from '@/components/workflows/presentation/workflowRunDisplayName';
import type { WorkflowAttentionSource } from '@/hooks/inbox/useWorkflowAttentionSource';
import type { AutomationInboxItem } from '@/hooks/inbox/useInboxModel';
import { buildAgentRequestSemanticSummary, type AgentRequestKind } from '@happier-dev/protocol/activity/agentRequestSummary';
import { buildInboxSessionReasonLine } from '@/components/inbox/workGroups/inboxSessionContextLine';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { t } from '@/text';
import { isSessionAwarenessContentReadableV1 } from '@happier-dev/protocol/sessions/awareness/availability';
import { buildInboxWorkflowReasonFacts } from '@/components/inbox/workGroups/inboxWorkflowReason';
import { formatAutomationRunCauseLabel, formatAutomationRunStateLabel } from '@/components/automations/list/automationListFormatting';
import { automationRunTone } from '@/components/automations/home/latestAutomationRuns';
import { readWorkflowRunWorkStatusFacts } from '@/components/work/status/workflowWorkStatusFacts';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { presentExecutionRunFailure } from '@/components/sessions/presentation/sessionRuntimeIssuePresentation';
import type { InboxItem } from '@/components/inbox/inboxItems';
import type { SessionListNeedsYouProjection } from '@/components/sessions/shell/sessionListPaneRetention';

export type VoiceBriefSource = Pick<InboxModel, 'sessionPresentation' | 'workGroups' | 'automationAttentionItems'
    | 'workflowAttention' | 'automationAttention' | 'isLoading' | 'showCaughtUp' | 'items'
    | 'openApprovals' | 'openUsageNotices' | 'actionOperationEntries' | 'friendRequests'> & Readonly<{
    source: Pick<InboxModel['source'], 'isDataReady' | 'personalSessionListCoverageComplete' | 'sessionListHomeObservationByServerId'>;
    needsYouShelf?: SessionListNeedsYouProjection | null;
}>;
export type VoiceBriefItem = Readonly<{
    key: string;
    category: 'needs_you' | 'failed' | 'ready';
    title: string;
    /** Why this row is here (the request it asks, else the Inbox's own reason), drawn only; never where it runs. */
    subtitle?: string;
    hasRequestControls?: boolean;
    destination: Readonly<{ kind: 'session'; address: SessionAddress }>
        | Readonly<{ kind: 'workflow'; runId: string }>
        | Readonly<{ kind: 'automation'; route: AutomationInboxItem['route'] }>;
    route?: string | AutomationInboxItem['route'];
}>;

function freshnessFacts(source: WorkflowAttentionSource) {
    const { available, phase, refreshFailed, knownAt, hasMore, loadingMore, loadMoreFailed } = source;
    return { available, phase, refreshFailed, knownAt, hasMore, loadingMore, loadMoreFailed };
}

/** Presentation of already-authorized Inbox membership, bounded by its existing source windows. */
export function buildVoiceBrief(input: Readonly<{ inbox: VoiceBriefSource; settings: unknown }>) {
    const { inbox } = input;
    const items: VoiceBriefItem[] = [];
    const shelf = inbox.needsYouShelf;
    const needsYouKeys = new Set(shelf?.items.map(item => JSON.stringify([
        item.type === 'session' ? 'session' : 'workflow_run', item.serverId,
        item.type === 'session' ? item.sessionId : item.runId,
    ])));
    const needsYou = (kind: InboxItem['source']['kind'], serverId: string | null | undefined, id: string) =>
        needsYouKeys.has(JSON.stringify([kind, serverId, id]));
    const speechByKey = new Map<string, Readonly<{ title?: string; requests?: readonly string[] }>>();
    const privacy = readVoicePrivacySettings(input.settings);
    // Brief is an explicit request, not an automatic Follow update. The Account
    // sharing switches still bound disclosure; update frequency does not hide names.
    const prefs = getVoiceContextFormatterPrefs({ settings: input.settings });
    const safeTitle = (title: string) => privacy.shareFilePaths ? title : redactVoicePathLikeString(title);
    const sessionTitle = (candidate: VoiceBriefSource['sessionPresentation']['readySessions'][number]) => {
        if (!isSessionAwarenessContentReadableV1(candidate.awareness.encryption)) return null;
        // Activity already resolved the exact Home's Session display owner. Keep
        // Brief pure: never reread the ambient store to reconstruct that identity.
        const title = candidate.title;
        return title.trim() ? title : null;
    };
    // Inbox already admits readable request details. Notification-preview policy
    // does not hide those details in the app; speech has its own disclosure below.
    const requestReason = (entry: VoiceBriefSource['sessionPresentation']['sessionsNeedingAttention'][number]): string | null => {
        const permissions = entry.requestDetails?.permissions ?? entry.pendingPermissions;
        const userActions = entry.requestDetails?.userActions ?? entry.pendingUserActions;
        const kind = permissions[0] ? 'permission' : userActions[0] ? 'user_action' : null;
        const request = permissions[0] ?? userActions[0];
        if (!kind || !request) return null;
        const semantic = buildAgentRequestSemanticSummary({ kind, toolName: request.tool, toolInput: request.arguments });
        if (kind === 'user_action') return semantic.firstQuestionText;
        if (semantic.permissionTitle) return semantic.permissionTitle;
        const action = semantic.shellCommand ? t('voiceMoments.briefRunCommand', { command: semantic.shellCommand })
            : semantic.filePath ? t('voice.readiness.permissionAccessFile', { path: semantic.filePath })
                : semantic.permissionAction === 'run_command' ? t('voice.readiness.permissionRunCommand')
                    : semantic.permissionAction === 'change_files' ? t('voice.readiness.permissionChangeFiles')
                        : t('voice.readiness.permissionContinueAction');
        return t('voiceMoments.briefWantsTo', { action });
    };
    const sessionSubtitle = (candidate: VoiceBriefSource['sessionPresentation']['readySessions'][number], request: string | null = null) => {
        if (!isSessionAwarenessContentReadableV1(candidate.awareness.encryption)) return {};
        const subtitle = joinHappierFacts(request, buildInboxSessionReasonLine(candidate, { showNeed: request === null }));
        return { subtitle: subtitle || t('common.unavailable') };
    };
    const projectSessionSpeech = (candidate: VoiceBriefSource['sessionPresentation']['readySessions'][number], requests: readonly (readonly [AgentRequestKind, string, string, unknown])[] = []) => {
        const address = normalizeSessionAddress(candidate.address?.serverId ?? candidate.serverId, candidate.sessionId);
        if (!address) return;
        // The sidebar and Activity already use the Session display-label owner,
        // including first-message and untitled fallbacks. Speech shares that
        // label only within the same Session-summary disclosure policy.
        const label = prefs.voiceShareSessionSummary ? safeTitle(sessionTitle(candidate) ?? '') : null;
        speechByKey.set(sessionAddressKey(address), {
            ...(label ? { title: label } : {}),
            ...(prefs.voiceSharePermissionRequests ? { requests: requests.map(([kind, id, tool, args]) => summarizeAgentRequestForVoiceHuman(kind, id, tool, args, prefs, label ?? undefined)).filter((value): value is string => Boolean(value)) } : {}),
        });
    };
    for (const entry of inbox.sessionPresentation.sessionsNeedingAttention) {
        const candidate = entry.candidate;
        const address = normalizeSessionAddress(candidate.address?.serverId ?? candidate.serverId, candidate.sessionId);
        const title = sessionTitle(candidate);
        if (!address || !title) continue;
        const requiresPerson = needsYou('session', address.serverId, address.sessionId);
        if (!requiresPerson && !candidate.personalAttention.reasons.includes('failed')) continue;
        items.push({ key: sessionAddressKey(address), category: requiresPerson ? 'needs_you' : 'failed',
            title, ...sessionSubtitle(candidate, requestReason(entry)),
            hasRequestControls: entry.pendingPermissions.length + entry.pendingUserActions.length > 0,
            destination: { kind: 'session', address }, ...(candidate.route ? { route: candidate.route } : {}) });
        projectSessionSpeech(candidate, [...(entry.requestDetails?.permissions ?? entry.pendingPermissions).map((request) => ['permission', request.id, request.tool, request.arguments] as const),
            ...(entry.requestDetails?.userActions ?? entry.pendingUserActions).map((request) => ['user_action', request.id, request.tool, request.arguments] as const)]);
    }
    for (const candidate of inbox.sessionPresentation.readySessions) {
        const address = normalizeSessionAddress(candidate.address?.serverId ?? candidate.serverId, candidate.sessionId);
        const title = sessionTitle(candidate);
        if (!address || !title) continue;
        items.push({ key: sessionAddressKey(address), category: 'ready', title, ...sessionSubtitle(candidate), destination: { kind: 'session', address }, ...(candidate.route ? { route: candidate.route } : {}) });
        projectSessionSpeech(candidate);
    }
    // These rows are already members of the Inbox's server-owned attention window,
    // including originless runs. Do not replace them with an origin Session lookup.
    for (const group of inbox.workGroups) {
        for (const item of group.items) {
            if (item.kind !== 'workflow_run') continue;
            const name = resolveWorkflowRunDisplayName(item.row.metadata);
            if (name.kind !== 'name' || !name.value.trim()) continue;
            const title = name.value;
            const status = item.row.summary ? resolveWorkStatusTone({ kind: 'workflow_run', facts: readWorkflowRunWorkStatusFacts(item.row.summary) }) : null;
            const category = needsYou('workflow_run', inbox.workflowAttention.serverId, item.runId) ? 'needs_you'
                : status?.tone === 'danger' ? 'failed' : null;
            if (!category) continue;
            const failure = category === 'failed' && item.row.summary?.errorCode
                ? presentExecutionRunFailure({ code: item.row.summary.errorCode })?.message : null;
            const subtitle = joinHappierFacts(...buildInboxWorkflowReasonFacts(item)) || failure || t('common.unavailable');
            items.push({ key: item.key, category, title, subtitle, destination: { kind: 'workflow', runId: item.runId }, route: createWorkflowRunRoute(item.runId, inbox.workflowAttention.serverId) });
            if (privacy.shareSessionSummary && title) speechByKey.set(item.key, { title: safeTitle(title) });
        }
    }
    for (const item of inbox.automationAttentionItems) {
        if (!item.title?.trim()) continue;
        const subtitle = joinHappierFacts(formatAutomationRunStateLabel(item.run), formatAutomationRunCauseLabel(item.run.cause));
        const category = needsYou('automation_run', inbox.automationAttention.serverId, item.run.id) ? 'needs_you'
            : automationRunTone(item.run.workflowRunState ?? item.run.state) === 'failed' ? 'failed' : null;
        if (!category) continue;
        items.push({ key: item.key, category, title: item.title, subtitle, destination: { kind: 'automation', route: item.route }, route: item.route });
        if (privacy.shareSessionSummary) speechByKey.set(item.key, { title: safeTitle(item.title) });
    }
    const rank = { needs_you: 0, failed: 1, ready: 2 } as const;
    items.sort((a, b) => rank[a.category] - rank[b.category]);
    const sources = [inbox.workflowAttention, inbox.automationAttention];
    const sourceIncomplete = inbox.isLoading || !inbox.source.isDataReady || inbox.source.personalSessionListCoverageComplete !== true
        || Object.values(inbox.source.sessionListHomeObservationByServerId ?? {}).some((home) => home?.phase !== 'ready')
        || sources.some((source) => source.available && (source.phase !== 'loaded' || source.refreshFailed || source.hasMore || source.loadMoreFailed));
    const freshness = { sessionHomes: inbox.source.sessionListHomeObservationByServerId ?? {}, workflow: freshnessFacts(inbox.workflowAttention), automation: freshnessFacts(inbox.automationAttention) };
    // Provider context is not the navigation model: never serialize route/identity,
    // callbacks or private records from Inbox. Decisions stay with canonical request tools/UI.
    const approval = formatVoiceApprovalGuidance(prefs.voiceCanApproveRequests);
    const counts = { needs_you: shelf?.count ?? null, failed: 0, ready: 0 };
    let projectedNeedsYou = 0;
    const spokenCounts = { needs_you: 0, failed: 0, ready: 0 };
    const speechGroups = new Map<string, Readonly<{ category: VoiceBriefItem['category']; title?: string; requests?: readonly string[] }> & { count: number }>();
    for (const item of items) {
        if (item.category === 'needs_you') projectedNeedsYou += 1;
        else counts[item.category] += 1;
        const speech = { category: item.category, ...speechByKey.get(item.key) };
        // Withheld identities stay in the total without an invented label.
        if (!speech.title) continue;
        spokenCounts[item.category] += 1;
        const key = JSON.stringify(speech);
        const existing = speechGroups.get(key);
        if (existing) existing.count += 1;
        else speechGroups.set(key, { ...speech, count: 1 });
    }
    // A collapsed/partial shelf may retain its exact total without all navigable
    // details. Missing sidebar scope never becomes an Account-wide Inbox count.
    const incomplete = sourceIncomplete || !shelf || shelf.incomplete
        || (counts.needs_you !== null && counts.needs_you > projectedNeedsYou);
    const caughtUp = inbox.showCaughtUp && !incomplete && items.length === 0;
    const remaining = { needs_you: counts.needs_you === null ? null : counts.needs_you - spokenCounts.needs_you,
        failed: counts.failed - spokenCounts.failed, ready: counts.ready - spokenCounts.ready };
    const context = JSON.stringify({ incomplete, caughtUp, counts, remaining, items: [...speechGroups.values()], approval });
    return { items, freshness, incomplete, caughtUp, context };
}

export type VoiceBrief = ReturnType<typeof buildVoiceBrief>;
