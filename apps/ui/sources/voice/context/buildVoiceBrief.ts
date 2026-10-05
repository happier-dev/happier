import type { InboxModel } from '@/hooks/inbox/useInboxModel';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { normalizeSessionAddress, sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { areSessionAddressesEqual } from '@/sync/domains/session/sessionAddress';
import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import { getVoiceContextFormatterPrefs } from './voiceContextPrefs';
import { summarizeAgentRequestForVoiceHuman } from './contextFormatters';
import { redactVoicePathLikeString } from '@/voice/shared/redactVoicePathLikeData';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { resolveWorkflowRunDisplayName } from '@/components/workflows/presentation/workflowRunDisplayName';
import type { WorkflowAttentionSource } from '@/hooks/inbox/useWorkflowAttentionSource';
import type { AutomationInboxItem } from '@/hooks/inbox/useInboxModel';
import type { AgentRequestKind } from '@happier-dev/protocol';
import { resolveVoiceSessionUpdatePolicyV1 } from '@happier-dev/protocol';
import { buildInboxSessionContextLine } from '@/components/inbox/workGroups/inboxSessionContextLine';

export type VoiceBriefSource = Pick<InboxModel, 'sessionPresentation' | 'workGroups' | 'automationAttentionItems'
    | 'workflowAttention' | 'automationAttention' | 'isLoading' | 'showCaughtUp'> & Readonly<{
    source: Pick<InboxModel['source'], 'isDataReady' | 'personalSessionListCoverageComplete' | 'sessionListHomeObservationByServerId'>;
}>;
export type VoiceBriefItem = Readonly<{
    key: string;
    category: 'needs_you' | 'failed' | 'ready';
    title: string;
    /** The Inbox row's own second line (its context: reason or summary · where · when), drawn only. */
    subtitle?: string;
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
export function buildVoiceBrief(input: Readonly<{ inbox: VoiceBriefSource; settings: unknown; currentTarget?: SessionAddress | null }>) {
    const { inbox } = input;
    const items: VoiceBriefItem[] = [];
    const speechByKey = new Map<string, Readonly<{ title?: string; requests?: readonly string[] }>>();
    const privacy = readVoicePrivacySettings(input.settings);
    const safeTitle = (title: string) => privacy.shareFilePaths ? title : redactVoicePathLikeString(title);
    // The visual row repeats exactly what the Inbox row says under the title; never spoken.
    const sessionSubtitle = (candidate: VoiceBriefSource['sessionPresentation']['readySessions'][number]) => {
        if (candidate.personalAttention.presentation !== 'full') return {};
        const subtitle = buildInboxSessionContextLine(candidate);
        return subtitle ? { subtitle } : {};
    };
    const projectSessionSpeech = (candidate: VoiceBriefSource['sessionPresentation']['readySessions'][number], requests: readonly (readonly [AgentRequestKind, string, string, unknown])[] = []) => {
        const address = normalizeSessionAddress(candidate.address?.serverId ?? candidate.serverId, candidate.sessionId);
        if (!address || candidate.personalAttention.presentation !== 'full') return;
        const includeInVoice = candidate.session.viewer?.follow?.includeInVoice === true;
        const isCurrentAttemptTarget = areSessionAddressesEqual(input.currentTarget, address);
        if (resolveVoiceSessionUpdatePolicyV1({ accountSettings: input.settings, includeInVoice, isCurrentAttemptTarget }).level === 'none') return;
        const prefs = getVoiceContextFormatterPrefs({ settings: input.settings, sessionId: address.sessionId, sessionAddress: address,
            includeInVoice, isCurrentAttemptTarget });
        speechByKey.set(sessionAddressKey(address), {
            ...(prefs.voiceShareSessionSummary ? { title: safeTitle(candidate.title) } : {}),
            ...(prefs.voiceSharePermissionRequests ? { requests: requests.map(([kind, id, tool, args]) => summarizeAgentRequestForVoiceHuman(kind, id, tool, args, prefs)).filter((value): value is string => Boolean(value)) } : {}),
        });
    };
    for (const entry of inbox.sessionPresentation.sessionsNeedingAttention) {
        const candidate = entry.candidate;
        const address = normalizeSessionAddress(candidate.address?.serverId ?? candidate.serverId, candidate.sessionId);
        if (!address) continue;
        const requiresPerson = candidate.personalAttention.reasons.some((reason) => reason === 'permission_required' || reason === 'user_action_required');
        items.push({ key: sessionAddressKey(address), category: !requiresPerson && candidate.personalAttention.reasons.includes('failed') ? 'failed' : 'needs_you',
            title: candidate.personalAttention.presentation === 'full' ? candidate.title : '', ...sessionSubtitle(candidate), destination: { kind: 'session', address }, ...(candidate.route ? { route: candidate.route } : {}) });
        projectSessionSpeech(candidate, [...entry.pendingPermissions.map((request) => ['permission', request.id, request.tool, request.arguments] as const),
            ...entry.pendingUserActions.map((request) => ['user_action', request.id, request.tool, request.arguments] as const)]);
    }
    for (const candidate of inbox.sessionPresentation.readySessions) {
        const address = normalizeSessionAddress(candidate.address?.serverId ?? candidate.serverId, candidate.sessionId);
        if (address) items.push({ key: sessionAddressKey(address), category: 'ready', title: candidate.personalAttention.presentation === 'full' ? candidate.title : '', ...sessionSubtitle(candidate), destination: { kind: 'session', address }, ...(candidate.route ? { route: candidate.route } : {}) });
        projectSessionSpeech(candidate);
    }
    // These rows are already members of the Inbox's server-owned attention window,
    // including originless runs. Do not replace them with an origin Session lookup.
    for (const group of inbox.workGroups) {
        for (const item of group.items) {
            if (item.kind !== 'workflow_run') continue;
            const name = resolveWorkflowRunDisplayName(item.row.metadata);
            const title = name.kind === 'name' ? name.value : '';
            items.push({ key: item.key, category: 'needs_you', title, destination: { kind: 'workflow', runId: item.runId }, route: createWorkflowRunRoute(item.runId) });
            if (privacy.shareSessionSummary && title) speechByKey.set(item.key, { title: safeTitle(title) });
        }
    }
    for (const item of inbox.automationAttentionItems) {
        items.push({ key: item.key, category: 'needs_you', title: '', destination: { kind: 'automation', route: item.route }, route: item.route });
    }
    const rank = { needs_you: 0, failed: 1, ready: 2 } as const;
    items.sort((a, b) => rank[a.category] - rank[b.category]);
    const sources = [inbox.workflowAttention, inbox.automationAttention];
    const incomplete = inbox.isLoading || !inbox.source.isDataReady || inbox.source.personalSessionListCoverageComplete !== true
        || Object.values(inbox.source.sessionListHomeObservationByServerId ?? {}).some((home) => home?.phase !== 'ready')
        || sources.some((source) => source.available && (source.phase !== 'loaded' || source.refreshFailed || source.hasMore || source.loadMoreFailed));
    const freshness = { sessionHomes: inbox.source.sessionListHomeObservationByServerId ?? {}, workflow: freshnessFacts(inbox.workflowAttention), automation: freshnessFacts(inbox.automationAttention) };
    const caughtUp = inbox.showCaughtUp && !incomplete && items.length === 0;
    // Provider context is not the navigation model: never serialize route/identity,
    // callbacks or private records from Inbox. Approvals remain canonical UI-only.
    const context = JSON.stringify({ incomplete, caughtUp, items: items.map((item) => ({ category: item.category, ...speechByKey.get(item.key) })), approval: 'tap_only' });
    return { items, freshness, incomplete, caughtUp, context };
}

export type VoiceBrief = ReturnType<typeof buildVoiceBrief>;
