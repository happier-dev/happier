import type { UsageHowYouWorkDetailInput } from '@happier-dev/protocol/usage/resolveUsageHowYouWork';
import { SessionPermissionAnsweringClientCategoryV1Schema } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';
import { SessionActionConfirmationsV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionActionConfirmationsV1';
import { TranscriptRawAgentRecordV1Schema } from '@happier-dev/protocol/sessions/messages/transcriptRawRecordV1';
import { UsageCoachModelRequestSchema, type UsagePromptComposition, type UsageCoachModelRequest } from '@happier-dev/protocol/usage/coach/usagePromptComposition';
import type { UsageCoachCompactionFact } from '@happier-dev/protocol/usage/coach/coachFinding';
import type { UsageMcpBindingUsage } from '@happier-dev/protocol/usage/coach/usageMcpBindingUsage';
import type { Session, DecryptedMessage } from '@/sync/domains/state/storageTypes';
import type { UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageAnalyticsContribution } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';

type OpenedUsageSession = Pick<Session, 'id' | 'metadata' | 'agentState' | 'sessionTurns'>;
type ScopedUsageSession = OpenedUsageSession & Pick<Session, 'serverId' | 'encryptionMode' | 'encryptedContentAvailability' | 'access'>;
type OpenedUsageMessage = Pick<DecryptedMessage, 'id' | 'localId' | 'acceptedDelivery'> & Readonly<{ content?: unknown; createdAt?: number }>;

function resolveAccountingWorkMembership(query: UsageQuery, contributions: readonly UsageAnalyticsContribution[] = []) {
    const selected = query.session === null ? null : new Set(typeof query.session === 'string' ? [query.session] : query.session);
    // Session metadata cannot prove historical model/source/project membership.
    // Only the canonical scoped accounting contribution can admit those turns.
    const needsAccountingMembership = query.projects.length > 0 || query.sources.length > 0 || query.modelIds.length > 0
        || query.workspaceIds.length > 0 || query.backendModes.length > 0;
    const matching = contributions.filter(row => row.sessionId !== null
        && (!selected || selected.has(row.sessionId))
        && (!query.agents.length || row.agentId !== null && query.agents.includes(row.agentId))
        && (!query.machines.length || row.machineId !== null && query.machines.includes(row.machineId))
        && (!query.projects.length || row.projectKey !== null && query.projects.includes(row.projectKey))
        && (!query.sources.length || row.source !== null && query.sources.includes(row.source))
        && (!query.modelIds.length || row.modelId !== null && query.modelIds.includes(row.modelId))
        && (!query.workspaceIds.length || row.workspaceId !== null && query.workspaceIds.includes(row.workspaceId))
        && (!query.backendModes.length || row.backendMode != null && query.backendModes.includes(row.backendMode)));
    const accountingWork = new Set(matching.filter(row => row.turnId !== null).map(row => JSON.stringify([row.sessionId, row.turnId])));
    const accountingSessions = new Set(matching.filter(row => row.turnId !== null).flatMap(row => row.sessionId === null ? [] : [row.sessionId]));
    return { selected, needsAccountingMembership, accountingWork, accountingSessions, matching };
}

/** Read demand and disclosed facts share the same historical membership owner. */
export function selectUsageQueryWorkEvidenceSessionIds(input: Readonly<{
    query: UsageQuery; sessions: readonly Pick<Session, 'id'>[]; contributions?: readonly UsageAnalyticsContribution[];
}>): readonly string[] {
    const membership = resolveAccountingWorkMembership(input.query, input.contributions);
    if (membership.needsAccountingMembership) return [...membership.accountingSessions];
    if (membership.selected) return [...membership.selected];
    return [...new Set([...input.sessions.map(session => session.id),
        ...membership.matching.flatMap(row => row.sessionId === null ? [] : [row.sessionId])])];
}

export function projectUsageQueryWorkEvidence(input: Readonly<{
    query: UsageQuery; scope: ServerAccountScope; currentScope: ServerAccountScope | null;
    isCurrent: boolean; sessions: readonly ScopedUsageSession[];
    openedMessages?: ReadonlyMap<string, readonly OpenedUsageMessage[]>;
    completeMessageSessionIds?: ReadonlySet<string>;
    contributions?: readonly UsageAnalyticsContribution[];
}>): UsageHowYouWorkDetailInput {
    const unknown = { status: 'unknown' as const };
    const { query } = input;
    if (!input.isCurrent || !areServerAccountScopesEqual(input.scope, input.currentScope)) return unknown;
    const { selected, needsAccountingMembership, accountingWork, accountingSessions } = resolveAccountingWorkMembership(query, input.contributions);
    if (needsAccountingMembership && accountingWork.size === 0) return unknown;
    const sessions = input.sessions.filter(session => (!session.serverId || session.serverId === input.scope.serverId)
        && (!selected || selected.has(session.id))
        && (!needsAccountingMembership || accountingSessions.has(session.id))
        && session.access?.capabilities.readTranscript !== false
        && isSessionContentReadable(readSessionContentAvailability(session)));
    if (!sessions.length) return unknown;
    const opened = sessions.map(session => projectSessionUsageWorkEvidence(session, input.openedMessages?.get(session.id),
        { messagesComplete: input.completeMessageSessionIds?.has(session.id) === true }));
    const facts = opened.flatMap(detail => detail.facts ?? []).filter(fact => accountingWork.has(fact.workId)
        || !needsAccountingMembership && (!query.agents.length || (fact.agentId !== null && query.agents.includes(fact.agentId)))
        && (!query.machines.length || (fact.machineId !== null && query.machines.includes(fact.machineId))));
    const knownWork = new Set([...accountingWork, ...facts.map(fact => fact.workId)]);
    const requiresWorkMembership = needsAccountingMembership || query.agents.length > 0 || query.machines.length > 0;
    const permissions = opened.flatMap(detail => detail.permissions ?? []).filter(fact => !requiresWorkMembership || knownWork.has(fact.workId));
    const acceptedInputs = opened.flatMap(detail => detail.acceptedInputs ?? []).filter(fact => !requiresWorkMembership || knownWork.has(fact.workId));
    const composition = opened.flatMap(detail => detail.coach?.composition ?? []).filter(record =>
        !requiresWorkMembership || record.turnId !== null && knownWork.has(JSON.stringify([record.sessionId, record.turnId])));
    const compactions = opened.flatMap(detail => detail.coach?.detail?.compactions ?? []).filter(record =>
        !requiresWorkMembership || record.turnId !== null && knownWork.has(JSON.stringify([record.sessionId, record.turnId])));
    const modelRequests = opened.flatMap(detail => detail.coach?.detail?.modelRequests ?? []).filter(record =>
        !requiresWorkMembership || knownWork.has(JSON.stringify([record.sessionId, record.turnId])));
    const mcpUsage = opened.flatMap(detail => detail.coach?.detail?.mcpUsage ?? []).filter(record =>
        !requiresWorkMembership || knownWork.has(JSON.stringify([record.sessionId, record.turnId])));
    if (opened.every(detail => detail.status === 'unknown')) return unknown;
    return { status: 'partial',
        ...(opened.some(detail => detail.facts !== undefined) ? { facts } : {}),
        ...(opened.some(detail => detail.permissions !== undefined) ? { permissions } : {}),
        ...(opened.some(detail => detail.acceptedInputs !== undefined) ? { acceptedInputs } : {}),
        ...(opened.some(detail => detail.coach !== undefined) ? { coach: { composition, compositionCoverage: 'partial' as const, detail: { coverage: 'partial' as const, compactions, mcpUsage, modelRequests } } } : {}),
        activityAtMs: [...facts.filter(fact => fact.kind === 'busy').map(fact => fact.startMs), ...acceptedInputs.map(fact => fact.acceptedAtMs)] };
}

const timestamp = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** A bounded projection of opened canonical facts, never a Session lifecycle owner. */
export function projectSessionUsageWorkEvidence(
    session: OpenedUsageSession,
    messages?: readonly OpenedUsageMessage[],
    coverage: Readonly<{ messagesComplete?: boolean }> = {},
): UsageHowYouWorkDetailInput {
    const facts: NonNullable<UsageHowYouWorkDetailInput['facts']>[number][] = [];
    const permissions: NonNullable<UsageHowYouWorkDetailInput['permissions']>[number][] = [];
    const turns = session.sessionTurns?.sessionId === session.id ? session.sessionTurns.turns : [];
    const machineId = session.metadata?.machineId ?? null;
    const workId = (turnId: string | null) => JSON.stringify([session.id, turnId]);
    for (const turn of turns) {
        facts.push({ workId: workId(turn.turnId), evidenceId: turn.turnId, agentId: turn.agentId ?? null,
            machineId, kind: 'busy', startMs: turn.startedAt, endMs: timestamp(turn.terminalAt) });
    }
    const confirmations = SessionActionConfirmationsV1Schema.safeParse(session.metadata?.actionConfirmationsV1);
    const requests = { ...(confirmations.success ? confirmations.data.requests : {}), ...session.agentState?.requests };
    const completed = { ...(confirmations.success ? confirmations.data.completedRequests : {}), ...session.agentState?.completedRequests };
    for (const [requestId, entry] of Object.entries({ ...requests, ...completed })) {
        const completion = completed[requestId];
        const turnId = typeof entry.turnId === 'string' && entry.turnId.trim() ? entry.turnId : null;
        const requestedAtMs = timestamp(entry.createdAt);
        const completedAtMs = completion ? timestamp(completion.completedAt) : null;
        const category = SessionPermissionAnsweringClientCategoryV1Schema.safeParse(completion?.answeringClientCategory);
        permissions.push({ requestId, workId: workId(turnId), requestedAtMs,
            decidedAtMs: completion && completion.status !== 'canceled' ? completedAtMs : null,
            toolId: entry.tool || null, answeringClientCategory: category.success ? category.data : null });
        if (turnId && requestedAtMs !== null) {
            facts.push({ workId: workId(turnId), evidenceId: requestId,
                agentId: turns.find(turn => turn.turnId === turnId)?.agentId ?? null, machineId,
                kind: entry.kind === 'user_action' ? 'user_wait' : 'permission_wait',
                startMs: requestedAtMs, endMs: completedAtMs });
        }
    }
    const acceptedInputs: NonNullable<UsageHowYouWorkDetailInput['acceptedInputs']>[number][] = [];
    const seenInputs = new Set<string>();
    const composition = new Map<string, UsagePromptComposition>();
    const compactions = new Map<string, UsageCoachCompactionFact>();
    const mcpUsage = new Map<string, UsageMcpBindingUsage>();
    for (const message of messages ?? []) {
        const content = message.content;
        if (content && typeof content === 'object' && !Array.isArray(content) && 'role' in content
            && content.role === 'agent' && 'content' in content) {
            const record = TranscriptRawAgentRecordV1Schema.safeParse(content.content);
            if (record.success && record.data.type === 'event' && record.data.data.type === 'mcp-binding-usage'
                && record.data.data.usage.sessionId === session.id) {
                const usage = record.data.data.usage;
                mcpUsage.set(usage.evidenceId, usage);
            }
            if (record.success && record.data.type === 'event' && record.data.data.type === 'prompt-composition'
                && record.data.data.composition.sessionId === session.id) {
                const evidence = record.data.data.composition;
                composition.set(evidence.evidenceId, evidence);
            }
            if (record.success && record.data.type === 'event' && record.data.data.type === 'context-compaction') {
                const event = record.data.data;
                const observedAtMs = timestamp(message.createdAt);
                if (event.phase === 'completed' && observedAtMs !== null
                    && event.source !== undefined && event.source !== 'transcript-inference' && event.source !== 'user-command') {
                    const evidenceId = JSON.stringify([session.id, event.lifecycleId ?? event.agentEventId ?? record.data.id]);
                    compactions.set(evidenceId, { evidenceId, observedAtMs, sessionId: session.id,
                        turnId: event.turnId ?? null });
                }
            }
        }
        const accepted = message.acceptedDelivery;
        if (!accepted || !message.localId || seenInputs.has(message.localId)) continue;
        seenInputs.add(message.localId);
        acceptedInputs.push({ inputId: message.localId, workId: workId(accepted.delivery.turnId),
            turnId: accepted.delivery.turnId, acceptedAtMs: accepted.acceptedAtMs, deliveryKind: accepted.delivery.kind });
    }
    const modelRequests: UsageCoachModelRequest[] = [];
    // A complete opened user/event page is necessary to exclude changed workloads.
    // Terminal completion measures response completion, not quality or native context equivalence.
    if (coverage.messagesComplete === true) {
        for (const turn of turns) {
            const terminalAt = timestamp(turn.terminalAt);
            const accepted = acceptedInputs.filter(row => row.turnId === turn.turnId);
            if (turn.status !== 'completed' || terminalAt === null || accepted.length !== 1
                || accepted[0]!.deliveryKind !== 'newTurn') continue;
            const records = [...composition.values()].filter(row => row.inputId === accepted[0]!.inputId);
            if (records.length !== 1) continue;
            const record = records[0]!;
            if (!record.requestIdentity || record.boundary !== 'host_pre_dispatch' || record.deliveryKind !== 'newTurn'
                || record.turnId !== null && record.turnId !== turn.turnId || record.observedAtMs > terminalAt) continue;
            const projected = UsageCoachModelRequestSchema.safeParse({ evidenceId: record.evidenceId,
                observedAtMs: terminalAt, startedAtMs: turn.startedAt, sessionId: session.id,
                turnId: turn.turnId, requestIdentity: record.requestIdentity });
            if (projected.success) modelRequests.push(projected.data);
        }
    }
    // The current retained snapshot/page is not proof of complete historical coverage.
    const hasFacts = session.sessionTurns?.sessionId === session.id || facts.length > 0;
    const hasPermissions = session.agentState?.requests != null || session.agentState?.completedRequests != null || confirmations.success;
    const hasAcceptedInputs = messages !== undefined && (messages.length === 0 || acceptedInputs.length > 0);
    return { status: hasFacts || hasPermissions || messages !== undefined ? 'partial' : 'unknown',
        ...(hasFacts ? { facts } : {}), ...(hasPermissions ? { permissions } : {}),
        ...(hasAcceptedInputs ? { acceptedInputs } : {}),
        ...(messages !== undefined ? { coach: { composition: [...composition.values()], compositionCoverage: 'partial' as const,
            detail: { coverage: 'partial' as const, compactions: [...compactions.values()], mcpUsage: [...mcpUsage.values()], modelRequests } } } : {}),
        activityAtMs: [...turns.map(turn => turn.startedAt), ...acceptedInputs.map(input => input.acceptedAtMs)] };
}
