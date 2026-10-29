import { createStoredReadSchema } from '../json/storedReadSchema.js';
import type { UsageHowYouWorkDetailInput } from '../usage/resolveUsageHowYouWork.js';
import { SessionPermissionAnsweringClientCategoryV1Schema } from '../sessions/permissions/respondRpcParamsV1.js';
import { SessionActionConfirmationsV1Schema } from '../sessions/metadata/sessionActionConfirmationsV1.js';
import { TranscriptRawAgentEventV1Schema, TranscriptRawAgentRecordV1Schema } from '../sessions/messages/transcriptRawRecordV1.js';
import { UsageCoachModelRequestSchema, type UsagePromptComposition, type UsageCoachModelRequest } from '../usage/coach/usagePromptComposition.js';
import type { UsageCoachCompactionFact } from '../usage/coach/coachFinding.js';
import type { UsageMcpBindingUsage } from '../usage/coach/usageMcpBindingUsage.js';
import type { UsageQuery } from '../inputs/usageQuery.js';
import type { UsageAnalyticsContribution } from '../usage/usageAnalyticsContracts.js';
import { canonicalUsageModelPriceId } from '../usage/usageModelPriceSchemas.js';
import { resolveToolMutationClassification } from '../tools/toolMutationClassification.js';
import type { SessionTurnsProjectionV1 } from '../sessions/turns/sessionTurnV1.js';
import type { SessionMessageAcceptedDeliveryFactsV1 } from '../sessions/messages/sessionMessageDeliveryResolutionV1.js';
import type { SessionAwarenessOriginV1 } from '../sessions/awareness/projectionV1.js';
import { projectSessionUsageCollaboration, resolveUsageCollaborationHistoricalSource, type UsageCollaborationToolEvidence } from './usageCollaboration.js';

export type OpenedUsageSession = Readonly<{
    id: string;
    createdAt?: number;
    origin?: SessionAwarenessOriginV1;
    manager?: Readonly<{ sessionId: string }> | null;
    metadata: Readonly<{ machineId?: string; actionConfirmationsV1?: unknown;
        forkV1?: Readonly<{ parentSessionId: string; createdAtMs: number }>;
        replaySeedV1?: Readonly<{ sourceSessionId: string; createdAtMs: number }>;
        handoffV1?: Readonly<{ sourceMachineId: string; targetMachineId: string; agentId: string; completedAtMs: number }>;
    }> | null;
    agentState: Readonly<{
        requests?: Readonly<Record<string, Readonly<{ tool: string; kind?: string; turnId?: string; createdAt?: number | null }>>> | null;
        completedRequests?: Readonly<Record<string, Readonly<{ tool: string; kind?: string; turnId?: string; createdAt?: number | null;
            completedAt?: number | null; status: string; answeringClientCategory?: unknown }>>> | null;
    }> | null;
    sessionTurns?: SessionTurnsProjectionV1 | null;
}>;
export type OpenedUsageMessage = Readonly<{ id: string; localId?: string | null; acceptedDelivery?: SessionMessageAcceptedDeliveryFactsV1 | null;
    content?: unknown; createdAt?: number }>;
/** Content-free facts retained after opened transcript bodies have been released. */
export type UsageSessionMessageEvidence = Pick<UsageHowYouWorkDetailInput, 'acceptedInputs' | 'phaseEvents' | 'coach' | 'collaboration'>;
const storedEventSchema = createStoredReadSchema(TranscriptRawAgentEventV1Schema);
const confirmationReadSchema = createStoredReadSchema(SessionActionConfirmationsV1Schema);

function resolveAccountingWorkMembership(query: UsageQuery, contributions: readonly UsageAnalyticsContribution[] = []) {
    const selected = query.session === null ? null : new Set(typeof query.session === 'string' ? [query.session] : query.session);
    // Session metadata cannot prove public-population or historical model/source/project membership.
    // Only the canonical scoped accounting contribution can admit those turns.
    const needsAccountingMembership = query.population === 'public_eligible_personal' || query.execution !== undefined
        || query.projects.length > 0 || query.sources.length > 0 || query.modelIds.length > 0
        || query.workspaceIds.length > 0 || query.backendModes.length > 0;
    const matching = contributions.filter(row => row.sessionId !== null
        && (!selected || selected.has(row.sessionId))
        && (!query.agents.length || row.agentId !== null && query.agents.includes(row.agentId))
        && (!query.machines.length || row.machineId !== null && query.machines.includes(row.machineId))
        && (!query.projects.length || row.projectKey !== null && query.projects.includes(row.projectKey))
        && (!query.sources.length || row.source !== null && query.sources.includes(row.source))
        && (query.execution === undefined || (row.sourceContext?.execution ?? 'unknown') === query.execution)
        && (!query.modelIds.length || query.modelIds.some(id =>
            (canonicalUsageModelPriceId(id) ?? 'unknown') === (canonicalUsageModelPriceId(row.modelId) ?? 'unknown')))
        && (!query.workspaceIds.length || row.workspaceId !== null && query.workspaceIds.includes(row.workspaceId))
        && (!query.backendModes.length || row.backendMode != null && query.backendModes.includes(row.backendMode)));
    const accountingWork = new Set(matching.filter(row => row.turnId !== null).map(row => JSON.stringify([row.sessionId, row.turnId])));
    const accountingSessions = new Set(matching.filter(row => row.turnId !== null).flatMap(row => row.sessionId === null ? [] : [row.sessionId]));
    return { selected, needsAccountingMembership, accountingWork, accountingSessions, matching };
}

/** Read demand and disclosed facts share the same historical membership owner. */
export function usageQueryNeedsSessionCandidates(query: UsageQuery): boolean {
    const membership = resolveAccountingWorkMembership(query);
    return membership.selected === null && !membership.needsAccountingMembership;
}

/** Retained detail is reusable only for the same proved historical turn population. */
export function hasSameUsageQueryWorkEvidenceMembership(input: Readonly<{
    query: UsageQuery;
    contributions?: readonly UsageAnalyticsContribution[];
    previousContributions?: readonly UsageAnalyticsContribution[];
}>): boolean {
    if (input.contributions === undefined || input.previousContributions === undefined) return false;
    const current = resolveAccountingWorkMembership(input.query, input.contributions).accountingWork;
    const previous = resolveAccountingWorkMembership(input.query, input.previousContributions).accountingWork;
    return current.size === previous.size && [...current].every(workId => previous.has(workId));
}

export function selectUsageQueryWorkEvidenceSessionIds(input: Readonly<{
    query: UsageQuery; sessions: readonly Pick<OpenedUsageSession, 'id'>[]; contributions?: readonly UsageAnalyticsContribution[];
}>): readonly string[] {
    const membership = resolveAccountingWorkMembership(input.query, input.contributions);
    if (membership.needsAccountingMembership) return [...membership.accountingSessions];
    if (membership.selected) return [...membership.selected];
    return [...new Set([...input.sessions.map(session => session.id),
        ...membership.matching.flatMap(row => row.sessionId === null ? [] : [row.sessionId])])];
}

export function projectUsageQueryWorkEvidence(input: Readonly<{
    query: UsageQuery; sessions: readonly OpenedUsageSession[];
    openedMessages?: ReadonlyMap<string, readonly OpenedUsageMessage[]>;
    sessionEvidence?: ReadonlyMap<string, UsageHowYouWorkDetailInput>;
    completeMessageSessionIds?: ReadonlySet<string>;
    contributions?: readonly UsageAnalyticsContribution[];
}>): UsageHowYouWorkDetailInput {
    const unknown = { status: 'unknown' as const };
    const { query } = input;
    const { selected, needsAccountingMembership, accountingWork, accountingSessions } = resolveAccountingWorkMembership(query, input.contributions);
    if (needsAccountingMembership && accountingWork.size === 0) return unknown;
    const sessions = input.sessions.filter(session => (!selected || selected.has(session.id))
        && (!needsAccountingMembership || accountingSessions.has(session.id)));
    const sessionsById = new Map(sessions.map(session => [session.id, session]));
    if (!sessions.length) return unknown;
    const opened = sessions.map(session => input.sessionEvidence?.get(session.id) ?? projectSessionUsageWorkEvidence(session, input.openedMessages?.get(session.id),
        { messagesComplete: input.completeMessageSessionIds?.has(session.id) === true }));
    const facts = opened.flatMap(detail => detail.facts ?? []).filter(fact => accountingWork.has(fact.workId)
        || !needsAccountingMembership && (!query.agents.length || (fact.agentId !== null && query.agents.includes(fact.agentId)))
        && (!query.machines.length || (fact.machineId !== null && query.machines.includes(fact.machineId))));
    const knownWork = new Set([...accountingWork, ...facts.map(fact => fact.workId)]);
    const requiresWorkMembership = needsAccountingMembership || query.agents.length > 0 || query.machines.length > 0;
    const permissions = opened.flatMap(detail => detail.permissions ?? []).filter(fact => !requiresWorkMembership || knownWork.has(fact.workId));
    const closedTurns = opened.flatMap(detail => detail.closedTurns ?? []).filter(fact => !requiresWorkMembership || knownWork.has(fact.workId));
    const collaboration = opened.flatMap(detail => detail.collaboration ?? []).filter(fact => !requiresWorkMembership
        || fact.workId !== null && knownWork.has(fact.workId)).map(fact => resolveUsageCollaborationHistoricalSource(fact,
            fact.sourceSessionId === null ? undefined : sessionsById.get(fact.sourceSessionId),
            needsAccountingMembership ? accountingWork : undefined));
    const acceptedInputs = opened.flatMap(detail => detail.acceptedInputs ?? []).filter(fact => !requiresWorkMembership || knownWork.has(fact.workId));
    const composition = opened.flatMap(detail => detail.coach?.composition ?? []).filter(record =>
        !requiresWorkMembership || record.turnId !== null && knownWork.has(JSON.stringify([record.sessionId, record.turnId])));
    const compactions = opened.flatMap(detail => detail.coach?.detail?.compactions ?? []).filter(record =>
        !requiresWorkMembership || record.turnId !== null && knownWork.has(JSON.stringify([record.sessionId, record.turnId])));
    const modelRequests = opened.flatMap(detail => detail.coach?.detail?.modelRequests ?? []).filter(record =>
        !requiresWorkMembership || knownWork.has(JSON.stringify([record.sessionId, record.turnId])));
    const mcpUsage = opened.flatMap(detail => detail.coach?.detail?.mcpUsage ?? []).filter(record =>
        !requiresWorkMembership || knownWork.has(JSON.stringify([record.sessionId, record.turnId])));
    const phaseEvents = opened.flatMap(detail => detail.phaseEvents ?? []).filter(record =>
        !requiresWorkMembership || record.turnId !== null && knownWork.has(JSON.stringify([record.sessionId, record.turnId])));
    if (opened.every(detail => detail.status === 'unknown')) return unknown;
    return { status: 'partial',
        ...(opened.some(detail => detail.facts !== undefined) ? { facts } : {}),
        ...(opened.some(detail => detail.permissions !== undefined) ? { permissions } : {}),
        ...(opened.some(detail => detail.closedTurns !== undefined) ? { closedTurns } : {}),
        ...(opened.some(detail => detail.collaboration !== undefined) ? { collaboration } : {}),
        ...(opened.some(detail => detail.acceptedInputs !== undefined) ? { acceptedInputs } : {}),
        ...(opened.some(detail => detail.phaseEvents !== undefined) ? { phaseEvents } : {}),
        ...(opened.some(detail => detail.coach !== undefined) ? { coach: { composition, compositionCoverage: 'partial' as const, detail: { coverage: 'partial' as const, compactions, mcpUsage, modelRequests } } } : {}),
        activityAtMs: [...facts.filter(fact => fact.kind === 'busy').map(fact => fact.startMs), ...acceptedInputs.map(fact => fact.acceptedAtMs)] };
}

const timestamp = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** A bounded projection of opened canonical facts, never a Session lifecycle owner. */
export function projectSessionUsageWorkEvidence(
    session: OpenedUsageSession,
    messages?: readonly OpenedUsageMessage[],
    coverage: Readonly<{ messagesComplete?: boolean; messageEvidence?: UsageSessionMessageEvidence }> = {},
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
    const confirmations = confirmationReadSchema.safeParse(session.metadata?.actionConfirmationsV1);
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
    const retained = coverage.messageEvidence;
    const hasMessages = messages !== undefined || retained !== undefined;
    const acceptedInputs = [...(retained?.acceptedInputs ?? [])];
    const seenInputs = new Set<string>();
    const composition = new Map<string, UsagePromptComposition>(retained?.coach?.composition?.map(row => [row.evidenceId, row]));
    const compactions = new Map<string, UsageCoachCompactionFact>(retained?.coach?.detail?.compactions?.map(row => [row.evidenceId, row]));
    const mcpUsage = new Map<string, UsageMcpBindingUsage>(retained?.coach?.detail?.mcpUsage?.map(row => [row.evidenceId, row]));
    const phaseEvents = new Map<string, NonNullable<UsageHowYouWorkDetailInput['phaseEvents']>[number]>(retained?.phaseEvents?.map(row => [row.evidenceId, row]));
    const collaborationTools: UsageCollaborationToolEvidence[] = [];
    const observedSidechainIds = new Set<string>();
    for (const message of messages ?? []) {
        const content = message.content;
        if (content && typeof content === 'object' && !Array.isArray(content) && 'role' in content
            && content.role === 'agent' && 'content' in content) {
            const record = TranscriptRawAgentRecordV1Schema.safeParse(content.content);
            if (record.success) {
                const raw = record.data;
                const nativeAgentId = raw.type === 'output' ? 'claude' : raw.type === 'codex' ? 'codex' : raw.type === 'acp' ? raw.agentId : null;
                if ('sidechainId' in raw.data && typeof raw.data.sidechainId === 'string') observedSidechainIds.add(raw.data.sidechainId);
                if (raw.type === 'output' && 'parent_tool_use_id' in raw.data && typeof raw.data.parent_tool_use_id === 'string') {
                    observedSidechainIds.add(raw.data.parent_tool_use_id);
                }
                const tools: { id: string; name: string }[] = [];
                if ((raw.type === 'codex' || raw.type === 'acp') && raw.data.type === 'tool-call'
                    && typeof raw.data.callId === 'string' && typeof raw.data.name === 'string') {
                    tools.push({ id: raw.data.callId, name: raw.data.name });
                    collaborationTools.push({ id: raw.data.callId, name: raw.data.name, input: raw.data.input,
                        observedAtMs: timestamp(message.createdAt), nativeAgentId });
                } else if ((raw.type === 'codex' || raw.type === 'acp') && (raw.data.type === 'tool-result' || raw.data.type === 'tool-call-result')
                    && typeof raw.data.callId === 'string') {
                    collaborationTools.push({ id: raw.data.callId, name: '', result: raw.data.output,
                        observedAtMs: timestamp(message.createdAt), nativeAgentId });
                } else if (raw.type === 'output' && (raw.data.type === 'assistant' || raw.data.type === 'user')) {
                    const assistant = 'message' in raw.data ? raw.data.message : null;
                    const blocks = assistant && typeof assistant === 'object' && !Array.isArray(assistant)
                        && 'content' in assistant && Array.isArray(assistant.content) ? assistant.content : [];
                    for (const block of blocks) {
                        if (block && typeof block === 'object' && block.type === 'tool_use' && 'id' in block && typeof block.id === 'string'
                            && 'name' in block && typeof block.name === 'string') {
                            tools.push({ id: block.id, name: block.name });
                            collaborationTools.push({ id: block.id, name: block.name, input: 'input' in block ? block.input : undefined,
                                observedAtMs: timestamp(message.createdAt), nativeAgentId });
                        } else if (block && typeof block === 'object' && block.type === 'tool_result' && 'tool_use_id' in block
                            && typeof block.tool_use_id === 'string') {
                            collaborationTools.push({ id: block.tool_use_id, name: '', result: 'content' in block ? block.content : undefined,
                                observedAtMs: timestamp(message.createdAt), nativeAgentId });
                        }
                    }
                }
                const observedAtMs = timestamp(message.createdAt);
                if (observedAtMs !== null) for (const tool of tools) {
                    const classification = resolveToolMutationClassification(tool.name);
                    const kind = classification === 'read_only' ? 'read' : classification === 'opaque_executor' ? 'execute'
                        : classification === 'container' ? 'delegate' : classification === null || classification === 'mutating_unknown'
                            ? 'unknown' : 'change';
                    phaseEvents.set(tool.id, { evidenceId: tool.id, sessionId: session.id, turnId: null, observedAtMs,
                        kind, method: 'tool_classification' });
                }
            }
            const event = record.success && record.data.type === 'event'
                ? { success: true as const, data: record.data.data }
                : record.success && record.data.type === 'acp' && record.data.data.type === 'event'
                    ? storedEventSchema.safeParse(record.data.data.data) : null;
            if (event?.success && event.data.type === 'mcp-binding-usage'
                && event.data.usage.sessionId === session.id) {
                const usage = event.data.usage;
                mcpUsage.set(usage.evidenceId, usage);
            }
            if (event?.success && event.data.type === 'prompt-composition'
                && event.data.composition.sessionId === session.id) {
                const evidence = event.data.composition;
                composition.set(evidence.evidenceId, evidence);
            }
            if (event?.success && event.data.type === 'context-compaction') {
                const compaction = event.data;
                const observedAtMs = timestamp(message.createdAt);
                if (compaction.phase === 'completed' && observedAtMs !== null
                    && compaction.source !== undefined && compaction.source !== 'transcript-inference' && compaction.source !== 'user-command') {
                    const evidenceId = JSON.stringify([session.id, compaction.lifecycleId ?? compaction.agentEventId
                        ?? (record.success && record.data.type === 'event' ? record.data.id : message.localId ?? message.id)]);
                    compactions.set(evidenceId, { evidenceId, observedAtMs, sessionId: session.id,
                        turnId: compaction.turnId ?? null });
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
    const hasAcceptedInputs = retained?.acceptedInputs !== undefined || messages !== undefined && (messages.length === 0 || acceptedInputs.length > 0);
    const collaboration = projectSessionUsageCollaboration({ session, tools: collaborationTools, observedSidechainIds, retained: retained?.collaboration });
    return { status: hasFacts || hasPermissions || hasMessages || collaboration.length > 0 ? 'partial' : 'unknown',
        ...(hasFacts ? { facts } : {}), ...(hasPermissions ? { permissions } : {}),
        ...(hasFacts ? { closedTurns: turns.map(turn => ({ workId: workId(turn.turnId), agentId: turn.agentId ?? null,
            startMs: turn.startedAt, endMs: timestamp(turn.terminalAt), status: turn.status })) } : {}),
        ...(hasMessages || collaboration.length > 0 ? { collaboration } : {}),
        ...(hasAcceptedInputs ? { acceptedInputs } : {}),
        ...(hasMessages ? { phaseEvents: [...phaseEvents.values()] } : {}),
        ...(hasMessages ? { coach: { composition: [...composition.values()], compositionCoverage: 'partial' as const,
            detail: { coverage: 'partial' as const, compactions: [...compactions.values()], mcpUsage: [...mcpUsage.values()], modelRequests } } } : {}),
        activityAtMs: [...turns.map(turn => turn.startedAt), ...acceptedInputs.map(input => input.acceptedAtMs)] };
}
